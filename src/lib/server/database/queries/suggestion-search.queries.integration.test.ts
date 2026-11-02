// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests: Suggestion Search Queries
 *
 * Tests similarity search queries extracted from Database class.
 * Uses real database with test data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    getTestDb,
    closeTestDb,
    truncateTestTables,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    findSimilarMediaDual,
    fetchCandidateEmbeddings,
    type ExternalMediaKey,
} from './suggestion-search.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
} from '../../../../../tests/integration/fixtures/media.fixtures.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import type { Sql } from 'postgres';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';

describe('Suggestion Search Queries', () => {
    let sql: Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clean up test data before each test
        await truncateTestTables(sql, [
            'media_embeddings',
            'external_ids',
            'library_availability',
            'provider_metadata',
            'user_ratings',
            'user_media_state',
            'media_files',
            'media_items',
        ]);
    });

    describe('findSimilarMediaDual', () => {
        it('should find similar media using jellyfin embeddings', async () => {
            // Create test movies with embeddings
            await createAndInsertTestMovie(sql, {
                title: 'Test Movie 1',
                tmdbId: 990101,
                withEmbedding: true,
            });

            await createAndInsertTestMovie(sql, {
                title: 'Test Movie 2',
                tmdbId: 990102,
                withEmbedding: true,
            });

            // Create a user embedding vector (1024 dimensions)
            const userEmbedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);

            // Search for similar media
            const results = await findSimilarMediaDual(sql, userEmbedding, {
                access: unrestrictedAccess(),
                limit: 10,
                source: EMBEDDING_SOURCE.LIBRARY,
            });

            // Verify results
            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);
            expect(results.length).toBeLessThanOrEqual(10);

            // Verify result structure
            const firstResult = results[0];
            expect(firstResult).toHaveProperty('media_uuid');
            expect(firstResult).toHaveProperty('primary_ext_id');
            expect(firstResult).toHaveProperty('title');
            expect(firstResult).toHaveProperty('library_similarity');
            expect(firstResult).toHaveProperty('combined_score');

            // F9: rows now expose embedding PRESENCE booleans, not the raw
            // `embedding::text` (~12KB/vector). The library-source movie has a
            // library embedding, so the flag must be true.
            expect(firstResult).toHaveProperty('has_library_embedding');
            expect(firstResult).toHaveProperty('has_discovery_embedding');
            expect(typeof firstResult.has_library_embedding).toBe('boolean');
            expect(typeof firstResult.has_discovery_embedding).toBe('boolean');
            expect(firstResult.has_library_embedding).toBe(true);
            // The heavy text columns must be gone entirely.
            expect(firstResult).not.toHaveProperty('library_embedding');
            expect(firstResult).not.toHaveProperty('discovery_embedding');
        });

        it('availableOnly keeps file-less rows out of the result (both sources and single source)', async () => {
            const owned = await createAndInsertTestMovie(sql, {
                title: 'Avail Owned',
                tmdbId: 990301,
                withEmbedding: true,
            });
            const ghost = await createAndInsertTestMovie(sql, {
                title: 'Avail Ghost',
                tmdbId: 990302,
                withEmbedding: true,
            });
            await sql`UPDATE media_items SET has_files = TRUE WHERE id = ${owned.id}::uuid`;
            await sql`UPDATE media_items SET has_files = FALSE WHERE id = ${ghost.id}::uuid`;

            const userEmbedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);

            for (const source of [undefined, EMBEDDING_SOURCE.LIBRARY] as const) {
                const all = await findSimilarMediaDual(sql, userEmbedding, {
                    access: unrestrictedAccess(),
                    limit: 10,
                    source,
                });
                expect(all.map((r) => r.media_uuid).sort()).toEqual([owned.id, ghost.id].sort());

                const availableOnly = await findSimilarMediaDual(sql, userEmbedding, {
                    access: unrestrictedAccess(),
                    limit: 10,
                    source,
                    availableOnly: true,
                });
                expect(availableOnly.map((r) => r.media_uuid)).toEqual([owned.id]);
            }
        });

        it('should exclude items by composite key (tmdb_id + media_type)', async () => {
            // Create test movies
            await createAndInsertTestMovie(sql, {
                title: 'Include Movie',
                tmdbId: 990201,
                withEmbedding: true,
            });

            await createAndInsertTestMovie(sql, {
                title: 'Exclude Movie',
                tmdbId: 990202,
                withEmbedding: true,
            });

            const userEmbedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);

            // Exclude movie2 by composite key
            const excludeItems: ExternalMediaKey[] = [
                { primary_ext_id: '990202', media_type: 'movie' },
            ];

            const results = await findSimilarMediaDual(sql, userEmbedding, {
                access: unrestrictedAccess(),
                limit: 10,
                source: EMBEDDING_SOURCE.LIBRARY,
                excludeItems,
            });

            // Verify movie2 is not in results
            const excludedMovie = results.find((r) => r.primary_ext_id === '990202');
            expect(excludedMovie).toBeUndefined();

            // Verify movie1 might be in results (depends on similarity)
            expect(results.some((r) => r.primary_ext_id === '990201')).toBeTruthy();
        });

        it('should filter by media type', async () => {
            // Create mixed media
            await createAndInsertTestMovie(sql, {
                title: 'Test Movie',
                tmdbId: 990301,
                withEmbedding: true,
            });

            await createAndInsertTestTvShow(sql, {
                title: 'Test TV Show',
                tmdbId: 880301,
                withEmbedding: true,
            });

            const userEmbedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);

            // Search for movies only
            const movieResults = await findSimilarMediaDual(sql, userEmbedding, {
                access: unrestrictedAccess(),
                limit: 10,
                source: EMBEDDING_SOURCE.LIBRARY,
                mediaTypes: ['movie'],
            });

            // Verify only movies in results
            expect(movieResults.every((r) => r.media_type === 'movie')).toBe(true);
            expect(movieResults.some((r) => r.primary_ext_id === '990301')).toBeTruthy();

            // Search for TV only
            const tvResults = await findSimilarMediaDual(sql, userEmbedding, {
                access: unrestrictedAccess(),
                limit: 10,
                source: EMBEDDING_SOURCE.LIBRARY,
                mediaTypes: ['tv'],
            });

            // Verify only TV shows in results
            expect(tvResults.every((r) => r.media_type === 'tv')).toBe(true);
            expect(tvResults.some((r) => r.primary_ext_id === '880301')).toBeTruthy();
        });

        it('should exclude items rated by user', async () => {
            // Create test movies
            const movie1 = await createAndInsertTestMovie(sql, {
                title: 'Rated Movie',
                tmdbId: 990401,
                withEmbedding: true,
            });

            // Create user rating for movie1 (ensure user exists in user_profiles first)
            const testUserId = generateTestUserId();
            await ensureTestUser(sql, testUserId);
            await sql`
				INSERT INTO user_ratings (user_id, media_id, rating)
				VALUES (${testUserId}, ${movie1.id}::uuid, 8)
			`;

            const userEmbedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);

            // Search excluding rated items
            const results = await findSimilarMediaDual(sql, userEmbedding, {
                access: unrestrictedAccess(),
                limit: 10,
                source: EMBEDDING_SOURCE.LIBRARY,
                excludeUserId: testUserId,
            });

            // Verify rated movie is excluded
            const ratedMovie = results.find((r) => r.primary_ext_id === '990401');
            expect(ratedMovie).toBeUndefined();
        });

        it('should apply quality and popularity scoring', async () => {
            // Create movie with metadata including quality scores
            const movieId = crypto.randomUUID();
            await sql`
				INSERT INTO media_items (id, title, media_type, year, status)
				VALUES (${movieId}::uuid, 'High Quality Movie', 'movie', 2024, 'active')
			`;

            await sql`
				INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
				VALUES (${movieId}::uuid, 'tmdb', '990501', 'movie', true)
			`;

            // Insert metadata with quality scores
            await sql`
				INSERT INTO provider_metadata (media_id, provider, metadata)
				VALUES (
					${movieId}::uuid,
					'tmdb',
					jsonb_build_object(
						'imdb_rating', '8.5',
						'rt_rating', '90',
						'popularity', '500'
					)
				)
			`;

            // Insert embedding
            const embedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);
            const vectorString = `[${embedding.join(',')}]`;
            await sql`
				INSERT INTO media_embeddings (media_id, embedding, source)
				VALUES (${movieId}::uuid, ${vectorString}::vector, 'jellyfin')
			`;

            const userEmbedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);

            // Search with quality and popularity weights
            const results = await findSimilarMediaDual(sql, userEmbedding, {
                access: unrestrictedAccess(),
                limit: 10,
                source: 'both',
                qualityWeight: 0.3,
                popularityWeight: 0.2,
            });

            // Verify scoring columns exist
            const movie = results.find((r) => r.primary_ext_id === '990501');
            if (movie) {
                expect(movie.quality_score).toBeDefined();
                expect(movie.popularity_score).toBeDefined();
                expect(movie.combined_score).toBeDefined();
            }
        });

        // ====================================================================
        // Q5: availability is no longer part of combined_score.
        //
        // The old score added `+availabilityPreference` (~0.7 normalized, ~0.35
        // after the /maxPossibleScore divide) for available items and
        // `+avoidWeight` for requestable ones. That offset dwarfed the tiny
        // (<0.02) similarity spread, so an available item ALWAYS outranked a
        // requestable one regardless of embedding match — a strict library-first
        // partition. With the term removed, combined_score is driven by the fused
        // similarity, so a strong-match requestable item can outrank a weak
        // available one. (Interleaving available/requestable now happens in the
        // engine, post-scoring — not in this SQL.)
        // ====================================================================
        it('does not apply an availability offset to combined_score (Q5)', async () => {
            // Available (has_files) item with a FAR library embedding.
            const availId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, year, status, has_files)
                VALUES (${availId}::uuid, 'Avail Far', 'movie', 2024, 'active', true)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${availId}::uuid, 'tmdb', '970001', 'movie', true)
            `;
            const farEmb = new Array(1024).fill(0);
            farEmb[10] = 1;
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${availId}::uuid, ${`[${farEmb.join(',')}]`}::vector, ${EMBEDDING_SOURCE.LIBRARY})
            `;

            // Requestable (no has_files) item with a NEAR discovery embedding.
            const reqId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, year, status, has_files)
                VALUES (${reqId}::uuid, 'Req Near', 'movie', 2024, 'active', false)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${reqId}::uuid, 'tmdb', '970002', 'movie', true)
            `;
            const nearEmb = new Array(1024).fill(0);
            nearEmb[500] = 1;
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${reqId}::uuid, ${`[${nearEmb.join(',')}]`}::vector, ${EMBEDDING_SOURCE.DISCOVERY})
            `;

            // Probe aligned with the requestable item's discovery embedding.
            const probe = new Array(1024).fill(0);
            probe[500] = 1;

            const results = await findSimilarMediaDual(sql, probe, {
                access: unrestrictedAccess(),
                limit: 10,
                source: 'both',
                mediaTypes: ['movie'],
            });

            const avail = results.find((r) => r.primary_ext_id === '970001');
            const req = results.find((r) => r.primary_ext_id === '970002');
            expect(avail).toBeDefined();
            expect(req).toBeDefined();

            // The near-match requestable item must outrank the far available one
            // (impossible under the old +availability offset), and sort first.
            expect(req!.combined_score).toBeGreaterThan(avail!.combined_score);
            expect(results[0].primary_ext_id).toBe('970002');
        });

        // ====================================================================
        // Availability crowd-out regression guard (mirrors for-you-helpers'
        // availability_ranked CTE test): a mixed pool ranked and cut with a
        // single LIMIT lets one availability class evict the other. Seed more
        // than `limit` unavailable (requestable) candidates that all outscore a
        // handful of available ones, then assert the available ones still
        // survive — they must land in their own PARTITION BY is_available
        // window instead of being pushed out of a shared top-N cut.
        // ====================================================================
        it('does not let unavailable candidates crowd out available ones past the limit', async () => {
            const limit = 3;

            // Available (has_files) items with a slightly-off embedding — lower
            // combined_score than the requestable block below.
            const availableIds: string[] = [];
            for (let i = 0; i < 2; i++) {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, year, status, has_files)
                    VALUES (${id}::uuid, ${`Crowd Avail ${i}`}, 'movie', 2024, 'active', true)
                `;
                await sql`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                    VALUES (${id}::uuid, 'tmdb', ${`96${i}001`}, 'movie', true)
                `;
                const emb = new Array(1024).fill(0);
                emb[0] = 1;
                emb[1] = 0.2; // slightly off-axis from the probe
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, ${EMBEDDING_SOURCE.LIBRARY})
                `;
                availableIds.push(id);
            }

            // More than `limit` unavailable (no has_files) items, all aligned
            // exactly with the probe — every one outscores every available item.
            for (let i = 0; i < limit + 3; i++) {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, year, status, has_files)
                    VALUES (${id}::uuid, ${`Crowd Unavail ${i}`}, 'movie', 2024, 'active', false)
                `;
                await sql`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                    VALUES (${id}::uuid, 'tmdb', ${`96${i}002`}, 'movie', true)
                `;
                const emb = new Array(1024).fill(0);
                emb[0] = 1;
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, ${EMBEDDING_SOURCE.DISCOVERY})
                `;
            }

            const probe = new Array(1024).fill(0);
            probe[0] = 1;

            const results = await findSimilarMediaDual(sql, probe, {
                access: unrestrictedAccess(),
                limit,
                source: 'both',
                mediaTypes: ['movie'],
            });

            const availableSurvivors = results.filter((r) => availableIds.includes(r.media_uuid));
            // Both available items must survive despite being outscored by more
            // than `limit` unavailable candidates — proof each availability class
            // is ranked (and cut) independently rather than sharing one window.
            expect(availableSurvivors.length).toBe(2);
        });

        // ====================================================================
        // SQL-H1: HNSW index usage (two-phase rewrite regression guard)
        //
        // The default source='both' path used to order directly by the
        // computed `combined_score` (late-fusion) expression, which structurally
        // prevents PostgreSQL from using the partial HNSW indexes — forcing a
        // Seq Scan + Sort over every embedding row. The two-phase rewrite first
        // gathers an HNSW-eligible candidate pool per source via the raw `<=>`
        // operator. This test asserts that the phase-1 candidate plan can use
        // the HNSW index. enable_sort is disabled for the assertion so the
        // planner must prefer an ordered index scan regardless of the tiny
        // test-table size; the OLD computed-expression form could not satisfy
        // that and would fall back to a btree scan + Sort node.
        // ====================================================================
        it('phase-1 candidate KNN can use the HNSW index (SQL-H1)', async () => {
            for (let i = 0; i < 25; i++) {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, year, status, has_files)
                    VALUES (${id}::uuid, ${`H1 Movie ${i}`}, 'movie', 2024, 'active', true)
                `;
                const embedding = new Array(1024).fill(0).map(() => Math.random() * 2 - 1);
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${id}::uuid, ${`[${embedding.join(',')}]`}::vector, ${EMBEDDING_SOURCE.LIBRARY})
                `;
            }
            await sql`ANALYZE media_embeddings`;
            await sql`ANALYZE media_items`;

            const userVector = '[' + new Array(1024).fill(0.1).join(',') + ']';

            // EXPLAIN the phase-1 library-source KNN subquery exactly as the
            // rewrite issues it. Use a reserved connection so the session-scoped
            // SET does not leak into the shared pool.
            const reserved = await sql.reserve();
            let planText: string;
            try {
                await reserved`SET enable_sort = off`;
                const plan = await reserved.unsafe(
                    `
                    EXPLAIN (COSTS OFF, FORMAT TEXT)
                    SELECT lib_emb.media_id
                    FROM media_embeddings lib_emb
                    JOIN media_items cmi ON cmi.id = lib_emb.media_id
                        AND cmi.status = 'active'
                        AND cmi.media_type = ANY(ARRAY['movie','tv'])
                    WHERE lib_emb.source = 'library'
                    ORDER BY lib_emb.embedding <=> '${userVector}'::vector
                    LIMIT 200;
                    `,
                );
                planText = (plan as Array<Record<string, string>>)
                    .map((r) => Object.values(r).join('\n'))
                    .join('\n');
            } finally {
                reserved.release();
            }

            expect(planText).toContain('idx_me_library_hnsw');
            // The combined-distance expression must NOT appear as a sort key:
            // candidate gathering orders by the raw operator only.
            expect(planText).not.toMatch(/Sort Key:.*1.*-.*<=>/);
        });
    });

    describe('fetchCandidateEmbeddings', () => {
        it('returns the library embedding vector text for requested UUIDs (F9)', async () => {
            const movie = await createAndInsertTestMovie(sql, {
                title: 'Vector Movie',
                tmdbId: 991001,
                withEmbedding: true,
            });

            const rows = await fetchCandidateEmbeddings(sql, [movie.id]);

            expect(rows.length).toBe(1);
            expect(rows[0].media_uuid).toBe(movie.id);
            // A library-source embedding was inserted, so its text must come back
            // and parse as a pgvector literal ("[...]").
            expect(rows[0].library_embedding).toBeTypeOf('string');
            expect(rows[0].library_embedding?.startsWith('[')).toBe(true);
        });

        it('returns an empty array for an empty UUID list (no query)', async () => {
            const rows = await fetchCandidateEmbeddings(sql, []);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // Lean projection (modal similar endpoint): media_scalars instead of the
    // provider_metadata JSONB detoast. Scalar fields must match what the full
    // projection extracts; engine-only fields come back NULL by contract.
    // ========================================================================
    describe('findSimilarMediaDual lean projection', () => {
        async function seedLeanCandidate(title: string, tmdbId: number): Promise<string> {
            const movieId = crypto.randomUUID();
            await sql`
				INSERT INTO media_items (id, title, media_type, year, status)
				VALUES (${movieId}::uuid, ${title}, 'movie', 2024, 'active')
			`;
            await sql`
				INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
				VALUES (${movieId}::uuid, 'tmdb', ${String(tmdbId)}, 'movie', true)
			`;
            // The media_scalars projection is trigger-synced from this insert.
            await sql`
				INSERT INTO provider_metadata (media_id, provider, metadata)
				VALUES (
					${movieId}::uuid,
					'tmdb',
					jsonb_build_object(
						'overview', ${title + ' overview'}::text,
						'imdb_rating', '7.5',
						'rt_rating', '80',
						'popularity', '55.5',
						'runtime_minutes', '120',
						'genres', jsonb_build_array(jsonb_build_object('name', 'Drama')),
						'actors', jsonb_build_array(jsonb_build_object('name', 'Test Actor'))
					)
				)
			`;
            const embedding = new Array(1024).fill(0);
            embedding[tmdbId % 1024] = 1;
            const vectorString = `[${embedding.join(',')}]`;
            await sql`
				INSERT INTO media_embeddings (media_id, embedding, source)
				VALUES (${movieId}::uuid, ${vectorString}::vector, ${EMBEDDING_SOURCE.LIBRARY})
			`;
            return movieId;
        }

        it('sources scalar fields from media_scalars and NULLs engine-only fields', async () => {
            const movieId = await seedLeanCandidate('Lean Mode', 990601);

            const probe = new Array(1024).fill(0);
            probe[990601 % 1024] = 1;
            const rows = await findSimilarMediaDual(sql, probe, {
                access: unrestrictedAccess(),
                limit: 5,
                mediaTypes: ['movie'],
                lean: true,
            });

            expect(rows.length).toBe(1);
            const row = rows[0];
            expect(row.media_uuid).toBe(movieId);
            expect(row.overview).toBe('Lean Mode overview');
            expect(Number(row.imdb_rating)).toBeCloseTo(7.5);
            expect(Number(row.rt_rating)).toBe(80);
            expect(Number(row.popularity)).toBeCloseTo(55.5);
            expect(row.has_library_embedding).toBe(true);
            expect(row.has_discovery_embedding).toBe(false);
            expect(row.combined_score).toBeGreaterThan(0);
            // Engine-only fields are intentionally NULL in lean mode
            expect(row.genres).toBeNull();
            expect(row.actors).toBeNull();
            expect(row.vote_count).toBeNull();
        });

        it('ranks the same candidates in the same order as the full projection', async () => {
            await seedLeanCandidate('Near', 990602);
            await seedLeanCandidate('Far', 990607);

            const probe = new Array(1024).fill(0);
            probe[990602 % 1024] = 1;

            const full = await findSimilarMediaDual(sql, probe, {
                access: unrestrictedAccess(),
                limit: 5,
                mediaTypes: ['movie'],
            });
            const lean = await findSimilarMediaDual(sql, probe, {
                access: unrestrictedAccess(),
                limit: 5,
                mediaTypes: ['movie'],
                lean: true,
            });

            expect(lean.map((r) => r.media_uuid)).toEqual(full.map((r) => r.media_uuid));
            expect(lean[0]?.title).toBe('Near');
        });
    });
    // ========================================================================
    // Access boundary — DIFFERENTIAL tests.
    //
    // The same fixture is queried twice, once with an explicit unrestricted
    // boundary and once restricted, and the restricted result must be a STRICT
    // SUBSET. That is what catches a boundary that arrives but is never spliced
    // into the SQL, or a predicate bound to the wrong alias — both make the
    // restricted result EQUAL the unrestricted one, which no "resolves without
    // throwing" assertion can detect.
    //
    // The two axes are seeded SEPARATELY on purpose. A single mixed fixture lets
    // one splice site be deleted with every test still green, because the other
    // predicate happens to remove the same rows.
    //
    // findSimilarMediaDual is the sharp case: it is a two-phase HNSW query whose
    // phase-1 CTE (`candidate_ids`) has NO access predicate and aliases
    // media_items as `cmi`, while both builders bind to `mi`. A fragment that
    // drifted into phase 1 would bind to the wrong alias or vanish; these tests
    // exercise the phase-2 splice point that must own the boundary.
    // ========================================================================
    describe('findSimilarMediaDual access boundary', () => {
        const DENIED_GROUP_ID = 'c0ffee00-1111-4222-8333-444444444444';

        /** Probe vector every seeded candidate is near, so ranking never hides a row. */
        function probeVector(): number[] {
            const v = new Array(1024).fill(0);
            v[7] = 1;
            return v;
        }

        /**
         * Seed one movie with a LIBRARY embedding close to `probeVector()`, an
         * explicit age_rating, and a media_files row (needed for the library
         * predicate to have anything to look at — an item with no file rows
         * passes the library filter unconditionally by design).
         */
        async function seedCandidate(opts: {
            title: string;
            tmdbId: number;
            ageRating: number | null;
            deniedLibrary: boolean;
        }): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, year, status, age_rating, has_files)
                VALUES (${id}::uuid, ${opts.title}, 'movie', 2024, 'active', ${opts.ageRating}, true)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${id}::uuid, 'tmdb', ${String(opts.tmdbId)}, 'movie', true)
            `;
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (
                    ${fileId}::uuid,
                    ${`/test/access/${id}.mkv`},
                    ${opts.deniedLibrary ? DENIED_GROUP_ID : null}::uuid,
                    NOW(), NOW()
                )
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${id}::uuid)
            `;
            // Near-identical vectors so every candidate survives ranking and any
            // difference in the result set is attributable to the boundary alone.
            const embedding = new Array(1024).fill(0);
            embedding[7] = 1;
            embedding[opts.tmdbId % 1024] = 0.01;
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${id}::uuid, ${`[${embedding.join(',')}]`}::vector, ${EMBEDDING_SOURCE.LIBRARY})
            `;
            return id;
        }

        beforeEach(async () => {
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${DENIED_GROUP_ID}::uuid, 'Denied Similar Group')
                ON CONFLICT (id) DO NOTHING
            `;
        });

        async function run(access: MediaAccessBoundary): Promise<string[]> {
            const rows = await findSimilarMediaDual(sql, probeVector(), {
                access,
                limit: 50,
                mediaTypes: ['movie'],
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            return rows.map((r) => r.media_uuid).sort();
        }

        it('library axis: denyGroups is a strict subset of unrestricted', async () => {
            const visible = await seedCandidate({
                title: 'Allowed Library',
                tmdbId: 991101,
                ageRating: null,
                deniedLibrary: false,
            });
            const hidden = await seedCandidate({
                title: 'Denied Library',
                tmdbId: 991102,
                ageRating: null,
                deniedLibrary: true,
            });

            const all = await run(unrestrictedAccess());
            const restricted = await run(
                restrictedAccess({
                    deniedGroupIds: [DENIED_GROUP_ID],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );

            expect(all).toContain(visible);
            expect(all).toContain(hidden);
            // Strict subset: everything restricted returns is in `all`, and
            // `all` returns something restricted does not.
            expect(restricted.every((id) => all.includes(id))).toBe(true);
            expect(restricted.length).toBeLessThan(all.length);
            expect(restricted).toContain(visible);
            expect(restricted).not.toContain(hidden);
        });

        it('age axis: limit is a strict subset of unrestricted', async () => {
            const visible = await seedCandidate({
                title: 'Age 6',
                tmdbId: 991201,
                ageRating: 6,
                deniedLibrary: false,
            });
            const hidden = await seedCandidate({
                title: 'Age 18',
                tmdbId: 991202,
                ageRating: 18,
                deniedLibrary: false,
            });

            const all = await run(unrestrictedAccess());
            const restricted = await run(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );

            expect(all).toContain(visible);
            expect(all).toContain(hidden);
            expect(restricted.every((id) => all.includes(id))).toBe(true);
            expect(restricted.length).toBeLessThan(all.length);
            expect(restricted).toContain(visible);
            expect(restricted).not.toContain(hidden);
        });

        it('age axis: allowUnrated governs rows with a NULL age_rating', async () => {
            const unrated = await seedCandidate({
                title: 'Unrated',
                tmdbId: 991301,
                ageRating: null,
                deniedLibrary: false,
            });

            const permitted = await run(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            );
            const forbidden = await run(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );

            expect(permitted).toContain(unrated);
            expect(forbidden).not.toContain(unrated);
        });

        it('denyAll returns EMPTY even when every row would otherwise match', async () => {
            await seedCandidate({
                title: 'Would Match',
                tmdbId: 991401,
                ageRating: null,
                deniedLibrary: false,
            });

            const all = await run(unrestrictedAccess());
            expect(all.length).toBeGreaterThan(0);

            expect(await run(denyAllAccess())).toEqual([]);
            // Each axis alone must close the result set too — a denyAll that only
            // worked when BOTH axes were set would leave half the type unenforced.
            expect(await run({ library: { kind: 'denyAll' }, age: { kind: 'any' } })).toEqual([]);
            expect(await run({ library: { kind: 'all' }, age: { kind: 'denyAll' } })).toEqual([]);
        });

        it('denyGroups with an EMPTY id list is identical to unrestricted', async () => {
            // Contract guard for the ef_search fast path. buildLibraryAccessFilter
            // emits nothing for an empty deny-list, so an empty `denyGroups` must
            // also read as unrestricted when sizing the HNSW candidate pool —
            // otherwise two boundaries producing byte-identical SQL would traverse
            // the graph differently and return different rows.
            //
            // HONEST LIMITATION: on a fixture this small the pool multiplier is
            // unobservable — the whole table fits inside every candidate pool, so
            // this asserts the contract but does NOT fail if `libraryRestricted`
            // drops its `.ids.length > 0` guard (verified by mutation). Catching
            // that needs a >candidatePoolSize fixture; the guard is documented at
            // the `restricted` computation instead.
            await seedCandidate({
                title: 'A',
                tmdbId: 991501,
                ageRating: null,
                deniedLibrary: false,
            });
            await seedCandidate({
                title: 'B',
                tmdbId: 991502,
                ageRating: null,
                deniedLibrary: true,
            });

            const all = await run(unrestrictedAccess());
            const emptyDeny = await run({
                library: { kind: 'denyGroups', ids: [] },
                age: { kind: 'any' },
            });
            expect(emptyDeny).toEqual(all);
        });
    });
});
