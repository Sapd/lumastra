// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration test for the file-segment projection (migration 16.152.0).
 *
 * Seeds real combined-file shapes against the test DB and asserts the derived
 * windows land on media_file_items:
 *
 *   - a chapter-backed double (the Hafentage S02E24E25 shape) -> exact offsets
 *   - a runtime-only double                                -> proportional split
 *   - a two-parter whose runtimes claim the combined length -> even split
 *   - a file whose name declares no range                  -> NO offsets, ever
 *   - a plain single-episode file                          -> untouched
 *
 * Everything runs inside a transaction that is always rolled back, so the
 * shared lumastra_tests DB is left clean regardless of outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import {
    getEpisodeWindowsForFile,
    getMultiEpisodeFileGroups,
    rebuildAllFileSegments,
    refreshSegmentsForFile,
} from './file-segments.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const URL = getTestDatabaseUrl();

let sql: postgres.Sql;

beforeAll(() => {
    sql = postgres(URL, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
    await sql?.end();
});

interface SeededEpisode {
    id: string;
    episodeNumber: number;
}

async function seedSeries(tx: postgres.TransactionSql, suffix: string): Promise<string> {
    const [series] = (await tx`
        INSERT INTO media_items (title, media_type, status, has_files)
        VALUES (${`Segment Fixture Series ${suffix}`}, 'tv', 'active', true)
        RETURNING id
    `) as { id: string }[];
    const [season] = (await tx`
        INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
        VALUES ('Season 2', 'season', 'active', true, ${series.id}, 2)
        RETURNING id
    `) as { id: string }[];
    return season.id;
}

/** Attach one file to N episode rows — the shape a combined file produces. */
async function seedFile(
    tx: postgres.TransactionSql,
    seasonId: string,
    opts: {
        path: string;
        durationSeconds: number;
        episodes: { episodeNumber: number; runtimeSeconds: number | null }[];
        chapters?: { name: string; startSeconds: number }[];
    },
): Promise<{ fileId: string; episodes: SeededEpisode[] }> {
    const [file] = (await tx`
        INSERT INTO media_files (file_path, duration_seconds)
        VALUES (${opts.path}, ${opts.durationSeconds})
        RETURNING id
    `) as { id: string }[];

    const episodes: SeededEpisode[] = [];
    for (const ep of opts.episodes) {
        const [row] = (await tx`
            INSERT INTO media_items
                (title, media_type, status, has_files, parent_id, season_number, episode_number, runtime_seconds)
            VALUES (${`Episode ${ep.episodeNumber}`}, 'episode', 'active', true, ${seasonId}, 2,
                    ${ep.episodeNumber}, ${ep.runtimeSeconds})
            RETURNING id
        `) as { id: string }[];
        await tx`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}, ${row.id}, true)
        `;
        episodes.push({ id: row.id, episodeNumber: ep.episodeNumber });
    }

    for (const [index, chapter] of (opts.chapters ?? []).entries()) {
        await tx`
            INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
            VALUES (${file.id}, ${index}, ${chapter.name},
                    ${Math.round(chapter.startSeconds * 10_000_000)}, 'file')
        `;
    }

    return { fileId: file.id, episodes };
}

async function offsetsFor(
    tx: postgres.TransactionSql,
    fileId: string,
): Promise<
    {
        episode_number: number;
        start_offset_ms: string | null;
        end_offset_ms: string | null;
        offset_source: string | null;
    }[]
> {
    return (await tx`
        SELECT mi.episode_number, mfi.start_offset_ms, mfi.end_offset_ms, mfi.offset_source
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
        ORDER BY mi.episode_number
    `) as {
        episode_number: number;
        start_offset_ms: string | null;
        end_offset_ms: string | null;
        offset_source: string | null;
    }[];
}

class Rollback extends Error {}

/** Run body inside a transaction that is always rolled back. */
async function inRolledBackTx(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    try {
        await sql.begin(async (tx) => {
            await body(tx as postgres.TransactionSql);
            throw new Rollback();
        });
    } catch (err) {
        if (!(err instanceof Rollback)) throw err;
    }
}

describe('file segments projection', () => {
    it.each([
        { label: 'Folge', boundary: '600000', source: 'chapter' },
        { label: 'Episode', boundary: '900000', source: 'even-split' },
    ])(
        'preserves historical $label chapter boundaries on combined files',
        async ({ label, boundary, source }) => {
            await inRolledBackTx(async (tx) => {
                const seasonId = await seedSeries(tx, 'numbered-chapters');
                const { fileId } = await seedFile(tx, seasonId, {
                    path: `/tmp/fixture-${crypto.randomUUID()}/S02E01E02.mkv`,
                    durationSeconds: 1800,
                    episodes: [
                        { episodeNumber: 1, runtimeSeconds: null },
                        { episodeNumber: 2, runtimeSeconds: null },
                    ],
                    chapters: [
                        { name: `${label} 1`, startSeconds: 0 },
                        { name: `${label} 2`, startSeconds: 600 },
                    ],
                });
                await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);
                expect(await offsetsFor(tx, fileId)).toEqual([
                    {
                        episode_number: 1,
                        start_offset_ms: '0',
                        end_offset_ms: boundary,
                        offset_source: source,
                    },
                    {
                        episode_number: 2,
                        start_offset_ms: boundary,
                        end_offset_ms: '1800000',
                        offset_source: source,
                    },
                ]);
            });
        },
    );

    it('derives exact offsets for a chapter-backed double episode', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'chapters');
            const { fileId } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/S02E24E25.mkv`,
                durationSeconds: 1354.602,
                episodes: [
                    { episodeNumber: 24, runtimeSeconds: 660 },
                    { episodeNumber: 25, runtimeSeconds: 660 },
                ],
                chapters: [
                    { name: 'Opening', startSeconds: 0 },
                    { name: 'T.J. in Nöten', startSeconds: 61.603 },
                    { name: 'Petey, der Schulschreck', startSeconds: 692.275 },
                    { name: 'Credits', startSeconds: 1323.072 },
                ],
            });

            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);

            const rows = await offsetsFor(tx, fileId);
            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({
                episode_number: 24,
                start_offset_ms: '0',
                end_offset_ms: '692275',
                offset_source: 'chapter',
            });
            expect(rows[1]).toMatchObject({
                episode_number: 25,
                start_offset_ms: '692275',
                end_offset_ms: '1354602',
                offset_source: 'chapter',
            });
        });
    });

    it('falls back to a proportional runtime split when the file has no chapters', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'runtime');
            const { fileId } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/S02E10E11.mkv`,
                durationSeconds: 1354.602,
                episodes: [
                    { episodeNumber: 10, runtimeSeconds: 660 },
                    { episodeNumber: 11, runtimeSeconds: 660 },
                ],
            });

            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);

            const rows = await offsetsFor(tx, fileId);
            expect(rows[0].offset_source).toBe('runtime-split');
            expect(rows[0].start_offset_ms).toBe('0');
            expect(rows[1].end_offset_ms).toBe('1354602');
            // Gapless.
            expect(rows[1].start_offset_ms).toBe(rows[0].end_offset_ms);
        });
    });

    it('refuses a file whose name declares no episode range', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'noprovenance');
            // Two rows on a file whose name says nothing about holding several
            // episodes — the link did not come from a combined release, so there
            // is no honest place to put a boundary.
            const { fileId } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/some-recording.mkv`,
                durationSeconds: 2595,
                episodes: [
                    { episodeNumber: 1, runtimeSeconds: 1300 },
                    { episodeNumber: 2, runtimeSeconds: 1295 },
                ],
            });

            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);

            const rows = await offsetsFor(tx, fileId);
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                expect(row.start_offset_ms).toBeNull();
                expect(row.end_offset_ms).toBeNull();
                expect(row.offset_source).toBeNull();
            }
        });
    });

    it('splits a two-parter whose parts each claim the combined runtime', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'twoparter');
            // The "Luma - S06E17-18 - The End" shape: a 2595s file where TMDB
            // records ~2600s against BOTH halves. The release name is the truth;
            // an earlier runtime-based guard read this as a mis-link and refused.
            const { fileId } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/Show - S06E17-18 - The End.mkv`,
                durationSeconds: 2595,
                episodes: [
                    { episodeNumber: 17, runtimeSeconds: 2600 },
                    { episodeNumber: 18, runtimeSeconds: 2600 },
                ],
            });

            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);

            const rows = await offsetsFor(tx, fileId);
            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({
                start_offset_ms: '0',
                end_offset_ms: '1297500',
                offset_source: 'even-split',
            });
            expect(rows[1]).toMatchObject({
                start_offset_ms: '1297500',
                end_offset_ms: '2595000',
                offset_source: 'even-split',
            });
        });
    });

    it('leaves ordinary single-episode files alone', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'single');
            const { fileId } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/S02E01.mkv`,
                durationSeconds: 660,
                episodes: [{ episodeNumber: 1, runtimeSeconds: 660 }],
                chapters: [{ name: 'Opening', startSeconds: 0 }],
            });

            // Single-episode files are not even loaded as candidates...
            const groups = await getMultiEpisodeFileGroups(tx as unknown as postgres.Sql, fileId);
            expect(groups).toHaveLength(0);

            // ...and a refresh leaves them on whole-file playback.
            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);
            const rows = await offsetsFor(tx, fileId);
            expect(rows[0].start_offset_ms).toBeNull();
        });
    });

    it('clears stale offsets when a file stops qualifying', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'stale');
            const { fileId, episodes } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/S02E30E31.mkv`,
                durationSeconds: 1354.602,
                episodes: [
                    { episodeNumber: 30, runtimeSeconds: 660 },
                    { episodeNumber: 31, runtimeSeconds: 660 },
                ],
            });

            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);
            expect((await offsetsFor(tx, fileId))[0].start_offset_ms).toBe('0');

            // Detach the second episode: the file now backs a single episode and
            // must revert to whole-file playback rather than keep a half-file window.
            await tx`
                DELETE FROM media_file_items
                WHERE file_id = ${fileId} AND media_item_id = ${episodes[1].id}
            `;
            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);

            const rows = await offsetsFor(tx, fileId);
            expect(rows).toHaveLength(1);
            expect(rows[0].start_offset_ms).toBeNull();
            expect(rows[0].offset_source).toBeNull();
        });
    });

    it('getEpisodeWindowsForFile returns every episode on the file, ordered', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'windows');
            const { fileId, episodes } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/S02E24E25.mkv`,
                durationSeconds: 1354.602,
                episodes: [
                    { episodeNumber: 24, runtimeSeconds: 660 },
                    { episodeNumber: 25, runtimeSeconds: 660 },
                ],
                chapters: [
                    { name: 'Opening', startSeconds: 0 },
                    { name: 'T.J. in Nöten', startSeconds: 61.603 },
                    { name: 'Petey, der Schulschreck', startSeconds: 692.275 },
                    { name: 'Credits', startSeconds: 1323.072 },
                ],
            });
            await refreshSegmentsForFile(tx as unknown as postgres.Sql, fileId);

            // Asking about EITHER episode returns both — that is what lets a session
            // that opened episode 24 complete episode 25 from the same position.
            for (const anchor of episodes) {
                const windows = await getEpisodeWindowsForFile(
                    tx as unknown as postgres.Sql,
                    anchor.id,
                );
                expect(windows).toEqual([
                    { mediaItemId: episodes[0].id, startMs: 0, endMs: 692_275 },
                    { mediaItemId: episodes[1].id, startMs: 692_275, endMs: 1_354_602 },
                ]);
            }
        });
    });

    it('getEpisodeWindowsForFile returns nothing for an unsegmented file', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'nowindows');
            const { episodes } = await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/Show - S02E05 - Single.mkv`,
                durationSeconds: 660,
                episodes: [{ episodeNumber: 5, runtimeSeconds: 660 }],
            });

            // An ordinary episode has no window: the file IS the episode, so
            // completion stays on the existing maths.
            expect(
                await getEpisodeWindowsForFile(tx as unknown as postgres.Sql, episodes[0].id),
            ).toEqual([]);
        });
    });

    it('rebuildAllFileSegments reports what it segmented', async () => {
        await inRolledBackTx(async (tx) => {
            const seasonId = await seedSeries(tx, 'rebuild');
            await seedFile(tx, seasonId, {
                path: `/tmp/fixture-${crypto.randomUUID()}/Show - S02E40E41 - Double.mkv`,
                durationSeconds: 1354.602,
                episodes: [
                    { episodeNumber: 40, runtimeSeconds: 660 },
                    { episodeNumber: 41, runtimeSeconds: 660 },
                ],
            });

            const result = await rebuildAllFileSegments(tx as unknown as postgres.Sql);

            expect(result.filesConsidered).toBeGreaterThanOrEqual(1);
            expect(result.filesSegmented).toBeGreaterThanOrEqual(1);
            expect(result.bySource['runtime-split']).toBeGreaterThanOrEqual(1);
        });
    });
});
