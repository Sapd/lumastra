// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Admin Stats Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUsers } from '../../../../../tests/integration/fixtures/user.fixtures.js';

import {
    getTopMovies,
    getTopTVShows,
    getActivityStats,
    getTopUsers,
    getActiveUsers,
    getGenreBreakdown,
    getContentFreshness,
    getDayHours,
    getSummary,
} from './admin-stats.queries.js';

describe('Admin Stats Queries', () => {
    let sql: postgres.Sql;
    const _testUserId = 'test_adminstats_user';

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'watch_history', 'provider_metadata']);
    });

    describe('getTopMovies', () => {
        it('returns empty array when no watch history', async () => {
            const result = await getTopMovies(sql);
            expect(result).toEqual([]);
        });
    });

    describe('getTopTVShows', () => {
        const USER_A = '11111111-1111-1111-1111-111111111111';
        const USER_B = '22222222-2222-2222-2222-222222222222';

        // watch_history.user_id → users(id) FK. `users` is not in the beforeEach
        // truncate set, so ensuring these once is enough for the whole block.
        beforeAll(async () => {
            await ensureTestUsers(sql, [USER_A, USER_B]);
        });

        /** Insert a series → season → episode chain, return the ids. */
        async function insertSeriesChain(opts: {
            canonicalTitle: string;
            year: number;
            originalTitle?: string;
            englishTitle?: string;
            tmdbId?: string;
        }): Promise<{ seriesId: string; episodeId: string }> {
            const [series] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, has_files, original_title, english_title)
                VALUES (${opts.canonicalTitle}, 'tv', ${opts.year}, 'active', true,
                    ${opts.originalTitle ?? null}, ${opts.englishTitle ?? null})
                RETURNING id
            `;
            const [season] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
                VALUES ('Season 1', 'season', 'active', true, ${series.id}::uuid, 1)
                RETURNING id
            `;
            const [episode] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number)
                VALUES ('Pilot', 'episode', 'active', true, ${season.id}::uuid, 1, 1)
                RETURNING id
            `;
            if (opts.tmdbId) {
                await sql`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                    VALUES (${series.id}::uuid, 'tmdb', ${opts.tmdbId}, 'tv', true)
                `;
            }
            return { seriesId: series.id, episodeId: episode.id };
        }

        async function insertEpisodeWatch(opts: {
            userId: string;
            seriesName: string;
            mediaId: string | null;
            seconds?: number;
        }): Promise<void> {
            await sql`
                INSERT INTO watch_history
                    (user_id, media_type, series_name, media_id, actual_watch_time_seconds, session_start_time)
                VALUES (
                    ${opts.userId}::uuid, 'episode', ${opts.seriesName},
                    ${opts.mediaId ? sql`${opts.mediaId}::uuid` : null},
                    ${opts.seconds ?? 1800}, NOW()
                )
            `;
        }

        it('returns empty array when no watch history', async () => {
            const result = await getTopTVShows(sql);
            expect(result).toEqual([]);
        });

        it('resolves series poster/year via the episode media_id parent chain even when series_name is a localized title that differs from the canonical title', async () => {
            // Canonical library title differs from the denormalized (localized)
            // series_name the client wrote onto watch_history — the exact-title
            // join would MISS, but the media_id → season → series chain resolves it.
            const { seriesId } = await insertSeriesChain({
                canonicalTitle: 'Harborfolk Adventures',
                year: 1999,
                tmdbId: '387',
            });
            await insertEpisodeWatch({
                userId: USER_A,
                seriesName: 'Harborfolk Hafenfreunde',
                mediaId: (
                    await sql<[{ id: string }]>`
                    SELECT id FROM media_items WHERE media_type = 'episode' LIMIT 1
                `
                )[0].id,
            });

            const result = await getTopTVShows(sql);
            expect(result).toHaveLength(1);
            const show = result[0];
            // Display keeps the localized label the user actually watched under.
            expect(show.title).toBe('Harborfolk Hafenfreunde');
            // But the id/year/externalIds now resolve from the real series row.
            expect(show.externalIds?.internal).toBe(seriesId);
            expect(show.externalIds?.tmdb).toBe('387');
            expect(show.year).toBe(1999);
        });

        it('falls back to exact canonical-title match when the episode media_id is NULL (legacy rows)', async () => {
            const { seriesId } = await insertSeriesChain({
                canonicalTitle: 'Shorefolk',
                year: 2001,
                tmdbId: '4556',
            });
            await insertEpisodeWatch({
                userId: USER_A,
                seriesName: 'Shorefolk', // exact match to canonical title
                mediaId: null,
            });

            const [show] = await getTopTVShows(sql);
            expect(show.externalIds?.internal).toBe(seriesId);
            expect(show.externalIds?.tmdb).toBe('4556');
            expect(show.year).toBe(2001);
        });

        it('falls back to the english_title column when media_id is NULL and the localized name only matches an alternate title', async () => {
            const { seriesId } = await insertSeriesChain({
                canonicalTitle: 'Shingeki no Kyojin',
                year: 2013,
                englishTitle: 'Voyage to Orion',
                tmdbId: '1429',
            });
            await insertEpisodeWatch({
                userId: USER_A,
                seriesName: 'Voyage to Orion', // matches english_title, not title
                mediaId: null,
            });

            const [show] = await getTopTVShows(sql);
            expect(show.externalIds?.internal).toBe(seriesId);
            expect(show.externalIds?.tmdb).toBe('1429');
            expect(show.year).toBe(2013);
        });

        it('still returns the leaderboard row (unresolved externalIds) when the series cannot be matched at all', async () => {
            await insertEpisodeWatch({
                userId: USER_A,
                seriesName: 'A Show With No Catalog Entry',
                mediaId: null,
            });

            const [show] = await getTopTVShows(sql);
            expect(show.title).toBe('A Show With No Catalog Entry');
            expect(show.uniqueViewers).toBe(1);
            expect(show.externalIds?.internal).toBeUndefined();
            expect(show.externalIds?.tmdb).toBeUndefined();
            expect(show.year).toBeNull();
        });

        it('collapses casing/whitespace variants of the same localized name into one row and counts distinct viewers', async () => {
            const { episodeId } = await insertSeriesChain({
                canonicalTitle: 'Harborfolk Adventures',
                year: 1999,
                tmdbId: '387',
            });
            // Two users, two casing variants of the same localized series_name.
            await insertEpisodeWatch({
                userId: USER_A,
                seriesName: 'Harborfolk Hafenfreunde',
                mediaId: episodeId,
            });
            await insertEpisodeWatch({
                userId: USER_B,
                seriesName: '  harborfolk hafenfreunde ',
                mediaId: episodeId,
            });

            const result = await getTopTVShows(sql);
            expect(result).toHaveLength(1);
            expect(result[0].uniqueViewers).toBe(2);
            expect(result[0].externalIds?.tmdb).toBe('387');
        });
    });

    describe('getActivityStats', () => {
        it('returns zeroed stats for empty database', async () => {
            const result = await getActivityStats(sql);
            expect(result.totalSessions).toBe(0);
            expect(result.totalMinutes).toBe(0);
            expect(result.dayOfWeek).toHaveLength(7);
            expect(result.hourOfDay).toHaveLength(24);
        });
    });

    describe('getTopUsers', () => {
        it('returns empty array when no watch history', async () => {
            const result = await getTopUsers(sql);
            expect(result).toEqual([]);
        });
    });

    describe('getActiveUsers', () => {
        it('returns empty array when no recent watch history', async () => {
            const result = await getActiveUsers(sql);
            expect(result).toEqual([]);
        });
    });

    describe('getGenreBreakdown', () => {
        it('returns empty array when no provider metadata', async () => {
            const result = await getGenreBreakdown(sql);
            expect(result).toEqual([]);
        });
    });

    describe('getContentFreshness', () => {
        it('returns zeroed stats for empty database', async () => {
            const result = await getContentFreshness(sql);
            expect(result.recentContent.items).toBe(0);
            expect(result.olderContent.items).toBe(0);
        });
    });

    describe('getDayHours', () => {
        it('returns empty array for invalid day name', async () => {
            const result = await getDayHours(sql, 'InvalidDay');
            expect(result).toEqual([]);
        });

        it('returns 24 hour slots for valid day', async () => {
            const result = await getDayHours(sql, 'Monday');
            expect(result).toHaveLength(24);
        });
    });

    describe('getSummary', () => {
        it('returns zeroed summary for empty watch history', async () => {
            const result = await getSummary(sql);
            expect(result.totalSessions).toBe(0);
            expect(result.uniqueItems).toBe(0);
        });
    });
});
