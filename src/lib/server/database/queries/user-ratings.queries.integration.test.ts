// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Ratings Query Module
 *
 * Tests CRUD operations, statistics, liked/disliked thresholds, and bulk operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createTestMovieBatch,
    createTestRating,
    insertTestRating,
    generateTestUserId,
    ensureTestUser,
    createAndInsertTestSeries,
    insertTestEmbedding,
    createTestEmbedding,
    placeInLibraryGroup,
    type PlaceableMediaType,
} from '../../../../../tests/integration/fixtures/index.js';
import { isEpisode } from '../../utils/media-types.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import type { UserId } from '$lib/shared/user-id.js';

// Import query functions to test
import {
    getUserRating,
    getUserRatingByTmdb,
    hasUserRated,
    getUserRatings,
    getUserLikedMedia,
    getUserDislikedMedia,
    getUserRatingsWithMetadata,
    getUserRatingsFullMetadata,
    getUsersWhoRated,
    getUserRatingStats,
    getUserRatingCount,
    getUserTodayRatingCount,
    getUserRatingDistribution,
    getMediaAverageRating,
    upsertUserRating,
    deleteUserRating,
    deleteAllUserRatings,
    bulkInsertRatings,
    bulkUpsertDemoRatings,
    getDemoEligibleMedia,
    deleteUserRatingsSimple,
    deleteUserSuggestions,
    deleteUserProfile,
    countUserRatings,
    countUserSuggestions,
    countUserWatchlist,
    getUserRatingsForMedia,
    getStarredItemIds,
    getStarredAlbumIds,
} from './user-ratings.queries.js';
import { upsertWatchlistItem } from './watchlist.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { pgTextTimestamp } from './builders/keyset-cursor.builder.js';

