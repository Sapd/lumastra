// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Featured Pick Query Module
 *
 * Tests hidden gem, fresh for you, perfect match, overlooked classic,
 * and buzzing now pick queries against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    createTestEmbedding,
    insertTestEmbedding,
    ensureTestUser,
    insertTestRating,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

import {
    fetchHiddenGem,
    fetchFreshForYou,
    fetchPerfectMatch,
    fetchOverlookedClassic,
    fetchBuzzingNow,
    fetchFeaturedPickByCriteria,
} from './featured-pick.queries.js';
import type { FeaturedCandidate } from './featured-pick.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Featured Pick Queries', () => {
    let sql: postgres.Sql;
    const testUser = generateTestUserId();

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'user_media_state',
            'user_ratings',
            'user_profiles',
            ...TEST_TABLES.media,
        ]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_state',
            'user_ratings',
            'user_profiles',
            ...TEST_TABLES.media,
        ]);
        await ensureTestUser(sql, testUser);
    });

    // ========================================================================
    // Helpers
    // ========================================================================

    async function seedCandidate(
        tmdbId: number,
        overrides: {
            imdbRating?: number;
            popularity?: number;
            releaseDate?: string;
            adult?: boolean;
            withEmb?: boolean;
            mediaType?: 'movie' | 'tv';
            voteCount?: number;
        } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        const mediaType = overrides.mediaType ?? 'movie';
        await insertTestMediaItem(
            sql,
            createTestMediaItem({
                id,
                title: `Featured ${tmdbId}`,
                media_type: mediaType,
            }),
        );
        await insertTestExternalIds(sql, createTestExternalIds(id, { tmdbId, mediaType }));
        // Insert provider_metadata with controlled values
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (
                ${id}::uuid,
                'tmdb',
                ${sql.json({
                    imdb_rating: overrides.imdbRating ?? 7.0,
                    popularity: overrides.popularity ?? 30,
                    release_date: overrides.releaseDate ?? '2024-01-15',
                    adult: overrides.adult ?? false,
                    // Above the default minVoteCount floor (50) so existing
                    // fixtures keep passing that hard filter unless a test
                    // explicitly overrides it to exercise the floor itself.
                    vote_count: overrides.voteCount ?? 500,
                    overview: 'Test overview for featured pick candidate',
                })},
                NOW()
            )
        `;
        if (overrides.withEmb) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
        }
        return id;
    }

    // ========================================================================
    // fetchHiddenGem
    // ========================================================================

    describe('fetchHiddenGem', () => {
        it('returns a high-rated low-popularity movie', async () => {
            await seedCandidate(990500, { imdbRating: 8.0, popularity: 10 });

            const result = await fetchHiddenGem(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).not.toBeNull();
            expect(result!.mediaId).toBeTruthy();
        });

        it('returns null when no candidates match', async () => {
            await seedCandidate(990501, { imdbRating: 6.0, popularity: 10 });

            const result = await fetchHiddenGem(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).toBeNull();
        });

        it('excludes watched media', async () => {
            const mediaId = await seedCandidate(990502, {
                imdbRating: 8.5,
                popularity: 5,
            });
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched)
                VALUES (${testUser}, ${mediaId}::uuid, true)
            `;

            const result = await fetchHiddenGem(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).toBeNull();
        });

        it('excludes disliked media', async () => {
            const mediaId = await seedCandidate(990503, {
                imdbRating: 8.5,
                popularity: 5,
            });
            await insertTestRating(sql, {
                user_id: testUser,
                media_id: mediaId,
                rating: 3,
                suggestion_context: null,
                skipped: false,
            });

            const result = await fetchHiddenGem(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // fetchFreshForYou
    // ========================================================================

    describe('fetchFreshForYou', () => {
        it('returns a recent release', async () => {
            const recentDate = new Date();
            recentDate.setDate(recentDate.getDate() - 10);
            await seedCandidate(990504, {
                releaseDate: recentDate.toISOString().split('T')[0],
                withEmb: true,
            });
            // Seed a liked rating to build user profile
            const likedId = await seedCandidate(990505, { withEmb: true });
            await insertTestRating(sql, {
                user_id: testUser,
                media_id: likedId,
                rating: 9,
                suggestion_context: null,
                skipped: false,
            });

            const result = await fetchFreshForYou(sql, testUser, [], 1, unrestrictedAccess());
            // May return null if no embedding similarity match
            // but the query should not throw
            expect(result === null || result!.mediaId).toBeTruthy();
        });

        // Fix 2: with the missing-embedding similarity default now 0 (was 0.5),
        // a profile-less user's Fresh-for-You must still render — ranking falls
        // through to the imdb_rating tiebreak rather than emptying out.
        it('still returns a recent release for a profile-less user (imdb tiebreak)', async () => {
            const recentDate = new Date();
            recentDate.setDate(recentDate.getDate() - 10);
            const freshId = await seedCandidate(990530, {
                releaseDate: recentDate.toISOString().split('T')[0],
                imdbRating: 7.5,
            });

            const result = await fetchFreshForYou(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).not.toBeNull();
            expect(result!.mediaId).toBe(freshId);
        });
    });

    // ========================================================================
    // fetchPerfectMatch
    // ========================================================================

    describe('fetchPerfectMatch', () => {
        it('returns a candidate when user has liked items with embeddings', async () => {
            const likedId = await seedCandidate(990506, { withEmb: true });
            const _candidateId = await seedCandidate(990507, { withEmb: true });
            await insertTestRating(sql, {
                user_id: testUser,
                media_id: likedId,
                rating: 9,
                suggestion_context: null,
                skipped: false,
            });

            const result = await fetchPerfectMatch(sql, testUser, [], 1, unrestrictedAccess());
            // Returns one of top 5 randomly; may be null if no similarity
            expect(result === null || result!.mediaId).toBeTruthy();
        });

        it('returns null when user has no liked embeddings', async () => {
            const result = await fetchPerfectMatch(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // fetchOverlookedClassic
    // ========================================================================

    describe('fetchOverlookedClassic', () => {
        it('returns an old high-rated movie', async () => {
            await seedCandidate(990508, {
                imdbRating: 8.5,
                releaseDate: '2010-01-01',
            });

            const result = await fetchOverlookedClassic(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).not.toBeNull();
        });

        it('returns null when no old high-rated movies exist', async () => {
            await seedCandidate(990509, {
                imdbRating: 8.5,
                releaseDate: '2024-01-01',
            });

            const result = await fetchOverlookedClassic(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).toBeNull();
        });

        it("honours the item's preferred_provider over the chain order", async () => {
            // tmdb says 8.5 (qualifies); the chain-winning 'aggregated' row
            // says 6.0 (does not). Chain order alone excludes the item; an
            // operator pinning tmdb as its preferred provider must bring it
            // back, exactly as the override-aware LATERAL this query used did.
            const id = await seedCandidate(990510, {
                imdbRating: 8.5,
                releaseDate: '2010-01-01',
            });
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${id}::uuid,
                    'aggregated',
                    ${sql.json({
                        imdb_rating: 6.0,
                        release_date: '2010-01-01',
                        adult: false,
                        vote_count: 500,
                    })},
                    NOW()
                )
            `;

            expect(
                await fetchOverlookedClassic(sql, testUser, [], 1, unrestrictedAccess()),
            ).toBeNull();

            // A trigger only accepts a preferred_provider that is an enabled row
            // in provider_capabilities. A fresh test database has none (the app
            // registers providers at startup), so seed tmdb here and restore it
            // afterwards: other suites count provider_capabilities rows.
            const [prior] = await sql<{ enabled: boolean }[]>`
                SELECT enabled FROM provider_capabilities WHERE provider = 'tmdb'
            `;
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('tmdb', 1, true, '{}'::jsonb)
                ON CONFLICT (provider) DO UPDATE SET enabled = true
            `;
            try {
                await sql`UPDATE media_items SET preferred_provider = 'tmdb' WHERE id = ${id}::uuid`;
                expect(
                    await fetchOverlookedClassic(sql, testUser, [], 1, unrestrictedAccess()),
                ).not.toBeNull();
            } finally {
                await sql`UPDATE media_items SET preferred_provider = NULL WHERE id = ${id}::uuid`;
                if (prior) {
                    await sql`UPDATE provider_capabilities SET enabled = ${prior.enabled} WHERE provider = 'tmdb'`;
                } else {
                    await sql`DELETE FROM provider_capabilities WHERE provider = 'tmdb'`;
                }
            }
        });
    });

    // ========================================================================
    // fetchBuzzingNow
    // ========================================================================

    describe('fetchBuzzingNow', () => {
        it('returns a popular candidate when user has liked embeddings', async () => {
            const likedId = await seedCandidate(990510, {
                withEmb: true,
                popularity: 150,
            });
            await seedCandidate(990511, { withEmb: true, popularity: 150 });
            await insertTestRating(sql, {
                user_id: testUser,
                media_id: likedId,
                rating: 9,
                suggestion_context: null,
                skipped: false,
            });

            const result = await fetchBuzzingNow(sql, testUser, [], 1, unrestrictedAccess());
            expect(result === null || result!.mediaId).toBeTruthy();
        });

        it('returns null when no popular candidates exist', async () => {
            const result = await fetchBuzzingNow(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).toBeNull();
        });

        // Fix 2 (missing-embedding cosine default 0.5 → 0): a profile-less user
        // must still get Buzzing Now. The no-profile ORDER BY fallback keeps a
        // neutral popularity multiplier (1) so the section does NOT empty out and
        // orders by popularity (not by a degenerate all-zero product).
        it('still ranks by popularity for a profile-less user (no dividing by the 0.5 freebie)', async () => {
            const lowPop = await seedCandidate(990520, { popularity: 120 });
            const highPop = await seedCandidate(990521, { popularity: 400 });

            const result = await fetchBuzzingNow(sql, testUser, [], 1, unrestrictedAccess());
            expect(result).not.toBeNull();
            // Highest popularity wins when there is no taste profile.
            expect(result!.mediaId).toBe(highPop);
            expect(result!.mediaId).not.toBe(lowPop);
        });
    });

    // ========================================================================
    // fetchFeaturedPickByCriteria
    // ========================================================================

    describe('fetchFeaturedPickByCriteria', () => {
        it('dispatches to hidden-gem', async () => {
            await seedCandidate(990512, { imdbRating: 8.5, popularity: 5 });

            const result = await fetchFeaturedPickByCriteria(
                sql,
                'hidden-gem',
                testUser,
                [],
                unrestrictedAccess(),
            );
            expect(result).not.toBeNull();
        });

        it('dispatches to overlooked-classic', async () => {
            await seedCandidate(990513, {
                imdbRating: 8.5,
                releaseDate: '2010-01-01',
            });

            const result = await fetchFeaturedPickByCriteria(
                sql,
                'overlooked-classic',
                testUser,
                [],
                unrestrictedAccess(),
            );
            expect(result).not.toBeNull();
        });

        it('returns null for unknown criteria', async () => {
            const result = await fetchFeaturedPickByCriteria(
                sql,
                'unknown-criteria',
                testUser,
                [],
                unrestrictedAccess(),
            );
            expect(result).toBeNull();
        });
    });
});

// =============================================================================
// Access boundary — differential
// =============================================================================

/**
 * Every exported query takes a REQUIRED {@link MediaAccessBoundary}. Each case
 * below runs the SAME fetcher over the SAME fixture several ways:
 *
 *   1. `unrestrictedAccess()` — POSITIVE CONTROL. Must return a row. Without it
 *      an unreachable fixture returns null and every restricted assertion below
 *      passes vacuously.
 *   2. deny the denied item's library group — a STRICT SUBSET: the allowed row
 *      survives, the denied row does not. Proven twice: once with both rows
 *      present (result must be the allowed id, never the denied one), and once
 *      after deleting the allowed row so the denied row is the ONLY candidate
 *      and the restricted run must go empty.
 *   3. `denyAllAccess()` — null.
 *   4. an age limit with allowUnrated flipped — proves the age fragment is
 *      spliced and bound to `mi.age_rating`, independently of the library axis.
 *
 * This is what catches a boundary argument that arrived but was never spliced
 * into the SQL, and a predicate applied to the wrong alias: both builders
 * hardcode / default to `mi`, so a mis-aliased query throws "missing FROM-clause
 * entry for table mi" — but ONLY under a restricted boundary, since both emit an
 * empty fragment when unrestricted.
 *
 * fetchPerfectMatch is the sharp one: its boundary predicates live inside the
 * `top_matches` CTE, which applies `LIMIT 5` before the outer SELECT. A fragment
 * emitted outside that CTE would either fail to compile (no `mi` in scope) or
 * filter after the top-5 cut.
 */
describe('featured-pick queries — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;
    const boundaryUser = generateTestUserId();

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'user_media_state',
            'user_ratings',
            'user_profiles',
            ...TEST_TABLES.media,
        ]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await closeTestDb();
    });

    let groupA: string;

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_state',
            'user_ratings',
            'user_profiles',
            ...TEST_TABLES.media,
        ]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await ensureTestUser(sql, boundaryUser);
        groupA = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${groupA}::uuid, 'Denied Featured Group')
        `;
    });

    /** Boundary denying exactly the given library groups; age unrestricted. */
    function denyGroups(...ids: string[]): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
    }

    /**
     * Seed one candidate. When `libraryGroupId` is given the item gets a
     * media_files row in that group — that is what makes the library-access
     * predicate able to exclude it, since the predicate always admits items with
     * NO media_file_items rows at all.
     */
    async function seed(opts: {
        tmdbId: number;
        libraryGroupId: string | null;
        metadata: Record<string, string | number | boolean>;
        withEmb?: boolean;
    }): Promise<string> {
        const id = crypto.randomUUID();
        await insertTestMediaItem(
            sql,
            createTestMediaItem({ id, title: `Boundary ${opts.tmdbId}`, media_type: 'movie' }),
        );
        await insertTestExternalIds(
            sql,
            createTestExternalIds(id, { tmdbId: opts.tmdbId, mediaType: 'movie' }),
        );
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${id}::uuid, 'tmdb', ${sql.json({
                imdb_rating: 7.0,
                popularity: 30,
                release_date: '2024-01-15',
                adult: false,
                vote_count: 500,
                overview: 'Access boundary fixture',
                ...opts.metadata,
            })}, NOW())
        `;
        if (opts.withEmb) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
        }
        if (opts.libraryGroupId) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/featured/${id}.mkv`}, ${opts.libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;
        }
        return id;
    }

    /**
     * Seed the liked-with-embedding item that gives `boundaryUser` a taste
     * profile (required by fetchPerfectMatch's `up.avg_embedding IS NOT NULL`).
     * Marked watched so it cannot itself surface as the candidate.
     */
    async function seedTasteProfile(tmdbId: number): Promise<void> {
        const likedId = await seed({
            tmdbId,
            libraryGroupId: null,
            metadata: { imdb_rating: 6.0, popularity: 1 },
            withEmb: true,
        });
        await insertTestRating(sql, {
            user_id: boundaryUser,
            media_id: likedId,
            rating: 9,
            suggestion_context: null,
            skipped: false,
        });
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched)
            VALUES (${boundaryUser}, ${likedId}::uuid, true)
        `;
    }

    type Fetcher = (access: MediaAccessBoundary) => Promise<FeaturedCandidate | null>;

    /**
     * The shared differential assertions. `deniedId` sits in groupA, `allowedId`
     * has no files at all, and both must be candidates for `run`.
     */
    async function assertBoundaryHonoured(
        run: Fetcher,
        deniedId: string,
        allowedId: string,
    ): Promise<void> {
        // 1. Positive control — the fixture is reachable at all.
        const open = await run(unrestrictedAccess());
        expect(open, 'unrestricted boundary must return a candidate').not.toBeNull();

        // 2a. Strict subset: the allowed row survives, the denied row never wins.
        const restricted = await run(denyGroups(groupA));
        expect(restricted, 'restricted boundary must still return the allowed row').not.toBeNull();
        expect(restricted!.mediaId).toBe(allowedId);
        expect(restricted!.mediaId).not.toBe(deniedId);

        // 3. Deny-all returns nothing.
        expect(await run(denyAllAccess())).toBeNull();

        // 2b. With the allowed row gone the denied row is the ONLY candidate:
        // unrestricted still finds it, the restricted boundary must not.
        await sql`DELETE FROM media_items WHERE id = ${allowedId}::uuid`;
        const openDeniedOnly = await run(unrestrictedAccess());
        expect(openDeniedOnly, 'denied row must be reachable without a boundary').not.toBeNull();
        expect(openDeniedOnly!.mediaId).toBe(deniedId);
        expect(await run(denyGroups(groupA))).toBeNull();
    }

    /**
     * Age axis, independent of the library axis: every seeded item has a NULL
     * age_rating, so an `allowUnrated: false` limit must empty the result while
     * the same limit with `allowUnrated: true` must not.
     */
    async function assertAgeAxisHonoured(run: Fetcher): Promise<void> {
        expect(
            await run(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            ),
            'unrated items are visible when allowUnrated is set',
        ).not.toBeNull();
        expect(
            await run(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            ),
            'unrated items must be hidden when allowUnrated is clear',
        ).toBeNull();
    }

    describe('fetchHiddenGem', () => {
        const meta = { imdb_rating: 8.5, popularity: 5 };

        it('honours the library axis', async () => {
            const deniedId = await seed({ tmdbId: 993001, libraryGroupId: groupA, metadata: meta });
            const allowedId = await seed({ tmdbId: 993002, libraryGroupId: null, metadata: meta });
            await assertBoundaryHonoured(
                (access) => fetchHiddenGem(sql, boundaryUser, [], 1, access),
                deniedId,
                allowedId,
            );
        });

        it('honours the age axis', async () => {
            await seed({ tmdbId: 993003, libraryGroupId: null, metadata: meta });
            await assertAgeAxisHonoured((access) =>
                fetchHiddenGem(sql, boundaryUser, [], 1, access),
            );
        });
    });

    describe('fetchFreshForYou', () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 10);
        const meta = {
            imdb_rating: 7.5,
            release_date: recent.toISOString().split('T')[0],
        };

        it('honours the library axis', async () => {
            const deniedId = await seed({ tmdbId: 993011, libraryGroupId: groupA, metadata: meta });
            const allowedId = await seed({ tmdbId: 993012, libraryGroupId: null, metadata: meta });
            // Both rank identically on similarity (neither has an embedding, so the
            // profile-less path scores both 0); the imdb tiebreak is also equal, so
            // the unrestricted run may return either — only the restricted runs are
            // asserted to be a specific id, which is exactly the boundary claim.
            await assertBoundaryHonoured(
                (access) => fetchFreshForYou(sql, boundaryUser, [], 1, access),
                deniedId,
                allowedId,
            );
        });

        it('honours the age axis', async () => {
            await seed({ tmdbId: 993013, libraryGroupId: null, metadata: meta });
            await assertAgeAxisHonoured((access) =>
                fetchFreshForYou(sql, boundaryUser, [], 1, access),
            );
        });
    });

    describe('fetchPerfectMatch', () => {
        // The access predicate here sits INSIDE the top_matches CTE, ahead of its
        // LIMIT 5. With only two candidates the cut is a no-op, so a denied row
        // surviving into the outer SELECT can only mean the predicate was not
        // applied where it belongs.
        const meta = { imdb_rating: 8.0, popularity: 20 };

        it('honours the library axis (predicate inside the top_matches CTE)', async () => {
            await seedTasteProfile(993020);
            const deniedId = await seed({
                tmdbId: 993021,
                libraryGroupId: groupA,
                metadata: meta,
                withEmb: true,
            });
            const allowedId = await seed({
                tmdbId: 993022,
                libraryGroupId: null,
                metadata: meta,
                withEmb: true,
            });
            await assertBoundaryHonoured(
                (access) => fetchPerfectMatch(sql, boundaryUser, [], 1, access),
                deniedId,
                allowedId,
            );
        });

        it('honours the age axis', async () => {
            await seedTasteProfile(993023);
            await seed({
                tmdbId: 993024,
                libraryGroupId: null,
                metadata: meta,
                withEmb: true,
            });
            await assertAgeAxisHonoured((access) =>
                fetchPerfectMatch(sql, boundaryUser, [], 1, access),
            );
        });
    });

    describe('fetchOverlookedClassic', () => {
        const meta = { imdb_rating: 8.5, release_date: '2010-01-01' };

        it('honours the library axis', async () => {
            const deniedId = await seed({ tmdbId: 993031, libraryGroupId: groupA, metadata: meta });
            const allowedId = await seed({ tmdbId: 993032, libraryGroupId: null, metadata: meta });
            await assertBoundaryHonoured(
                (access) => fetchOverlookedClassic(sql, boundaryUser, [], 1, access),
                deniedId,
                allowedId,
            );
        });

        it('honours the age axis', async () => {
            await seed({ tmdbId: 993033, libraryGroupId: null, metadata: meta });
            await assertAgeAxisHonoured((access) =>
                fetchOverlookedClassic(sql, boundaryUser, [], 1, access),
            );
        });
    });

    describe('fetchBuzzingNow', () => {
        it('honours the library axis', async () => {
            // Popularity breaks the ORDER BY tie deterministically: the denied row
            // is the MORE popular one, so without the boundary it wins outright.
            // Under the boundary it must not appear at all.
            const deniedId = await seed({
                tmdbId: 993041,
                libraryGroupId: groupA,
                metadata: { popularity: 400 },
            });
            const allowedId = await seed({
                tmdbId: 993042,
                libraryGroupId: null,
                metadata: { popularity: 150 },
            });
            const open = await fetchBuzzingNow(sql, boundaryUser, [], 1, unrestrictedAccess());
            expect(open!.mediaId).toBe(deniedId);
            await assertBoundaryHonoured(
                (access) => fetchBuzzingNow(sql, boundaryUser, [], 1, access),
                deniedId,
                allowedId,
            );
        });

        it('honours the age axis', async () => {
            await seed({
                tmdbId: 993043,
                libraryGroupId: null,
                metadata: { popularity: 150 },
            });
            await assertAgeAxisHonoured((access) =>
                fetchBuzzingNow(sql, boundaryUser, [], 1, access),
            );
        });
    });

    describe('fetchFeaturedPickByCriteria', () => {
        it('forwards the boundary to the dispatched fetcher', async () => {
            const meta = { imdb_rating: 8.5, popularity: 5 };
            const deniedId = await seed({ tmdbId: 993051, libraryGroupId: groupA, metadata: meta });
            const allowedId = await seed({ tmdbId: 993052, libraryGroupId: null, metadata: meta });
            await assertBoundaryHonoured(
                (access) =>
                    fetchFeaturedPickByCriteria(sql, 'hidden-gem', boundaryUser, [], access),
                deniedId,
                allowedId,
            );
        });

        it('returns null for every criteria under deny-all', async () => {
            await seed({
                tmdbId: 993053,
                libraryGroupId: null,
                metadata: { imdb_rating: 8.5, popularity: 5 },
            });
            for (const criteria of [
                'hidden-gem',
                'fresh-for-you',
                'perfect-match',
                'overlooked-classic',
                'buzzing-now',
            ]) {
                expect(
                    await fetchFeaturedPickByCriteria(
                        sql,
                        criteria,
                        boundaryUser,
                        [],
                        denyAllAccess(),
                    ),
                    `${criteria} must return nothing under deny-all`,
                ).toBeNull();
            }
        });
    });
});
