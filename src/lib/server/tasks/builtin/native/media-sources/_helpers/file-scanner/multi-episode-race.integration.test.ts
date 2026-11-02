// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A range file (`Show S03E03E04.mkv`) and its own single-episode file
 * (`Show S03E04.mkv`) scanned at the same time must end with the single file
 * holding episode 4, whatever the order.
 *
 * Both processes ran the dedicated-file check before either had attached, so
 * the range file kept a link to episode 4 next to the dedicated file. The
 * per-episode advisory lock serialises the decision; a range file that already
 * holds such a link (from before the fix) is repaired when it is rescanned.
 *
 * Real scanner, real Postgres, real files and real ffprobe.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import type * as MediaItemsQueries from '../../../../../../database/queries/media-items.queries.js';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import {
    findRangeFilesMissingLinks,
    partitionSupersededRangeFiles,
} from './multi-episode-links.js';
import { loadMediaFilesByPrefix } from '../../../../../../database/queries/media-files.queries.js';
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    getScanProgress: async () => null,
    deleteScanProgress: async () => {},
    getAnyScanProgress: async () => null,
    getAggregateScanProgress: async () => null,
    getScanProgressByKey: async () => new Map(),
}));

// The window between a range file's dedicated-file check and its attach is a
// few milliseconds; a random pause before each episode lookup makes the other
// file's attach land inside it often enough to show the race on every run.
vi.mock('../../../../../../database/queries/media-items.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const findOrCreate = actual.findOrCreatePersonalEpisode as FindOrCreatePersonalEpisode;
    return {
        ...actual,
        findOrCreatePersonalEpisode: async (
            ...args: Parameters<FindOrCreatePersonalEpisode>
        ): ReturnType<FindOrCreatePersonalEpisode> => {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 80));
            return findOrCreate(...args);
        },
    };
});

type FindOrCreatePersonalEpisode = typeof MediaItemsQueries.findOrCreatePersonalEpisode;

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
/** Fresh rounds: the race only fires on some interleavings. */
const ROUNDS = 30;
const SLOW = 240_000;

