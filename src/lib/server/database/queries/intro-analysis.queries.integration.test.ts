// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Intro Analysis Query Module
 *
 * Tests episode file lookups, unanalyzed season detection, and
 * media item info queries for the intro analyzer plugin.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestSeries } from '../../../../../tests/integration/fixtures/index.js';

import {
    getEpisodesWithFilesForSeason,
    getUnanalyzedSeasons,
    getFilePathForItem,
    getMediaItemInfo,
} from './intro-analysis.queries.js';

describe('Intro Analysis Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_segments',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);
    });

    // ========================================================================
    // getEpisodesWithFilesForSeason
    // ========================================================================

    describe('getEpisodesWithFilesForSeason', () => {
        it('returns episodes with file paths for a season', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            // Get season ID from episodes
            const episodeRows = await sql<{ parent_id: string }[]>`
                SELECT parent_id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items WHERE parent_id = ${series.seriesId}
                  )
                LIMIT 1
            `;
            const seasonId = episodeRows[0].parent_id;

            // Insert files for episodes
            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seasonId} AND media_type = 'episode'
            `;
            for (let i = 0; i < episodes.length; i++) {
                const ep = episodes[i];
                const [fileRow] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, duration_seconds)
                    VALUES (${`/series/s01e0${i + 1}.mkv`}, 2700)
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileRow.id}::uuid, ${ep.id}::uuid)
                `;
            }

            const result = await getEpisodesWithFilesForSeason(sql, seasonId);
            expect(result.length).toBe(2);
            expect(result[0]).toHaveProperty('episodeId');
            expect(result[0]).toHaveProperty('filePath');
            expect(result[0]).toHaveProperty('durationSeconds');
        });

        it('returns empty array for season with no episodes', async () => {
            const seasonId = crypto.randomUUID();
            // Create a season with no episodes
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${seasonId}::uuid, 'Empty Season', 'season', 'active')
            `;

            const result = await getEpisodesWithFilesForSeason(sql, seasonId);
            expect(result).toEqual([]);
        });

        it('picks the default file version, not an arbitrary linked one', async () => {
            // Regression: DISTINCT ON tie-broke on mf.part_number, which is NULL for
            // every plain file — so the winner was arbitrary. An episode range-linked
            // to a combined file could get that file's path and duration instead of
            // its own, and the analyzer then wrote intro/outro offsets belonging to a
            // completely different video.
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [{ id: seasonId }] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'season' AND parent_id = ${series.seriesId}
            `;
            const [episode] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seasonId} AND media_type = 'episode'
            `;

            const [combined] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/series/S06E01E03-combined.mkv', 344)
                RETURNING id
            `;
            const [own] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/series/S06E02-own.mkv', 632)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${combined.id}::uuid, ${episode.id}::uuid, false),
                       (${own.id}::uuid, ${episode.id}::uuid, true)
            `;

            const result = await getEpisodesWithFilesForSeason(sql, seasonId);
            expect(result.length).toBe(1);
            expect(result[0].filePath).toBe('/series/S06E02-own.mkv');
            expect(result[0].durationSeconds).toBe(632);
        });
    });

    // ========================================================================
    // getUnanalyzedSeasons
    // ========================================================================

    describe('getUnanalyzedSeasons', () => {
        it('returns seasons with unanalyzed episodes', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });

            // Get season ID
            const seasonRows = await sql<{ id: string; parent_id: string }[]>`
                SELECT id, parent_id FROM media_items
                WHERE media_type = 'season' AND parent_id = ${series.seriesId}
            `;
            const seasonId = seasonRows[0].id;

            // Insert files for episodes (required by query)
            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seasonId} AND media_type = 'episode'
            `;
            for (let i = 0; i < episodes.length; i++) {
                const ep = episodes[i];
                const [fileRow] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path)
                    VALUES (${`/series/episode-${i + 1}.mkv`})
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileRow.id}::uuid, ${ep.id}::uuid)
                `;
            }

            // No segments yet, so all episodes are unanalyzed
            const result = await getUnanalyzedSeasons(sql, 'lumastra-intro', 10);
            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('seasonId');
            expect(result[0]).toHaveProperty('seriesId');
            expect(result[0]).toHaveProperty('episodeCount');
        });

        it('excludes seasons where all episodes have segments for the source', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const seasonRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'season' AND parent_id = ${series.seriesId}
            `;
            const seasonId = seasonRows[0].id;

            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seasonId} AND media_type = 'episode'
            `;
            let fileCounter = 0;
            for (const ep of episodes) {
                const [fileRow] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path)
                    VALUES (${`/series/episode-${++fileCounter}.mkv`})
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileRow.id}::uuid, ${ep.id}::uuid)
                `;

                // Insert segment for EVERY episode with this source
                await sql`
                    INSERT INTO media_segments (media_id, source, type, start_time, end_time)
                    VALUES (${ep.id}::uuid, 'lumastra-intro', 'Intro', 0, 30)
                `;
            }

            const result = await getUnanalyzedSeasons(sql, 'lumastra-intro', 10);
            const found = result.find((r) => r.seasonId === seasonId);
            expect(found).toBeUndefined();
        });

        it('returns empty array when no seasons have >= 2 episodes', async () => {
            const result = await getUnanalyzedSeasons(sql, 'lumastra-intro', 10);
            // May contain other test data, but should not error
            expect(Array.isArray(result)).toBe(true);
        });
    });

    // ========================================================================
    // getFilePathForItem
    // ========================================================================

    describe('getFilePathForItem', () => {
        it('returns file path for media item', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });

            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items WHERE parent_id = ${series.seriesId}
                  )
            `;
            const episodeId = episodes[0].id;

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/episodes/test.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${episodeId}::uuid)
            `;

            const result = await getFilePathForItem(sql, episodeId);
            expect(result).toBe('/episodes/test.mkv');
        });

        it('returns null when no file exists', async () => {
            const result = await getFilePathForItem(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('prefers the default file version over other linked versions', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episode] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items WHERE parent_id = ${series.seriesId}
                  )
            `;

            const [combined] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/episodes/combined.mkv', 344)
                RETURNING id
            `;
            const [own] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/episodes/own.mkv', 632)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${combined.id}::uuid, ${episode.id}::uuid, false),
                       (${own.id}::uuid, ${episode.id}::uuid, true)
            `;

            const result = await getFilePathForItem(sql, episode.id);
            expect(result).toBe('/episodes/own.mkv');
        });
    });

    // ========================================================================
    // getMediaItemInfo
    // ========================================================================

    describe('getMediaItemInfo', () => {
        it('returns media item info with duration', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });

            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items WHERE parent_id = ${series.seriesId}
                  )
            `;
            const episodeId = episodes[0].id;

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/episodes/test.mkv', 3600)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${episodeId}::uuid)
            `;

            const result = await getMediaItemInfo(sql, episodeId);
            expect(result).not.toBeNull();
            expect(result!.mediaType).toBe('episode');
            expect(result!.durationSeconds).toBe(3600);
        });

        it('returns null for non-existent item', async () => {
            const result = await getMediaItemInfo(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('reports the default file version duration, not an arbitrary one', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episode] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items WHERE parent_id = ${series.seriesId}
                  )
            `;

            const [combined] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/episodes/combined-dur.mkv', 344)
                RETURNING id
            `;
            const [own] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/episodes/own-dur.mkv', 632)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${combined.id}::uuid, ${episode.id}::uuid, false),
                       (${own.id}::uuid, ${episode.id}::uuid, true)
            `;

            const result = await getMediaItemInfo(sql, episode.id);
            expect(result!.durationSeconds).toBe(632);
        });

        it('returns info without duration when no file linked', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });

            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items WHERE parent_id = ${series.seriesId}
                  )
            `;
            const episodeId = episodes[0].id;

            const result = await getMediaItemInfo(sql, episodeId);
            expect(result).not.toBeNull();
            expect(result!.mediaType).toBe('episode');
            expect(result!.durationSeconds).toBeNull();
        });
    });
});
