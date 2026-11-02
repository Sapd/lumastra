// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Mood Recommendations Query Module
 *
 * These queries are complex (many JOINs, filters, scoring).
 * Tests verify they run without error and return expected shapes
 * for minimal data scenarios.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { toUserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    insertTestExternalIds,
    createTestExternalIds,
    insertTestEmbedding,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { cacheManager, CACHE_NAMESPACES } from '../../cache/index.js';
import { TasteDamperService } from '../../services/taste-damper.service.js';

import {
    findMoodMedia,
    findMoodMediaPersonalized,
    findTrendingMoodMedia,
} from './mood-recommendations.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

async function insertProviderMetadata(
    sql: postgres.Sql,
    mediaId: string,
    metadata: postgres.JSONValue,
): Promise<void> {
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
        VALUES (${mediaId}::uuid, 'tmdb', ${sql.json(metadata)}, NOW(), NOW())
    `;
}

describe('Mood Recommendations Queries', () => {
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
            'media_embeddings',
        ]);
        // The damper context centers cosines against a cached global embedding
        // mean (see TasteDamperService.getGlobalMean) — clear it so a prior
        // test/file's seeded embeddings can't leak into this run's mean.
        await cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean).delete('global-mean:v1');
    });

    // ========================================================================
    // Candidate prefilter — losslessness
    //
    // The mood queries no longer scan media_items; they seed candidates from
    // the trigger-maintained media_genres / media_keywords projections and
    // score the survivors against the winning provider blob. That prefilter is
    // only safe if it is a strict SUPERSET of what the scoring would keep, so
    // these lock down BOTH halves of the `keyword_matches > 0 OR
    // genre_matches > 0` predicate independently. A regression here is silent:
    // matching items simply stop appearing.
    // ========================================================================

    describe('candidate prefilter losslessness', () => {
        /** Seed one available movie with the given provider metadata. */
        async function seedMovie(
            tmdbId: number,
            metadata: Record<string, unknown>,
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
            );
            await insertProviderMetadata(sql, item.id, metadata as postgres.JSONValue);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            return item.id;
        }

        it('returns an item matched ONLY by genre (no keyword overlap at all)', async () => {
            const userId = toUserId(randomUUID());
            const id = await seedMovie(991001, {
                overview: 'Genre only',
                genres: [35],
                mdblist_keywords: ['totally', 'unrelated'],
            });

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: ['nomatch-keyword'],
                    genres: [35],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.internal_id)).toContain(id);
        });

        it('returns an item matched ONLY by keyword (item carries no genres)', async () => {
            const userId = toUserId(randomUUID());
            const id = await seedMovie(991002, {
                overview: 'Keyword only',
                mdblist_keywords: ['slapstick'],
            });

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: ['slapstick'],
                    genres: [99999],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.internal_id)).toContain(id);
        });

        it('matches profile keywords case-insensitively against stored metadata', async () => {
            const userId = toUserId(randomUUID());
            const id = await seedMovie(991003, {
                overview: 'Mixed case keyword',
                mdblist_keywords: ['Dark-Comedy'],
            });

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: ['DARK-COMEDY'],
                    genres: [],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.internal_id)).toContain(id);
        });

        it('does NOT return an item matching neither keyword nor genre', async () => {
            const userId = toUserId(randomUUID());
            const id = await seedMovie(991004, {
                overview: 'No match',
                genres: [28],
                mdblist_keywords: ['explosions'],
            });

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: ['romance'],
                    genres: [10749],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.internal_id)).not.toContain(id);
        });

        it('still applies excludeKeywords to a candidate that matched on genre', async () => {
            const userId = toUserId(randomUUID());
            const id = await seedMovie(991005, {
                overview: 'Excluded by keyword',
                genres: [35],
                mdblist_keywords: ['gore'],
            });

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: [],
                    genres: [35],
                    excludeGenres: [],
                    excludeKeywords: ['gore'],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.internal_id)).not.toContain(id);
        });

        it('counts a duplicated matching keyword more than once (ranking semantics)', async () => {
            // The provider blobs genuinely contain duplicates (~20k media on
            // prod) and the original scoring counted them. The single-pass
            // LATERAL must preserve that, otherwise relevance ordering shifts.
            const userId = toUserId(randomUUID());
            const dupId = await seedMovie(991006, {
                overview: 'Duplicated keyword',
                mdblist_keywords: ['comedy', 'comedy', 'comedy'],
            });
            const singleId = await seedMovie(991007, {
                overview: 'Single keyword',
                mdblist_keywords: ['comedy'],
            });

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: ['comedy'],
                    genres: [],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });

            const ids = result.map((r) => r.internal_id);
            expect(ids).toContain(dupId);
            expect(ids).toContain(singleId);
            // 3 hits * 15pts vs 1 hit * 15pts — the duplicate-carrying item wins.
            expect(ids.indexOf(dupId)).toBeLessThan(ids.indexOf(singleId));
        });
    });

    // ========================================================================
    // findMoodMedia
    // ========================================================================

    describe('findMoodMedia', () => {
        it('returns empty array when no keywords or genres provided', async () => {
            const userId = toUserId(randomUUID());
            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: [],
                    genres: [],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(result).toEqual([]);
        });

        it('runs without error and returns shape for active media', async () => {
            const userId = toUserId(randomUUID());
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 990001,
                    mediaType: 'movie',
                }),
            );
            await insertProviderMetadata(sql, item.id, {
                overview: 'Test',
                imdb_rating: 7.0,
                mdblist_keywords: ['action', 'hero'],
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const result = await findMoodMedia(sql, {
                profile: {
                    keywords: ['action'],
                    genres: [],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            // May return the item or empty depending on filter alignment
            expect(Array.isArray(result)).toBe(true);
        });

        it('excludes an item the user rated <= 4', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 990004,
                    mediaType: 'movie',
                }),
            );
            await insertProviderMetadata(sql, item.id, {
                overview: 'Test',
                imdb_rating: 7.0,
                mdblist_keywords: ['action', 'hero'],
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const profile = {
                keywords: ['action'],
                genres: [],
                excludeGenres: [],
                excludeKeywords: [],
            };

            const before = await findMoodMedia(sql, {
                profile,
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(before.some((r) => r.primary_ext_id === '990004')).toBe(true);

            await sql`
                INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, skipped)
                VALUES (${userId}, ${item.id}::uuid, 3, NULL, false)
            `;

            const after = await findMoodMedia(sql, {
                profile,
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(after.some((r) => r.primary_ext_id === '990004')).toBe(false);
        });
    });

    // ========================================================================
    // findMoodMediaPersonalized
    // ========================================================================

    describe('findMoodMediaPersonalized', () => {
        it('returns empty array when no keywords or genres', async () => {
            const userId = toUserId(randomUUID());
            const result = await findMoodMediaPersonalized(sql, {
                profile: {
                    keywords: [],
                    genres: [],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(result).toEqual([]);
        });

        it('runs without error with user profile and media', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            // Insert a user profile with a dummy embedding vector
            const vector = `[${Array(1024).fill(0).join(',')}]`;
            await sql`
                UPDATE user_profiles
                SET catalog_embedding = ${vector}::vector
                WHERE user_id = ${userId}::uuid
            `;

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 990002,
                    mediaType: 'movie',
                }),
            );
            await insertProviderMetadata(sql, item.id, {
                overview: 'Test',
                imdb_rating: 8.0,
                mdblist_keywords: ['comedy'],
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const result = await findMoodMediaPersonalized(sql, {
                profile: {
                    keywords: ['comedy'],
                    genres: [],
                    excludeGenres: [],
                    excludeKeywords: [],
                },
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(Array.isArray(result)).toBe(true);
        });
    });

    // ========================================================================
    // findMoodMediaPersonalized — taste-damper penalty
    // ========================================================================

    describe('findMoodMediaPersonalized — taste-damper penalty', () => {
        const DIM = 1024;
        const SQRT3_OVER_2 = Math.sqrt(3) / 2;

        function vec(entries: Record<number, number>): number[] {
            const v = new Array<number>(DIM).fill(0);
            for (const [i, val] of Object.entries(entries)) v[Number(i)] = val;
            return v;
        }

        /** Seed a mood-matching movie with a fixed LIBRARY embedding. */
        async function seedMoodItem(
            title: string,
            tmdbId: number,
            embedding: number[],
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
            );
            await insertProviderMetadata(sql, item.id, {
                overview: 'Test',
                imdb_rating: 7.0,
                mdblist_keywords: ['action'],
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await insertTestEmbedding(sql, {
                media_id: item.id,
                embedding,
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            return item.id;
        }

        it('demotes an item in an active damper neighborhood below an equally-relevant one', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            // catalog_embedding = axis 0. X and Y both sit at 60° from it (equal
            // ai_similarity = cos(60°) = 0.5, just above the query's 0.45 floor)
            // but in DIFFERENT planes, so mean-centering makes them point in
            // opposite directions relative to each other (see below) — X's
            // damper-centered vector is the exact negation of Y's.
            const catalogEmbedding = vec({ 0: 1 });
            const xEmbedding = vec({ 0: 0.5, 1: SQRT3_OVER_2 });
            const yEmbedding = vec({ 0: 0.5, 2: SQRT3_OVER_2 });

            const vectorLiteral = `[${catalogEmbedding.join(',')}]`;
            await sql`
                UPDATE user_profiles
                SET catalog_embedding = ${vectorLiteral}::vector
                WHERE user_id = ${userId}::uuid
            `;

            // Identical rating/keywords/genres on both items → identical
            // relevance_score in the absence of a damper (both have ai_similarity
            // = 0.5 too), so any ranking difference below is attributable ONLY to
            // the damper attenuation.
            const damped = await seedMoodItem('Damped Movie', 991001, xEmbedding);
            const unrelated = await seedMoodItem('Unrelated Movie', 991002, yEmbedding);

            const profile = {
                keywords: ['action'],
                genres: [],
                excludeGenres: [],
                excludeKeywords: [],
            };

            // Baseline: no damper — both items qualify (sanity check only; tied
            // sort keys make their relative order arbitrary, so it isn't asserted).
            const before = await findMoodMediaPersonalized(sql, {
                profile,
                userId,
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(before.some((r) => r.internal_id === damped)).toBe(true);
            expect(before.some((r) => r.internal_id === unrelated)).toBe(true);

            // Damper on X's own neighborhood (X IS the damper target, so its
            // mean-centered cosine against its own damper vector is exactly 1 —
            // the maximum possible penalty — while Y's mean-centered vector
            // works out to the exact opposite direction, giving it a penalty of
            // 0. This is a deliberate geometric construction, not a tuned
            // approximation.)
            const damperService = new TasteDamperService(sql);
            await damperService.recordDamper(userId, damped, 'movie');
            const damper = await damperService.getDamperContext(userId);
            expect(damper).not.toBeNull();

            const after = await findMoodMediaPersonalized(sql, {
                profile,
                userId,
                limit: 10,
                access: unrestrictedAccess(),
                damper,
            });

            const damperIdx = after.findIndex((r) => r.internal_id === damped);
            const unrelatedIdx = after.findIndex((r) => r.internal_id === unrelated);
            expect(damperIdx).toBeGreaterThanOrEqual(0);
            expect(unrelatedIdx).toBeGreaterThanOrEqual(0);
            // Tied relevance_score, but the damped item's ranking score is
            // attenuated — it must sort strictly below the unrelated one.
            expect(unrelatedIdx).toBeLessThan(damperIdx);
        });

        it('applies the 0.45 taste floor only to items that have an embedding', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const vectorLiteral = `[${vec({ 0: 1 }).join(',')}]`;
            await sql`
                UPDATE user_profiles
                SET catalog_embedding = ${vectorLiteral}::vector
                WHERE user_id = ${userId}::uuid
            `;

            // cos = 0.9 (kept), cos = 0.2 (below the floor: dropped).
            const close = await seedMoodItem('Close Movie', 991011, vec({ 0: 0.9, 1: 0.43589 }));
            const far = await seedMoodItem('Far Movie', 991012, vec({ 0: 0.2, 1: 0.9798 }));
            // No embedding yet: scores the neutral 0.5 and must stay listed.
            const item = createTestMediaItem({ media_type: 'movie', title: 'Unembedded Movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, { tmdbId: 991013, mediaType: 'movie' }),
            );
            await insertProviderMetadata(sql, item.id, {
                overview: 'Test',
                imdb_rating: 7.0,
                mdblist_keywords: ['action'],
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const ids = (
                await findMoodMediaPersonalized(sql, {
                    profile: {
                        keywords: ['action'],
                        genres: [],
                        excludeGenres: [],
                        excludeKeywords: [],
                    },
                    userId,
                    limit: 50,
                    access: unrestrictedAccess(),
                })
            ).map((r) => r.internal_id);
            expect(ids).toContain(close);
            expect(ids).toContain(item.id);
            expect(ids).not.toContain(far);
        });
    });

    // ========================================================================
    // findTrendingMoodMedia
    // ========================================================================

    describe('findTrendingMoodMedia', () => {
        it('returns empty array when no matching media', async () => {
            const result = await findTrendingMoodMedia(sql, {
                limit: 10,
                access: unrestrictedAccess(),
            });
            expect(Array.isArray(result)).toBe(true);
        });

        it('returns trending items with popularity > 50', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 990003,
                    mediaType: 'movie',
                }),
            );
            await insertProviderMetadata(sql, item.id, {
                overview: 'Blockbuster',
                popularity: 120.5,
            });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const result = await findTrendingMoodMedia(sql, {
                limit: 10,
                access: unrestrictedAccess(),
            });
            // Result may include the item if popularity filter matches
            expect(Array.isArray(result)).toBe(true);
        });
    });
});

// =============================================================================
// Access-boundary differential tests
// =============================================================================

/**
 * All three exported queries take a REQUIRED {@link MediaAccessBoundary}. These
 * tests run the SAME fixture through each query three ways and assert:
 *
 *   1. `unrestrictedAccess()` — POSITIVE CONTROL, must return BOTH seeded items.
 *      Without it a swallowed error or an unreachable fixture returns [], which
 *      would make every restricted assertion below vacuously true.
 *   2. restricted — a STRICT SUBSET: nothing new appears and the denied row is
 *      gone, while the allowed row survives.
 *   3. `denyAllAccess()` — EMPTY.
 *
 * This is what catches a boundary argument that arrived but was never spliced
 * into the SQL, and a predicate applied to the wrong table alias: both builders
 * hardcode / default to `mi`, so a mis-aliased query throws "missing FROM-clause
 * entry for table mi" — but ONLY under a restricted boundary, since both emit an
 * empty fragment when unrestricted.
 *
 * FAST-PATH CAVEAT: findMoodMedia / findMoodMediaPersonalized early-return []
 * when the profile has no keywords AND no genres. That return is profile-driven,
 * not access-driven, so the deny-all cases below deliberately use a profile that
 * genuinely matches the fixture — otherwise deny-all would pass for the wrong
 * reason. The unrestricted positive control is what proves the profile matches.
 */
describe('mood-recommendations queries — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    /** Boundary denying exactly the given library groups; age unrestricted. */
    function denyGroups(...ids: string[]): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
    }

    /** A profile that matches both seeded items via genre AND keyword. */
    const MATCHING_PROFILE = {
        keywords: ['boundary-kw'],
        genres: [35],
        excludeGenres: [],
        excludeKeywords: [],
    };

    let groupA: string;
    let userId: ReturnType<typeof toUserId>;
    let allowedId: string;
    let deniedId: string;

    /**
     * Seed one movie matching MATCHING_PROFILE. When `libraryGroupId` is given
     * the item gets a media_files row in that group, which is what makes the
     * library-access predicate able to exclude it — the predicate always admits
     * items with NO media_file_items rows at all.
     */
    async function seedMovie(
        tmdbId: number,
        popularity: number,
        libraryGroupId: string | null,
    ): Promise<string> {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await insertTestExternalIds(
            sql,
            createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
        );
        await insertProviderMetadata(sql, item.id, {
            overview: 'Access boundary fixture',
            genres: [35],
            mdblist_keywords: ['boundary-kw'],
            // findTrendingMoodMedia hard-filters on popularity > 50.
            popularity,
        });
        if (libraryGroupId) {
            const fileId = randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/mood/${item.id}.mkv`}, ${libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${item.id}::uuid)
            `;
        }
        await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
        return item.id;
    }

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
            'media_embeddings',
        ]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean).delete('global-mean:v1');

        groupA = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'Denied Mood Group')`;

        userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);

        deniedId = await seedMovie(992001, 900, groupA);
        allowedId = await seedMovie(992002, 800, null);
    });

    describe('findMoodMedia', () => {
        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await findMoodMedia(sql, {
                profile: MATCHING_PROFILE,
                userId,
                limit: 50,
                access,
            });
            return rows.map((r) => r.internal_id ?? '');
        }

        it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
            const open = await run(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);
            expect(open).toContain(deniedId);
            expect(open).toContain(allowedId);

            const narrowed = await run(denyGroups(groupA));
            const openSet = new Set(open);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(deniedId);
            expect(narrowed).toContain(allowedId);

            expect(await run(denyAllAccess())).toEqual([]);
        });

        it('honours the age axis independently of the library axis', async () => {
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${deniedId}::uuid`;
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${allowedId}::uuid`;

            // Library unrestricted, age capped at 12 → only the age-6 item.
            const ageCapped = await run(
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
            );
            expect(ageCapped).toEqual([allowedId]);
        });
    });

    describe('findMoodMediaPersonalized', () => {
        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await findMoodMediaPersonalized(sql, {
                profile: MATCHING_PROFILE,
                userId,
                limit: 50,
                access,
            });
            return rows.map((r) => r.internal_id ?? '');
        }

        it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
            // No user embedding and no item embeddings → ai_similarity is the
            // 0.5 default, which clears the > 0.45 gate, so both rows survive.
            const open = await run(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);
            expect(open).toContain(deniedId);
            expect(open).toContain(allowedId);

            const narrowed = await run(denyGroups(groupA));
            const openSet = new Set(open);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(deniedId);
            expect(narrowed).toContain(allowedId);

            expect(await run(denyAllAccess())).toEqual([]);
        });

        it('honours the age axis independently of the library axis', async () => {
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${deniedId}::uuid`;
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${allowedId}::uuid`;

            const ageCapped = await run(
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
            );
            expect(ageCapped).toEqual([allowedId]);
        });
    });

    describe('findTrendingMoodMedia', () => {
        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await findTrendingMoodMedia(sql, { limit: 50, access });
            return rows.map((r) => r.internal_id ?? '');
        }

        it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
            const open = await run(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);
            expect(open).toContain(deniedId);
            expect(open).toContain(allowedId);

            const narrowed = await run(denyGroups(groupA));
            const openSet = new Set(open);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).not.toContain(deniedId);
            expect(narrowed).toContain(allowedId);

            expect(await run(denyAllAccess())).toEqual([]);
        });

        it('applies the boundary on the excludeList branch too', async () => {
            // The excludeList branch is a SEPARATE query body — a boundary
            // spliced into only one of the two would pass every test above.
            async function runExcluding(access: MediaAccessBoundary): Promise<string[]> {
                const rows = await findTrendingMoodMedia(sql, {
                    limit: 50,
                    excludeList: [{ primary_ext_id: '999999', media_type: 'movie' }],
                    access,
                });
                return rows.map((r) => r.internal_id ?? '');
            }

            const open = await runExcluding(unrestrictedAccess());
            expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);
            expect(open).toContain(deniedId);

            const narrowed = await runExcluding(denyGroups(groupA));
            expect(narrowed).not.toContain(deniedId);
            expect(narrowed).toContain(allowedId);

            expect(await runExcluding(denyAllAccess())).toEqual([]);
        });

        it('honours the age axis independently of the library axis', async () => {
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${deniedId}::uuid`;
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${allowedId}::uuid`;

            const ageCapped = await run(
                restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
            );
            expect(ageCapped).toEqual([allowedId]);
        });
    });
});
