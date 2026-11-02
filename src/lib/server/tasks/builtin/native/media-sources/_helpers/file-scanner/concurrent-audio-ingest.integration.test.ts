// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';
import * as rematch from '../../../../../../database/queries/file-rematch.queries.js';
import { hashFileHead } from '../../../../../../utils/file-hash.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '../../../../../../database/queries/media-files.queries.js';
import * as audioTagParser from './audio-tag-parser.js';
import { ID3_LATIN1, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';

describe('music scanner: concurrent first ingest (real PG)', () => {
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

    it('hash reclaim does not attach a second track after another ingest won the file', async () => {
        const filePath = await fixture();
        const hash = await hashFileHead(filePath);
        const [old] =
            await sql`INSERT INTO media_items (title,media_type,is_dismissed,dismissed_at,dismissed_content_hash)
            VALUES ('Old Aria','track',true,NOW(),${hash}) RETURNING id`;
        const [winner] =
            await sql`INSERT INTO media_items (title,media_type) VALUES ('Winner','track') RETURNING id`;
        const lookup = rematch.findReclaimableByHash;
        vi.spyOn(rematch, 'findReclaimableByHash').mockImplementation(async (...args) => {
            const match = await lookup(...args);
            expect(match?.media_item_id).toBe(old.id);
            const file = await upsertMediaFile(sql, {
                filePath,
                libraryGroupId: libraryPath.library_group_id,
            });
            await attachFileToItem(sql, file.id, winner.id);
            return match;
        });
        expect(await processVideoFile(sql, filePath, libraryPath, [], context)).not.toBe('error');
        expect(
            await sql`SELECT mfi.media_item_id FROM media_file_items mfi
            JOIN media_files f ON f.id=mfi.file_id WHERE f.file_path=${filePath}`,
        ).toEqual([{ media_item_id: winner.id }]);
        expect(await sql`SELECT is_dismissed FROM media_items WHERE id=${old.id}`).toEqual([
            { is_dismissed: true },
        ]);
    });

    it.each(['new', 'reclaim'])(
        'uses the shared 64-bit file-link lock on the %s path',
        async (mode) => {
            const filePath = await fixture();
            if (mode === 'reclaim') {
                await sql`INSERT INTO media_items (title,media_type,is_dismissed,dismissed_at,dismissed_content_hash)
                VALUES ('Old','track',true,NOW(),${await hashFileHead(filePath)})`;
            }
            const locker = postgres(getTestDatabaseUrl(), { max: 1 });
            const worker = postgres(getTestDatabaseUrl(), { max: 1 });
            let ingest: Promise<unknown> | undefined;
            try {
                const [workerPid] = await worker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                await locker.begin(async (tx) => {
                    const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`media-file-link:${filePath}`},0))`;
                    ingest = processVideoFile(worker, filePath, libraryPath, [], {
                        ...context,
                        sql: worker,
                    });
                    await expect
                        .poll(
                            async () => {
                                const [r] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (
                        SELECT 1 FROM pg_locks h JOIN pg_locks w
                        ON h.locktype=w.locktype AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
                        WHERE h.pid=${holder.pid} AND w.pid=${workerPid.pid}
                            AND h.locktype='advisory' AND h.granted AND NOT w.granted
                    ) AS waiting`;
                                return r.waiting;
                            },
                            { timeout: 10000 },
                        )
                        .toBe(true);
                });
                expect(await ingest).not.toBe('error');
            } finally {
                await ingest;
                await Promise.all([locker.end({ timeout: 5 }), worker.end({ timeout: 5 })]);
            }
        },
        30000,
    );

    it.each([false, true])(
        'scan and watcher create one track (stale bulk snapshot: %s)',
        async (snapshot) => {
            const filePath = await fixture();
            const workers = [
                postgres(getTestDatabaseUrl(), { max: 1 }),
                postgres(getTestDatabaseUrl(), { max: 1 }),
            ];
            const parse = audioTagParser.parseAudioTags;
            let arrivals = 0;
            let release!: () => void;
            const bothParsing = new Promise<void>((resolve) => {
                release = resolve;
            });
            // Both ingests have passed the initial no-file check before either
            // finishes reading tags. A fresh bulk-scan snapshot has the same gap.
            vi.spyOn(audioTagParser, 'parseAudioTags').mockImplementation(async (...args) => {
                if (args[0] === filePath && arrivals < 2) {
                    if (++arrivals === 2) release();
                    await bothParsing;
                }
                return parse(...args);
            });
            try {
                const outcomes = await Promise.all(
                    workers.map((worker) =>
                        processVideoFile(
                            worker,
                            filePath,
                            libraryPath,
                            [],
                            { ...context, sql: worker },
                            snapshot ? new Map() : undefined,
                        ),
                    ),
                );
                expect(outcomes).not.toContain('error');
                const rows = await sql<{ id: string }[]>`
                SELECT mi.id FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                JOIN media_items mi ON mi.id = mfi.media_item_id
                WHERE mf.file_path = ${filePath} AND mi.media_type = 'track'
            `;
                expect(rows).toHaveLength(1);
                const all = await sql`SELECT id FROM media_items WHERE media_type = 'track'`;
                expect(all).toHaveLength(1);
            } finally {
                await Promise.all(workers.map((worker) => worker.end({ timeout: 5 })));
            }
        },
        60_000,
    );
});
