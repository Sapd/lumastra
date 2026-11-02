// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Excluded Series Query Module
 *
 * Tests CRUD operations for series exclusions. Mutes are keyed by id (catalog
 * UUID or TMDB id), never by title.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
    createAndInsertTestSeries,
    createAndInsertTestMovie,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    getExcludedSeries,
    getExcludedSeriesKeys,
    resolveTmdbToCatalogIds,
    resolveCatalogIdsToExternal,
    removeExcludedSeriesById,
    upsertExcludedSeries,
    clearExcludedSeries,
} from './user-excluded-series.queries.js';

describe('User Excluded Series Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.preferences);
    });

    async function ensureUser(userId: string): Promise<void> {
        await ensureTestUser(sql, userId);
    }

    /** Mute a TMDB TV id; the label is only what the client sent. */
    async function muteTmdbTv(userId: UserId, label: string, tmdbId: string) {
        return upsertExcludedSeries.execute(sql, {
            userId,
            seriesName: label,
            tmdbId,
            tmdbType: 'tv',
        });
    }

    // ==========================================================================
    // Read Queries
    // ==========================================================================

    describe('getExcludedSeries', () => {
        it('returns all excluded series for a user', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await muteTmdbTv(username, 'Series A', '1001');
            await muteTmdbTv(username, 'Series B', '1002');
            await muteTmdbTv(username, 'Series C', '1003');

            const result = await getExcludedSeries.all(sql, {
                userId: username,
            });

            expect(result.length).toBe(3);
            expect(result.map((r) => r.tmdb_id).sort()).toEqual(['1001', '1002', '1003']);
        });

        it('orders by excluded_at DESC', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await muteTmdbTv(username, 'First', '1001');
            await muteTmdbTv(username, 'Second', '1002');
            await muteTmdbTv(username, 'Third', '1003');

            const result = await getExcludedSeries.all(sql, {
                userId: username,
            });

            expect(result[0].tmdb_id).toBe('1003');
        });

        it('returns empty array for user with no exclusions', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await getExcludedSeries.all(sql, {
                userId: username,
            });

            expect(result).toEqual([]);
        });

        it('has nullable media_id column', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await muteTmdbTv(username, 'Test Series', '1001');

            const result = await getExcludedSeries.all(sql, {
                userId: username,
            });

            expect(result[0].tmdb_id).toBe('1001');
            expect(result[0].media_id).toBeNull();
        });

        it('does not list a legacy title-keyed row', async () => {
            const username = generateTestUserId();
            await ensureUser(username);
            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${username}::uuid, 'Legacy Show', 'series_name', 'series_excluded')
            `;
            await muteTmdbTv(username, 'Kept', '1001');

            const result = await getExcludedSeries.all(sql, { userId: username });

            expect(result.map((r) => r.kind)).toEqual(['tmdb_tv']);
        });
    });

    // ==========================================================================
    // Write Queries
    // ==========================================================================

    describe('upsertExcludedSeries', () => {
        it('inserts new excluded series', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await muteTmdbTv(username, 'New Excluded Show', '1001');

            expect(result.length).toBe(1);
            expect(result[0].series_name).toBe('New Excluded Show');
            expect(result[0].kind).toBe('tmdb_tv');
            expect(result[0].user_id).toBe(username);
        });

        it('updates excluded_at on conflict', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await muteTmdbTv(username, 'Update Test Show', '1001');
            await muteTmdbTv(username, 'Update Test Show', '1001');

            // Verify only one record exists
            const all = await getExcludedSeries.all(sql, { userId: username });
            expect(all.length).toBe(1);
        });

        it('inserts nothing when neither a media id nor a TMDB id is given', async () => {
            const userId = generateTestUserId();
            await ensureUser(userId);

            // The params type forbids this; guard the runtime path regardless.
            const result = await upsertExcludedSeries.execute(sql, {
                userId,
                seriesName: 'Name Only',
            } as unknown as Parameters<typeof upsertExcludedSeries.execute>[1]);

            expect(result).toEqual([]);
            expect(
                await sql`SELECT 1 FROM user_media_flags WHERE user_id = ${userId}::uuid`,
            ).toHaveLength(0);
        });
    });

    describe('clearExcludedSeries', () => {
        it('removes all excluded series for a user', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await muteTmdbTv(username, 'Clear A', '2001');
            await muteTmdbTv(username, 'Clear B', '2002');
            await muteTmdbTv(username, 'Clear C', '2003');

            const result = await clearExcludedSeries.execute(sql, {
                userId: username,
            });

            expect(result[0].count).toBe(3);

            // Verify all cleared
            const remaining = await getExcludedSeries.all(sql, {
                userId: username,
            });
            expect(remaining.length).toBe(0);
        });

        it('returns count of 0 for user with no exclusions', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await clearExcludedSeries.execute(sql, {
                userId: username,
            });

            expect(result[0].count).toBe(0);
        });

        it('does not affect other users', async () => {
            const user1 = generateTestUserId();
            const user2 = generateTestUserId();
            await ensureUser(user1);
            await ensureUser(user2);

            await muteTmdbTv(user1, 'User 1 Show', '2004');
            await muteTmdbTv(user2, 'User 2 Show', '2005');

            await clearExcludedSeries.execute(sql, { userId: user1 });

            // User 2's exclusions should remain
            const user2Exclusions = await getExcludedSeries.all(sql, {
                userId: user2,
            });
            expect(user2Exclusions.length).toBe(1);
        });
    });

    describe('upsertExcludedSeries UUID target guard', () => {
        it('writes a UUID-keyed row only while the series row exists', async () => {
            const userId = generateTestUserId();
            await ensureUser(userId);
            const missing = crypto.randomUUID();
            expect(
                await upsertExcludedSeries.execute(sql, {
                    userId,
                    seriesName: 'Gone',
                    mediaId: missing,
                }),
            ).toEqual([]);
            expect(
                await sql`SELECT 1 FROM user_media_flags WHERE user_id = ${userId} AND target_id = ${missing}`,
            ).toHaveLength(0);

            const present = crypto.randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type) VALUES (${present}, 'Here', 'tv')`;
            try {
                const rows = await upsertExcludedSeries.execute(sql, {
                    userId,
                    seriesName: 'Here',
                    mediaId: present,
                });
                expect(rows).toHaveLength(1);
                expect(rows[0].media_id).toBe(present);
            } finally {
                await sql`DELETE FROM user_media_flags WHERE target_id = ${present}`;
                await sql`DELETE FROM media_items WHERE id = ${present}`;
            }
        });
    });
    describe('id-keyed exclusions', () => {
        beforeEach(async () => {
            await truncateTables(sql, ['upcoming_releases', ...TEST_TABLES.media]);
        });

        it('keeps a TMDB TV id and a TMDB movie id with the same number apart', async () => {
            const userId = generateTestUserId();
            await ensureUser(userId);

            await upsertExcludedSeries.execute(sql, {
                userId,
                seriesName: 'Show',
                tmdbId: '4242',
                tmdbType: 'tv',
            });
            await upsertExcludedSeries.execute(sql, {
                userId,
                seriesName: 'Film',
                tmdbId: '4242',
                tmdbType: 'movie',
            });

            const keys = await getExcludedSeriesKeys.all(sql, { userId });
            expect(keys.map((k) => `${k.target_type}:${k.target_id}`).sort()).toEqual([
                'tmdb_movie:movie:4242',
                'tmdb_tv:tv:4242',
            ]);
        });

        it('lists an id row with its kind, ids and the catalog title as label', async () => {
            const userId = generateTestUserId();
            await ensureUser(userId);
            const series = await createAndInsertTestSeries(sql, {
                title: 'Lantern Bay',
                tmdbId: 880001,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await upsertExcludedSeries.execute(sql, {
                userId,
                seriesName: 'ignored label',
                mediaId: series.seriesId.toUpperCase(),
            });

            const [row] = await getExcludedSeries.all(sql, { userId });
            expect(row).toMatchObject({
                kind: 'series',
                media_id: series.seriesId,
                tmdb_id: null,
                series_name: 'Lantern Bay',
            });
        });

        it('labels a TMDB row from the catalog, then the arr projection, then the id', async () => {
            const userId = generateTestUserId();
            await ensureUser(userId);
            const movie = await createAndInsertTestMovie(sql, {
                title: 'Quiet Harbor',
                tmdbId: 880002,
            });
            await sql`
                INSERT INTO upcoming_releases
                    (source, source_item_id, media_type, tmdb_id, series_title, title, air_date)
                VALUES ('sonarr', 1, 'episode', 880003, 'Unlisted Show', 'Pilot', '2026-11-01')`;
            for (const [kind, id] of [
                ['movie', String(movie.tmdbId)],
                ['tv', '880003'],
                ['tv', '880004'],
            ] as const) {
                await upsertExcludedSeries.execute(sql, {
                    userId,
                    seriesName: 'label from client',
                    tmdbId: id,
                    tmdbType: kind,
                });
            }

            const rows = await getExcludedSeries.all(sql, { userId });
            const byTmdb = new Map(rows.map((r) => [`${r.kind}:${r.tmdb_id}`, r]));
            expect(byTmdb.get(`tmdb_movie:${movie.tmdbId}`)?.series_name).toBe('Quiet Harbor');
            expect(byTmdb.get('tmdb_tv:880003')?.series_name).toBe('Unlisted Show');
            expect(byTmdb.get('tmdb_tv:880004')?.series_name).toBe('TMDB 880004');
        });

        it('removes exactly one row by id and only for its owner', async () => {
            const owner = generateTestUserId();
            const other = generateTestUserId();
            await ensureUser(owner);
            await ensureUser(other);
            await muteTmdbTv(owner, 'A', '3001');
            await muteTmdbTv(owner, 'B', '3002');
            const [rowA] = (await getExcludedSeries.all(sql, { userId: owner })).filter(
                (r) => r.tmdb_id === '3001',
            );

            expect(await removeExcludedSeriesById.all(sql, { userId: other, id: rowA.id })).toEqual(
                [],
            );
            expect(await removeExcludedSeriesById.all(sql, { userId: owner, id: rowA.id })).toEqual(
                [{ id: rowA.id }],
            );
            const left = await getExcludedSeries.all(sql, { userId: owner });
            expect(left.map((r) => r.tmdb_id)).toEqual(['3002']);
        });

        it('resolves TMDB ids to catalog items only within the same media type', async () => {
            const series = await createAndInsertTestSeries(sql, {
                tmdbId: 880010,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const movie = await createAndInsertTestMovie(sql, { tmdbId: 880010 });

            const tvOnly = await resolveTmdbToCatalogIds.all(sql, {
                tvIds: ['880010'],
                movieIds: [],
            });
            expect(tvOnly.map((r) => r.id)).toEqual([series.seriesId]);

            const movieOnly = await resolveTmdbToCatalogIds.all(sql, {
                tvIds: [],
                movieIds: ['880010'],
            });
            expect(movieOnly.map((r) => r.id)).toEqual([movie.id]);
        });

        it('resolves catalog ids back to their TMDB id and type', async () => {
            const series = await createAndInsertTestSeries(sql, {
                tmdbId: 880011,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await sql`DELETE FROM external_ids WHERE media_id = ${series.seriesId}::uuid AND provider <> 'tmdb'`;
            const rows = await resolveCatalogIdsToExternal.all(sql, { ids: [series.seriesId] });
            expect(rows).toEqual([{ provider: 'tmdb', external_id: '880011', media_type: 'tv' }]);
        });

        it('also returns the TVDB id of a series, and nothing for an item without ids', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await sql`DELETE FROM external_ids WHERE media_id = ${series.seriesId}::uuid`;
            expect(await resolveCatalogIdsToExternal.all(sql, { ids: [series.seriesId] })).toEqual(
                [],
            );
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${series.seriesId}::uuid, 'tvdb', '81189', 'tv')
            `;
            expect(await resolveCatalogIdsToExternal.all(sql, { ids: [series.seriesId] })).toEqual([
                { provider: 'tvdb', external_id: '81189', media_type: 'tv' },
            ]);
        });
    });
});
