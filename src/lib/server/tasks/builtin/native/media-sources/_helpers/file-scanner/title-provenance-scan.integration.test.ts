// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    deleteScanProgress: async () => {},
    getAggregateScanProgress: async () => null,
}));
vi.mock('./audio-tag-parser.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('./audio-tag-parser.js')>();
    return { ...original, parseAudioTags: vi.fn(original.parseAudioTags) };
});
vi.mock('./video-processor.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('./video-processor.js')>();
    return { ...original, processVideoFile: vi.fn(original.processVideoFile) };
});

import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import { findTrackFilesWithUnverifiedTitleSourceByPrefix } from '../../../../../../database/queries/media-files.queries.js';
import { LoggerInstance } from '../../../../../../utils/logger.js';
import { scanForSync } from '../../file-scanner.js';
import { processVideoFile } from './video-processor.js';
import { parseAudioTags } from './audio-tag-parser.js';
import { writeId3Mp3, textFrameBody, ID3_UTF8 } from './id3-mp3-fixture.test-helpers.js';

// Real files, tag parser, PostgreSQL and ordinary scan entry. Spies count work;
// only failed/cancelled parses are injected. Providers are absent in this fixture.
describe('ordinary music scan catches up title provenance', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    let filePath: string;
    let trackId: string;
    const logger = new LoggerInstance('TitleProvenanceScanTest');
    const infoLog = vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        const original =
            await vi.importActual<typeof import('./audio-tag-parser.js')>('./audio-tag-parser.js');
        vi.mocked(parseAudioTags).mockReset().mockImplementation(original.parseAudioTags);
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'title-catchup-%'`;
        root = await mkdtemp(join(tmpdir(), 'title-catchup_%_'));
        const albumDir = join(root, 'Source Artist', 'Source Album');
        await mkdir(albumDir, { recursive: true });
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`title-catchup-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group.id}, true) RETURNING *`;
        libraryPath = lp;
        filePath = join(albumDir, '01 Plain Title.mp3');
        return async () => {
            await rm(root, { recursive: true, force: true });
        };
    });

    async function seed(title: string | null = 'Actual Tag Title'): Promise<void> {
        await writeId3Mp3(filePath, 4, [
            ...(title === null ? [] : [{ id: 'TIT2', body: textFrameBody(ID3_UTF8, [title]) }]),
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Source Artist']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Source Album']) },
        ]);
        expect(await processVideoFile(sql, filePath, libraryPath, [], { sql, logger })).toBe(
            'added',
        );
        const [row] = await sql<{ id: string }[]>`
            SELECT mi.id FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id WHERE mf.file_path = ${filePath}`;
        trackId = row.id;
        await sql`UPDATE media_items SET title = 'Plain Title', title_source = 'filename',
            custom_metadata = custom_metadata - 'title_source_verified'
            WHERE id = ${trackId}`;
        vi.clearAllMocks();
    }

    async function state(): Promise<{
        title: string;
        title_source: string;
        verified: unknown;
        parent_id: string;
    }> {
        const [row] = await sql<
            { title: string; title_source: string; verified: unknown; parent_id: string }[]
        >`
            SELECT title, title_source, custom_metadata->'title_source_verified' AS verified, parent_id
            FROM media_items WHERE id = ${trackId}`;
        return row;
    }

    async function associations(): Promise<unknown> {
        const links = await sql`
            SELECT to_jsonb(mfi) AS link
            FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mf.file_path = ${filePath} ORDER BY mfi.media_item_id`;
        const counts =
            await sql`SELECT count(*) AS tracks FROM media_items WHERE media_type = 'track'`;
        const identity =
            await sql`SELECT id, parent_id, sort_order FROM media_items WHERE id = ${trackId}`;
        return { links: [...links], counts: [...counts], identity: [...identity] };
    }

    async function scan(abortSignal?: AbortSignal): Promise<void> {
        await scanForSync(libraryPath.id, { sql, logger, abortSignal });
        const triage = infoLog.mock.calls
            .map((call) => String(call[0]))
            .find((line) => line.includes('File scanner: triage'));
        expect(triage).toMatch(/0 maybe-changed, 0 new/);
    }

    it('reaches tag evidence without a file change, preserves identity and bytes, then cheaply skips', async () => {
        await seed();
        const before = await state();
        const originalAssociations = await associations();
        const bytes = await readFile(filePath);
        await scan();
        expect(await state()).toMatchObject({
            title: 'Actual Tag Title',
            title_source: 'tag',
            verified: true,
            parent_id: before.parent_id,
        });
        expect(await readFile(filePath)).toEqual(bytes);
        expect(await associations()).toEqual(originalAssociations);
        expect(parseAudioTags).toHaveBeenCalled();
        expect(processVideoFile).toHaveBeenCalledTimes(1);
        vi.clearAllMocks();
        await scan();
        expect(processVideoFile).not.toHaveBeenCalled();
        expect(parseAudioTags).not.toHaveBeenCalled();
    });

    it('verifies a genuinely untagged file once and leaves its filename source visible', async () => {
        await seed(null);
        await scan();
        expect(await state()).toMatchObject({
            title: 'Plain Title',
            title_source: 'filename',
            verified: true,
        });
        vi.clearAllMocks();
        await scan();
        expect(processVideoFile).not.toHaveBeenCalled();
        expect(parseAudioTags).not.toHaveBeenCalled();
    });

    it('preserves a manual lock while recording completed verification', async () => {
        await seed();
        await sql`UPDATE media_items SET title = 'Admin Title', metadata_locked = true WHERE id = ${trackId}`;
        await scan();
        expect(await state()).toMatchObject({
            title: 'Admin Title',
            title_source: 'filename',
            verified: true,
        });
    });

    it('verifies a locked mojibake title once without changing the manual title/source', async () => {
        await seed();
        await sql`UPDATE media_items SET title = 'Admin �', metadata_locked = true WHERE id = ${trackId}`;
        await scan();
        expect(await state()).toMatchObject({
            title: 'Admin �',
            title_source: 'filename',
            verified: true,
        });
        vi.clearAllMocks();
        await scan();
        expect(processVideoFile).not.toHaveBeenCalled();
    });

    it.each(['corrupt', 'timeout', 'aborted'] as const)(
        'does not verify a %s parse and retries on the next ordinary scan',
        async (parseError) => {
            await seed();
            const controller = new AbortController();
            vi.mocked(parseAudioTags).mockImplementationOnce(async (_path, options) => {
                if (parseError === 'aborted') {
                    controller.abort();
                    expect(options?.signal?.aborted).toBe(true);
                }
                return { title: 'Filename fallback', titleFromFilename: true, parseError };
            });
            await scan(controller.signal);
            expect(await state()).toMatchObject({ title_source: 'filename', verified: null });
            vi.clearAllMocks();
            await scan();
            expect(await state()).toMatchObject({ title_source: 'tag', verified: true });
        },
    );

    it('repairs NULL metadata end-to-end without changing the original associations or track count', async () => {
        await seed();
        await sql`UPDATE media_items SET custom_metadata = NULL, title = 'Old Filename Title' WHERE id = ${trackId}`;
        const before = await associations();
        await scan();
        expect(await state()).toMatchObject({
            title: 'Actual Tag Title',
            title_source: 'tag',
            verified: true,
        });
        expect(await associations()).toEqual(before);
    });

    it.each(['corrupt', 'timeout', 'aborted'] as const)(
        'preserves mojibake-bearing filename metadata on %s parse, then recovers',
        async (parseError) => {
            await seed();
            await sql`UPDATE media_items SET title = 'Broken �',
                custom_metadata = '{"artist":"Broken �","album":"Source Album","sentinel":"preserve"}'::jsonb
                WHERE id = ${trackId}`;
            const before =
                await sql`SELECT title, title_source, custom_metadata FROM media_items WHERE id = ${trackId}`;
            const original =
                await vi.importActual<typeof import('./audio-tag-parser.js')>(
                    './audio-tag-parser.js',
                );
            vi.mocked(parseAudioTags).mockResolvedValue({
                title: 'Bad fallback',
                titleFromFilename: true,
                parseError,
            });
            await scan();
            const [afterFailure] =
                await sql`SELECT title, title_source, custom_metadata FROM media_items WHERE id = ${trackId}`;
            // Ordinary artist maintenance may add derived credit keys, but an
            // incomplete tag parse must preserve every original metadata key.
            expect(afterFailure).toMatchObject(before[0]);
            expect((await state()).verified).toBeNull();
            vi.mocked(parseAudioTags).mockReset().mockImplementation(original.parseAudioTags);
            await scan();
            expect(await state()).toMatchObject({ title: 'Actual Tag Title', title_source: 'tag' });
        },
    );

    it('repairs later whole-file links while preserving ordinary and segmented track identities', async () => {
        await seed();
        await sql`UPDATE media_items SET title_source = 'tag' WHERE id = ${trackId}`;
        const [later] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, title_source, parent_id)
            SELECT 'Later Filename', 'track', 'active', 'filename', parent_id FROM media_items WHERE id = ${trackId}
            RETURNING id`;
        const [segment] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, title_source, parent_id, custom_metadata)
            SELECT 'Chapter Title', 'track', 'active', 'filename', parent_id, '{"chapter":"keep","artist":"Segment Artist"}'::jsonb
            FROM media_items WHERE id = ${trackId} RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id)
            SELECT file_id, ${later.id} FROM media_file_items WHERE media_item_id = ${trackId}`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, start_offset_ms, end_offset_ms, offset_source)
            SELECT file_id, ${segment.id}, 1000, 2000, 'chapter' FROM media_file_items WHERE media_item_id = ${trackId}`;
        const before = await associations();
        const segmentBefore =
            await sql`SELECT to_jsonb(mi) AS item FROM media_items mi WHERE id = ${segment.id}`;
        await scan();
        const [repaired] =
            await sql`SELECT title, title_source, custom_metadata->'title_source_verified' AS verified FROM media_items WHERE id = ${later.id}`;
        expect(repaired).toMatchObject({
            title: 'Actual Tag Title',
            title_source: 'tag',
            verified: true,
        });
        expect(await associations()).toEqual(before);
        expect([
            ...(await sql`SELECT to_jsonb(mi) AS item FROM media_items mi WHERE id = ${segment.id}`),
        ]).toEqual([...segmentBefore]);
        expect(processVideoFile).toHaveBeenCalledTimes(1);
        vi.clearAllMocks();
        await scan();
        expect(processVideoFile).not.toHaveBeenCalled();
        expect(parseAudioTags).not.toHaveBeenCalled();
    });

    it.each(['inactive', 'dismissed'] as const)(
        'does not promote an %s filename-source track',
        async (kind) => {
            await seed();
            if (kind === 'inactive')
                await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${trackId}`;
            else await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${trackId}`;
            const before =
                await sql`SELECT to_jsonb(mi) AS item FROM media_items mi WHERE id = ${trackId}`;
            expect(await findTrackFilesWithUnverifiedTitleSourceByPrefix(sql, root)).toEqual([]);
            await scan();
            expect(processVideoFile).not.toHaveBeenCalled();
            expect([
                ...(await sql`SELECT to_jsonb(mi) AS item FROM media_items mi WHERE id = ${trackId}`),
            ]).toEqual([...before]);
        },
    );

    it('processes one physical file once when another promotion reason overlaps', async () => {
        await seed();
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || '{"awaiting_provider_match":true}'::jsonb WHERE id = ${trackId}`;
        await scan();
        expect(processVideoFile).toHaveBeenCalledTimes(1);
        expect(await state()).toMatchObject({ title_source: 'tag', verified: true });
    });

    it('scopes candidates to tracks beneath the literal directory prefix, including legacy NULL metadata', async () => {
        await seed();
        await sql`UPDATE media_items SET custom_metadata = NULL WHERE id = ${trackId}`;
        const paths = [
            root + '-sibling/song.mp3',
            root.replace('_%_', 'XYZ') + '/song.mp3',
            root + '/movie.mp3',
        ];
        for (const [index, outsidePath] of paths.entries()) {
            const [item] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, title_source)
                VALUES ('Outside', ${index === 2 ? 'movie' : 'track'}, 'active', 'filename') RETURNING id`;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES (${outsidePath}) RETURNING id`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${item.id}, ${file.id})`;
        }
        expect(await findTrackFilesWithUnverifiedTitleSourceByPrefix(sql, root)).toEqual([
            filePath,
        ]);
        expect(await findTrackFilesWithUnverifiedTitleSourceByPrefix(sql, root + '/')).toEqual([
            filePath,
        ]);
        await sql`UPDATE media_items SET custom_metadata = '{"title_source_verified":true}'::jsonb WHERE id = ${trackId}`;
        expect(await findTrackFilesWithUnverifiedTitleSourceByPrefix(sql, root)).toEqual([]);
    });

    it('leaves an unavailable file unverified for a later scan', async () => {
        await seed();
        await rm(filePath);
        await scanForSync(libraryPath.id, { sql, logger });
        expect(processVideoFile).not.toHaveBeenCalled();
        expect(await state()).toMatchObject({ title_source: 'filename', verified: null });
        // The absent-file cleanup hold must not claim tag evidence.
    });

    it.each([false, true])(
        'does not repair track title provenance in a nonmusic library (chapters=%s)',
        async (scanChapters) => {
            await seed();
            await sql`UPDATE library_paths SET media_type = 'movie', scan_chapters = ${scanChapters} WHERE id = ${libraryPath.id}`;
            await scan();
            // d837af0836: chapter catch-up may independently promote the file. Neither
            // path may parse music tags or claim title provenance in a movie library.
            expect(processVideoFile).toHaveBeenCalledTimes(scanChapters ? 1 : 0);
            expect(parseAudioTags).not.toHaveBeenCalled();
            expect(await state()).toMatchObject({
                title: 'Plain Title',
                title_source: 'filename',
                verified: null,
            });
        },
    );
});
