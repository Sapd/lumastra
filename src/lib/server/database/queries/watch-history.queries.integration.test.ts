// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watch History Query Module
 *
 * Tests trending calculations, timeframe filters, user stats, and analytics queries.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createTestWatchHistoryEntry,
    createTrendingWatchHistoryBatch,
    insertTestWatchHistoryEntry,
    insertTestWatchHistoryEntries,
    generateTestUserId,
    createAndInsertTestSeries,
} from '../../../../../tests/integration/fixtures/index.js';
import { randomUUID } from 'node:crypto';

// Import query functions to test
import {
    timeframeToInterval,
    timeframeToDays,
    getMediaWatchStats,
    getMediaWatchStatsInTimeframe,
    getTrendingMedia,
    getTrendingMovies,
    getTrendingEpisodes,
    getMediaViewers,
    getUserRecentWatchActivity,
    getRecentActivity,
    getUserWatchStats,
    getUserWatchStatsInTimeframe,
    getUserWatchCount,
    getPlaybackQualityStats,
    getTranscodingPercentage,
    getUsersWhoWatched,
} from './watch-history.queries.js';

describe('Viewing Sessions Queries', () => {
    let sql: postgres.Sql;

    // Pre-generated stable UUIDs for tests that reuse the same user across assertions
    const USER1 = randomUUID();
    const USER2 = randomUUID();
    const USER3 = randomUUID();
    const USER_A = randomUUID();
    const USER_B = randomUUID();
    const USER_C = randomUUID();
    const VIEWER_A = randomUUID();
    const VIEWER_B = randomUUID();
    const WATCHER_1 = randomUUID();
    const WATCHER_2 = randomUUID();
    const EP_USERS = Array.from({ length: 3 }, () => randomUUID());
    const EP_USER_SINGLE = randomUUID();

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
    // Timeframe Helpers
    // ==========================================================================

    describe('timeframeToInterval', () => {
        it('converts timeframes to PostgreSQL intervals', () => {
            expect(timeframeToInterval('today')).toBe('1 day');
            expect(timeframeToInterval('week')).toBe('7 days');
            expect(timeframeToInterval('month')).toBe('30 days');
            expect(timeframeToInterval('year')).toBe('365 days');
            expect(timeframeToInterval('all')).toBe('100 years');
        });
    });

    describe('timeframeToDays', () => {
        it('converts timeframes to day counts', () => {
            expect(timeframeToDays('today')).toBe(1);
            expect(timeframeToDays('week')).toBe(7);
            expect(timeframeToDays('month')).toBe(30);
            expect(timeframeToDays('year')).toBe(365);
            expect(timeframeToDays('all')).toBe(36500);
        });
    });

    // ==========================================================================
    // Media Watch Stats
    // ==========================================================================

    describe('getMediaWatchStats', () => {
        it('returns aggregated watch statistics for media', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'stats-movie-001',
            });

            // Create sessions from different users
            const sessions = [
                createTestWatchHistoryEntry(USER1, 'stats-movie-001', 'MOVIE', {
                    watchTimeSeconds: 30 * 60, // 30 min
                }),
                createTestWatchHistoryEntry(USER2, 'stats-movie-001', 'MOVIE', {
                    watchTimeSeconds: 60 * 60, // 60 min
                }),
                createTestWatchHistoryEntry(USER3, 'stats-movie-001', 'MOVIE', {
                    watchTimeSeconds: 45 * 60, // 45 min
                }),
            ];
            await insertTestWatchHistoryEntries(sql, sessions);

            const result = await getMediaWatchStats.get(sql, {
                mediaId: movieId,
            });

            expect(result).not.toBeNull();
            expect(result?.session_count).toBe(3);
            expect(result?.unique_viewers).toBe(3);
            expect(result?.total_watch_minutes).toBe(135); // 30 + 60 + 45
            expect(Number(result?.avg_watch_minutes)).toBeCloseTo(45, 0);
        });

        it('handles same user multiple sessions', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'stats-movie-002',
            });

            const sessions = [
                createTestWatchHistoryEntry(USER1, 'stats-movie-002', 'MOVIE', {
                    watchTimeSeconds: 20 * 60,
                }),
                createTestWatchHistoryEntry(USER1, 'stats-movie-002', 'MOVIE', {
                    watchTimeSeconds: 40 * 60,
                }),
            ];
            await insertTestWatchHistoryEntries(sql, sessions);

            const result = await getMediaWatchStats.get(sql, {
                mediaId: movieId,
            });

            expect(result?.session_count).toBe(2);
            expect(result?.unique_viewers).toBe(1); // Same user
        });
    });

    describe('getMediaWatchStatsInTimeframe', () => {
        it('filters by timeframe', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'timeframe-movie-001',
            });

            // Create session within last week
            const recentSession = createTestWatchHistoryEntry(
                USER1,
                'timeframe-movie-001',
                'MOVIE',
                {
                    startTime: new Date(),
                    watchTimeSeconds: 30 * 60,
                },
            );
            await insertTestWatchHistoryEntry(sql, recentSession);

            // Note: We can't easily create old sessions without direct SQL,
            // so we just verify recent sessions are included
            const result = await getMediaWatchStatsInTimeframe.get(sql, {
                mediaId: movieId,
                days: 7,
            });

            expect(result?.session_count).toBe(1);
        });
    });

    // ==========================================================================
    // Trending Queries
    // ==========================================================================

    describe('getTrendingMovies', () => {
        it('returns trending movies sorted by trending_score', async () => {
            // Create movies with different watch patterns - use unique tmdbIds to avoid conflicts
            await createAndInsertTestMovie(sql, {
                jellyfinId: 'trending-001',
                tmdbId: 900001,
            });
            const { id: movie2Id } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'trending-002',
                tmdbId: 900002,
            });
            const { id: movie3Id } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'trending-003',
                tmdbId: 900003,
            });

            // Movie 1: 3 users, 60 min total
            const sessions1 = createTrendingWatchHistoryBatch('trending-001', 'MOVIE', {
                userCount: 3,
                watchTimeRange: [600, 1800], // 10-30 min
            });
            // Movie 2: 5 users, 100 min total
            const sessions2 = createTrendingWatchHistoryBatch('trending-002', 'MOVIE', {
                userCount: 5,
                watchTimeRange: [600, 1800],
            });
            // Movie 3: 1 user, 20 min
            const sessions3 = createTrendingWatchHistoryBatch('trending-003', 'MOVIE', {
                userCount: 1,
                watchTimeRange: [600, 1800],
            });

            await insertTestWatchHistoryEntries(sql, [...sessions1, ...sessions2, ...sessions3]);

            const result = await getTrendingMovies.all(sql, {
                days: 7,
                limit: 10,
            });

            expect(result.length).toBeGreaterThanOrEqual(2);
            // Movie 2 should rank higher (more viewers)
            const movie2Index = result.findIndex((r) => r.media_id === movie2Id);
            const movie3Index = result.findIndex((r) => r.media_id === movie3Id);

            if (movie2Index >= 0 && movie3Index >= 0) {
                expect(movie2Index).toBeLessThan(movie3Index);
            }
        });

        it('excludes sessions with < 5 min watch time', async () => {
            const { id: shortWatchId } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'short-watch-001',
            });

            const shortSession = createTestWatchHistoryEntry(USER1, 'short-watch-001', 'MOVIE', {
                watchTimeSeconds: 60, // Only 1 minute
            });
            await insertTestWatchHistoryEntry(sql, shortSession);

            const result = await getTrendingMovies.all(sql, {
                days: 7,
                limit: 10,
            });

            const found = result.find((r) => r.media_id === shortWatchId);
            expect(found).toBeUndefined();
        });
    });

    describe('getTrendingMedia', () => {
        it('filters by media types', async () => {
            await createAndInsertTestMovie(sql, {
                jellyfinId: 'trend-movie-001',
            });
            // Note: Episodes would need episode fixtures

            const movieSession = createTestWatchHistoryEntry(USER1, 'trend-movie-001', 'MOVIE', {
                watchTimeSeconds: 30 * 60,
            });
            await insertTestWatchHistoryEntry(sql, movieSession);

            const result = await getTrendingMedia.all(sql, {
                days: 7,
                mediaTypes: ['MOVIE'],
                limit: 10,
            });

            result.forEach((r) => {
                expect(r.media_type.toUpperCase()).toBe('MOVIE');
            });
        });
    });

    describe('getTrendingEpisodes', () => {
        it('returns trending episodes sorted by trending_score', async () => {
            // Create series with episodes
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });

            const episodes = series.seasons[0].episodes;

            // Episode 1: 3 users watch (more trending)
            for (let i = 0; i < 3; i++) {
                const session = createTestWatchHistoryEntry(
                    EP_USERS[i],
                    episodes[0].jellyfin_id,
                    'EPISODE',
                    {
                        watchTimeSeconds: 20 * 60,
                    },
                );
                await insertTestWatchHistoryEntry(sql, session);
            }

            // Episode 2: 1 user watches (less trending)
            const session2 = createTestWatchHistoryEntry(
                EP_USER_SINGLE,
                episodes[1].jellyfin_id,
                'EPISODE',
                {
                    watchTimeSeconds: 20 * 60,
                },
            );
            await insertTestWatchHistoryEntry(sql, session2);

            const result = await getTrendingEpisodes.all(sql, {
                days: 7,
                limit: 10,
            });

            expect(result.length).toBeGreaterThanOrEqual(2);

            // Resolve Jellyfin IDs to media_items UUIDs for comparison
            const [ep1Row] = await sql<{ media_id: string }[]>`
                SELECT media_id FROM external_ids
                WHERE provider = 'jellyfin' AND external_id = ${episodes[0].jellyfin_id}
                LIMIT 1
            `;
            const [ep2Row] = await sql<{ media_id: string }[]>`
                SELECT media_id FROM external_ids
                WHERE provider = 'jellyfin' AND external_id = ${episodes[1].jellyfin_id}
                LIMIT 1
            `;

            // Episode with more viewers should rank higher
            const ep1Index = result.findIndex((r) => r.media_id === ep1Row?.media_id);
            const ep2Index = result.findIndex((r) => r.media_id === ep2Row?.media_id);

            if (ep1Index >= 0 && ep2Index >= 0) {
                expect(ep1Index).toBeLessThan(ep2Index);
            }
        });

        it('excludes sessions with < 5 min watch time', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });

            const episode = series.seasons[0].episodes[0];

            // Short session
            const shortSession = createTestWatchHistoryEntry(
                USER1,
                episode.jellyfin_id,
                'EPISODE',
                {
                    watchTimeSeconds: 2 * 60, // Only 2 min
                },
            );
            await insertTestWatchHistoryEntry(sql, shortSession);

            const result = await getTrendingEpisodes.all(sql, {
                days: 7,
                limit: 10,
            });

            // Resolve Jellyfin ID to media_items UUID for comparison
            const [epRow] = await sql<{ media_id: string }[]>`
                SELECT media_id FROM external_ids
                WHERE provider = 'jellyfin' AND external_id = ${episode.jellyfin_id}
                LIMIT 1
            `;

            const found = result.find((r) => r.media_id === epRow?.media_id);
            expect(found).toBeUndefined();
        });

        it('only includes EPISODE media type', async () => {
            // Create a movie session
            const { id: trendEpMovieId } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'trend-ep-movie',
            });
            const movieSession = createTestWatchHistoryEntry(USER1, 'trend-ep-movie', 'MOVIE', {
                watchTimeSeconds: 30 * 60,
            });
            await insertTestWatchHistoryEntry(sql, movieSession);

            const result = await getTrendingEpisodes.all(sql, {
                days: 7,
                limit: 10,
            });

            // Movie should not appear in episode trending
            const found = result.find((r) => r.media_id === trendEpMovieId);
            expect(found).toBeUndefined();
        });
    });

    // ==========================================================================
    // User Statistics
    // ==========================================================================

    describe('getUserWatchStats', () => {
        it('returns user watch statistics', async () => {
            const userId = generateTestUserId();
            await createAndInsertTestMovie(sql, {
                jellyfinId: 'user-stat-001',
            });

            const sessions = [
                createTestWatchHistoryEntry(userId, 'user-stat-001', 'MOVIE', {
                    watchTimeSeconds: 60 * 60,
                }),
                createTestWatchHistoryEntry(userId, 'user-stat-001', 'MOVIE', {
                    watchTimeSeconds: 30 * 60,
                }),
            ];
            await insertTestWatchHistoryEntries(sql, sessions);

            const result = await getUserWatchStats.get(sql, { userId });

            expect(result).not.toBeNull();
            expect(result?.total_sessions).toBe(2);
            // PostgreSQL numeric returns as string, check watch hours are >= 1
            expect(Number(result?.total_watch_hours)).toBeGreaterThanOrEqual(1);
            expect(result?.movies_watched).toBe(2);
        });

        it('separates movies and episodes counts', async () => {
            const userId = generateTestUserId();

            await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-movie',
                tmdbId: 950101,
            });
            await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-episode',
                tmdbId: 950102,
            });

            const movieSession = createTestWatchHistoryEntry(userId, 'jf-movie', 'MOVIE', {
                watchTimeSeconds: 60 * 60,
            });
            const episodeSession = createTestWatchHistoryEntry(userId, 'jf-episode', 'EPISODE', {
                watchTimeSeconds: 45 * 60,
            });
            await insertTestWatchHistoryEntries(sql, [movieSession, episodeSession]);

            const result = await getUserWatchStats.get(sql, { userId });

            expect(result?.movies_watched).toBe(1);
            expect(result?.episodes_watched).toBe(1);
        });
    });

    describe('getUserWatchStatsInTimeframe', () => {
        it('filters stats by timeframe', async () => {
            const userId = generateTestUserId();

            await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-recent',
                tmdbId: 950103,
            });

            const session = createTestWatchHistoryEntry(userId, 'jf-recent', 'MOVIE', {
                startTime: new Date(),
                watchTimeSeconds: 2 * 60 * 60,
            });
            await insertTestWatchHistoryEntry(sql, session);

            const result = await getUserWatchStatsInTimeframe.get(sql, {
                userId,
                days: 7,
            });

            expect(result?.total_sessions).toBe(1);
            expect(Number(result?.total_watch_hours)).toBeCloseTo(2, 1);
        });
    });

    describe('getUserWatchCount', () => {
        it('returns total session count', async () => {
            const userId = generateTestUserId();

            for (let i = 0; i < 5; i++) {
                await createAndInsertTestMovie(sql, {
                    jellyfinId: `jf-count-${i}`,
                    tmdbId: 950200 + i,
                });
                const session = createTestWatchHistoryEntry(userId, `jf-count-${i}`, 'MOVIE', {
                    watchTimeSeconds: 30 * 60,
                });
                await insertTestWatchHistoryEntry(sql, session);
            }

            const result = await getUserWatchCount.get(sql, { userId });

            expect(result).toBe(5);
        });
    });

    // ==========================================================================
    // Activity Feeds
    // ==========================================================================

    describe('getUserRecentWatchActivity', () => {
        it('returns recent activity ordered by session_start_time DESC', async () => {
            const userId = generateTestUserId();
            const movieIds: string[] = [];

            for (let i = 0; i < 5; i++) {
                const { id } = await createAndInsertTestMovie(sql, {
                    jellyfinId: `jf-activity-${i}`,
                    tmdbId: 800100 + i,
                });
                movieIds.push(id);

                const startTime = new Date();
                startTime.setHours(startTime.getHours() - i);

                const session = createTestWatchHistoryEntry(userId, `jf-activity-${i}`, 'MOVIE', {
                    startTime,
                    watchTimeSeconds: 30 * 60,
                });
                await insertTestWatchHistoryEntry(sql, session);
            }

            const result = await getUserRecentWatchActivity.all(sql, {
                userId,
                limit: 10,
            });

            expect(result.length).toBe(5);
            // First should be most recent (i=0 has the latest startTime)
            expect(result[0].media_id).toBe(movieIds[0]);
        });
    });

    describe('getRecentActivity', () => {
        it('returns activity from all users', async () => {
            const users = [USER_A, USER_B, USER_C];

            for (let i = 0; i < users.length; i++) {
                const user = users[i];
                const jellyfinId = `jf-global-activity-${i}`;
                await createAndInsertTestMovie(sql, {
                    jellyfinId,
                    tmdbId: 790100 + i,
                });
                const session = createTestWatchHistoryEntry(user, jellyfinId, 'MOVIE', {
                    watchTimeSeconds: 10 * 60, // 10 min (above 5 min threshold)
                });
                await insertTestWatchHistoryEntry(sql, session);
            }

            const result = await getRecentActivity.all(sql, {
                limit: 10,
                minWatchSeconds: 300, // 5 min minimum
            });

            expect(result.length).toBe(3);
        });
    });

    // ==========================================================================
    // Playback Quality Stats
    // ==========================================================================

    describe('getPlaybackQualityStats', () => {
        it('returns quality distribution', async () => {
            await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-quality-1',
                tmdbId: 700001,
            });
            await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-quality-2',
                tmdbId: 700002,
            });
            const sessions = [
                createTestWatchHistoryEntry(USER1, 'jf-quality-1', 'MOVIE', {
                    watchTimeSeconds: 30 * 60,
                    resolution: '1080p',
                }),
                createTestWatchHistoryEntry(USER2, 'jf-quality-2', 'MOVIE', {
                    watchTimeSeconds: 30 * 60,
                    resolution: '720p',
                }),
            ];
            await insertTestWatchHistoryEntries(sql, sessions);

            const result = await getPlaybackQualityStats.all(sql, { days: 7 });

            expect(result.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('getTranscodingPercentage', () => {
        it('returns zero transcoding stats (is_transcoding column was dropped)', async () => {
            const result = await getTranscodingPercentage.get(sql, { days: 7 });

            // is_transcoding column was removed; query returns hardcoded zeros
            expect(result?.total_sessions).toBe(0);
            expect(Number(result?.transcoded_pct)).toBe(0);
            expect(Number(result?.direct_play_pct)).toBe(100);
        });
    });

    // ==========================================================================
    // Complex Queries
    // ==========================================================================

    describe('getMediaViewers', () => {
        it('returns viewer list for media', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'viewers-movie-001',
            });

            const sessions = [
                createTestWatchHistoryEntry(VIEWER_A, 'viewers-movie-001', 'MOVIE', {
                    watchTimeSeconds: 60 * 60,
                }),
                createTestWatchHistoryEntry(VIEWER_B, 'viewers-movie-001', 'MOVIE', {
                    watchTimeSeconds: 30 * 60,
                }),
                createTestWatchHistoryEntry(VIEWER_A, 'viewers-movie-001', 'MOVIE', {
                    watchTimeSeconds: 45 * 60,
                }),
            ];
            await insertTestWatchHistoryEntries(sql, sessions);

            const result = await getMediaViewers.all(sql, {
                mediaId: movieId,
                limit: 10,
            });

            expect(result.length).toBe(2); // 2 unique viewers

            const viewerA = result.find((r) => r.user_id === VIEWER_A);
            expect(viewerA?.session_count).toBe(2);
            expect(viewerA?.total_watch_minutes).toBe(105); // 60 + 45
        });
    });

    describe('getUsersWhoWatched', () => {
        it('returns map of media UUIDs to users who watched', async () => {
            const { id: movie1Id } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-who-001',
                tmdbId: 800201,
            });
            const { id: movie2Id } = await createAndInsertTestMovie(sql, {
                jellyfinId: 'jf-who-002',
                tmdbId: 800202,
            });

            const sessions = [
                createTestWatchHistoryEntry(WATCHER_1, 'jf-who-001', 'MOVIE', {
                    watchTimeSeconds: 10 * 60,
                }),
                createTestWatchHistoryEntry(WATCHER_2, 'jf-who-001', 'MOVIE', {
                    watchTimeSeconds: 15 * 60,
                }),
                createTestWatchHistoryEntry(WATCHER_1, 'jf-who-002', 'MOVIE', {
                    watchTimeSeconds: 20 * 60,
                }),
            ];
            await insertTestWatchHistoryEntries(sql, sessions);

            const result = await getUsersWhoWatched(sql, [movie1Id, movie2Id], 7, 300);

            expect(result.size).toBe(2);
            expect(result.get(movie1Id)?.sort()).toEqual([WATCHER_1, WATCHER_2].sort());
            expect(result.get(movie2Id)).toEqual([WATCHER_1]);
        });

        it('returns empty map for no matches', async () => {
            const result = await getUsersWhoWatched(
                sql,
                ['00000000-0000-0000-0000-000000000000'],
                7,
                300,
            );
            expect(result.size).toBe(0);
        });
    });
});