describe('User Ratings Queries', () => {
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
    // Single Item Queries
    // ==========================================================================

    describe('getUserRating', () => {
        it('returns rating for existing user-media pair', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600001,
            });
            const userId = generateTestUserId();

            await insertTestRating(sql, createTestRating(userId, mediaId, 8));

            const result = await getUserRating.one(sql, { userId, mediaId });

            expect(result).not.toBeNull();
            expect(result?.rating).toBe(8);
        });

        it('returns null for non-existent rating', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600002,
            });
            const userId = generateTestUserId();

            const result = await getUserRating.one(sql, { userId, mediaId });

            expect(result).toBeNull();
        });
    });

    describe('getUserRatingByTmdb', () => {
        it('resolves rating via TMDB ID', async () => {
            const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, { tmdbId: 600003 });
            const userId = generateTestUserId();

            await insertTestRating(sql, createTestRating(userId, mediaId, 7));

            const result = await getUserRatingByTmdb.one(sql, {
                userId,
                tmdbId,
                mediaType: 'movie',
            });

            expect(result).not.toBeNull();
            expect(result?.rating).toBe(7);
            expect(result?.media_id).toBe(mediaId);
        });
    });

    describe('hasUserRated', () => {
        it('returns true when user has rated', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600004,
            });
            const userId = generateTestUserId();

            await insertTestRating(sql, createTestRating(userId, mediaId, 6));

            const result = await hasUserRated.check(sql, { userId, mediaId });

            expect(result).toBe(true);
        });

        it('returns false when user has not rated', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600005,
            });
            const userId = generateTestUserId();

            const result = await hasUserRated.check(sql, { userId, mediaId });

            expect(result).toBe(false);
        });
    });

    // ==========================================================================
    // List Queries
    // ==========================================================================

    describe('getUserRatings', () => {
        it('returns user ratings ordered by created_at DESC', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();

            // Insert ratings with slight delays to ensure ordering
            for (let i = 0; i < movies.length; i++) {
                await insertTestRating(sql, createTestRating(userId, movies[i].id, 5 + i));
            }

            const result = await getUserRatings.all(sql, {
                userId,
                limit: 10,
                includeSkipped: false,
            });

            expect(result.length).toBe(5);
            // Most recent should be first
            expect(result[0].rating).toBe(9); // Last inserted
        });

        it('excludes skipped ratings when includeSkipped is false', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600010,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 5,
                skipped: true,
            });

            const result = await getUserRatings.all(sql, {
                userId,
                limit: 10,
                includeSkipped: false,
            });

            expect(result.length).toBe(0);
        });

        it('includes skipped ratings when includeSkipped is true', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600011,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 5,
                skipped: true,
            });

            const result = await getUserRatings.all(sql, {
                userId,
                limit: 10,
                includeSkipped: true,
            });

            expect(result.length).toBe(1);
        });
    });

    describe('getUserLikedMedia', () => {
        it('returns only media with rating >= 7', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();

            // Ratings: 5, 6, 7, 8, 9
            for (let i = 0; i < movies.length; i++) {
                await insertTestRating(sql, createTestRating(userId, movies[i].id, 5 + i));
            }

            const result = await getUserLikedMedia.all(sql, {
                userId,
                limit: 10,
            });

            // Should only include ratings 7, 8, 9
            expect(result.length).toBe(3);
            result.forEach((r) => {
                expect(r.rating).toBeGreaterThanOrEqual(7);
            });
        });

        it('orders by rating DESC, then created_at DESC', async () => {
            const movies = await createTestMovieBatch(sql, 4);
            const userId = generateTestUserId();

            await insertTestRating(sql, createTestRating(userId, movies[0].id, 9));
            await insertTestRating(sql, createTestRating(userId, movies[1].id, 8));
            await insertTestRating(sql, createTestRating(userId, movies[2].id, 10));
            await insertTestRating(sql, createTestRating(userId, movies[3].id, 7));

            const result = await getUserLikedMedia.all(sql, {
                userId,
                limit: 10,
            });

            expect(result[0].rating).toBe(10);
            expect(result[1].rating).toBe(9);
        });
    });

    describe('getUserDislikedMedia', () => {
        it('returns only media with rating <= 4', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();

            // Ratings: 1, 2, 3, 4, 5
            for (let i = 0; i < movies.length; i++) {
                await insertTestRating(sql, createTestRating(userId, movies[i].id, 1 + i));
            }

            const result = await getUserDislikedMedia.all(sql, {
                userId,
                limit: 10,
            });

            // Should only include ratings 1, 2, 3, 4
            expect(result.length).toBe(4);
            result.forEach((r) => {
                expect(r.rating).toBeLessThanOrEqual(4);
            });
        });
    });

    // ==========================================================================
    // Statistics Queries
    // ==========================================================================

    describe('getUserRatingStats', () => {
        it('returns correct statistics', async () => {
            const movies = await createTestMovieBatch(sql, 10);
            const userId = generateTestUserId();

            // Create ratings: 5 liked (7-10), 3 disliked (1-4), 2 neutral (5-6)
            const ratings = [10, 9, 8, 7, 7, 1, 2, 3, 5, 6];
            for (let i = 0; i < movies.length; i++) {
                await insertTestRating(sql, createTestRating(userId, movies[i].id, ratings[i]));
            }

            const result = await getUserRatingStats.get(sql, { userId });

            expect(result).not.toBeNull();
            expect(result?.total_ratings).toBe(10);
            expect(result?.liked_count).toBe(5); // 7, 7, 8, 9, 10
            expect(result?.disliked_count).toBe(3); // 1, 2, 3
            expect(result?.avg_rating).toBeCloseTo(5.8, 1);
        });

        it('returns today_ratings count', async () => {
            const movies = await createTestMovieBatch(sql, 3);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 7));
            }

            const result = await getUserRatingStats.get(sql, { userId });

            expect(result?.today_ratings).toBe(3);
        });
    });

    describe('getUserRatingCount', () => {
        it('returns total rating count', async () => {
            const movies = await createTestMovieBatch(sql, 7);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 5));
            }

            const result = await getUserRatingCount.get(sql, { userId });

            expect(result).toBe(7);
        });
    });

    describe('getUserTodayRatingCount', () => {
        it('returns count of ratings created today', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 6));
            }

            const result = await getUserTodayRatingCount.get(sql, { userId });

            expect(result).toBe(5);
        });
    });

    describe('getUserRatingDistribution', () => {
        it('returns rating counts grouped by rating value', async () => {
            const movies = await createTestMovieBatch(sql, 6);
            const userId = generateTestUserId();

            // Create ratings: 2x rating 5, 3x rating 8, 1x rating 10
            const ratings = [5, 5, 8, 8, 8, 10];
            for (let i = 0; i < movies.length; i++) {
                await insertTestRating(sql, createTestRating(userId, movies[i].id, ratings[i]));
            }

            const result = await getUserRatingDistribution.all(sql, { userId });

            const distribution = new Map(result.map((r) => [r.rating, r.count]));
            expect(distribution.get(5)).toBe(2);
            expect(distribution.get(8)).toBe(3);
            expect(distribution.get(10)).toBe(1);
        });
    });

    describe('getMediaAverageRating', () => {
        it('returns average rating across all users', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600050,
            });

            // Multiple users rate the same movie
            const users = [generateTestUserId(), generateTestUserId(), generateTestUserId()];
            const ratings = [6, 8, 10];

            for (let i = 0; i < users.length; i++) {
                await insertTestRating(sql, createTestRating(users[i], mediaId, ratings[i]));
            }

            const result = await getMediaAverageRating.get(sql, { mediaId });

            expect(result?.rating_count).toBe(3);
            expect(Number(result?.avg_rating)).toBe(8); // (6+8+10)/3
        });
    });

    // ==========================================================================
    // Write Operations
    // ==========================================================================

    describe('upsertUserRating', () => {
        it('inserts new rating', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600060,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 9,
            });

            expect(result.length).toBe(1);
            expect(result[0].rating).toBe(9);
        });

        it('updates existing rating', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600061,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Initial rating
            await upsertUserRating.execute(sql, { userId, mediaId, rating: 5 });

            // Update rating
            const result = await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 9,
            });

            expect(result[0].rating).toBe(9);

            // Verify only one record exists
            const count = await sql`
                SELECT COUNT(*) as count FROM user_ratings
                WHERE user_id = ${userId} AND media_id = ${mediaId}::uuid
            `;
            expect(Number(count[0].count)).toBe(1);
        });

        it('handles suggestion_context', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600062,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 7,
                suggestionContext: 'home_recommended',
            });

            expect(result[0].suggestion_context).toBe('home_recommended');
        });

        it('reports inserted=true on fresh insert, false on conflict-update', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600063,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Fresh insert — xmax = 0 → inserted true
            const first = await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 6,
            });
            expect(first[0].inserted).toBe(true);

            // Same (user, media) again — ON CONFLICT DO UPDATE → inserted false
            const second = await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 9,
            });
            expect(second[0].inserted).toBe(false);
            expect(second[0].rating).toBe(9);
        });
    });

    describe('deleteUserRating', () => {
        it('deletes existing rating', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600070,
            });
            const userId = generateTestUserId();

            await insertTestRating(sql, createTestRating(userId, mediaId, 7));

            const result = await deleteUserRating.execute(sql, {
                userId,
                mediaId,
            });

            expect(result.length).toBe(1);

            // Verify deleted
            const remaining = await getUserRating.one(sql, { userId, mediaId });
            expect(remaining).toBeNull();
        });

        it('returns empty array if no rating to delete', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600071,
            });
            const userId = generateTestUserId();

            const result = await deleteUserRating.execute(sql, {
                userId,
                mediaId,
            });

            expect(result.length).toBe(0);
        });
    });

    describe('deleteAllUserRatings', () => {
        it('deletes all ratings for a user', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 6));
            }

            const result = await deleteAllUserRatings.execute(sql, { userId });

            expect(result[0].count).toBe(5);

            // Verify all deleted
            const remaining = await getUserRatings.all(sql, {
                userId,
                limit: 10,
                includeSkipped: true,
            });
            expect(remaining.length).toBe(0);
        });
    });

    describe('bulkInsertRatings', () => {
        it('inserts multiple ratings efficiently', async () => {
            const movies = await createTestMovieBatch(sql, 20);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const ratingsData = movies.map((m, i) => ({
                userId,
                mediaId: m.id,
                rating: (i % 10) + 1,
                suggestionContext: 'bulk_test',
            }));

            const count = await bulkInsertRatings(sql, ratingsData);

            expect(count).toBe(20);

            // Verify all inserted
            const stats = await getUserRatingStats.get(sql, { userId });
            expect(stats?.total_ratings).toBe(20);
        });

        it('handles upsert on conflict', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600080,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Initial insert
            await bulkInsertRatings(sql, [{ userId, mediaId, rating: 5 }]);

            // Update via bulk insert
            await bulkInsertRatings(sql, [{ userId, mediaId, rating: 10 }]);

            // Should have updated rating
            const result = await getUserRating.one(sql, { userId, mediaId });
            expect(result?.rating).toBe(10);
        });

        it('returns 0 for empty input', async () => {
            const count = await bulkInsertRatings(sql, []);
            expect(count).toBe(0);
        });
    });

    describe('getDemoEligibleMedia', () => {
        it('returns active media with LIBRARY embeddings including media_id and primary_ext_id', async () => {
            const { id, tmdbId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600200,
                withEmbedding: true,
            });
            // A movie without an embedding should not be returned.
            await createAndInsertTestMovie(sql, { tmdbId: 600201 });

            const rows = await getDemoEligibleMedia(sql, 8, unrestrictedAccess());

            const found = rows.find((r) => r.media_id === id);
            expect(found).toBeDefined();
            expect(found!.primary_ext_id).toBe(String(tmdbId));
            expect(found!.media_type).toBe('movie');
            // The non-embedded movie must be excluded.
            expect(rows.some((r) => r.media_id !== id && r.primary_ext_id === '600201')).toBe(
                false,
            );
        });

        it('respects the limit', async () => {
            for (let i = 0; i < 5; i++) {
                await createAndInsertTestMovie(sql, {
                    tmdbId: 600300 + i,
                    withEmbedding: true,
                });
            }
            const rows = await getDemoEligibleMedia(sql, 3, unrestrictedAccess());
            expect(rows.length).toBe(3);
        });
    });

    describe('bulkUpsertDemoRatings', () => {
        it('inserts multiple ratings in a single round-trip with NOW() created_at', async () => {
            const m1 = await createAndInsertTestMovie(sql, { tmdbId: 600400 });
            const m2 = await createAndInsertTestMovie(sql, { tmdbId: 600401 });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const count = await bulkUpsertDemoRatings(sql, userId, [
                { mediaId: m1.id, rating: 5 },
                { mediaId: m2.id, rating: 4 },
            ]);

            expect(count).toBe(2);
            const r1 = await getUserRating.one(sql, {
                userId,
                mediaId: m1.id,
            });
            expect(r1?.rating).toBe(5);
        });

        it('updates rating and refreshes created_at on conflict', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600410,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bulkUpsertDemoRatings(sql, userId, [{ mediaId, rating: 3 }]);
            await bulkUpsertDemoRatings(sql, userId, [{ mediaId, rating: 9 }]);

            const result = await getUserRating.one(sql, { userId, mediaId });
            expect(result?.rating).toBe(9);
        });

        it('returns 0 for empty input', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const count = await bulkUpsertDemoRatings(sql, userId, []);
            expect(count).toBe(0);
        });
    });

    // ==========================================================================
    // Extended Metadata Queries
    // ==========================================================================

    describe('getUserRatingsWithMetadata', () => {
        it('returns ratings with metadata from provider_metadata', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600090,
            });
            const userId = generateTestUserId();

            // Insert provider metadata
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({
                    poster_path: '/test-poster.jpg',
                    overview: 'A test movie overview',
                })})
            `;

            await insertTestRating(sql, createTestRating(userId, mediaId, 8));

            const result = await getUserRatingsWithMetadata.all(sql, {
                userId,
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(1);
            expect(result[0].rating).toBe(8);
            expect(result[0].poster_path).toBe('/test-poster.jpg');
            expect(result[0].overview).toBe('A test movie overview');
        });

        it('handles pagination with offset', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 7));
            }

            const page1 = await getUserRatingsWithMetadata.all(sql, {
                userId,
                limit: 2,
                offset: 0,
                access: unrestrictedAccess(),
            });
            const page2 = await getUserRatingsWithMetadata.all(sql, {
                userId,
                limit: 2,
                offset: 2,
                access: unrestrictedAccess(),
            });

            expect(page1.length).toBe(2);
            expect(page2.length).toBe(2);
            // Ensure no overlap
            const page1Ids = page1.map((r) => r.media_id);
            const page2Ids = page2.map((r) => r.media_id);
            expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
        });

        it('excludes skipped ratings', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600091,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 6,
                skipped: true,
            });

            const result = await getUserRatingsWithMetadata.all(sql, {
                userId,
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(0);
        });
    });

    describe('getUserRatingsFullMetadata', () => {
        it('returns ratings with availability information', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600092,
            });
            const userId = generateTestUserId();

            // Insert provider metadata
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({
                    overview: 'Full metadata overview',
                    imdb_rating: 7.5,
                    rt_rating: 85,
                })})
            `;

            // Insert media_file_items so is_available = true.
            // isAvailableExpr reads mi.has_files (O(1) column), not EXISTS(media_file_items).
            // We must insert the file record AND flip has_files = true on the media item.
            const [{ id: fileId }] = await sql<[{ id: string }]>`
                INSERT INTO media_files (file_path)
                VALUES (${`/test/media/jf-${mediaId}.mkv`})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaId}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${mediaId}::uuid
            `;

            await insertTestRating(sql, createTestRating(userId, mediaId, 9));

            const result = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 7,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(1);
            expect(result[0].rating).toBe(9);
            expect(result[0].is_available).toBe(true);
            expect(result[0].can_request).toBe(false);
            expect(Number(result[0].imdb_rating)).toBeCloseTo(7.5, 1);
            expect(result[0].rt_rating).toBe(85);
            // [multilingual-media-metadata] media_id is the translation-overlay
            // lookup key (ai/user-ratings.ts) — must be the resolved media_items UUID.
            expect(result[0].media_id).toBe(mediaId);
        });

        it('filters by minimum rating', async () => {
            const movies = await createTestMovieBatch(sql, 3);
            const userId = generateTestUserId();

            await insertTestRating(sql, createTestRating(userId, movies[0].id, 5));
            await insertTestRating(sql, createTestRating(userId, movies[1].id, 7));
            await insertTestRating(sql, createTestRating(userId, movies[2].id, 9));

            const result = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 7,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
            result.forEach((r) => {
                expect(r.rating).toBeGreaterThanOrEqual(7);
            });
        });

        it('shows can_request true when not available', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600093,
            });
            const userId = generateTestUserId();

            // Remove Jellyfin external ID and ensure has_files = false
            // so isAvailableExpr (mi.has_files OR EXISTS jellyfin) returns false
            await sql`
                DELETE FROM external_ids
                WHERE media_id = ${mediaId}::uuid AND provider = 'jellyfin'
            `;
            await sql`
                UPDATE media_items SET has_files = false WHERE id = ${mediaId}::uuid
            `;

            await insertTestRating(sql, createTestRating(userId, mediaId, 8));

            const result = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 1,
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(1);
            expect(result[0].is_available).toBe(false);
            expect(result[0].can_request).toBe(true);
        });

        // --------------------------------------------------------------------
        // Opt-in keyset cursor — keyset over `(created_at DESC, media_id DESC)`.
        // created_at is NOT NULL, so there is no NULL group to carry.
        // --------------------------------------------------------------------

        /** Force a rating's created_at to an exact (micro-precision) instant. */
        async function setRatingCreatedAt(userId: string, mediaId: string, ts: string) {
            await sql`
                UPDATE user_ratings
                SET created_at = ${pgTextTimestamp(sql, ts)}::timestamptz
                WHERE user_id = ${userId} AND media_id = ${mediaId}::uuid
            `;
        }

        it('cursor walk reproduces the offset ordering exactly (parity)', async () => {
            const movies = await createTestMovieBatch(sql, 5);
            const userId = generateTestUserId();
            // Distinct, descending created_at so the (created_at DESC) order is
            // unambiguous. movies[0] newest … movies[4] oldest.
            for (let i = 0; i < movies.length; i++) {
                await insertTestRating(sql, createTestRating(userId, movies[i].id, 8));
                await setRatingCreatedAt(userId, movies[i].id, `2026-07-0${i + 1} 12:00:00+00`);
            }

            const full = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 1,
                limit: 100,
                access: unrestrictedAccess(),
            });
            expect(full.length).toBe(5);
            const expectedOrder = full.map((r) => r.media_id);
            // Sanity: strictly descending created_at.
            expect(expectedOrder[0]).toBe(movies[4].id); // 2026-07-05 newest
            expect(expectedOrder[4]).toBe(movies[0].id); // 2026-07-01 oldest

            // Page size 2. First page = offset mode (offset 0, J1 bootstrap); every
            // later page = keyset mode using the previous page's last-row cursor.
            const pageSize = 2;
            const walked: string[] = [];
            let cursor: { createdAt: string; id: string } | null = null;
            for (let guard = 0; guard < 10; guard++) {
                const rows = await getUserRatingsFullMetadata.all(sql, {
                    userId,
                    ratingMin: 1,
                    limit: pageSize,
                    access: unrestrictedAccess(),
                    ...(cursor ? { cursor } : { offset: 0 }),
                });
                if (rows.length === 0) break;
                for (const r of rows) walked.push(r.media_id);
                const last = rows[rows.length - 1];
                cursor = { createdAt: last.created_at_cursor!, id: last.media_id };
                if (rows.length < pageSize) break;
            }

            expect(walked).toEqual(expectedOrder);
            expect(new Set(walked).size).toBe(walked.length);
        });

        it('preserves microsecond precision across the page boundary', async () => {
            const movies = await createTestMovieBatch(sql, 2);
            const userId = generateTestUserId();
            // Two ratings in the SAME millisecond, 1 microsecond apart. A cursor
            // that round-tripped through a JS Date (ms precision) would collapse
            // these to the same instant and skip or re-emit one across the page 1 →
            // page 2 boundary.
            await insertTestRating(sql, createTestRating(userId, movies[0].id, 8));
            await insertTestRating(sql, createTestRating(userId, movies[1].id, 8));
            await setRatingCreatedAt(userId, movies[0].id, '2026-07-01 12:00:00.000002+00'); // newer
            await setRatingCreatedAt(userId, movies[1].id, '2026-07-01 12:00:00.000001+00'); // older

            // Page 1 (offset mode) size 1 → the newer row.
            const p1 = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 1,
                limit: 1,
                offset: 0,
                access: unrestrictedAccess(),
            });
            expect(p1.length).toBe(1);
            expect(p1[0].media_id).toBe(movies[0].id);
            // The cursor carries the exact micro rendering, not a ms-truncated Date.
            expect(p1[0].created_at_cursor).toContain('.000002');

            // Page 2 (cursor mode) size 1 → the older row, NOT a skip/dup.
            const p2 = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 1,
                limit: 1,
                cursor: { createdAt: p1[0].created_at_cursor!, id: p1[0].media_id },
                access: unrestrictedAccess(),
            });
            expect(p2.length).toBe(1);
            expect(p2[0].media_id).toBe(movies[1].id);
        });

        it('id tiebreak orders rows sharing an identical created_at without skip/dup', async () => {
            const movies = await createTestMovieBatch(sql, 3);
            const userId = generateTestUserId();
            const sameTs = '2026-07-01 12:00:00.000000+00';
            for (const m of movies) {
                await insertTestRating(sql, createTestRating(userId, m.id, 8));
                await setRatingCreatedAt(userId, m.id, sameTs);
            }

            const full = await getUserRatingsFullMetadata.all(sql, {
                userId,
                ratingMin: 1,
                limit: 100,
                access: unrestrictedAccess(),
            });
            expect(full.length).toBe(3);
            const expectedOrder = full.map((r) => r.media_id);

            // Walk one row per page through the cursor and confirm identical order.
            const walked: string[] = [];
            let cursor: { createdAt: string; id: string } | null = null;
            for (let guard = 0; guard < 6; guard++) {
                const rows = await getUserRatingsFullMetadata.all(sql, {
                    userId,
                    ratingMin: 1,
                    limit: 1,
                    access: unrestrictedAccess(),
                    ...(cursor ? { cursor } : { offset: 0 }),
                });
                if (rows.length === 0) break;
                walked.push(rows[0].media_id);
                cursor = { createdAt: rows[0].created_at_cursor!, id: rows[0].media_id };
            }

            expect(walked).toEqual(expectedOrder);
            expect(new Set(walked).size).toBe(3);
        });
    });

    describe('getUsersWhoRated', () => {
        it('returns all users who rated a media item', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600094,
            });
            const users = [generateTestUserId(), generateTestUserId(), generateTestUserId()];

            for (let i = 0; i < users.length; i++) {
                await insertTestRating(sql, createTestRating(users[i], mediaId, 5 + i));
            }

            const result = await getUsersWhoRated.all(sql, { mediaId });

            expect(result.length).toBe(3);
            const userIds = result.map((r) => r.user_id);
            users.forEach((u) => {
                expect(userIds).toContain(u);
            });
        });

        it('excludes skipped ratings', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600095,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertUserRating.execute(sql, {
                userId,
                mediaId,
                rating: 5,
                skipped: true,
            });

            const result = await getUsersWhoRated.all(sql, { mediaId });

            expect(result.length).toBe(0);
        });

        it('returns empty array for unrated media', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 600096,
            });

            const result = await getUsersWhoRated.all(sql, { mediaId });

            expect(result).toEqual([]);
        });
    });

    // ==========================================================================
    // Admin/Bulk Operations
    // ==========================================================================

    describe('deleteUserRatingsSimple', () => {
        it('deletes all ratings without returning count', async () => {
            const movies = await createTestMovieBatch(sql, 3);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 7));
            }

            await deleteUserRatingsSimple(sql, userId);

            // Verify all deleted
            const count = await getUserRatingCount.get(sql, { userId });
            expect(count).toBe(0);
        });
    });

    describe('countUserRatings', () => {
        it('returns accurate count', async () => {
            const movies = await createTestMovieBatch(sql, 4);
            const userId = generateTestUserId();

            for (const movie of movies) {
                await insertTestRating(sql, createTestRating(userId, movie.id, 6));
            }

            const count = await countUserRatings(sql, userId);

            expect(count).toBe(4);
        });

        it('returns 0 for user with no ratings', async () => {
            const userId = generateTestUserId();

            const count = await countUserRatings(sql, userId);

            expect(count).toBe(0);
        });
    });

    // Repointed from the legacy user_watchlist table (watchlist-as-system-
    // playlist migration, task 5) to playlist_items/playlists (playlist_type =
    // 'watchlist'). The only consumer (GET /api/ai/clear-user/[userId]) uses
    // this for a REPORTED count on a route that explicitly preserves watchlist
    // data — a wrong count here misreports what clear-user left behind.
    describe('countUserWatchlist', () => {
        it('counts playlist_items rows on the user watchlist playlist', async () => {
            await truncateTables(sql, ['playlist_items', 'playlists']);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const movies = await createTestMovieBatch(sql, 3);

            for (const movie of movies) {
                await upsertWatchlistItem(sql, toUserId(userId), movie.id);
            }

            const count = await countUserWatchlist(sql, toUserId(userId));

            expect(count).toBe(3);
        });

        it('does not duplicate on a fan-out playlist_items row (different season key, same media)', async () => {
            await truncateTables(sql, ['playlist_items', 'playlists']);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 600101 });

            await upsertWatchlistItem(sql, toUserId(userId), mediaId);
            const [playlistRow] = await sql<{ id: number }[]>`
                SELECT id FROM playlists WHERE user_id = ${userId}::uuid AND playlist_type = 'watchlist'
            `;
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, season_number, episode_number, title, position)
                VALUES (${playlistRow.id}, ${mediaId}::uuid, 1, NULL, 'Fan-out row', 99)
            `;

            const count = await countUserWatchlist(sql, toUserId(userId));

            expect(count).toBe(2);
        });

        it('returns 0 for a user with no watchlist items', async () => {
            await truncateTables(sql, ['playlist_items', 'playlists']);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const count = await countUserWatchlist(sql, toUserId(userId));

            expect(count).toBe(0);
        });

        it('does not count another users watchlist items', async () => {
            await truncateTables(sql, ['playlist_items', 'playlists']);
            const owner = generateTestUserId();
            const viewer = generateTestUserId();
            await ensureTestUser(sql, owner);
            await ensureTestUser(sql, viewer);
            const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 600102 });

            await upsertWatchlistItem(sql, toUserId(owner), mediaId);

            const count = await countUserWatchlist(sql, toUserId(viewer));

            expect(count).toBe(0);
        });
    });

    describe('deleteUserSuggestions', () => {
        it('deletes all suggestions for a user', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Insert some suggestions
            const movies = await createTestMovieBatch(sql, 3);
            for (const movie of movies) {
                await sql`
                    INSERT INTO user_suggestions (user_id, media_id, combined_score)
                    VALUES (${userId}, ${movie.id}::uuid, 0.8)
                `;
            }

            // Verify they exist
            const beforeCount = await countUserSuggestions(sql, userId);
            expect(beforeCount).toBe(3);

            // Delete
            await deleteUserSuggestions(sql, userId);

            // Verify deleted
            const afterCount = await countUserSuggestions(sql, userId);
            expect(afterCount).toBe(0);
        });

        it('handles user with no suggestions', async () => {
            const userId = generateTestUserId();

            // Should not throw
            await deleteUserSuggestions(sql, userId);

            const count = await countUserSuggestions(sql, userId);
            expect(count).toBe(0);
        });
    });

    describe('deleteUserProfile', () => {
        it('deletes user profile', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Verify profile exists
            const [before] = await sql`
                SELECT COUNT(*) as count FROM user_profiles WHERE user_id = ${userId}
            `;
            expect(Number(before.count)).toBe(1);

            // Delete
            await deleteUserProfile(sql, userId);

            // Verify deleted
            const [after] = await sql`
                SELECT COUNT(*) as count FROM user_profiles WHERE user_id = ${userId}
            `;
            expect(Number(after.count)).toBe(0);
        });

        it('handles non-existent user', async () => {
            const userId = generateTestUserId();

            // Should not throw
            await deleteUserProfile(sql, userId);
        });
    });

    describe('countUserSuggestions', () => {
        it('returns accurate count', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const movies = await createTestMovieBatch(sql, 5);
            for (const movie of movies) {
                await sql`
                    INSERT INTO user_suggestions (user_id, media_id, combined_score)
                    VALUES (${userId}, ${movie.id}::uuid, 0.75)
                `;
            }

            const count = await countUserSuggestions(sql, userId);

            expect(count).toBe(5);
        });

        it('returns 0 for user with no suggestions', async () => {
            const userId = generateTestUserId();

            const count = await countUserSuggestions(sql, userId);

            expect(count).toBe(0);
        });
    });

    // ==========================================================================
    // Episode Ratings — AI Bypass Invariant
    // ==========================================================================

    describe('Episode ratings (AI bypass invariant)', () => {
        it('stores a rating for an episode UUID', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            // Grab the first (and only) episode's UUID via the DB
            const [epRow] = await sql<{ id: string }[]>`
                SELECT mi.id FROM media_items mi
                WHERE mi.parent_id = (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid LIMIT 1
                )
                AND mi.media_type = 'episode'
                LIMIT 1
            `;
            expect(epRow).toBeDefined();
            const episodeId = epRow.id;

            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await upsertUserRating.execute(sql, {
                userId,
                mediaId: episodeId,
                rating: 8,
            });

            expect(result.length).toBe(1);
            expect(result[0].rating).toBe(8);
            expect(result[0].media_id).toBe(episodeId);
        });

        it('episode media_type is correctly identified by isEpisode()', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [epRow] = await sql<{ id: string; media_type: string }[]>`
                SELECT mi.id, mi.media_type FROM media_items mi
                WHERE mi.parent_id = (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid LIMIT 1
                )
                AND mi.media_type = 'episode'
                LIMIT 1
            `;
            expect(epRow).toBeDefined();

            // This is the exact check used in /api/ai/rate to bypass the AI pipeline
            expect(isEpisode(epRow.media_type)).toBe(true);
        });

        it('resolveExternalIdsToMediaId fast-path: internal UUID is returned unchanged', async () => {
            // Verify the fast-path: the route uses resolveExternalIdsToMediaId which returns
            // the internal UUID directly without a DB lookup when it is a valid UUID.
            // We test the invariant at the DB level: upsertUserRating with the episode UUID works.
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodes = await sql<{ id: string }[]>`
                SELECT mi.id FROM media_items mi
                WHERE mi.parent_id = (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid LIMIT 1
                )
                AND mi.media_type = 'episode'
                ORDER BY mi.episode_number
            `;
            expect(episodes.length).toBe(2);

            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Rate both episodes separately
            for (const ep of episodes) {
                await upsertUserRating.execute(sql, {
                    userId,
                    mediaId: ep.id,
                    rating: 7,
                });
            }

            // Both ratings should be stored
            for (const ep of episodes) {
                const rating = await getUserRating.one(sql, {
                    userId,
                    mediaId: ep.id,
                });
                expect(rating).not.toBeNull();
                expect(rating?.rating).toBe(7);
            }
        });

        it('series parent is NOT an episode — isEpisode() returns false for tv', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [seriesRow] = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${series.seriesId}::uuid LIMIT 1
            `;
            expect(seriesRow).toBeDefined();
            // Series should not be treated as episode — no AI bypass for series ratings
            expect(isEpisode(seriesRow.media_type)).toBe(false);
        });
    });

    // ==========================================================================
    // Access boundary — differential
    // ==========================================================================

    /**
     * Every query in this module that joins `media_items` takes a REQUIRED
     * {@link MediaAccessBoundary}. Each case below runs the SAME query over the
     * SAME fixture three ways:
     *
     *   1. `unrestrictedAccess()` — POSITIVE CONTROL. Must return BOTH rows.
     *      Without it, an unreachable fixture returns nothing and every
     *      restricted assertion below passes vacuously.
     *   2. deny the denied row's library group — a STRICT SUBSET: the allowed row
     *      survives, the denied row does not.
     *   3. `denyAllAccess()` — EMPTY.
     *
     * This is what catches a boundary argument that arrived but was never
     * spliced into the SQL (cases 2 and 3 would return the unrestricted result),
     * and a predicate bound to the wrong alias: `buildLibraryAccessFilter`
     * hardcodes `mi` and `buildAgeRatingFilter` defaults to it, so a mis-aliased
     * query raises "missing FROM-clause entry for table mi" — but ONLY under a
     * restricted boundary, since both builders emit an empty fragment when the
     * scope is `all`/`any`. An unrestricted-only test proves nothing here.
     *
     * The age axis is asserted independently of the library axis so that a
     * boundary which happens to thread `library` correctly while dropping `age`
     * (or vice versa) still fails.
     */
    describe('access boundary is honoured (differential)', () => {
        let boundaryUser: UserId;
        let groupA: string;

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
         * Seed one rated media item.
         *
         * When `libraryGroupId` is given the item is placed in that group via
         * `placeInLibraryGroup`, which attaches the file wherever the
         * library-access predicate actually looks for it — directly for a leaf
         * type, on a generated descendant for a container type such as `album`.
         * An item with no files at all is the natural "always allowed" control,
         * since the predicate unconditionally admits those.
         */
        async function seedRated(opts: {
            mediaType: string;
            rating: number;
            libraryGroupId?: string;
            ageRating?: number | null;
            withEmbedding?: boolean;
        }): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, age_rating)
                VALUES (
                    ${id}::uuid,
                    ${`Boundary ${id.slice(0, 8)}`},
                    ${opts.mediaType},
                    'active',
                    ${Boolean(opts.libraryGroupId)},
                    ${opts.ageRating ?? null}
                )
            `;
            await insertTestRating(sql, createTestRating(boundaryUser, id, opts.rating));
            if (opts.withEmbedding) {
                await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
            }
            if (opts.libraryGroupId) {
                // Routed through the shared helper rather than attaching a file
                // to `id` directly: for a container type (`album` below) the
                // access predicate judges DESCENDANTS' files, never the
                // container's own, so a direct attach leaves the restriction
                // vacuous and the differential assertions pass on nothing.
                await placeInLibraryGroup(sql, {
                    mediaItemId: id,
                    mediaType: opts.mediaType as PlaceableMediaType,
                    libraryGroupId: opts.libraryGroupId,
                });
            }
            return id;
        }

        /**
         * The shared differential assertions. `deniedId` sits in groupA;
         * `allowedId` has no files at all. `run` must surface both under an
         * unrestricted boundary.
         */
        async function assertBoundaryHonoured(
            run: (access: MediaAccessBoundary) => Promise<string[]>,
            deniedId: string,
            allowedId: string,
        ): Promise<void> {
            // 1. Positive control — the fixture is reachable at all.
            const open = await run(unrestrictedAccess());
            expect(open, 'unrestricted boundary must surface both rows').toEqual(
                expect.arrayContaining([deniedId, allowedId]),
            );

            // 2. Strict subset — the allowed row survives, the denied row is gone.
            const restricted = await run(denyGroups(groupA));
            expect(restricted).toContain(allowedId);
            expect(restricted).not.toContain(deniedId);
            expect(restricted.length).toBeLessThan(open.length);
            for (const id of restricted) expect(open).toContain(id);

            // 3. denyAll returns nothing at all.
            expect(await run(denyAllAccess())).toEqual([]);
        }

        beforeEach(async () => {
            // The outer beforeEach already truncated media + user data; media_files
            // goes with it, so library_groups can be cleared without FK trouble.
            // library_paths.library_group_id FKs library_groups ON DELETE
            // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
            // earlier left a group-attached library_paths row behind. Drop the
            // dependents first: this file's intent is "no library groups exist",
            // and a path attached to a group that is about to be deleted has to go
            // with it anyway. Group-less paths are deliberately left alone.
            await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
            await sql`DELETE FROM library_groups`;
            boundaryUser = generateTestUserId();
            await ensureTestUser(sql, boundaryUser);
            groupA = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupA}::uuid, 'Denied Ratings Group')
            `;
        });

        afterAll(async () => {
            // library_paths.library_group_id FKs library_groups ON DELETE
            // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
            // earlier left a group-attached library_paths row behind. Drop the
            // dependents first: this file's intent is "no library groups exist",
            // and a path attached to a group that is about to be deleted has to go
            // with it anyway. Group-less paths are deliberately left alone.
            await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
            await sql`DELETE FROM library_groups`;
        });

        it('getUserRatingsWithMetadata honours the library axis', async () => {
            const denied = await seedRated({
                mediaType: 'movie',
                rating: 8,
                libraryGroupId: groupA,
            });
            const allowed = await seedRated({ mediaType: 'movie', rating: 8 });

            await assertBoundaryHonoured(
                async (access) =>
                    (
                        await getUserRatingsWithMetadata.all(sql, {
                            userId: boundaryUser,
                            limit: 50,
                            offset: 0,
                            access,
                        })
                    ).map((r) => r.media_id),
                denied,
                allowed,
            );
        });

        it('getUserRatingsWithMetadata honours the age axis independently', async () => {
            const adult = await seedRated({ mediaType: 'movie', rating: 8, ageRating: 18 });
            const family = await seedRated({ mediaType: 'movie', rating: 8, ageRating: 6 });

            const run = async (access: MediaAccessBoundary): Promise<string[]> =>
                (
                    await getUserRatingsWithMetadata.all(sql, {
                        userId: boundaryUser,
                        limit: 50,
                        offset: 0,
                        access,
                    })
                ).map((r) => r.media_id);

            expect(await run(unrestrictedAccess())).toEqual(
                expect.arrayContaining([adult, family]),
            );

            const limited = await run(limitAge(12, true));
            expect(limited).toContain(family);
            expect(limited).not.toContain(adult);
        });

        it('getUserRatingsFullMetadata honours the library axis', async () => {
            const denied = await seedRated({
                mediaType: 'movie',
                rating: 9,
                libraryGroupId: groupA,
            });
            const allowed = await seedRated({ mediaType: 'movie', rating: 9 });

            await assertBoundaryHonoured(
                async (access) =>
                    (
                        await getUserRatingsFullMetadata.all(sql, {
                            userId: boundaryUser,
                            ratingMin: 1,
                            limit: 50,
                            offset: 0,
                            access,
                        })
                    ).map((r) => r.media_id),
                denied,
                allowed,
            );
        });

        it('getUserRatingsFullMetadata honours the age axis, including allowUnrated', async () => {
            const unrated = await seedRated({ mediaType: 'movie', rating: 9, ageRating: null });
            const family = await seedRated({ mediaType: 'movie', rating: 9, ageRating: 6 });

            const run = async (access: MediaAccessBoundary): Promise<string[]> =>
                (
                    await getUserRatingsFullMetadata.all(sql, {
                        userId: boundaryUser,
                        ratingMin: 1,
                        limit: 50,
                        offset: 0,
                        access,
                    })
                ).map((r) => r.media_id);

            // allowUnrated: true keeps the NULL-age-rating row.
            const permissive = await run(limitAge(12, true));
            expect(permissive).toEqual(expect.arrayContaining([unrated, family]));

            // allowUnrated: false drops it — proving allowUnrated is actually bound
            // and not hardcoded on the way through the boundary.
            const strict = await run(limitAge(12, false));
            expect(strict).toContain(family);
            expect(strict).not.toContain(unrated);
        });

        it('getUserRatingsForMedia honours the boundary', async () => {
            const denied = await seedRated({
                mediaType: 'movie',
                rating: 7,
                libraryGroupId: groupA,
            });
            const allowed = await seedRated({ mediaType: 'movie', rating: 7 });

            await assertBoundaryHonoured(
                async (access) =>
                    (
                        await getUserRatingsForMedia.all(sql, {
                            userId: boundaryUser,
                            mediaIds: [denied, allowed],
                            access,
                        })
                    ).map((r) => r.media_id),
                denied,
                allowed,
            );
        });

        it('getStarredItemIds honours the boundary', async () => {
            const denied = await seedRated({
                mediaType: 'album',
                rating: 10,
                libraryGroupId: groupA,
            });
            const allowed = await seedRated({ mediaType: 'album', rating: 10 });

            await assertBoundaryHonoured(
                async (access) =>
                    (await getStarredItemIds(sql, boundaryUser, access)).map((r) => r.id),
                denied,
                allowed,
            );
        });

        it('getStarredAlbumIds honours the boundary', async () => {
            const denied = await seedRated({
                mediaType: 'album',
                rating: 10,
                libraryGroupId: groupA,
            });
            const allowed = await seedRated({ mediaType: 'album', rating: 10 });

            await assertBoundaryHonoured(
                async (access) =>
                    (await getStarredAlbumIds(sql, boundaryUser, 50, access)).map((r) => r.id),
                denied,
                allowed,
            );
        });

        it('getDemoEligibleMedia honours the boundary', async () => {
            const denied = await seedRated({
                mediaType: 'movie',
                rating: 5,
                libraryGroupId: groupA,
                withEmbedding: true,
            });
            const allowed = await seedRated({
                mediaType: 'movie',
                rating: 5,
                withEmbedding: true,
            });

            await assertBoundaryHonoured(
                async (access) =>
                    (await getDemoEligibleMedia(sql, 50, access)).map((r) => r.media_id),
                denied,
                allowed,
            );
        });
    });
});
