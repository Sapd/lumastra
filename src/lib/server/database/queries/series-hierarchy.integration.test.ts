// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Series -> Season -> Episode Hierarchy
 *
 * This test file verifies that queries correctly handle the media_items hierarchy:
 * - series (media_type = 'tv', parent_id = null)
 * - season (media_type = 'season', parent_id = series.id)
 * - episode (media_type = 'episode', parent_id = season.id)
 *
 * These tests ensure that queries properly join through seasons when querying
 * episodes for a series, rather than assuming episodes are direct children of series.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    createAndInsertTestTvShow,
} from '../../../../../tests/integration/fixtures/index.js';

describe('Series Hierarchy (Integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.watchStatus,
            ...TEST_TABLES.jellyfinContent,
        ]);
    });

    // =============================================================================
    // Helper: Query episodes for a series using the correct pattern
    // =============================================================================

    async function countEpisodesUnderSeries(seriesId: string): Promise<number> {
        const [result] = await sql<{ count: string }[]>`
            SELECT COUNT(*) as count
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            WHERE season.parent_id = ${seriesId} AND mi.media_type = 'episode'
        `;
        return Number(result?.count ?? 0);
    }

    // =============================================================================
    // Tests: Verify queries work with proper hierarchy (episodes under seasons)
    // =============================================================================

    describe('proper hierarchy: episodes under seasons', () => {
        it('createAndInsertTestSeries creates proper hierarchy', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Test Series',
                tmdbId: 999999,
                seasonCount: 2,
                episodesPerSeason: 3,
            });

            // Verify series exists with correct type
            const [seriesItem] = await sql<{ id: string; media_type: string }[]>`
                SELECT id, media_type FROM media_items WHERE id = ${series.seriesId}
            `;
            expect(seriesItem).toBeDefined();
            expect(seriesItem.media_type).toBe('tv');

            // Verify seasons are children of series
            const seasons = await sql<{ id: string; media_type: string; parent_id: string }[]>`
                SELECT id, media_type, parent_id FROM media_items
                WHERE parent_id = ${series.seriesId} AND media_type = 'season'
            `;
            expect(seasons).toHaveLength(2);

            // Verify NO episodes are directly under series (this would be wrong)
            const directEpisodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${series.seriesId} AND media_type = 'episode'
            `;
            expect(directEpisodes).toHaveLength(0);

            // Verify episodes exist under seasons
            const episodeCount = await countEpisodesUnderSeries(series.seriesId);
            expect(episodeCount).toBe(6); // 2 seasons x 3 episodes
        });

        it('counts episodes correctly using season join', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Chapter Test Series',
                tmdbId: 999998,
                seasonCount: 2,
                episodesPerSeason: 2,
            });

            const count = await countEpisodesUnderSeries(series.seriesId);
            expect(count).toBe(4);
        });

        it('counts episodes in specific season correctly', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Multi Season Series',
                tmdbId: 999997,
                seasonCount: 2,
                episodesPerSeason: 3,
            });

            // Get season 1 episode count via join
            const [result] = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count
                FROM media_items mi
                JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
                WHERE season.parent_id = ${series.seriesId}
                  AND mi.media_type = 'episode'
                  AND mi.season_number = 1
            `;
            expect(Number(result?.count)).toBe(3);
        });
    });

    // =============================================================================
    // Tests: Verify wrong hierarchy (episodes directly under series) produces 0
    // =============================================================================

    describe('wrong hierarchy: episodes directly under series', () => {
        it('returns 0 when episodes are directly under series', async () => {
            // Create series
            const { id: seriesId } = await createAndInsertTestTvShow(sql, {
                title: 'Wrong Hierarchy Series',
                tmdbId: 999996,
            });

            // Create episodes directly under series (WRONG - should be under seasons)
            for (let i = 1; i <= 3; i++) {
                const epId = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items
                        (id, title, media_type, parent_id, season_number, episode_number)
                    VALUES
                        (${epId}::uuid, ${`Episode ${i}`}, 'episode', ${seriesId}::uuid, 1, ${i})
                `;
            }

            // Count using correct pattern should return 0
            const count = await countEpisodesUnderSeries(seriesId);
            expect(count).toBe(0);
        });

        it('verify wrong hierarchy structure in database', async () => {
            // Create series
            const { id: seriesId } = await createAndInsertTestTvShow(sql, {
                title: 'Verify Wrong Hierarchy',
                tmdbId: 999995,
            });

            // Insert episode directly under series (wrong)
            const epId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items
                    (id, title, media_type, parent_id, season_number, episode_number)
                VALUES
                    (${epId}::uuid, 'Episode 1', 'episode', ${seriesId}::uuid, 1, 1)
            `;

            // Verify episode is directly under series
            const [episode] = await sql<{ parent_id: string }[]>`
                SELECT parent_id FROM media_items WHERE id = ${epId}
            `;
            expect(episode.parent_id).toBe(seriesId);

            // Verify NO seasons exist
            const seasons = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seriesId} AND media_type = 'season'
            `;
            expect(seasons).toHaveLength(0);

            // The wrong-pattern query would find 1, correct pattern finds 0
            const [wrongCount] = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count
                FROM media_items
                WHERE parent_id = ${seriesId} AND media_type = 'episode'
            `;
            expect(Number(wrongCount?.count)).toBe(1);
        });
    });
});
