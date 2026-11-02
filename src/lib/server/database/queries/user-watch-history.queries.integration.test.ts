// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Watch History Query Module
 *
 * Tests watch history lookups, embedding joins, and counts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    createTestMovieBatch,
    createTestWatchStateEntry,
    insertTestWatchStateEntry,
    insertTestWatchState,
    generateTestUserId,
    createTestEmbedding,
    insertTestEmbedding,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';

// Import query functions to test
import {
    getWatchedItems,
    getWatchedMovies,
    getWatchedTvShows,
    getRecentWatchedMoviesWithEmbeddings,
    getRecentWatchedTvWithEmbeddings,
    getRecentWatchedWithTitles,
    getWatchedCount,
    getWatchedMovieCount,
    getWatchedTvCount,
} from './user-watch-history.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type { UserId } from '$lib/shared/user-id';

describe('User Watch History Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    });

    // ==========================================================================
    // Basic Watch History Queries
    // ==========================================================================

    describe('getWatchedItems', () => {
        it('returns distinct watched items with TMDB ID and media type', async () => {
            const userId = generateTestUserId();

            const movie1 = await createAndInsertTestMovie(sql, {
                tmdbId: 700001,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                tmdbId: 700002,
            });
            const tvShow = await createAndInsertTestTvShow(sql, {
                tmdbId: 700003,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, movie1.id),
                createTestWatchStateEntry(userId, movie2.id),
                createTestWatchStateEntry(userId, tvShow.id),
            ]);

            const result = await getWatchedItems.all(sql, { userId, access: unrestrictedAccess() });

            expect(result.length).toBe(3);

            const tmdbIds = result.map((r) => r.tmdb_id).sort((a, b) => a.localeCompare(b));
            expect(tmdbIds).toEqual(['700001', '700002', '700003']);

            const movieCount = result.filter((r) => r.media_type === 'movie').length;
            const tvCount = result.filter((r) => r.media_type === 'tv').length;
            expect(movieCount).toBe(2);
            expect(tvCount).toBe(1);
        });

        it('returns empty array for user with no watch history', async () => {
            const userId = generateTestUserId();

            const result = await getWatchedItems.all(sql, { userId, access: unrestrictedAccess() });

            expect(result).toEqual([]);
        });
    });

    describe('getWatchedMovies', () => {
        it('returns only movies from watch history', async () => {
            const userId = generateTestUserId();

            const movie1 = await createAndInsertTestMovie(sql, {
                tmdbId: 700010,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                tmdbId: 700011,
            });
            const tvShow = await createAndInsertTestTvShow(sql, {
                tmdbId: 700012,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, movie1.id),
                createTestWatchStateEntry(userId, movie2.id),
                createTestWatchStateEntry(userId, tvShow.id),
            ]);

            const result = await getWatchedMovies.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
            result.forEach((r) => {
                expect(r.media_type).toBe('movie');
            });
        });

        it('respects limit parameter', async () => {
            const userId = generateTestUserId();
            const movies = await createTestMovieBatch(sql, 5);

            await insertTestWatchState(
                sql,
                movies.map((m) => createTestWatchStateEntry(userId, m.id)),
            );

            const result = await getWatchedMovies.all(sql, {
                userId,
                limit: 3,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(3);
        });
    });

    describe('getWatchedTvShows', () => {
        it('returns only TV shows from watch history', async () => {
            const userId = generateTestUserId();

            const movie = await createAndInsertTestMovie(sql, {
                tmdbId: 700020,
            });
            const tvShow1 = await createAndInsertTestTvShow(sql, {
                tmdbId: 700021,
            });
            const tvShow2 = await createAndInsertTestTvShow(sql, {
                tmdbId: 700022,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, movie.id),
                createTestWatchStateEntry(userId, tvShow1.id),
                createTestWatchStateEntry(userId, tvShow2.id),
            ]);

            const result = await getWatchedTvShows.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
            result.forEach((r) => {
                expect(r.media_type).toBe('tv');
            });
        });
    });

    // ==========================================================================
    // "Because You Watched" Source Queries
    // ==========================================================================

    describe('getRecentWatchedMoviesWithEmbeddings', () => {
        it('returns only movies with embeddings', async () => {
            const userId = generateTestUserId();

            const movieWithEmbedding = await createAndInsertTestMovie(sql, {
                tmdbId: 700030,
                withEmbedding: true,
            });
            const movieWithoutEmbedding = await createAndInsertTestMovie(sql, {
                tmdbId: 700031,
                withEmbedding: false,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, movieWithEmbedding.id),
                createTestWatchStateEntry(userId, movieWithoutEmbedding.id),
            ]);

            const result = await getRecentWatchedMoviesWithEmbeddings.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(1);
            expect(result[0].tmdb_id).toBe('700030');
        });

        it('includes title and media_id', async () => {
            const userId = generateTestUserId();

            const movie = await createAndInsertTestMovie(sql, {
                title: 'Embedded Movie Test',
                tmdbId: 700032,
                withEmbedding: true,
            });

            await insertTestWatchStateEntry(sql, createTestWatchStateEntry(userId, movie.id));

            const result = await getRecentWatchedMoviesWithEmbeddings.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(1);
            expect(result[0].title).toBe('Embedded Movie Test');
            expect(result[0].media_id).toBe(movie.id);
        });

        it('orders by watched_at DESC', async () => {
            const userId = generateTestUserId();

            const movie1 = await createAndInsertTestMovie(sql, {
                tmdbId: 700040,
                withEmbedding: true,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                tmdbId: 700041,
                withEmbedding: true,
            });

            // Insert with different timestamps
            const date1 = new Date();
            date1.setDate(date1.getDate() - 5);
            const date2 = new Date();

            await insertTestWatchStateEntry(
                sql,
                createTestWatchStateEntry(userId, movie1.id, date1),
            );
            await insertTestWatchStateEntry(
                sql,
                createTestWatchStateEntry(userId, movie2.id, date2),
            );

            const result = await getRecentWatchedMoviesWithEmbeddings.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result[0].tmdb_id).toBe('700041'); // More recent
        });
    });

    describe('getRecentWatchedTvWithEmbeddings', () => {
        it('returns only TV shows with embeddings', async () => {
            const userId = generateTestUserId();

            const tvWithEmbedding = await createAndInsertTestTvShow(sql, {
                tmdbId: 700050,
                withEmbedding: true,
            });
            const tvWithoutEmbedding = await createAndInsertTestTvShow(sql, {
                tmdbId: 700051,
                withEmbedding: false,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, tvWithEmbedding.id),
                createTestWatchStateEntry(userId, tvWithoutEmbedding.id),
            ]);

            const result = await getRecentWatchedTvWithEmbeddings.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(1);
            expect(result[0].tmdb_id).toBe('700050');
            expect(result[0].media_type).toBe('tv');
        });
    });

    describe('getRecentWatchedWithTitles', () => {
        it('returns both movies and TV with titles', async () => {
            const userId = generateTestUserId();

            const movie = await createAndInsertTestMovie(sql, {
                title: 'Test Movie Title',
                tmdbId: 700060,
            });
            const tvShow = await createAndInsertTestTvShow(sql, {
                title: 'Test TV Title',
                tmdbId: 700061,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, movie.id),
                createTestWatchStateEntry(userId, tvShow.id),
            ]);

            const result = await getRecentWatchedWithTitles.all(sql, {
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
            const titles = result.map((r) => r.title).sort();
            expect(titles).toEqual(['Test Movie Title', 'Test TV Title'].sort());
        });
    });

    // ==========================================================================
    // Watch History Count Queries
    // ==========================================================================

    describe('getWatchedCount', () => {
        it('returns total distinct watched count', async () => {
            const userId = generateTestUserId();
            const movies = await createTestMovieBatch(sql, 5);
            const tvShow = await createAndInsertTestTvShow(sql, {
                tmdbId: 700070,
            });

            await insertTestWatchState(sql, [
                ...movies.map((m) => createTestWatchStateEntry(userId, m.id)),
                createTestWatchStateEntry(userId, tvShow.id),
            ]);

            const result = await getWatchedCount.one(sql, { userId, access: unrestrictedAccess() });

            expect(result?.count).toBe(6);
        });
    });

    describe('getWatchedMovieCount', () => {
        it('returns count of watched movies only', async () => {
            const userId = generateTestUserId();

            const movies = await createTestMovieBatch(sql, 4);
            const tvShow = await createAndInsertTestTvShow(sql, {
                tmdbId: 700080,
            });

            await insertTestWatchState(sql, [
                ...movies.map((m) => createTestWatchStateEntry(userId, m.id)),
                createTestWatchStateEntry(userId, tvShow.id),
            ]);

            const result = await getWatchedMovieCount.one(sql, {
                userId,
                access: unrestrictedAccess(),
            });

            expect(result?.count).toBe(4);
        });
    });

    describe('getWatchedTvCount', () => {
        it('returns count of watched TV shows only', async () => {
            const userId = generateTestUserId();

            const movie = await createAndInsertTestMovie(sql, {
                tmdbId: 700090,
            });
            const tvShow1 = await createAndInsertTestTvShow(sql, {
                tmdbId: 700091,
            });
            const tvShow2 = await createAndInsertTestTvShow(sql, {
                tmdbId: 700092,
            });

            await insertTestWatchState(sql, [
                createTestWatchStateEntry(userId, movie.id),
                createTestWatchStateEntry(userId, tvShow1.id),
                createTestWatchStateEntry(userId, tvShow2.id),
            ]);

            const result = await getWatchedTvCount.one(sql, {
                userId,
                access: unrestrictedAccess(),
            });

            expect(result?.count).toBe(2);
        });
    });
    // ==========================================================================
    // Access boundary — differential
    // ==========================================================================

    /**
     * Every query in this module takes a REQUIRED {@link MediaAccessBoundary},
     * but only three of them can enforce one. The two groups are asserted
     * differently on purpose — see the module docstring for why the split exists.
     *
     * ENFORCING (`getRecentWatched*WithEmbeddings`, `getRecentWatchedWithTitles`)
     * join `media_items` as `mi`. Each is run over the SAME fixture three ways:
     *
     *   1. `unrestrictedAccess()` — POSITIVE CONTROL. Must return BOTH rows.
     *      Without it an unreachable fixture returns nothing and every restricted
     *      assertion below passes vacuously.
     *   2. deny the denied row's library group — a STRICT SUBSET: the allowed row
     *      survives, the denied row does not.
     *   3. `denyAllAccess()` — EMPTY.
     *
     * This is what catches a boundary that arrived but was never spliced into the
     * SQL (cases 2 and 3 would match case 1), and a predicate bound to the wrong
     * alias: `buildLibraryAccessFilter` hardcodes `mi` and `buildAgeRatingFilter`
     * defaults to it, so a mis-aliased query raises "missing FROM-clause entry for
     * table mi" — but ONLY under a restricted boundary, because both builders emit
     * an empty fragment for `all`/`any`. An unrestricted-only test proves nothing.
     *
     * The age axis is asserted independently of the library axis, so a query that
     * threads `library` correctly while dropping `age` (or vice versa) still fails.
     *
     * NON-ENFORCING (`getWatchedItems`, `getWatchedMovies`, `getWatchedTvShows`,
     * and the three counts) have no `media_items` row to bind to. They are
     * asserted on the two states they CAN honour: `denyAll` empties the result,
     * and a restricted boundary REJECTS rather than silently returning unfiltered
     * rows. The rejection test is the one that matters — it is what stops someone
     * later passing a real user's boundary here and believing it took effect.
     */
    describe('access boundary is honoured (differential)', () => {
        let boundaryUser: UserId;
        let groupA: string;
        let nextTmdbId = 790000;

        /** Boundary denying exactly the given library groups; age unrestricted. */
        function denyGroups(...ids: string[]): MediaAccessBoundary {
            return restrictedAccess({
                deniedGroupIds: ids,
                maxAgeRating: null,
                allowUnrated: true,
            });
        }

        /** Boundary limiting age only; library unrestricted. */
        function limitAge(maxAgeRating: number, allowUnrated: boolean): MediaAccessBoundary {
            return restrictedAccess({ deniedGroupIds: [], maxAgeRating, allowUnrated });
        }

        /**
         * Seed one watched media item.
         *
         * `libraryGroupId` is what makes the library predicate able to exclude the
         * row. Placement goes through `placeInLibraryGroup`, which puts the file
         * where the predicate actually looks — directly for a leaf type such as
         * `movie`, on a generated season/episode descendant for the `tv`
         * container, whose own files the predicate never inspects. An item with
         * no files at all is the natural "always allowed" control, since the
         * predicate unconditionally admits those.
         */
        async function seedWatched(opts: {
            mediaType: 'movie' | 'tv';
            libraryGroupId?: string;
            ageRating?: number | null;
            withEmbedding?: boolean;
        }): Promise<{ id: string; tmdbId: string }> {
            const id = crypto.randomUUID();
            const tmdbId = String(nextTmdbId++);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, age_rating)
                VALUES (
                    ${id}::uuid,
                    ${`Boundary ${tmdbId}`},
                    ${opts.mediaType},
                    'active',
                    ${Boolean(opts.libraryGroupId)},
                    ${opts.ageRating ?? null}
                )
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (
                    ${id}::uuid,
                    ${getPrimaryExternalIdProvider()},
                    ${tmdbId},
                    ${opts.mediaType},
                    true
                )
            `;
            await insertTestWatchStateEntry(sql, createTestWatchStateEntry(boundaryUser, id));
            if (opts.withEmbedding) {
                await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
            }
            if (opts.libraryGroupId) {
                await placeInLibraryGroup(sql, {
                    mediaItemId: id,
                    mediaType: opts.mediaType,
                    libraryGroupId: opts.libraryGroupId,
                });
            }
            return { id, tmdbId };
        }

        /**
         * The shared differential assertions. `deniedKey` sits in groupA;
         * `allowedKey` has no files at all. `run` must surface both under an
         * unrestricted boundary.
         */
        async function assertBoundaryHonoured(
            run: (access: MediaAccessBoundary) => Promise<string[]>,
            deniedKey: string,
            allowedKey: string,
        ): Promise<void> {
            // 1. Positive control — the fixture is reachable at all.
            const open = await run(unrestrictedAccess());
            expect(open, 'unrestricted boundary must surface both rows').toEqual(
                expect.arrayContaining([deniedKey, allowedKey]),
            );

            // 2. Strict subset — the allowed row survives, the denied row is gone.
            const restricted = await run(denyGroups(groupA));
            expect(restricted).toContain(allowedKey);
            expect(restricted).not.toContain(deniedKey);
            expect(restricted.length).toBeLessThan(open.length);
            for (const key of restricted) expect(open).toContain(key);

            // 3. denyAll returns nothing at all.
            expect(await run(denyAllAccess())).toEqual([]);
        }

        // Each test gets its OWN library group id, and only groups this describe
        // block created are cleaned up. A blanket `DELETE FROM library_groups`
        // fails against a shared test DB — `library_paths` references it with
        // ON DELETE RESTRICT, and those rows survive the media truncation.
        const GROUP_NAME = 'Denied Watch History Group';

        beforeEach(async () => {
            boundaryUser = generateTestUserId();
            groupA = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupA}::uuid, ${GROUP_NAME})
            `;
        });

        afterAll(async () => {
            await sql`DELETE FROM library_groups WHERE name = ${GROUP_NAME}`;
        });

        // ---- Enforcing queries ------------------------------------------------

        it('getRecentWatchedMoviesWithEmbeddings honours the library axis', async () => {
            const denied = await seedWatched({
                mediaType: 'movie',
                withEmbedding: true,
                libraryGroupId: groupA,
            });
            const allowed = await seedWatched({ mediaType: 'movie', withEmbedding: true });

            await assertBoundaryHonoured(
                async (access) =>
                    (
                        await getRecentWatchedMoviesWithEmbeddings.all(sql, {
                            userId: boundaryUser,
                            limit: 50,
                            access,
                        })
                    ).map((r) => r.media_id),
                denied.id,
                allowed.id,
            );
        });

        it('getRecentWatchedMoviesWithEmbeddings honours the age axis independently', async () => {
            const adult = await seedWatched({
                mediaType: 'movie',
                withEmbedding: true,
                ageRating: 18,
            });
            const family = await seedWatched({
                mediaType: 'movie',
                withEmbedding: true,
                ageRating: 6,
            });

            const run = async (access: MediaAccessBoundary): Promise<string[]> =>
                (
                    await getRecentWatchedMoviesWithEmbeddings.all(sql, {
                        userId: boundaryUser,
                        limit: 50,
                        access,
                    })
                ).map((r) => r.media_id);

            expect(await run(unrestrictedAccess())).toEqual(
                expect.arrayContaining([adult.id, family.id]),
            );

            const limited = await run(limitAge(12, true));
            expect(limited).toContain(family.id);
            expect(limited).not.toContain(adult.id);
        });

        it('getRecentWatchedTvWithEmbeddings honours the library axis', async () => {
            const denied = await seedWatched({
                mediaType: 'tv',
                withEmbedding: true,
                libraryGroupId: groupA,
            });
            const allowed = await seedWatched({ mediaType: 'tv', withEmbedding: true });

            await assertBoundaryHonoured(
                async (access) =>
                    (
                        await getRecentWatchedTvWithEmbeddings.all(sql, {
                            userId: boundaryUser,
                            limit: 50,
                            access,
                        })
                    ).map((r) => r.media_id),
                denied.id,
                allowed.id,
            );
        });

        it('getRecentWatchedWithTitles honours the library axis', async () => {
            const denied = await seedWatched({ mediaType: 'movie', libraryGroupId: groupA });
            const allowed = await seedWatched({ mediaType: 'tv' });

            await assertBoundaryHonoured(
                async (access) =>
                    (
                        await getRecentWatchedWithTitles.all(sql, {
                            userId: boundaryUser,
                            limit: 50,
                            access,
                        })
                    ).map((r) => r.tmdb_id),
                denied.tmdbId,
                allowed.tmdbId,
            );
        });

        it('getRecentWatchedWithTitles honours the age axis, including allowUnrated', async () => {
            const unrated = await seedWatched({ mediaType: 'movie', ageRating: null });
            const family = await seedWatched({ mediaType: 'movie', ageRating: 6 });

            const run = async (access: MediaAccessBoundary): Promise<string[]> =>
                (
                    await getRecentWatchedWithTitles.all(sql, {
                        userId: boundaryUser,
                        limit: 50,
                        access,
                    })
                ).map((r) => r.tmdb_id);

            // allowUnrated: true keeps the NULL-age-rating row.
            expect(await run(limitAge(12, true))).toEqual(
                expect.arrayContaining([unrated.tmdbId, family.tmdbId]),
            );

            // allowUnrated: false drops it — proving allowUnrated is actually
            // bound and not hardcoded on the way through the boundary.
            const strict = await run(limitAge(12, false));
            expect(strict).toContain(family.tmdbId);
            expect(strict).not.toContain(unrated.tmdbId);
        });

        // ---- Non-enforcing queries -------------------------------------------

        it('denyAll empties every non-enforcing query', async () => {
            await seedWatched({ mediaType: 'movie' });
            await seedWatched({ mediaType: 'tv' });

            const userId = boundaryUser;
            const deny = denyAllAccess();

            expect(await getWatchedItems.all(sql, { userId, access: deny })).toEqual([]);
            expect(await getWatchedMovies.all(sql, { userId, limit: 50, access: deny })).toEqual(
                [],
            );
            expect(await getWatchedTvShows.all(sql, { userId, limit: 50, access: deny })).toEqual(
                [],
            );
            expect((await getWatchedCount.one(sql, { userId, access: deny }))?.count).toBe(0);
            expect((await getWatchedMovieCount.one(sql, { userId, access: deny }))?.count).toBe(0);
            expect((await getWatchedTvCount.one(sql, { userId, access: deny }))?.count).toBe(0);

            // Positive control: the same fixture IS reachable unrestricted, so the
            // assertions above are not passing on an empty fixture.
            const open = unrestrictedAccess();
            expect(
                (await getWatchedItems.all(sql, { userId, access: open })).length,
            ).toBeGreaterThan(0);
            expect((await getWatchedCount.one(sql, { userId, access: open }))?.count).toBe(2);
        });

        it('non-enforcing queries REJECT a restricted boundary instead of ignoring it', async () => {
            await seedWatched({ mediaType: 'movie', libraryGroupId: groupA });

            const userId = boundaryUser;
            const restricted = denyGroups(groupA);
            const aged = limitAge(12, true);

            await expect(getWatchedItems.all(sql, { userId, access: restricted })).rejects.toThrow(
                /cannot enforce a restricted MediaAccessBoundary/,
            );
            await expect(
                getWatchedMovies.all(sql, { userId, limit: 50, access: restricted }),
            ).rejects.toThrow(/cannot enforce a restricted MediaAccessBoundary/);
            await expect(
                getWatchedTvShows.all(sql, { userId, limit: 50, access: restricted }),
            ).rejects.toThrow(/cannot enforce a restricted MediaAccessBoundary/);
            await expect(getWatchedCount.one(sql, { userId, access: restricted })).rejects.toThrow(
                /cannot enforce a restricted MediaAccessBoundary/,
            );
            await expect(
                getWatchedMovieCount.one(sql, { userId, access: restricted }),
            ).rejects.toThrow(/cannot enforce a restricted MediaAccessBoundary/);
            // The age axis is rejected too, not just the library axis.
            await expect(getWatchedTvCount.one(sql, { userId, access: aged })).rejects.toThrow(
                /cannot enforce a restricted MediaAccessBoundary/,
            );
        });
    });
});
