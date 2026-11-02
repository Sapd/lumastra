// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Episode Chapters Query Module
 *
 * Tests chapter CRUD and existence checks for episodes, files, and series.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getChaptersForEpisode,
    getChaptersForFile,
    getChaptersForSeries,
    upsertChaptersForFile,
    hasChaptersForFile,
    hasChapters,
    countEpisodesWithChapters,
    canUploadChaptersForFile,
} from './episode-chapters.queries.js';
import { MediaChaptersResponseSchema } from '../../../schemas/api-media-responses.js';
import { AdminChaptersResponseSchema } from '../../../schemas/api-admin-responses.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

/** Queries retain database ticks; admin response serialization exposes milliseconds. */
function toWireChapters(chapters: { start_ticks: number; end_ticks: number | null }[]) {
    return chapters.map(({ start_ticks, end_ticks, ...row }) => ({
        ...row,
        startMs: Math.round(start_ticks / 10_000),
        endMs: end_ticks === null ? null : Math.round(end_ticks / 10_000),
    }));
}

describe('Episode Chapters Queries', () => {
    let sql: postgres.Sql;
    let seriesId: string;
    let seasonId: string;
    let episodeId: string;
    let fileId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'episode_chapters',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'episode_chapters',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);

        seriesId = crypto.randomUUID();
        seasonId = crypto.randomUUID();
        episodeId = crypto.randomUUID();
        fileId = crypto.randomUUID();

        // Insert series -> season -> episode hierarchy
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${seriesId}::uuid, ${'Test Series'}, 'tv', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
            VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
            VALUES (${episodeId}::uuid, ${'Episode 1'}, 'episode', ${seasonId}::uuid, 1, 1, 'active')
        `;

        // Insert media file and link to episode
        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (${fileId}::uuid, ${'/test/episode.mkv'}, NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileId}::uuid, ${episodeId}::uuid, true)
        `;
    });

    // ========================================================================
    // upsertChaptersForFile
    // ========================================================================

    describe('upsertChaptersForFile', () => {
        it('allows explicit replacement and clearing of uploads while protecting manual markers', async () => {
            const chapter = {
                chapterIndex: 0,
                chapterName: 'Lantern Crossing',
                startTicks: '100000',
                endTicks: null,
                source: 'upload',
            };
            await upsertChaptersForFile(sql, fileId, [chapter]);
            expect(await canUploadChaptersForFile(sql, fileId)).toBe(true);
            await upsertChaptersForFile(sql, fileId, [], { allowUploadReplacement: true });
            expect(await getChaptersForFile(sql, fileId)).toEqual([]);
            await upsertChaptersForFile(sql, fileId, [{ ...chapter, source: 'manual' }]);
            expect(await canUploadChaptersForFile(sql, fileId)).toBe(false);
            await upsertChaptersForFile(sql, fileId, [chapter], { allowUploadReplacement: true });
            expect((await getChaptersForFile(sql, fileId))[0].source).toBe('manual');
        });
        it('inserts chapters for a file', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'Intro',
                    startTicks: '0',
                    endTicks: '10000000',
                    source: 'test',
                },
                {
                    chapterIndex: 1,
                    chapterName: 'Main',
                    startTicks: '10000000',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForFile(sql, fileId);
            expect(rows.length).toBe(2);
            expect(rows[0].chapter_name).toBe('Intro');
            expect(rows[1].chapter_name).toBe('Main');
        });

        it('replaces existing chapters on subsequent call', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'Old',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'New',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForFile(sql, fileId);
            expect(rows.length).toBe(1);
            expect(rows[0].chapter_name).toBe('New');
        });

        it('returns early for empty chapters array', async () => {
            await expect(upsertChaptersForFile(sql, fileId, [])).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // getChaptersForEpisode
    // ========================================================================

    describe('getChaptersForEpisode', () => {
        it('returns chapters for the default file of an episode', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'Intro',
                    startTicks: '0',
                    endTicks: '10000000',
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForEpisode(sql, episodeId);
            expect(rows.length).toBe(1);
            expect(rows[0].chapter_name).toBe('Intro');
        });

        it('returns empty array when episode has no chapters', async () => {
            const rows = await getChaptersForEpisode(sql, episodeId);
            expect(rows).toEqual([]);
        });

        it('orders results by chapter_index', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 2,
                    chapterName: 'Third',
                    startTicks: '20000000',
                    endTicks: null,
                    source: 'test',
                },
                {
                    chapterIndex: 0,
                    chapterName: 'First',
                    startTicks: '0',
                    endTicks: '10000000',
                    source: 'test',
                },
                {
                    chapterIndex: 1,
                    chapterName: 'Second',
                    startTicks: '10000000',
                    endTicks: '20000000',
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForEpisode(sql, episodeId);
            expect(rows.map((r) => r.chapter_name)).toEqual(['First', 'Second', 'Third']);
        });
    });

    // ========================================================================
    // getChaptersForFile
    // ========================================================================

    describe('getChaptersForFile', () => {
        it('returns chapters for a file without mediaItemId', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'A',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForFile(sql, fileId);
            expect(rows.length).toBe(1);
        });

        it('verifies file belongs to mediaItemId when provided', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'A',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForFile(sql, fileId, episodeId);
            expect(rows.length).toBe(1);
        });

        it('returns empty when file does not belong to mediaItemId', async () => {
            const otherEpisodeId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${otherEpisodeId}::uuid, ${'Other Ep'}, 'episode', 'active')
            `;

            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'A',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForFile(sql, fileId, otherEpisodeId);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getChaptersForSeries
    // ========================================================================

    describe('getChaptersForSeries', () => {
        it('returns chapters for all episodes of a series', async () => {
            const ep2Id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${ep2Id}::uuid, ${'Episode 2'}, 'episode', ${seasonId}::uuid, 1, 2, 'active')
            `;

            const file2Id = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${file2Id}::uuid, ${'/test/ep2.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${file2Id}::uuid, ${ep2Id}::uuid, true)
            `;

            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'Ep1Ch1',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);
            await upsertChaptersForFile(sql, file2Id, [
                {
                    chapterIndex: 0,
                    chapterName: 'Ep2Ch1',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            const rows = await getChaptersForSeries(sql, seriesId);
            expect(rows.length).toBe(2);
            const names = rows.map((r) => r.chapter_name);
            expect(names).toContain('Ep1Ch1');
            expect(names).toContain('Ep2Ch1');
        });

        it('returns empty array when series has no chapters', async () => {
            const rows = await getChaptersForSeries(sql, seriesId);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // hasChaptersForFile
    // ========================================================================

    describe('hasChaptersForFile', () => {
        it('returns true when file has chapters', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'A',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            expect(await hasChaptersForFile(sql, fileId)).toBe(true);
        });

        it('returns false when file has no chapters', async () => {
            expect(await hasChaptersForFile(sql, fileId)).toBe(false);
        });
    });

    // ========================================================================
    // hasChapters
    // ========================================================================

    describe('hasChapters', () => {
        it('returns true when episode has chapters', async () => {
            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'A',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);

            expect(await hasChapters(sql, episodeId)).toBe(true);
        });

        it('returns false when episode has no chapters', async () => {
            expect(await hasChapters(sql, episodeId)).toBe(false);
        });
    });

    // ========================================================================
    // countEpisodesWithChapters
    // ========================================================================

    describe('countEpisodesWithChapters', () => {
        it('counts episodes with chapters in a series', async () => {
            const ep2Id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${ep2Id}::uuid, ${'Episode 2'}, 'episode', ${seasonId}::uuid, 1, 2, 'active')
            `;

            const file2Id = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${file2Id}::uuid, ${'/test/ep2.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${file2Id}::uuid, ${ep2Id}::uuid, true)
            `;

            await upsertChaptersForFile(sql, fileId, [
                {
                    chapterIndex: 0,
                    chapterName: 'Ep1Ch1',
                    startTicks: '0',
                    endTicks: null,
                    source: 'test',
                },
            ]);
            // ep2 has no chapters

            const count = await countEpisodesWithChapters(sql, seriesId);
            expect(count).toBe(1);
        });

        it('returns 0 when no episodes have chapters', async () => {
            const count = await countEpisodesWithChapters(sql, seriesId);
            expect(count).toBe(0);
        });
    });
    // ========================================================================
    // Response-schema contract
    //
    // Regression: GET /api/admin/media/{id}/chapters (and the v1 twin) parse
    // every row through MediaChaptersResponseSchema, whose `media_item_id` is
    // `.nullable()` — which accepts null but NOT undefined. The non-series
    // paths used to `SELECT ec.*` / `SELECT *`, so the key was absent entirely
    // and `.parse()` threw an unhandled 500 for any item that actually HAS
    // chapters. Empty results and the series path (which projects
    // `mfi.media_item_id` explicitly) both parsed fine, which masked it.
    // ========================================================================

    describe('response-schema contract', () => {
        const CHAPTERS = [
            {
                chapterIndex: 0,
                chapterName: 'Intro',
                startTicks: '0',
                endTicks: '10000000',
                source: 'test',
            },
            {
                chapterIndex: 1,
                chapterName: 'Main',
                startTicks: '10000000',
                endTicks: null,
                source: 'test',
            },
        ];

        it('getChaptersForEpisode rows satisfy MediaChaptersResponseSchema', async () => {
            await upsertChaptersForFile(sql, fileId, CHAPTERS);

            const chapters = await getChaptersForEpisode(sql, episodeId);
            expect(chapters.length).toBe(2);

            // Asserted before the field check: this is the exact call that threw
            // the unhandled 500 in the admin/v1 handlers.
            expect(() =>
                MediaChaptersResponseSchema.parse({
                    chapters: toWireChapters(chapters),
                    episodesWithChapters: 1,
                }),
            ).not.toThrow();
            expect(chapters[0].media_item_id).toBe(episodeId);
        });

        it('reads start_ticks/end_ticks as NUMBERS, and the admin client schema accepts them', async () => {
            // upsertChaptersForFile WRITES these as strings, which is what made
            // the string-typed schemas look plausible. The read side does not
            // agree: `start_ticks`/`end_ticks` are bigint, and connection.ts
            // registers a bigint (OID 20) parser returning Number(x). Assert the
            // DRIVER's behaviour here rather than trusting either schema — this
            // is the belief that code and schema were wrong about together.
            await upsertChaptersForFile(sql, fileId, CHAPTERS);

            const chapters = await getChaptersForEpisode(sql, episodeId);

            expect(typeof chapters[0].start_ticks).toBe('number');
            expect(chapters[0].start_ticks).toBe(0);
            expect(chapters[0].end_ticks).toBe(10_000_000);
            expect(chapters[1].end_ticks).toBeNull();

            // AdminChaptersResponseSchema gates this SAME body on the client
            // (getMediaChapters in $lib/api/admin). It used to be a hand-written
            // copy declaring start_ticks: z.string() / end_ticks:
            // z.string().nullable() and media_item_id non-nullable, so every real
            // row failed it — invisibly, because apiFetch is fail-open.
            expect(() =>
                AdminChaptersResponseSchema.parse({
                    chapters: toWireChapters(chapters),
                    episodesWithChapters: 1,
                }),
            ).not.toThrow();
        });

        it('getChaptersForFile rows satisfy the schema on the ownership-JOIN branch', async () => {
            await upsertChaptersForFile(sql, fileId, CHAPTERS);

            const chapters = await getChaptersForFile(sql, fileId, episodeId);
            expect(chapters.length).toBe(2);
            expect(chapters[0].media_item_id).toBe(episodeId);

            expect(() =>
                MediaChaptersResponseSchema.parse({
                    chapters: toWireChapters(chapters),
                    episodesWithChapters: 1,
                }),
            ).not.toThrow();
        });

        it('getChaptersForFile rows satisfy the schema on the bare branch', async () => {
            await upsertChaptersForFile(sql, fileId, CHAPTERS);

            const chapters = await getChaptersForFile(sql, fileId);
            expect(chapters.length).toBe(2);
            expect(chapters[0].media_item_id).toBe(episodeId);

            expect(() =>
                MediaChaptersResponseSchema.parse({
                    chapters: toWireChapters(chapters),
                    episodesWithChapters: 1,
                }),
            ).not.toThrow();
        });

        it('leaves media_item_id null on the bare branch when the file is unlinked', async () => {
            const orphanFileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${orphanFileId}::uuid, ${'/test/orphan.mkv'}, NOW(), NOW())
            `;
            await upsertChaptersForFile(sql, orphanFileId, CHAPTERS);

            const chapters = await getChaptersForFile(sql, orphanFileId);
            expect(chapters.length).toBe(2);
            expect(chapters[0].media_item_id).toBeNull();

            expect(() =>
                MediaChaptersResponseSchema.parse({
                    chapters: toWireChapters(chapters),
                    episodesWithChapters: 1,
                }),
            ).not.toThrow();
        });

        it('does not multiply rows when one file is linked to several media items', async () => {
            // Split-episode shape: media_file_items PK is (file_id, media_item_id),
            // so a plain JOIN on file_id would return each chapter once per link.
            const ep2Id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${ep2Id}::uuid, ${'Episode 2'}, 'episode', ${seasonId}::uuid, 1, 2, 'active')
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${fileId}::uuid, ${ep2Id}::uuid, true, 1)
            `;
            await upsertChaptersForFile(sql, fileId, CHAPTERS);

            const chapters = await getChaptersForFile(sql, fileId);
            expect(chapters.length).toBe(2);
            expect(chapters.map((c) => c.chapter_index)).toEqual([0, 1]);
        });

        it('returns bigint tick columns as numbers, as the schema declares', async () => {
            await upsertChaptersForFile(sql, fileId, CHAPTERS);

            const chapters = await getChaptersForEpisode(sql, episodeId);
            expect(typeof chapters[0].start_ticks).toBe('number');
            expect(chapters[0].start_ticks).toBe(0);
            expect(typeof chapters[0].end_ticks).toBe('number');
            expect(chapters[0].end_ticks).toBe(10000000);
            expect(chapters[1].end_ticks).toBeNull();
        });
    });
});
