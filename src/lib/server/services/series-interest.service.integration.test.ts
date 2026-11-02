// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for series-interest.service.ts: viewing moments as the
 * follow-state queries count them (both directions, `getSeriesFollowStates`
 * for user → series and `getSeriesFollowers` for series → users), and the
 * `series_excluded` mute.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/series-interest.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/index.js';
import {
    loadSeriesExclusionsForUser,
    isSeriesExcludedFor,
    listUsersExcludingSeries,
    SERIES_INTEREST_MOMENT_GAP_SECONDS,
} from './series-interest.service.js';
import {
    getSeriesFollowers,
    getSeriesFollowStates,
} from '$lib/server/database/queries/new-release-episodes.queries.js';
import { isMonitoredSeriesExcluded } from '$lib/server/utils/excluded-series-match.js';
import { toUserId } from '$lib/shared/user-id.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * `base` moved `steps` half-hours into the past — one episode's worth of real
 * viewing apart, so consecutive calls are separate viewing MOMENTS. Watches
 * stamped at the same instant are a bulk mark and count as one moment.
 */
function viewingAt(base: Date, steps: number): Date {
    return new Date(base.getTime() - steps * 30 * MINUTE_MS);
}

describe('series-interest.service', () => {
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
            ...TEST_TABLES.userData,
            ...TEST_TABLES.preferences,
        ]);
    });

    /** Mark one episode of a series watched at an explicit timestamp. */
    async function watchEpisodeAt(
        userId: string,
        seriesMediaId: string,
        seasonNumber: number,
        episodeNumber: number,
        watchedAt: Date | null,
    ): Promise<void> {
        const [row] = await sql<{ id: string }[]>`
            SELECT ep.id::text AS id
            FROM media_items season
            JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
            WHERE season.parent_id = ${seriesMediaId}::uuid
              AND season.media_type = 'season'
              AND season.season_number = ${seasonNumber}
              AND ep.episode_number = ${episodeNumber}
        `;
        if (!row) {
            throw new Error(
                `Test fixture error: S${seasonNumber}E${episodeNumber} not found for series ${seriesMediaId}`,
            );
        }
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
            VALUES (${userId}::uuid, ${row.id}::uuid, true, ${watchedAt})
            ON CONFLICT (user_id, media_id) DO UPDATE SET
                is_watched = true,
                last_watched_at = ${watchedAt}
        `;
    }

    /** Moment counts of one (user, series), from both directions; they must agree. */
    async function momentsOf(userId: string, seriesId: string): Promise<number | undefined> {
        const forUser = (
            await getSeriesFollowStates(sql, toUserId(userId), SERIES_INTEREST_MOMENT_GAP_SECONDS)
        ).find((r) => r.series_id === seriesId);
        const forSeries = (
            await getSeriesFollowers(sql, seriesId, SERIES_INTEREST_MOMENT_GAP_SECONDS)
        ).find((r) => r.user_id === userId);
        expect(forSeries?.watched_moment_count).toBe(forUser?.watched_moment_count);
        expect(forSeries?.watched_episode_count).toBe(forUser?.watched_episode_count);
        return forUser?.watched_moment_count;
    }

    describe('viewing moments — a bulk mark is not viewing', () => {
        // Prod 2026-10-02: an import marked whole series watched for every user
        // in one instant, and each new season then pushed to ~30 users who had
        // never seen the show. Episodes marked within 2 minutes of each other
        // are ONE moment; the follow threshold counts moments, not episodes.
        it('separate viewings are one moment each', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });
            const now = new Date();
            for (let ep = 1; ep <= 3; ep++) {
                await watchEpisodeAt(userId, series.seriesId, 1, ep, viewingAt(now, 3 - ep));
            }
            expect(await momentsOf(userId, series.seriesId)).toBe(3);
        });

        it('a bulk mark of ten episodes is one moment', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 5,
            });
            const importedAt = new Date(Date.now() - 180 * DAY_MS);
            for (const season of [1, 2]) {
                for (let ep = 1; ep <= 5; ep++) {
                    await watchEpisodeAt(
                        userId,
                        series.seriesId,
                        season,
                        ep,
                        new Date(importedAt.getTime() + (season * 10 + ep) * 20),
                    );
                }
            }
            expect(await momentsOf(userId, series.seriesId)).toBe(1);
        });

        it('undated watches are ONE moment, next to dated ones too', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 4,
            });
            const sixMonthsAgo = new Date(Date.now() - 180 * DAY_MS);
            await watchEpisodeAt(userId, series.seriesId, 1, 1, null);
            await watchEpisodeAt(userId, series.seriesId, 1, 2, null);
            expect(await momentsOf(userId, series.seriesId)).toBe(1);
            await watchEpisodeAt(userId, series.seriesId, 1, 3, viewingAt(sixMonthsAgo, 1));
            await watchEpisodeAt(userId, series.seriesId, 1, 4, viewingAt(sixMonthsAgo, 0));
            expect(await momentsOf(userId, series.seriesId)).toBe(3);
        });

        it('a bulk mark plus two separate viewings is three moments', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 6,
            });
            const sixMonthsAgo = new Date(Date.now() - 180 * DAY_MS);
            for (let ep = 1; ep <= 4; ep++) {
                await watchEpisodeAt(
                    userId,
                    series.seriesId,
                    1,
                    ep,
                    new Date(sixMonthsAgo.getTime() + ep * 50),
                );
            }
            await watchEpisodeAt(userId, series.seriesId, 1, 5, viewingAt(sixMonthsAgo, -2));
            await watchEpisodeAt(userId, series.seriesId, 1, 6, viewingAt(sixMonthsAgo, -4));
            expect(await momentsOf(userId, series.seriesId)).toBe(3);
        });
    });

    describe('series → users direction (getSeriesFollowers)', () => {
        it('lists every watcher and an explicit follower with no watch history, nobody else', async () => {
            const [watcher, follower, bystander, otherFlags] = [
                generateTestUserId(),
                generateTestUserId(),
                generateTestUserId(),
                generateTestUserId(),
            ];
            for (const u of [watcher, follower, bystander, otherFlags])
                await ensureTestUser(sql, u);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const other = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            await watchEpisodeAt(watcher, series.seriesId, 1, 1, viewingAt(new Date(), 1));
            await watchEpisodeAt(bystander, other.seriesId, 1, 1, viewingAt(new Date(), 1));
            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES
                    (${follower}::uuid, ${series.seriesId}, 'series', 'series_episode_notifications'),
                    -- Composite-key target ids of other flag types must not break the series scope.
                    (${otherFlags}::uuid, 'tmdb:1:movie', 'media', 'dismissed_cw')
            `;

            const rows = await getSeriesFollowers(
                sql,
                series.seriesId,
                SERIES_INTEREST_MOMENT_GAP_SECONDS,
            );
            const byUser = new Map(rows.map((r) => [r.user_id, r]));
            expect([...byUser.keys()].sort()).toEqual([watcher, follower].sort());
            expect(byUser.get(watcher)?.explicitly_followed).toBe(false);
            expect(byUser.get(watcher)?.watched_moment_count).toBe(1);
            expect(byUser.get(follower)?.explicitly_followed).toBe(true);
            expect(byUser.get(follower)?.watched_moment_count).toBe(0);
        });
    });

    describe('series_excluded — direct UUID comparison', () => {
        it('excludes a series keyed by its media UUID (target_type=series)', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${userId}::uuid, ${series.seriesId}, 'series', 'series_excluded')
            `;

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(isSeriesExcludedFor(exclusions, series.seriesId)).toBe(true);
        });

        it('excludes a series with NO Jellyfin external id (direct UUID compare, no join needed)', async () => {
            // Regression guard for the (c) deviation: the exclusion match no
            // longer round-trips through external_ids(provider='jellyfin'),
            // so a series lacking a Jellyfin id can still be excluded.
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            await sql`DELETE FROM external_ids WHERE media_id = ${series.seriesId}::uuid AND provider = 'jellyfin'`;

            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${userId}::uuid, ${series.seriesId}, 'series', 'series_excluded')
            `;

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(isSeriesExcludedFor(exclusions, series.seriesId)).toBe(true);
        });
    });
    describe('series_excluded — TMDB keys', () => {
        async function flag(userId: string, targetType: string, targetId: string): Promise<void> {
            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${userId}::uuid, ${targetId}, ${targetType}, 'series_excluded')
            `;
        }

        it('resolves a TMDB TV key to the catalog series that carries the id', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                tmdbId: 770001,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await flag(userId, 'tmdb_tv', 'tv:770001');

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.tmdbTv.has('770001')).toBe(true);
            expect(isSeriesExcludedFor(exclusions, series.seriesId)).toBe(true);
            expect(await listUsersExcludingSeries(sql, series.seriesId)).toEqual(new Set([userId]));
        });

        it('does not resolve a TMDB TV key to a movie with the same number', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const movie = await createAndInsertTestMovie(sql, { tmdbId: 770002 });
            await flag(userId, 'tmdb_tv', 'tv:770002');

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.itemIds.has(movie.id)).toBe(false);
        });

        it('resolves a TMDB movie key to the catalog movie', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const movie = await createAndInsertTestMovie(sql, { tmdbId: 770003 });
            await flag(userId, 'tmdb_movie', 'movie:770003');

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.itemIds.has(movie.id)).toBe(true);
        });

        it('adds the TVDB id of a muted catalog series without a TMDB id, so its Sonarr rows are hidden', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await sql`DELETE FROM external_ids WHERE media_id = ${series.seriesId}::uuid`;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${series.seriesId}::uuid, 'tvdb', '770081', 'tv')
            `;
            await flag(userId, 'series', series.seriesId);

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.tvdbTv.has('770081')).toBe(true);
            expect(exclusions.tmdbTv.size).toBe(0);
            expect(isMonitoredSeriesExcluded(exclusions, undefined, 770081)).toBe(true);
        });

        it('adds the TVDB id of the catalog series a TMDB key resolves to', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                tmdbId: 770082,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await sql`DELETE FROM external_ids WHERE media_id = ${series.seriesId}::uuid AND provider = 'tvdb'`;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${series.seriesId}::uuid, 'tvdb', '770083', 'tv')
            `;
            await flag(userId, 'tmdb_tv', 'tv:770082');

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.tvdbTv.has('770083')).toBe(true);
            expect(isMonitoredSeriesExcluded(exclusions, 999999, 770083)).toBe(true);
        });

        it('adds the TMDB id of a muted catalog series, so its arr rows are hidden too', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                tmdbId: 770004,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await flag(userId, 'series', series.seriesId);

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.tmdbTv.has('770004')).toBe(true);
            expect(exclusions.tmdbMovie.has('770004')).toBe(false);
        });

        it('does not carry the title of a muted catalog series', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                title: 'Saltmarsh Gazette',
                tmdbId: 770006,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await flag(userId, 'series', series.seriesId);

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions).not.toHaveProperty('exactNames');
            expect(exclusions.unresolvedTmdb).toBe(false);
        });

        it('flags a TMDB mute that matches no catalog item as unresolved', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            await flag(userId, 'tmdb_tv', 'tv:770099');

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.unresolvedTmdb).toBe(true);
        });

        it('ignores a legacy title-keyed row', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const series = await createAndInsertTestSeries(sql, {
                title: 'Copper Hill',
                tmdbId: 770005,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await flag(userId, 'series_name', 'Copper Hill');

            const exclusions = await loadSeriesExclusionsForUser(sql, userId);
            expect(exclusions.itemIds.size).toBe(0);
            expect(exclusions.tmdbTv.size).toBe(0);
            expect(isSeriesExcludedFor(exclusions, series.seriesId)).toBe(false);
            expect((await listUsersExcludingSeries(sql, series.seriesId)).size).toBe(0);
        });
    });
});
