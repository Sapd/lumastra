// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for For-You Helpers Query Module
 *
 * Tests user preference queries (watched, liked, disliked media)
 * and fallback queries for recommendation sources.
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
    generateTestUserId,
    insertTestRating,
    createTestRating,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE, type EmbeddingSource } from '../../utils/embedding-source.js';

// Import query functions to test
import {
    getDislikedMediaIds,
    getBehaviorallyDemotedMediaIds,
    getRandomPopularItem,
    lookupAvailabilityByInternalIds,
    lookupAvailabilityByTmdbIds,
    queryFreshReleases,
    querySimilarMediaWithAvailability,
    querySimilarMediaWithAvailabilityTwoPhase,
    toWatchedExclusionKey,
    type SimilarMediaParams,
} from './for-you-helpers.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('For-You Helpers Queries', () => {
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
    // User Preference Queries
    // ==========================================================================

    describe('getDislikedMediaIds', () => {
        it('returns media IDs rated 4 or below', async () => {
            const userId = generateTestUserId();
            const movie1 = createTestMediaItem({ media_type: 'movie' });
            const movie2 = createTestMediaItem({ media_type: 'movie' });
            const movie3 = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie1);
            await insertTestMediaItem(sql, movie2);
            await insertTestMediaItem(sql, movie3);

            // Disliked (rating <= 4)
            await insertTestRating(sql, createTestRating(userId, movie1.id, 2));
            await insertTestRating(sql, createTestRating(userId, movie2.id, 4));
            // Liked (rating > 4)
            await insertTestRating(sql, createTestRating(userId, movie3.id, 8));

            const result = await getDislikedMediaIds(sql, userId);

            expect(result.length).toBe(2);
            expect(result).toContain(movie1.id);
            expect(result).toContain(movie2.id);
            expect(result).not.toContain(movie3.id);
        });

        it('returns empty array when user has no disliked media', async () => {
            const userId = generateTestUserId();
            const result = await getDislikedMediaIds(sql, userId);
            expect(result).toEqual([]);
        });
    });

    describe('getBehaviorallyDemotedMediaIds', () => {
        // Helper: insert a watch_history row with calibrated thresholds.
        // Bypasses the test fixture which doesn't expose status/completion.
        async function insertWatchHistoryRow(
            userId: string,
            mediaId: string,
            opts: {
                status: 'completed' | 'abandoned' | 'active';
                actualWatchTimeSeconds: number;
                completionPercentage: number | null;
            },
        ): Promise<void> {
            await ensureTestUser(sql, userId);
            await sql`
                INSERT INTO watch_history (
                    user_id, media_type, source_service, title,
                    session_start_time, actual_watch_time_seconds,
                    completion_percentage, status, media_id
                ) VALUES (
                    ${userId}, 'movie', 'lumastra', 'Test',
                    NOW(), ${opts.actualWatchTimeSeconds},
                    ${opts.completionPercentage}, ${opts.status},
                    ${mediaId}::uuid
                )
            `;
        }

        // Default option override — the default minTotalEngagements floor of
        // 20 doesn't apply to most of these focused unit tests; we override
        // to 1 so a single qualified row registers.
        const noFloor = { minTotalEngagements: 1 };

        it('returns abandoned media with >=5min watched and <60% completion', async () => {
            const userId = generateTestUserId();
            const movie1 = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie1);

            await insertWatchHistoryRow(userId, movie1.id, {
                status: 'abandoned',
                actualWatchTimeSeconds: 600, // 10 min
                completionPercentage: 35,
            });

            const result = await getBehaviorallyDemotedMediaIds(sql, userId, noFloor);
            expect(result).toEqual([movie1.id]);
        });

        it('ignores abandoned sessions under 5 min (peeks)', async () => {
            const userId = generateTestUserId();
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            await insertWatchHistoryRow(userId, movie.id, {
                status: 'abandoned',
                actualWatchTimeSeconds: 60, // 1 min — peek
                completionPercentage: 5,
            });

            const result = await getBehaviorallyDemotedMediaIds(sql, userId, noFloor);
            expect(result).toEqual([]);
        });

        it('ignores abandoned sessions with >=60% completion', async () => {
            const userId = generateTestUserId();
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            await insertWatchHistoryRow(userId, movie.id, {
                status: 'abandoned',
                actualWatchTimeSeconds: 3600,
                completionPercentage: 75, // close to finishing
            });

            const result = await getBehaviorallyDemotedMediaIds(sql, userId, noFloor);
            expect(result).toEqual([]);
        });

        it('ignores completed sessions even with low completion percentage', async () => {
            const userId = generateTestUserId();
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            await insertWatchHistoryRow(userId, movie.id, {
                status: 'completed',
                actualWatchTimeSeconds: 600,
                completionPercentage: 30,
            });

            const result = await getBehaviorallyDemotedMediaIds(sql, userId, noFloor);
            expect(result).toEqual([]);
        });

        it('respects the minTotalEngagements floor', async () => {
            const userId = generateTestUserId();
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            await insertWatchHistoryRow(userId, movie.id, {
                status: 'abandoned',
                actualWatchTimeSeconds: 600,
                completionPercentage: 35,
            });

            // Only 1 engagement total → default floor of 20 blocks this user
            const blocked = await getBehaviorallyDemotedMediaIds(sql, userId);
            expect(blocked).toEqual([]);

            // Override floor to 1 → returns the row
            const allowed = await getBehaviorallyDemotedMediaIds(sql, userId, {
                minTotalEngagements: 1,
            });
            expect(allowed).toEqual([movie.id]);
        });

        it('deduplicates when the same media has multiple qualified rows', async () => {
            const userId = generateTestUserId();
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            for (let i = 0; i < 3; i++) {
                await insertWatchHistoryRow(userId, movie.id, {
                    status: 'abandoned',
                    actualWatchTimeSeconds: 600,
                    completionPercentage: 30,
                });
            }

            const result = await getBehaviorallyDemotedMediaIds(sql, userId, noFloor);
            expect(result).toEqual([movie.id]);
        });

        it('returns empty array when user has no qualifying abandonments', async () => {
            const userId = generateTestUserId();
            const result = await getBehaviorallyDemotedMediaIds(sql, userId, noFloor);
            expect(result).toEqual([]);
        });
    });

    // ==========================================================================
    // Fallback Queries
    // ==========================================================================

    describe('getRandomPopularItem', () => {
        async function insertMediaFileItem(mediaItemId: string): Promise<void> {
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES (${`/test/${mediaItemId}.mkv`})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${file.id}::uuid, ${mediaItemId}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid
            `;
        }

        it('returns a random popular movie', async () => {
            // Create a movie with all required criteria:
            // - TMDB external ID
            // - Jellyfin embedding
            // - Available (has media_file_items)
            // - Good IMDB rating (>= 7.0)
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const externalIds = createTestExternalIds(movie.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            await insertTestEmbedding(sql, createTestEmbedding(movie.id, EMBEDDING_SOURCE.LIBRARY));

            await insertMediaFileItem(movie.id);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${movie.id}::uuid,
                    'aggregated',
                    ${sql.json({ imdb_rating: 7.5 })},
                    NOW()
                )
            `;

            const result = await getRandomPopularItem(sql, 'movie', unrestrictedAccess());

            expect(result).not.toBeNull();
            expect(result?.primary_ext_id).toBe('990001');
            expect(result?.media_type).toBe('movie');
            expect(result?.title).toBe(movie.title);
        });

        it('returns a random popular TV show', async () => {
            const tvShow = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, tvShow);

            const externalIds = createTestExternalIds(tvShow.id, {
                tmdbId: 880001,
                mediaType: 'tv',
            });
            await insertTestExternalIds(sql, externalIds);

            await insertTestEmbedding(
                sql,
                createTestEmbedding(tvShow.id, EMBEDDING_SOURCE.LIBRARY),
            );

            await insertMediaFileItem(tvShow.id);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${tvShow.id}::uuid,
                    'tmdb',
                    ${sql.json({ mdblist_score: 75 })},
                    NOW()
                )
            `;

            const result = await getRandomPopularItem(sql, 'tv', unrestrictedAccess());

            expect(result).not.toBeNull();
            expect(result?.primary_ext_id).toBe('880001');
            expect(result?.media_type).toBe('tv');
        });

        it('returns null when no items match criteria', async () => {
            // Create a movie without embedding (fails criteria)
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const externalIds = createTestExternalIds(movie.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            // No embedding, no availability, no metadata

            const result = await getRandomPopularItem(sql, 'movie', unrestrictedAccess());

            expect(result).toBeNull();
        });

        it('excludes items with low ratings', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const externalIds = createTestExternalIds(movie.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            await insertTestEmbedding(sql, createTestEmbedding(movie.id, EMBEDDING_SOURCE.LIBRARY));

            await insertMediaFileItem(movie.id);

            // Low IMDB rating (below threshold)
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${movie.id}::uuid,
                    'aggregated',
                    ${sql.json({ imdb_rating: 5.0, mdblist_score: 50 })},
                    NOW()
                )
            `;

            const result = await getRandomPopularItem(sql, 'movie', unrestrictedAccess());

            expect(result).toBeNull();
        });

        it('excludes items not available in Jellyfin', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const externalIds = createTestExternalIds(movie.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            await insertTestEmbedding(sql, createTestEmbedding(movie.id, EMBEDDING_SOURCE.LIBRARY));

            // No media_file_items row — item is not available in library

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${movie.id}::uuid,
                    'aggregated',
                    ${sql.json({ imdb_rating: 8.0 })},
                    NOW()
                )
            `;

            const result = await getRandomPopularItem(sql, 'movie', unrestrictedAccess());

            expect(result).toBeNull();
        });

        it('only returns items of specified media type', async () => {
            // Create a TV show that meets all criteria
            const tvShow = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, tvShow);

            const externalIds = createTestExternalIds(tvShow.id, {
                tmdbId: 880001,
                mediaType: 'tv',
            });
            await insertTestExternalIds(sql, externalIds);

            await insertTestEmbedding(
                sql,
                createTestEmbedding(tvShow.id, EMBEDDING_SOURCE.LIBRARY),
            );

            await insertMediaFileItem(tvShow.id);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${tvShow.id}::uuid,
                    'aggregated',
                    ${sql.json({ imdb_rating: 8.5 })},
                    NOW()
                )
            `;

            // Request movie - should return null since only TV exists
            const result = await getRandomPopularItem(sql, 'movie', unrestrictedAccess());

            expect(result).toBeNull();
        });

        it('accepts mdblist_score as alternative to imdb_rating', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const externalIds = createTestExternalIds(movie.id, {
                tmdbId: 990002,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            await insertTestEmbedding(sql, createTestEmbedding(movie.id, EMBEDDING_SOURCE.LIBRARY));

            await insertMediaFileItem(movie.id);

            // Only mdblist_score (no imdb_rating)
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${movie.id}::uuid,
                    'aggregated',
                    ${sql.json({ mdblist_score: 80 })},
                    NOW()
                )
            `;

            const result = await getRandomPopularItem(sql, 'movie', unrestrictedAccess());

            expect(result).not.toBeNull();
            expect(result?.primary_ext_id).toBe('990002');
        });
    });

    describe('queryFreshReleases (reads media_scalars projection)', () => {
        const iso = (msAgo: number): string =>
            new Date(Date.now() - msAgo).toISOString().slice(0, 10);

        it('returns a recent, well-rated title via the media_scalars lateral', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, { tmdbId: 991001, mediaType: 'movie' }),
            );
            // provider_metadata write → trg_provider_metadata_scalars populates media_scalars.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${movie.id}::uuid, 'tmdb',
                    ${sql.json({ release_date: iso(30 * 864e5), mdblist_score: 78, overview: 'Fresh.' })}, NOW())
            `;

            const rows = await queryFreshReleases(
                sql,
                iso(90 * 864e5),
                [],
                20,
                unrestrictedAccess(),
            );
            const hit = rows.find((r) => r.primary_ext_id === '991001');
            expect(hit).toBeDefined();
            expect(hit?.mdblist_score).toBe(78);
        });

        it('excludes titles older than the window', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, { tmdbId: 991002, mediaType: 'movie' }),
            );
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${movie.id}::uuid, 'tmdb',
                    ${sql.json({ release_date: iso(400 * 864e5), mdblist_score: 90 })}, NOW())
            `;

            const rows = await queryFreshReleases(
                sql,
                iso(90 * 864e5),
                [],
                20,
                unrestrictedAccess(),
            );
            expect(rows.find((r) => r.primary_ext_id === '991002')).toBeUndefined();
        });
    });
});

// ============================================================================
// Two-phase ANN parity
// ============================================================================
//
// The full-scan `querySimilarMediaWithAvailability` and the HNSW
// `querySimilarMediaWithAvailabilityTwoPhase` share byte-identical scoring CTEs;
// the only difference is that the two-phase variant bounds the re-score to an
// ANN candidate pool. This suite seeds a small fixture (< 20 embedded items) so
// the ANN pool (ef_search 200) trivially covers everything, then asserts both
// functions return the SAME ids in the SAME order — the invariant that guards
// the fused-once restructure and every other change to these two queries.
describe('querySimilarMediaWithAvailability — full-scan vs two-phase parity', () => {
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

    // A 1024-dim unit vector whose cosine similarity to the source vector
    // (axis 0, [1,0,0,…]) is exactly `cos`: put `cos` on axis 0 and the
    // complementary magnitude on axis 1 so the vector stays unit-length.
    const EMBEDDING_DIM = 1024;
    function vecAtCosine(cos: number): number[] {
        const v = new Array<number>(EMBEDDING_DIM).fill(0);
        v[0] = cos;
        v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
        return v;
    }
    const SOURCE_VEC = vecAtCosine(1); // == axis 0

    async function seedCandidate(
        tmdbId: number,
        cos: number,
        opts: { available?: boolean; source?: EmbeddingSource } = {},
    ): Promise<{ id: string; tmdbId: number }> {
        const available = opts.available ?? false;
        const source = opts.source ?? EMBEDDING_SOURCE.LIBRARY;
        const movie = createTestMediaItem({ media_type: 'movie', has_files: available });
        await insertTestMediaItem(sql, movie);
        await insertTestExternalIds(
            sql,
            createTestExternalIds(movie.id, { tmdbId, mediaType: 'movie' }),
        );
        await insertTestEmbedding(sql, {
            media_id: movie.id,
            embedding: vecAtCosine(cos),
            source,
        });
        return { id: movie.id, tmdbId };
    }

    it('returns identical ids in identical order for the same inputs', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // Source item (excluded by primary_ext.external_id != tmdbId).
        const SOURCE_TMDB = 700000;
        await seedCandidate(SOURCE_TMDB, 1.0);

        // Qualifying candidates with strictly-decreasing cosine similarity, all
        // above the 0.5 fused threshold → deterministic strict ordering.
        await seedCandidate(700001, 0.95);
        await seedCandidate(700002, 0.9);
        await seedCandidate(700003, 0.85);
        await seedCandidate(700004, 0.8);
        await seedCandidate(700005, 0.7);

        // Below-threshold candidate → excluded by BOTH paths.
        await seedCandidate(700006, 0.3);

        // Watched candidate (high similarity) → excluded via watchedKeys.
        const watched = await seedCandidate(700007, 0.88);

        // Disliked candidate (high similarity) → excluded via the rating<=4 join.
        const disliked = await seedCandidate(700008, 0.92);
        await insertTestRating(sql, createTestRating(userId, disliked.id, 2));
        // A liked rating too, to exercise the ratings fixture (unused by this
        // query but part of the "user with dislikes/ratings" seed).
        const liked = await seedCandidate(700009, 0.6);
        await insertTestRating(sql, createTestRating(userId, liked.id, 9));

        const params: SimilarMediaParams = {
            userId,
            mediaType: 'movie',
            tmdbId: SOURCE_TMDB,
            embeddingStr: `[${SOURCE_VEC.join(',')}]`,
            rawKeywords: [],
            stems: [],
            tasteKeywords: [],
            watchedKeys: [toWatchedExclusionKey(watched.tmdbId, 'movie')],
            limit: 10,
            similarWeightDislikedKeyword: 0.1,
            similarWeightDislikedGenre: 0.1,
            access: unrestrictedAccess(),
        };

        const fullScan = await querySimilarMediaWithAvailability(sql, {
            ...params,
            useTwoPhaseAnn: false,
        });
        const twoPhase = await querySimilarMediaWithAvailabilityTwoPhase(sql, params);

        const fullIds = fullScan.map((r) => r.primary_ext_id);
        const twoIds = twoPhase.map((r) => r.primary_ext_id);

        // Expected set/order: similarity-descending, thresholded, exclusions applied.
        // 700009 (cos 0.6) also qualifies and slots between 700005 (0.7) and the
        // 0.5 cutoff.
        expect(fullIds).toEqual(['700001', '700002', '700003', '700004', '700005', '700009']);
        // The core parity invariant: both paths agree exactly.
        expect(twoIds).toEqual(fullIds);
    });

    it('availableOnly keeps file-less rows out of the candidate pool on both paths', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const SOURCE_TMDB = 730000;
        await seedCandidate(SOURCE_TMDB, 1.0);
        // Closer file-less rows would fill a small limit if they were not filtered.
        await seedCandidate(730001, 0.99, { available: false });
        await seedCandidate(730002, 0.98, { available: false });
        await seedCandidate(730003, 0.8, { available: true });
        await seedCandidate(730004, 0.7, { available: true });

        const params: SimilarMediaParams = {
            userId,
            mediaType: 'movie',
            tmdbId: SOURCE_TMDB,
            embeddingStr: `[${SOURCE_VEC.join(',')}]`,
            rawKeywords: [],
            stems: [],
            tasteKeywords: [],
            watchedKeys: [],
            limit: 10,
            similarWeightDislikedKeyword: 0.1,
            similarWeightDislikedGenre: 0.1,
            access: unrestrictedAccess(),
            availableOnly: true,
        };

        const fullScan = await querySimilarMediaWithAvailability(sql, {
            ...params,
            useTwoPhaseAnn: false,
        });
        const twoPhase = await querySimilarMediaWithAvailabilityTwoPhase(sql, params);

        expect(fullScan.map((r) => r.primary_ext_id)).toEqual(['730003', '730004']);
        expect(twoPhase.map((r) => r.primary_ext_id)).toEqual(['730003', '730004']);
        expect(fullScan.every((r) => r.is_available)).toBe(true);
    });

    it('disliked keyword stems hard-filter and penalise candidates identically on both paths', async () => {
        // Guards the dislike-only keyword fetch: candidate keywords are fetched
        // only when they map to a disliked stem, either through stem_map
        // ('slasher-film' -> 'slasher') or as an unmapped keyword that is its
        // own stem ('zombie', 'heist'). Keywords reach media_keywords through
        // the provider_metadata sync trigger.
        async function setKeywords(mediaId: string, keywords: string[]): Promise<void> {
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({ mdblist_keywords: keywords })}, NOW(), NOW())
            `;
        }

        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const SOURCE_TMDB = 720000;
        await seedCandidate(SOURCE_TMDB, 1.0);

        // Three disliked titles: 'slasher' and 'zombie' reach the hard-filter
        // threshold (3); 'heist' appears twice, so it is only a soft penalty.
        for (let i = 0; i < 3; i++) {
            const disliked = await seedCandidate(720100 + i, 0.2);
            await setKeywords(
                disliked.id,
                i < 2 ? ['slasher-film', 'zombie', 'heist'] : ['slasher-film', 'zombie'],
            );
            await insertTestRating(sql, createTestRating(userId, disliked.id, 2));
        }

        const mappedStem = await seedCandidate(720001, 0.95);
        await setKeywords(mappedStem.id, ['slasher-film', 'romance']);
        const unmappedStem = await seedCandidate(720002, 0.94);
        await setKeywords(unmappedStem.id, ['zombie']);
        const penalised = await seedCandidate(720003, 0.93);
        await setKeywords(penalised.id, ['heist', 'romance']);
        const neutral = await seedCandidate(720004, 0.85);
        await setKeywords(neutral.id, ['romance']);
        await seedCandidate(720005, 0.8); // no keywords at all

        const params: SimilarMediaParams = {
            userId,
            mediaType: 'movie',
            tmdbId: SOURCE_TMDB,
            embeddingStr: `[${SOURCE_VEC.join(',')}]`,
            rawKeywords: ['slasher-film'],
            stems: ['slasher'],
            tasteKeywords: ['slasher-film', 'zombie', 'heist', 'romance'],
            watchedKeys: [],
            limit: 10,
            similarWeightDislikedKeyword: 0.1,
            similarWeightDislikedGenre: 0.1,
            access: unrestrictedAccess(),
        };

        const fullScan = await querySimilarMediaWithAvailability(sql, {
            ...params,
            useTwoPhaseAnn: false,
        });
        const twoPhase = await querySimilarMediaWithAvailabilityTwoPhase(sql, params);

        // 720001/720002 are hard-filtered; 720003 drops from 0.93 to 0.73
        // (2 dislikes x 0.1) and falls behind the neutral candidates.
        const fullIds = fullScan.map((r) => r.primary_ext_id);
        expect(fullIds).toEqual(['720004', '720005', '720003']);
        expect(twoPhase.map((r) => r.primary_ext_id)).toEqual(fullIds);
    });

    it('per-class window: available candidates survive even when outnumbered and outscored by unavailable ones', async () => {
        // Regression for the bug fixed by the `availability_ranked` window: a
        // single combined `ORDER BY combined_score LIMIT limit + 15` let
        // unavailable (discovery) candidates evict every available (library)
        // row once they outnumbered the window and outscored it. Seed MORE
        // unavailable candidates than the window (limit + 15) and give every
        // one of them a higher cosine similarity than every available
        // candidate — under the old single-window LIMIT this must return
        // zero available rows; under the fix each availability class gets
        // its own window.
        const SOURCE_TMDB = 810000;
        await seedCandidate(SOURCE_TMDB, 1.0);

        const limit = 5;
        const perClassWindow = limit + 15;

        const UNAVAILABLE_COUNT = perClassWindow + 5; // 20 + 5 = 25
        const unavailableIds: number[] = [];
        for (let i = 0; i < UNAVAILABLE_COUNT; i++) {
            const tmdbId = 810001 + i;
            unavailableIds.push(tmdbId);
            // Strictly decreasing, all above the 0.5 threshold and above
            // every available candidate's similarity below.
            await seedCandidate(tmdbId, 0.99 - i * 0.01, {
                available: false,
                source: EMBEDDING_SOURCE.DISCOVERY,
            });
        }

        const AVAILABLE_COUNT = 5;
        const availableIds: number[] = [];
        for (let i = 0; i < AVAILABLE_COUNT; i++) {
            const tmdbId = 810101 + i;
            availableIds.push(tmdbId);
            // All below the lowest unavailable similarity (0.75) but still
            // above the 0.5 qualification threshold.
            await seedCandidate(tmdbId, 0.6 - i * 0.01, {
                available: true,
                source: EMBEDDING_SOURCE.LIBRARY,
            });
        }

        const params: SimilarMediaParams = {
            userId: generateTestUserId(),
            mediaType: 'movie',
            tmdbId: SOURCE_TMDB,
            embeddingStr: `[${SOURCE_VEC.join(',')}]`,
            rawKeywords: [],
            stems: [],
            tasteKeywords: [],
            watchedKeys: [],
            limit,
            similarWeightDislikedKeyword: 0.1,
            similarWeightDislikedGenre: 0.1,
            access: unrestrictedAccess(),
        };

        const fullScan = await querySimilarMediaWithAvailability(sql, {
            ...params,
            useTwoPhaseAnn: false,
        });
        const twoPhase = await querySimilarMediaWithAvailabilityTwoPhase(sql, params);

        for (const rows of [fullScan, twoPhase]) {
            const availableRows = rows.filter((r) => r.is_available);
            const unavailableRows = rows.filter((r) => !r.is_available);

            // All 5 available candidates must survive — not evicted by the
            // far-more-numerous, higher-scoring unavailable ones.
            expect(availableRows.map((r) => r.primary_ext_id).sort()).toEqual(
                availableIds.map(String).sort(),
            );

            // Unavailable candidates must also be present (a per-class
            // window, not an availability filter), capped at limit + 15 —
            // with 25 seeded and a window of 20, exactly 20 survive.
            expect(unavailableRows.length).toBe(perClassWindow);
            expect(unavailableRows.length).toBeLessThanOrEqual(perClassWindow);
            expect(availableRows.length).toBeLessThanOrEqual(perClassWindow);
        }
    });

    // The parity invariant above only ever ran at an UNRESTRICTED boundary, so
    // it could not have caught the two-phase pool-sizing rewrite (`restricted`
    // now derives from the scope union rather than the legacy null-ness). Pin
    // parity under a restriction too: the ×3 pool widening must not change WHICH
    // rows survive relative to the full scan, which has no pool at all.
    it('full-scan and two-phase agree under a RESTRICTED boundary', async () => {
        const SOURCE_TMDB = 720000;
        await seedCandidate(SOURCE_TMDB, 1.0);
        await seedCandidate(720001, 0.95);
        await seedCandidate(720002, 0.9);
        const overAge = await seedCandidate(720003, 0.85);
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${overAge.id}::uuid`;

        const restricted = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: true,
        });
        const params: SimilarMediaParams = {
            userId: generateTestUserId(),
            mediaType: 'movie',
            tmdbId: SOURCE_TMDB,
            embeddingStr: `[${SOURCE_VEC.join(',')}]`,
            rawKeywords: [],
            stems: [],
            tasteKeywords: [],
            watchedKeys: [],
            limit: 10,
            similarWeightDislikedKeyword: 0.1,
            similarWeightDislikedGenre: 0.1,
            access: restricted,
        };

        const fullScan = await querySimilarMediaWithAvailability(sql, {
            ...params,
            useTwoPhaseAnn: false,
        });
        const twoPhase = await querySimilarMediaWithAvailabilityTwoPhase(sql, params);

        const fullIds = fullScan.map((r) => r.primary_ext_id);
        expect(fullIds).toEqual(['720001', '720002']);
        expect(twoPhase.map((r) => r.primary_ext_id)).toEqual(fullIds);
    });
});

// ============================================================================
// Access boundary — differential coverage
// ============================================================================
//
// Every query in this module that reads media_items runs TWICE over one fixture:
// once with an explicitly unrestricted boundary, once with a restricted one. The
// restricted result must be a STRICT subset of the unrestricted one, and a
// denyAll boundary must return nothing.
//
// This is what catches a boundary argument that arrived but was never spliced
// into the SQL (both runs would return identical sets), and a predicate bound to
// the wrong table alias (the query would throw, or filter the wrong rows). The
// fixture isolates each axis — one item fails ONLY the library check, one fails
// ONLY the age check — so dropping either builder call alone turns this red.
//
// All four queries here bury their boundary predicates one level below the outer
// SELECT (inside `deduped` for queryFreshReleases, inside `candidate_media` for
// both similar-media variants), which is exactly the subquery-scope error class
// a differential test exists to catch.
describe('for-you helpers — access boundary', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.userData,
            'media_file_items',
            'media_files',
            'library_groups',
            'media_scalars',
            ...TEST_TABLES.media,
        ]);
    });

    // A fixed axis-0 unit vector. `createTestEmbedding` returns a RANDOM unit
    // vector, and in 1024 dimensions two random vectors are near-orthogonal — so
    // every fixture row would fall below the similar-media query's 0.5 fused
    // threshold and be dropped for reasons unrelated to access. Giving every
    // fixture row the same vector, and using it as the source, pins similarity
    // at 1.0 so the access boundary is the ONLY thing that can remove a row.
    const AXIS_VEC: number[] = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const AXIS_VEC_STR = `[${AXIS_VEC.join(',')}]`;

    /** Deny the restricted library group AND cap the age at 12, unrated allowed. */
    function restrictedBoundary(deniedGroupId: string): MediaAccessBoundary {
        return restrictedAccess({
            deniedGroupIds: [deniedGroupId],
            maxAgeRating: 12,
            allowUnrated: true,
        });
    }

    async function createLibraryGroup(name: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name, sort_order, created_at, updated_at)
            VALUES (${name}, 1, NOW(), NOW())
            RETURNING id
        `;
        return row.id;
    }

    async function attachFile(
        mediaItemId: string,
        libraryGroupId: string,
        path: string,
    ): Promise<void> {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
            VALUES (${path}, ${libraryGroupId}::uuid, NOW(), NOW())
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}::uuid, ${mediaItemId}::uuid)
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
    }

    interface AxisFixture {
        deniedGroupId: string;
        /** Passes both axes. */
        visibleTmdbId: string;
        /** Fails ONLY the library axis. */
        deniedLibraryTmdbId: string;
        /** Fails ONLY the age axis. */
        deniedAgeTmdbId: string;
        ids: { visible: string; deniedLibrary: string; deniedAge: string };
    }

    /**
     * Three movies isolating each axis. Every one of them satisfies the
     * *non-access* criteria of all four queries under test (library embedding,
     * a file so `has_files` holds for getRandomPopularItem, a fresh
     * release_date, and a quality score above every gate), so the ONLY thing
     * that can remove a row is the access boundary.
     */
    async function seedAxisFixture(): Promise<AxisFixture> {
        const allowedGroupId = await createLibraryGroup('Allowed');
        const deniedGroupId = await createLibraryGroup('Denied');

        const spec = [
            { key: 'visible', tmdbId: 960001, group: 'allowed', age: 6 },
            { key: 'deniedLibrary', tmdbId: 960002, group: 'denied', age: 6 },
            { key: 'deniedAge', tmdbId: 960003, group: 'allowed', age: 18 },
        ] as const;

        const ids: Record<string, string> = {};
        for (const s of spec) {
            const movie = createTestMediaItem({ media_type: 'movie', title: `Fixture ${s.key}` });
            await insertTestMediaItem(sql, movie);
            ids[s.key] = movie.id;

            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, { tmdbId: s.tmdbId, mediaType: 'movie' }),
            );
            await insertTestEmbedding(sql, {
                media_id: movie.id,
                embedding: AXIS_VEC,
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            await attachFile(
                movie.id,
                s.group === 'allowed' ? allowedGroupId : deniedGroupId,
                `/movies/${s.key}.mkv`,
            );
            await sql`UPDATE media_items SET age_rating = ${s.age} WHERE id = ${movie.id}::uuid`;

            // provider_metadata write → trg_provider_metadata_scalars populates
            // media_scalars, which queryFreshReleases scans.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${movie.id}::uuid, 'tmdb', ${sql.json({
                    release_date: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
                    mdblist_score: 78,
                    imdb_rating: 8.0,
                    overview: 'Fixture.',
                })}, NOW())
            `;
        }

        return {
            deniedGroupId,
            visibleTmdbId: '960001',
            deniedLibraryTmdbId: '960002',
            deniedAgeTmdbId: '960003',
            ids: {
                visible: ids.visible,
                deniedLibrary: ids.deniedLibrary,
                deniedAge: ids.deniedAge,
            },
        };
    }

    /** Assert `restricted` is a strict subset of `unrestricted`. */
    function expectStrictSubset(restricted: string[], unrestricted: string[]): void {
        for (const id of restricted) {
            expect(unrestricted).toContain(id);
        }
        expect(restricted.length).toBeLessThan(unrestricted.length);
    }

    const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

    describe('queryFreshReleases', () => {
        it('restricted rows are a strict subset of unrestricted', async () => {
            const fx = await seedAxisFixture();

            const open = await queryFreshReleases(
                sql,
                iso(90 * 864e5),
                [],
                50,
                unrestrictedAccess(),
            );
            const closed = await queryFreshReleases(
                sql,
                iso(90 * 864e5),
                [],
                50,
                restrictedBoundary(fx.deniedGroupId),
            );

            const openIds = open.map((r) => r.primary_ext_id);
            const closedIds = closed.map((r) => r.primary_ext_id);

            expect(openIds.sort()).toEqual(
                [fx.visibleTmdbId, fx.deniedLibraryTmdbId, fx.deniedAgeTmdbId].sort(),
            );
            // Exactly one survives — proving BOTH predicates are live. Dropping
            // the library fragment leaves deniedLibrary; dropping the age
            // fragment leaves deniedAge.
            expect(closedIds).toEqual([fx.visibleTmdbId]);
            expectStrictSubset(closedIds, openIds);
        });

        it('denyAll returns nothing', async () => {
            await seedAxisFixture();
            const rows = await queryFreshReleases(sql, iso(90 * 864e5), [], 50, denyAllAccess());
            expect(rows).toEqual([]);
        });
    });

    describe('lookupAvailabilityByTmdbIds', () => {
        const allIds = ['960001', '960002', '960003'];

        it('restricted keys are a strict subset of unrestricted', async () => {
            const fx = await seedAxisFixture();

            const open = await lookupAvailabilityByTmdbIds(sql, allIds, unrestrictedAccess());
            const closed = await lookupAvailabilityByTmdbIds(
                sql,
                allIds,
                restrictedBoundary(fx.deniedGroupId),
            );

            const openKeys = [...open.keys()].sort();
            const closedKeys = [...closed.keys()].sort();

            expect(openKeys).toEqual(allIds.map((id) => `${id}:movie`).sort());
            expect(closedKeys).toEqual([`${fx.visibleTmdbId}:movie`]);
            expectStrictSubset(closedKeys, openKeys);
        });

        it('denyAll returns an empty map', async () => {
            await seedAxisFixture();
            const map = await lookupAvailabilityByTmdbIds(sql, allIds, denyAllAccess());
            expect(map.size).toBe(0);
        });
    });

    describe('lookupAvailabilityByInternalIds', () => {
        it('reports has_files per internal id and omits unknown ids', async () => {
            const owned = createTestMediaItem({ media_type: 'movie', has_files: true });
            const ghost = createTestMediaItem({ media_type: 'movie', has_files: false });
            await insertTestMediaItem(sql, owned);
            await insertTestMediaItem(sql, ghost);

            const map = await lookupAvailabilityByInternalIds(
                sql,
                [owned.id, ghost.id, '00000000-0000-4000-a000-000000000000'],
                unrestrictedAccess(),
            );

            expect(map.get(owned.id)?.is_available).toBe(true);
            expect(map.get(ghost.id)?.is_available).toBe(false);
            expect(map.size).toBe(2);
        });

        it('denyAll returns an empty map', async () => {
            const owned = createTestMediaItem({ media_type: 'movie', has_files: true });
            await insertTestMediaItem(sql, owned);
            expect((await lookupAvailabilityByInternalIds(sql, [owned.id], denyAllAccess())).size).toBe(0);
        });
    });

    describe('getRandomPopularItem', () => {
        // This query returns ONE random row, so a set-subset assertion is not
        // available. Instead each axis is isolated to a SINGLE seeded candidate:
        // unrestricted must find it, restricted must not. That is deterministic
        // and still fails if the predicate is dropped.
        it('library axis: the only candidate is in a denied group', async () => {
            const fx = await seedAxisFixture();
            await sql`DELETE FROM media_items WHERE id IN (${fx.ids.visible}::uuid, ${fx.ids.deniedAge}::uuid)`;

            expect(await getRandomPopularItem(sql, 'movie', unrestrictedAccess())).not.toBeNull();
            expect(
                await getRandomPopularItem(sql, 'movie', restrictedBoundary(fx.deniedGroupId)),
            ).toBeNull();
        });

        it('age axis: the only candidate is over the age cap', async () => {
            const fx = await seedAxisFixture();
            await sql`DELETE FROM media_items WHERE id IN (${fx.ids.visible}::uuid, ${fx.ids.deniedLibrary}::uuid)`;

            expect(await getRandomPopularItem(sql, 'movie', unrestrictedAccess())).not.toBeNull();
            expect(
                await getRandomPopularItem(sql, 'movie', restrictedBoundary(fx.deniedGroupId)),
            ).toBeNull();
        });

        it('restricted always returns the one visible candidate, never a denied one', async () => {
            const fx = await seedAxisFixture();
            for (let i = 0; i < 12; i++) {
                const row = await getRandomPopularItem(
                    sql,
                    'movie',
                    restrictedBoundary(fx.deniedGroupId),
                );
                expect(row?.primary_ext_id).toBe(fx.visibleTmdbId);
            }
        });

        it('denyAll returns null', async () => {
            const fx = await seedAxisFixture();
            expect(await getRandomPopularItem(sql, 'movie', denyAllAccess())).toBeNull();
            // ...and does not merely fall through to "no rows matched": the same
            // boundary minus denyAll finds a row.
            expect(
                await getRandomPopularItem(sql, 'movie', restrictedBoundary(fx.deniedGroupId)),
            ).not.toBeNull();
        });
    });

    describe('querySimilarMediaWithAvailability (both variants)', () => {
        // Every fixture row sits at cosine 1.0 from AXIS_VEC, so all three
        // qualify on similarity and only the boundary can remove one. This suite
        // asserts set membership, not ordering.
        async function runBoth(
            _fx: AxisFixture,
            access: MediaAccessBoundary,
        ): Promise<{ full: string[]; two: string[] }> {
            const params: SimilarMediaParams = {
                userId: generateTestUserId(),
                mediaType: 'movie',
                tmdbId: 999999, // not one of the fixture ids — excludes nothing
                embeddingStr: AXIS_VEC_STR,
                rawKeywords: [],
                stems: [],
                tasteKeywords: [],
                watchedKeys: [],
                limit: 20,
                similarWeightDislikedKeyword: 0.1,
                similarWeightDislikedGenre: 0.1,
                access,
            };
            const full = await querySimilarMediaWithAvailability(sql, {
                ...params,
                useTwoPhaseAnn: false,
            });
            const two = await querySimilarMediaWithAvailabilityTwoPhase(sql, params);
            return {
                full: full.map((r) => r.primary_ext_id).sort(),
                two: two.map((r) => r.primary_ext_id).sort(),
            };
        }

        it('restricted rows are a strict subset of unrestricted, on both paths', async () => {
            const fx = await seedAxisFixture();

            const open = await runBoth(fx, unrestrictedAccess());
            const closed = await runBoth(fx, restrictedBoundary(fx.deniedGroupId));

            // Both paths must agree with each other at each boundary...
            expect(open.two).toEqual(open.full);
            expect(closed.two).toEqual(closed.full);

            expect(open.full).toEqual(
                [fx.visibleTmdbId, fx.deniedLibraryTmdbId, fx.deniedAgeTmdbId].sort(),
            );
            expect(closed.full).toEqual([fx.visibleTmdbId]);
            expectStrictSubset(closed.full, open.full);
        });

        it('denyAll returns nothing on both paths, without opening a transaction', async () => {
            const fx = await seedAxisFixture();
            const none = await runBoth(fx, denyAllAccess());
            expect(none.full).toEqual([]);
            expect(none.two).toEqual([]);
        });
    });
});