describe('range file and its own single-episode file (real PG, real ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let season: string;
    let libraryPath: LibraryPathRow;
    let range: string;
    let single: string;
    const logger = {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
        debug: (): void => undefined,
    };
    let context: FileScannerContext;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger } as unknown as FileScannerContext;
    });
    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'episode-race-%'`;
        root = mkdtempSync(join(tmpdir(), 'episode-race-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`episode-race-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'tv', ${group.id}, true) RETURNING *`;
        libraryPath = lp;
        season = join(root, 'Show', 'Season 03');
        mkdirSync(season, { recursive: true });
        range = join(season, 'Show S03E03E04.mkv');
        single = join(season, 'Show S03E04.mkv');
        copyFileSync(FIXTURE, range);
        copyFileSync(FIXTURE, single);
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /** Episode number → the files linked to it, with their default flags. */
    async function linksByEpisode(): Promise<
        Map<number, Array<{ file_path: string; is_default: boolean }>>
    > {
        const rows = await sql<{ n: number; file_path: string; is_default: boolean }[]>`
            SELECT mi.episode_number AS n, mf.file_path, mfi.is_default
              FROM media_items mi
              JOIN media_file_items mfi ON mfi.media_item_id = mi.id
              JOIN media_files mf ON mf.id = mfi.file_id
             WHERE mi.media_type = 'episode'
             ORDER BY mi.episode_number, mf.file_path
        `;
        const out = new Map<number, Array<{ file_path: string; is_default: boolean }>>();
        for (const r of rows) {
            const list = out.get(r.n) ?? [];
            list.push({ file_path: r.file_path, is_default: r.is_default });
            out.set(r.n, list);
        }
        return out;
    }

    async function seedDoubleLink(opts: { offsetSource?: string }): Promise<void> {
        // The single file wins episode 4 in the usual way; the range file is
        // then scanned, yields episode 4 and links episode 3.
        await processVideoFile(sql, single, libraryPath, [], context);
        await processVideoFile(sql, range, libraryPath, [], context);
        // Re-create the state the race leaves behind: the range file also
        // holds episode 4 next to the dedicated file.
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, offset_source, start_offset_ms, end_offset_ms)
            SELECT rf.id, ep.id, false, ${opts.offsetSource ?? null},
                   ${opts.offsetSource ? 0 : null}, ${opts.offsetSource ? 682480 : null}
              FROM media_files rf, media_items ep
             WHERE rf.file_path = ${range}
               AND ep.media_type = 'episode' AND ep.episode_number = 4
        `;
    }

    it(
        'concurrent scans of the range file and its single file leave episode 4 on the single file',
        async () => {
            for (let round = 0; round < ROUNDS; round++) {
                await truncateTables(sql, TEST_TABLES.media);
                const order = round % 2 === 0 ? [range, single] : [single, range];
                await Promise.all(
                    order.map((p) => processVideoFile(sql, p, libraryPath, [], context)),
                );

                const links = await linksByEpisode();
                expect(links.get(4), `round ${round}: episode 4`).toEqual([
                    { file_path: single, is_default: true },
                ]);
                expect(links.get(3), `round ${round}: episode 3`).toEqual([
                    { file_path: range, is_default: true },
                ]);
                for (const [n, files] of links) {
                    expect(
                        files.filter((f) => f.is_default),
                        `round ${round}: episode ${n} default`,
                    ).toHaveLength(1);
                }
            }
        },
        SLOW,
    );

    it(
        'a scan repairs a range file that already holds a link next to the dedicated file',
        async () => {
            await seedDoubleLink({});
            expect(
                (await linksByEpisode())
                    .get(4)
                    ?.map((f) => f.file_path)
                    .sort(),
            ).toEqual([range, single].sort());

            // The full scan promotes the range file out of the unchanged set.
            const promoted = await findRangeFilesMissingLinks(sql, [range]);
            expect(promoted.has(range)).toBe(true);

            await processVideoFile(sql, range, libraryPath, [], context);

            const links = await linksByEpisode();
            expect(links.get(4)).toEqual([{ file_path: single, is_default: true }]);
            expect(links.get(3)).toEqual([{ file_path: range, is_default: true }]);
        },
        SLOW,
    );

    it.each([false, true])(
        'revalidates derived range windows only when catching up chapter evidence (chapters=%s)',
        async (scanChapters) => {
            await seedDoubleLink({ offsetSource: 'runtime-split' });
            // d837af0836: chapter catch-up recomputes derived windows. Isolate
            // the range-link guard here; manual protection is tested below.
            libraryPath.scan_chapters = scanChapters;

            const promoted = await findRangeFilesMissingLinks(sql, [range]);
            expect(promoted.has(range)).toBe(false);

            await processVideoFile(sql, range, libraryPath, [], context);

            const links = await linksByEpisode();
            expect(
                links
                    .get(4)
                    ?.map((f) => f.file_path)
                    .sort(),
            ).toEqual(scanChapters ? [single] : [range, single].sort());
            expect(links.get(3)?.map((f) => f.file_path)).toEqual([range]);
            const windows =
                await sql`SELECT mfi.offset_source, mfi.start_offset_ms::text, mfi.end_offset_ms::text
                FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id
                JOIN media_items ep ON ep.id = mfi.media_item_id
                WHERE mf.file_path = ${range} AND ep.episode_number = 4`;
            expect([...windows]).toEqual(
                scanChapters
                    ? []
                    : [
                          {
                              offset_source: 'runtime-split',
                              start_offset_ms: '0',
                              end_offset_ms: '682480',
                          },
                      ],
            );
        },
        SLOW,
    );

    it(
        'preserves manual range windows during chapter catch-up',
        async () => {
            // 428fee7403 / 16.430.0 separates manual ownership from boundary origin.
            await seedDoubleLink({ offsetSource: 'manual' });
            await sql`UPDATE media_file_items SET boundary_origin = 'manual'
            WHERE offset_source = 'manual'`;
            const before = await sql`SELECT to_jsonb(mfi) AS link FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id WHERE mf.file_path = ${range}
            ORDER BY mfi.media_item_id`;
            expect(await findRangeFilesMissingLinks(sql, [range])).toEqual(new Set());
            await processVideoFile(sql, range, libraryPath, [], context);
            expect([
                ...(await sql`SELECT to_jsonb(mfi) AS link FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id WHERE mf.file_path = ${range}
            ORDER BY mfi.media_item_id`),
            ]).toEqual([...before]);
            expect(
                (await linksByEpisode())
                    .get(4)
                    ?.map((file) => file.file_path)
                    .sort(),
            ).toEqual([range, single].sort());
        },
        SLOW,
    );

    it(
        'a range file whose every episode its single files take over records its stub, so the next scan skips it',
        async () => {
            const dir = join(root, 'Show', 'Season 01');
            mkdirSync(dir, { recursive: true });
            const combined = join(dir, 'Show S01E01E02.mkv');
            const first = join(dir, 'Show S01E01.mkv');
            const second = join(dir, 'Show S01E02.mkv');
            for (const p of [combined, first, second]) copyFileSync(FIXTURE, p);

            // The range file is seen first and takes both episodes.
            await processVideoFile(sql, combined, libraryPath, [], context);
            const before = await linksByEpisode();
            expect(before.get(1)?.map((f) => f.file_path)).toEqual([combined]);
            expect(before.get(2)?.map((f) => f.file_path)).toEqual([combined]);

            // Then each single file takes its episode; the second eviction
            // leaves the range file with no link at all.
            await processVideoFile(sql, first, libraryPath, [], context);
            await processVideoFile(sql, second, libraryPath, [], context);

            const [row] = await sql<
                {
                    is_linked: boolean;
                    health_issues: Array<{ type: string; superseded_by?: string[] }> | null;
                    file_mtime: Date | null;
                    file_size_bytes: number | string | null;
                }[]
            >`
                SELECT EXISTS (
                           SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id
                       ) AS is_linked,
                       mf.health_issues, mf.file_mtime, mf.file_size_bytes
                  FROM media_files mf
                 WHERE mf.file_path = ${combined}
            `;
            expect(row.is_linked).toBe(false);
            const issue = row.health_issues?.find((i) => i.type === 'range_superseded');
            expect(issue?.superseded_by?.slice().sort()).toEqual([first, second].sort());
            expect(row.file_mtime).not.toBeNull();
            expect(row.file_size_bytes).not.toBeNull();

            // The next full scan walks the same files: the range file is
            // partitioned as superseded and is not handed to processVideoFile.
            const known = await loadMediaFilesByPrefix(sql, root);
            const walked = new Set([combined, first, second]);
            const partition = await partitionSupersededRangeFiles([combined], known, walked, sql);
            expect(partition.superseded).toEqual([combined]);
            expect(partition.process).toEqual([]);
        },
        SLOW,
    );
});
