// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watch Status Query Module
 *
 * Tests episode/movie watch status operations, bulk unnest operations, and convenience methods.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    insertTestEpisodeWatchStatus,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test (write functions removed — now in WatchManager)
import {
    getSeriesEpisodesWithWatchStatus,
    getSeasonEpisodesWithWatchStatus,
    getSeriesEpisodes,
    getSeasonEpisodes,
    getSeriesEpisodeIds,
    getSeasonEpisodeIds,
} from './watch-status.queries.js';

describe('Watch Status Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
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

    // ==========================================================================
    // Episode Watch Status - Read Queries
    // ==========================================================================

    describe('getSeriesEpisodesWithWatchStatus', () => {
        it('returns all episodes with watch status for a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 5,
            });
            const userId = generateTestUserId();

            // Mark some episodes as watched
            const season1Episodes = series.seasons[0].episodes;
            await insertTestEpisodeWatchStatus(sql, userId, season1Episodes[0].jellyfin_id, {
                isWatched: true,
            });
            await insertTestEpisodeWatchStatus(sql, userId, season1Episodes[1].jellyfin_id, {
                isWatched: true,
            });

            const result = await getSeriesEpisodesWithWatchStatus.all(sql, {
                seriesId: series.seriesId,
                userId,
            });

            expect(result.length).toBe(10); // 2 seasons × 5 episodes
            const watchedEpisodes = result.filter((e) => e.is_watched);
            expect(watchedEpisodes.length).toBe(2);
        });

        it('returns episodes ordered by season and episode number', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 3,
            });
            const userId = generateTestUserId();

            const result = await getSeriesEpisodesWithWatchStatus.all(sql, {
                seriesId: series.seriesId,
                userId,
            });

            // Verify ordering
            expect(result[0].season_number).toBe(1);
            expect(result[0].episode_number).toBe(1);
            expect(result[3].season_number).toBe(2);
            expect(result[3].episode_number).toBe(1);
        });

        it('includes runtime_ms for each episode', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
                episodeRuntimeSeconds: 2700, // 45 min
            });
            const userId = generateTestUserId();

            const result = await getSeriesEpisodesWithWatchStatus.all(sql, {
                seriesId: series.seriesId,
                userId,
            });

            expect(Number(result[0].runtime_ms)).toBe(2700 * 1000);
        });
    });

    describe('getSeasonEpisodesWithWatchStatus', () => {
        it('returns episodes for a specific season only', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 3,
                episodesPerSeason: 4,
            });
            const userId = generateTestUserId();

            const result = await getSeasonEpisodesWithWatchStatus.all(sql, {
                seriesId: series.seriesId,
                seasonNumber: 2,
                userId,
            });

            expect(result.length).toBe(4);
            result.forEach((e) => {
                expect(e.season_number).toBe(2);
            });
        });
    });

    // Write query tests removed — functions consolidated into WatchManager

    // ==========================================================================
    // Episodes Lookup
    // ==========================================================================

    describe('getSeriesEpisodes', () => {
        it('returns all episodes for a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 6,
            });

            const result = await getSeriesEpisodes.all(sql, {
                seriesId: series.seriesId,
            });

            expect(result.length).toBe(12);
        });
    });

    describe('getSeasonEpisodes', () => {
        it('returns episodes for a specific season', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 3,
                episodesPerSeason: 4,
            });

            const result = await getSeasonEpisodes.all(sql, {
                seriesId: series.seriesId,
                seasonNumber: 2,
            });

            expect(result.length).toBe(4);
        });
    });

    describe('getSeriesEpisodeIds', () => {
        it('returns only episode IDs (lightweight)', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 5,
            });

            const ids = await getSeriesEpisodeIds(sql, series.seriesId);

            expect(ids.length).toBe(5);
            expect(typeof ids[0]).toBe('string');
        });
    });

    describe('getSeasonEpisodeIds', () => {
        it('returns episode IDs for a specific season', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 4,
            });

            const ids = await getSeasonEpisodeIds(sql, series.seriesId, 1);

            expect(ids.length).toBe(4);
        });
    });
});
