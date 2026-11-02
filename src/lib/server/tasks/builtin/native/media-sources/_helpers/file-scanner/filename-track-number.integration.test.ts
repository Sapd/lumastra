// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';
import { MediaLifecycleService } from '../../../../../../services/media-lifecycle.service.js';
import * as audioTagParser from './audio-tag-parser.js';
import { ID3_LATIN1, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';

describe('music scanner: filename track numbering (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    const logger = {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
        debug: (): void => undefined,
    };
    let context: FileScannerContext;

    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger } as unknown as FileScannerContext;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-track-number-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`track-number-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group!.id}, true)
            RETURNING *
        `;
        libraryPath = lp!;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp!.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group!.id}`;
        };
    });

    async function fixture(
        trackNumber?: string,
        filename = 'Invented Artist - Invented Album - 07 - Invented Title.mp3',
    ): Promise<string> {
        const albumDir = join(root, 'Invented Artist', 'Invented Album', 'CD 01');
        await mkdir(albumDir, { recursive: true });
        return writeId3Mp3(join(albumDir, filename), 3, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Invented Title']) },
            { id: 'TALB', body: textFrameBody(ID3_LATIN1, ['Invented Album']) },
            { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['Invented Artist']) },
            ...(trackNumber === undefined
                ? []
                : [{ id: 'TRCK', body: textFrameBody(ID3_LATIN1, [trackNumber]) }]),
        ]);
    }

    async function track(filePath: string): Promise<{
        id: string;
        sort_order: number | null;
        custom_metadata: Record<string, unknown>;
    }> {
        const [row] = await sql<
            {
                id: string;
                sort_order: number | null;
                custom_metadata: Record<string, unknown>;
            }[]
        >`
            SELECT mi.id, mi.sort_order, mi.custom_metadata
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path = ${filePath}
        `;
        expect(row).toBeDefined();
        return row!;
    }

    it('inserts filename numbering when TRCK is absent', async () => {
        const p = await fixture();
        expect(await processVideoFile(sql, p, libraryPath, [], context)).toBe('added');
        expect(await track(p)).toMatchObject({
            sort_order: 7,
            custom_metadata: { track_number: 7, track_number_source: 'filename' },
        });
    }, 60_000);

    it.each(['missing', 'null', 'string'])(
        'backfills an unchanged row with %s track_number',
        async (shape) => {
            const p = await fixture();
            await processVideoFile(sql, p, libraryPath, [], context);
            const original = await track(p);
            const metadata = { ...original.custom_metadata };
            delete metadata.track_number;
            delete metadata.track_number_source;
            if (shape === 'null') metadata.track_number = null;
            if (shape === 'string') metadata.track_number = 'unknown';
            // Fill the other backfill fields: filename numbering alone must trigger repair.
            metadata.genre = ['Electronic'];
            metadata.recording_mbid = '3d282fcc-91e7-4c22-9854-53427c6cc15d';
            await sql`
                UPDATE media_items
                SET custom_metadata = ${sql.json(metadata as never)}, sort_order = NULL
                WHERE id = ${original.id}
            `;
            await processVideoFile(sql, p, libraryPath, [], context);
            expect(await track(p)).toMatchObject({
                id: original.id,
                sort_order: 7,
                custom_metadata: { track_number: 7, track_number_source: 'filename' },
            });
        },
        60_000,
    );

    it('preserves a track-number tag over the filename', async () => {
        const p = await fixture('12');
        await processVideoFile(sql, p, libraryPath, [], context);
        await processVideoFile(sql, p, libraryPath, [], context);
        const row = await track(p);
        expect(row.sort_order).toBe(12);
        expect(row.custom_metadata.track_number).toBe(12);
        expect(row.custom_metadata.track_number_source).toBeUndefined();
    }, 60_000);

    it('does not reparse tags solely because an unnumbered filename has no track tag', async () => {
        // Other unchanged-file maintenance (album art backfill) may parse tags;
        // compare against a control track that already has its number.
        async function parsesOnRescan(p: string): Promise<number> {
            await processVideoFile(sql, p, libraryPath, [], context);
            const original = await track(p);
            const metadata = {
                ...original.custom_metadata,
                genre: ['Electronic'],
                recording_mbid: '3d282fcc-91e7-4c22-9854-53427c6cc15d',
                title_source_verified: true,
            };
            expect(original.custom_metadata.raw_artist_tags).toMatchObject({ source: 'file' });
            await sql`
                UPDATE media_items SET custom_metadata = ${sql.json(metadata as never)}
                WHERE id = ${original.id}
            `;
            const parse = vi.spyOn(audioTagParser, 'parseAudioTags');
            await processVideoFile(sql, p, libraryPath, [], context);
            const calls = parse.mock.calls.filter(([path]) => path === p).length;
            parse.mockRestore();
            return calls;
        }
        const control = await parsesOnRescan(await fixture('12', 'Invented Artist - Control.mp3'));
        const p = await fixture(undefined, 'Invented Artist - Invented Title.mp3');
        expect(await parsesOnRescan(p)).toBe(control);
        expect((await track(p)).custom_metadata.track_number).toBeUndefined();
    }, 60_000);

    it('replaces filename numbering and provenance when a changed file gains TRCK', async () => {
        const p = await fixture();
        await processVideoFile(sql, p, libraryPath, [], context);
        const original = await track(p);
        await fixture('12');
        await processVideoFile(sql, p, libraryPath, [], context);
        const row = await track(p);
        expect(row.id).toBe(original.id);
        expect(row.sort_order).toBe(12);
        expect(row.custom_metadata.track_number).toBe(12);
        expect(row.custom_metadata.track_number_source).toBeUndefined();
    }, 60_000);

    it('finishes content invalidation before reporting a changed-file rescan complete', async () => {
        const p = await fixture();
        await processVideoFile(sql, p, libraryPath, [], context);
        await fixture('12');
        const originalInvalidate = MediaLifecycleService.onFileContentChanged;
        const invalidations: ReturnType<typeof originalInvalidate>[] = [];
        vi.spyOn(MediaLifecycleService, 'onFileContentChanged').mockImplementation((...args) => {
            const pending = originalInvalidate(...args);
            invalidations.push(pending);
            return pending;
        });
        // A separate PostgreSQL session stalls the real invalidation after it
        // locks media_files. The rescan must not return with that transaction
        // still live, where later work or cleanup can invert its table locks.
        const blocker = await sql.reserve();
        let scan: ReturnType<typeof processVideoFile> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await blocker`BEGIN`;
            await blocker`LOCK TABLE media_streams IN ACCESS EXCLUSIVE MODE`;
            scan = processVideoFile(sql, p, libraryPath, [], context);
            await vi.waitFor(
                async () => {
                    const [row] = await sql<{ waiting: boolean }[]>`
                    SELECT EXISTS (
                        SELECT 1 FROM pg_stat_activity
                        WHERE datname = current_database() AND pid <> pg_backend_pid()
                          AND wait_event_type = 'Lock'
                          AND query LIKE '%DELETE FROM media_streams%'
                    ) AS waiting
                `;
                    expect(row.waiting).toBe(true);
                },
                { timeout: 10_000 },
            );
            expect(
                await Promise.race([
                    scan.then(() => 'returned'),
                    new Promise<string>((resolve) => {
                        timer = setTimeout(() => resolve('waiting for invalidation'), 2000);
                    }),
                ]),
            ).toBe('waiting for invalidation');
        } finally {
            clearTimeout(timer);
            await blocker`ROLLBACK`;
            blocker.release();
            await Promise.all([scan, ...invalidations]);
        }
        expect(await scan).toBe('updated');
        expect(invalidations).toHaveLength(1);
        expect(await track(p)).toMatchObject({
            sort_order: 12,
            custom_metadata: { track_number: 12 },
        });
    }, 60_000);

    it('respects metadata_locked during backfill', async () => {
        const p = await fixture();
        await processVideoFile(sql, p, libraryPath, [], context);
        const original = await track(p);
        await sql`
            UPDATE media_items
            SET custom_metadata = custom_metadata - 'track_number' - 'track_number_source',
                sort_order = NULL, metadata_locked = true
            WHERE id = ${original.id}
        `;
        await processVideoFile(sql, p, libraryPath, [], context);
        const row = await track(p);
        expect(row.custom_metadata.track_number).toBeUndefined();
        expect(row.custom_metadata.track_number_source).toBeUndefined();
        expect(row.sort_order).toBeNull();
        // The lock must also stop the backfill from re-parsing tags on every scan.
        const parse = vi.spyOn(audioTagParser, 'parseAudioTags');
        await processVideoFile(sql, p, libraryPath, [], context);
        const ownParses = parse.mock.calls.filter(([path]) => path === p).length;
        parse.mockRestore();
        const control = await fixture('12', 'Invented Artist - Locked Control.mp3');
        await processVideoFile(sql, control, libraryPath, [], context);
        const controlRow = await track(control);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${controlRow.id}`;
        const controlParse = vi.spyOn(audioTagParser, 'parseAudioTags');
        await processVideoFile(sql, control, libraryPath, [], context);
        const controlParses = controlParse.mock.calls.filter(([path]) => path === control).length;
        controlParse.mockRestore();
        expect(ownParses).toBe(controlParses);
    }, 60_000);
});
