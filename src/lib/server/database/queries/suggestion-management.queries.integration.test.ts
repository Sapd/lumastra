// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests: Suggestion Management Queries
 *
 * Tests CRUD operations for user suggestions.
 * Uses real database with test data.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    getTestDb,
    closeTestDb,
    truncateTestTables,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    saveSuggestions,
    getUserSuggestions,
    clearUserSuggestions,
    cleanupExpiredSuggestions,
    type UserSuggestionInput,
} from './suggestion-management.queries.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/media.fixtures.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import type { Sql } from 'postgres';
import { attachFileToItem, recomputeHasFilesBatch } from './media-files.queries.js';
import { MediaLifecycleService } from '../../services/media-lifecycle.service.js';

// saveSuggestions only mints stub rows while the discovery catalog is enabled.
// Default ON; the gate test below flips it off.
const discoveryGate = vi.hoisted(() => ({ enabled: true }));
vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    isDiscoveryCatalogEnabled: () => discoveryGate.enabled,
}));

describe('Suggestion Management Queries', () => {
    let sql: Sql;
    const testUserId = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
        // Stub creation fires afterCreated (stage-state seeding, cache wipes)
        // fire-and-forget; under CI load it raced the next beforeEach TRUNCATE
        // and deadlocked (shard 4, 2026-10-20). Same stub as media-upsert's test.
        vi.spyOn(MediaLifecycleService, 'afterCreated').mockResolvedValue(undefined);
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clean up test data before each test
        await truncateTestTables(sql, [
            'user_suggestions',
            'media_file_items',
            'media_files',
            'media_embeddings',
            'external_ids',
            'library_availability',
            'provider_metadata',
            'user_ratings',
            'media_items',
            'user_profiles',
        ]);
        // Ensure test user exists in user_profiles (FK requirement for user_suggestions)
        await ensureTestUser(sql, testUserId);
    });

    describe('saveSuggestions', () => {
        it('should save new suggestions to database', async () => {
            // Create test movie
            await createAndInsertTestMovie(sql, {
                title: 'Test Movie',
                tmdbId: 991001,
            });

            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991001',
                    media_type: 'movie',
                    cache_context: 'general',
                    library_similarity_score: 0.85,
                    discovery_similarity_score: 0.78,
                    combined_score: 0.82,
                    suggestion_reason: 'High similarity match',
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, suggestions);

            // Verify suggestion was saved
            const saved = await getUserSuggestions(sql, testUserId, 10);

            expect(saved).toHaveLength(1);
            expect(saved[0].primary_ext_id).toBe('991001');
            expect(saved[0].combined_score).toBeCloseTo(0.82, 2);
        });

        it('should handle ON CONFLICT with upsert logic', async () => {
            // Create test movie
            await createAndInsertTestMovie(sql, {
                title: 'Test Movie',
                tmdbId: 991002,
            });

            // Insert initial suggestion
            const initial: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991002',
                    media_type: 'movie',
                    cache_context: 'general',
                    combined_score: 0.75,
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, initial);

            // Update with new score
            const updated: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991002',
                    media_type: 'movie',
                    cache_context: 'general',
                    combined_score: 0.88,
                    suggestion_reason: 'Updated score',
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, updated);

            // Verify only one entry exists with updated score
            const saved = await getUserSuggestions(sql, testUserId, 10);

            expect(saved).toHaveLength(1);
            expect(saved[0].combined_score).toBeCloseTo(0.88, 2);
            expect(saved[0].suggestion_reason).toBe('Updated score');
        });

        it('should create media items for non-existent TMDB IDs', async () => {
            // Use TMDB ID that doesn't exist yet
            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '999999',
                    media_type: 'movie',
                    cache_context: 'general',
                    combined_score: 0.75,
                    is_available: false,
                    can_request: true,
                },
            ];

            await saveSuggestions(sql, suggestions);

            // Verify suggestion was saved
            const saved = await getUserSuggestions(sql, testUserId, 10);

            expect(saved).toHaveLength(1);
            expect(saved[0].primary_ext_id).toBe('999999');

            // Verify media item was created
            const mediaExists = await sql`
				SELECT id FROM media_items mi
				WHERE EXISTS (
					SELECT 1 FROM external_ids
					WHERE media_id = mi.id
					AND provider = 'tmdb'
					AND external_id = '999999'
				)
			`;
            expect(mediaExists).toHaveLength(1);
        });

        it('creates no media item and saves no suggestion when the discovery catalog is disabled', async () => {
            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '999998',
                    media_type: 'movie',
                    cache_context: 'general',
                    combined_score: 0.75,
                    is_available: false,
                    can_request: true,
                },
            ];

            discoveryGate.enabled = false;
            try {
                await saveSuggestions(sql, suggestions);
            } finally {
                discoveryGate.enabled = true;
            }

            expect(await getUserSuggestions(sql, testUserId, 10)).toHaveLength(0);
            const rows = await sql`
				SELECT 1 FROM external_ids WHERE provider = 'tmdb' AND external_id = '999998'
			`;
            expect(rows).toHaveLength(0);
        });

        it('should set expiration to 2 days from now', async () => {
            await createAndInsertTestMovie(sql, {
                title: 'Test Movie',
                tmdbId: 991003,
            });

            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991003',
                    media_type: 'movie',
                    combined_score: 0.8,
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, suggestions);

            // Verify expiration is set
            const saved = await getUserSuggestions(sql, testUserId, 10);

            expect(saved).toHaveLength(1);
            expect(saved[0].expires_at).toBeDefined();

            // Verify it's approximately 2 days from now (within 1 hour tolerance)
            const now = Date.now();
            const twoDays = 2 * 24 * 60 * 60 * 1000;
            const expiresAt = saved[0].expires_at.getTime();
            const diff = Math.abs(expiresAt - (now + twoDays));
            expect(diff).toBeLessThan(60 * 60 * 1000); // Within 1 hour
        });
    });

    describe('getUserSuggestions', () => {
        it('reads canonical availability for a saved series with episode files only', async () => {
            const series = await createAndInsertTestTvShow(sql, {
                title: 'Available Series',
                tmdbId: 881100,
            });
            const season = createTestMediaItem({
                media_type: 'season',
                parent_id: series.id,
            });
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, season);
            await insertTestMediaItem(sql, episode);
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path)
                VALUES (${fileId}::uuid, ${`/test/episodes/${episode.id}.mkv`})
            `;
            await attachFileToItem(sql, fileId, episode.id);
            const directLinks = await sql`
                SELECT file_id FROM media_file_items
                WHERE media_item_id = ${series.id}::uuid
            `;
            expect(directLinks).toHaveLength(0);

            await saveSuggestions(sql, [
                {
                    user_id: testUserId,
                    primary_ext_id: String(series.tmdbId),
                    media_type: 'tv',
                    combined_score: 0.76,
                    // Input flags are not persisted; availability is read from the catalog.
                    is_available: false,
                    can_request: true,
                },
            ]);

            const results = await getUserSuggestions(sql, testUserId, 10);
            expect(results).toHaveLength(1);
            expect(results[0].media_id).toBe(series.id);
            expect(results[0].media_type).toBe('tv');
            expect(results[0].combined_score).toBeCloseTo(0.76, 2);
            expect(results[0].is_available).toBe(true);
            expect(results[0].can_request).toBe(false);

            await sql`DELETE FROM media_file_items WHERE file_id = ${fileId}::uuid`;
            await recomputeHasFilesBatch(sql, [episode.id]);
            const unavailable = await getUserSuggestions(sql, testUserId, 10);
            expect(unavailable).toHaveLength(1);
            expect(unavailable[0].media_id).toBe(series.id);
            expect(unavailable[0].is_available).toBe(false);
            expect(unavailable[0].can_request).toBe(true);

            await attachFileToItem(sql, fileId, episode.id);
            const restored = await getUserSuggestions(sql, testUserId, 10);
            expect(restored).toHaveLength(1);
            expect(restored[0].media_id).toBe(series.id);
            expect(restored[0].is_available).toBe(true);
            expect(restored[0].can_request).toBe(false);
        });

        it('should retrieve suggestions for a user', async () => {
            await createAndInsertTestMovie(sql, {
                title: 'Movie 1',
                tmdbId: 991101,
            });
            await createAndInsertTestMovie(sql, {
                title: 'Movie 2',
                tmdbId: 991102,
            });

            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991101',
                    media_type: 'movie',
                    combined_score: 0.9,
                    is_available: true,
                    can_request: false,
                },
                {
                    user_id: testUserId,
                    primary_ext_id: '991102',
                    media_type: 'movie',
                    combined_score: 0.85,
                    is_available: false,
                    can_request: true,
                },
            ];

            await saveSuggestions(sql, suggestions);

            const results = await getUserSuggestions(sql, testUserId, 10);

            expect(results).toHaveLength(2);
            // Should be ordered by combined_score DESC
            expect(results[0].primary_ext_id).toBe('991101');
            expect(results[1].primary_ext_id).toBe('991102');
        });

        it('should filter by media type', async () => {
            await createAndInsertTestMovie(sql, {
                title: 'Test Movie',
                tmdbId: 991201,
            });

            // Create TV show manually since we need it
            const tvId = crypto.randomUUID();
            await sql`
				INSERT INTO media_items (id, title, media_type, status)
				VALUES (${tvId}::uuid, 'Test TV Show', 'tv', 'active')
			`;
            await sql`
				INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
				VALUES (${tvId}::uuid, 'tmdb', '881201', 'tv', true)
			`;

            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991201',
                    media_type: 'movie',
                    combined_score: 0.9,
                    is_available: true,
                    can_request: false,
                },
                {
                    user_id: testUserId,
                    primary_ext_id: '881201',
                    media_type: 'tv',
                    combined_score: 0.85,
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, suggestions);

            // Filter for movies only
            const movieResults = await getUserSuggestions(sql, testUserId, 10, {
                mediaType: 'movie',
            });
            expect(movieResults).toHaveLength(1);
            expect(movieResults[0].primary_ext_id).toBe('991201');

            // Filter for TV only
            const tvResults = await getUserSuggestions(sql, testUserId, 10, {
                mediaType: 'tv',
            });
            expect(tvResults).toHaveLength(1);
            expect(tvResults[0].primary_ext_id).toBe('881201');
        });

        it('should exclude persisted non-video suggestions from the default read', async () => {
            const movie = await createAndInsertTestMovie(sql, {
                title: 'Video Suggestion',
                tmdbId: 991250,
            });
            const audiobookId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${audiobookId}::uuid, 'Persisted Audiobook', 'audiobook', 'active')
            `;

            await sql`
                INSERT INTO user_suggestions (
                    user_id, media_id, cache_context, combined_score, expires_at
                )
                VALUES
                    (${testUserId}, ${audiobookId}::uuid, 'general', 1.0, NOW() + INTERVAL '1 day'),
                    (${testUserId}, ${movie.id}::uuid, 'general', 0.5, NOW() + INTERVAL '1 day')
            `;

            const results = await getUserSuggestions(sql, testUserId, 10);

            expect(results).toHaveLength(1);
            expect(results[0].media_type).toBe('movie');
        });

        it('should filter by cache context', async () => {
            await createAndInsertTestMovie(sql, {
                title: 'General Movie',
                tmdbId: 991301,
            });
            await createAndInsertTestMovie(sql, {
                title: 'Watched Based Movie',
                tmdbId: 991302,
            });

            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991301',
                    media_type: 'movie',
                    cache_context: 'general',
                    combined_score: 0.9,
                    is_available: true,
                    can_request: false,
                },
                {
                    user_id: testUserId,
                    primary_ext_id: '991302',
                    media_type: 'movie',
                    cache_context: 'watched_based',
                    combined_score: 0.85,
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, suggestions);

            // Filter for general context
            const generalResults = await getUserSuggestions(sql, testUserId, 10, {
                cacheContext: 'general',
            });
            expect(generalResults).toHaveLength(1);
            expect(generalResults[0].primary_ext_id).toBe('991301');

            // Filter for watched_based context
            const watchedResults = await getUserSuggestions(sql, testUserId, 10, {
                watchedBased: true,
            });
            expect(watchedResults).toHaveLength(1);
            expect(watchedResults[0].primary_ext_id).toBe('991302');
        });

        it('should respect limit parameter', async () => {
            // Create 10 suggestions
            const suggestions: UserSuggestionInput[] = [];
            for (let i = 0; i < 10; i++) {
                await createAndInsertTestMovie(sql, {
                    title: `Movie ${i}`,
                    tmdbId: 991400 + i,
                });

                suggestions.push({
                    user_id: testUserId,
                    primary_ext_id: String(991400 + i),
                    media_type: 'movie',
                    combined_score: 0.9 - i * 0.05,
                    is_available: true,
                    can_request: false,
                });
            }

            await saveSuggestions(sql, suggestions);

            // Request only 3
            const results = await getUserSuggestions(sql, testUserId, 3);

            expect(results).toHaveLength(3);
            // Should get highest scoring ones
            expect(results[0].primary_ext_id).toBe('991400');
            expect(results[1].primary_ext_id).toBe('991401');
            expect(results[2].primary_ext_id).toBe('991402');
        });

        it('should exclude expired suggestions', async () => {
            const movie = await createAndInsertTestMovie(sql, {
                title: 'Expired Movie',
                tmdbId: 991501,
            });

            // Insert expired suggestion directly
            await sql`
				INSERT INTO user_suggestions (
					user_id, media_id, cache_context, combined_score, expires_at
				)
				VALUES (
					${testUserId},
					${movie.id}::uuid,
					'general',
					0.9,
					NOW() - INTERVAL '1 day'
				)
			`;

            const results = await getUserSuggestions(sql, testUserId, 10);

            expect(results).toHaveLength(0);
        });
    });

    describe('clearUserSuggestions', () => {
        it('should clear all suggestions for a user', async () => {
            await createAndInsertTestMovie(sql, {
                title: 'Movie 1',
                tmdbId: 991601,
            });
            await createAndInsertTestMovie(sql, {
                title: 'Movie 2',
                tmdbId: 991602,
            });

            const suggestions: UserSuggestionInput[] = [
                {
                    user_id: testUserId,
                    primary_ext_id: '991601',
                    media_type: 'movie',
                    combined_score: 0.9,
                    is_available: true,
                    can_request: false,
                },
                {
                    user_id: testUserId,
                    primary_ext_id: '991602',
                    media_type: 'movie',
                    combined_score: 0.85,
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, suggestions);

            // Verify suggestions exist
            let results = await getUserSuggestions(sql, testUserId, 10);
            expect(results).toHaveLength(2);

            // Clear suggestions
            await clearUserSuggestions(sql, testUserId);

            // Verify suggestions are gone
            results = await getUserSuggestions(sql, testUserId, 10);
            expect(results).toHaveLength(0);
        });

        it('should not affect other users suggestions', async () => {
            await createAndInsertTestMovie(sql, {
                title: 'Shared Movie',
                tmdbId: 991701,
            });

            // Ensure both users exist in user_profiles (FK requirement)
            const altUser1 = generateTestUserId();
            const altUser2 = generateTestUserId();
            await ensureTestUser(sql, altUser1);
            await ensureTestUser(sql, altUser2);

            const user1Suggestions: UserSuggestionInput[] = [
                {
                    user_id: altUser1,
                    primary_ext_id: '991701',
                    media_type: 'movie',
                    combined_score: 0.9,
                    is_available: true,
                    can_request: false,
                },
            ];

            const user2Suggestions: UserSuggestionInput[] = [
                {
                    user_id: altUser2,
                    primary_ext_id: '991701',
                    media_type: 'movie',
                    combined_score: 0.85,
                    is_available: true,
                    can_request: false,
                },
            ];

            await saveSuggestions(sql, user1Suggestions);
            await saveSuggestions(sql, user2Suggestions);

            // Clear altUser1's suggestions
            await clearUserSuggestions(sql, altUser1);

            // Verify altUser1 has no suggestions
            const user1Results = await getUserSuggestions(sql, altUser1, 10);
            expect(user1Results).toHaveLength(0);

            // Verify altUser2 still has suggestions
            const user2Results = await getUserSuggestions(sql, altUser2, 10);
            expect(user2Results).toHaveLength(1);
        });
    });

    describe('cleanupExpiredSuggestions', () => {
        it('should delete expired suggestions', async () => {
            const movie1 = await createAndInsertTestMovie(sql, {
                title: 'Active Movie',
                tmdbId: 991801,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                title: 'Expired Movie',
                tmdbId: 991802,
            });

            // Insert active suggestion
            await sql`
				INSERT INTO user_suggestions (
					user_id, media_id, cache_context, combined_score, expires_at
				)
				VALUES (
					${testUserId},
					${movie1.id}::uuid,
					'general',
					0.9,
					NOW() + INTERVAL '1 day'
				)
			`;

            // Insert expired suggestion
            await sql`
				INSERT INTO user_suggestions (
					user_id, media_id, cache_context, combined_score, expires_at
				)
				VALUES (
					${testUserId},
					${movie2.id}::uuid,
					'general',
					0.85,
					NOW() - INTERVAL '1 day'
				)
			`;

            // Clean up expired
            const deletedCount = await cleanupExpiredSuggestions(sql);

            expect(deletedCount).toBe(1);

            // Verify only active suggestion remains
            const results = await getUserSuggestions(sql, testUserId, 10);
            expect(results).toHaveLength(1);
            expect(results[0].primary_ext_id).toBe('991801');
        });

        it('should return count of deleted suggestions', async () => {
            // Insert multiple expired suggestions
            for (let i = 0; i < 5; i++) {
                const movie = await createAndInsertTestMovie(sql, {
                    title: `Expired Movie ${i}`,
                    tmdbId: 991900 + i,
                });

                await sql`
					INSERT INTO user_suggestions (
						user_id, media_id, cache_context, combined_score, expires_at
					)
					VALUES (
						${testUserId},
						${movie.id}::uuid,
						'general',
						0.8,
						NOW() - INTERVAL '1 day'
					)
				`;
            }

            const deletedCount = await cleanupExpiredSuggestions(sql);

            expect(deletedCount).toBe(5);
        });

        it('should return 0 when no expired suggestions exist', async () => {
            const movie = await createAndInsertTestMovie(sql, {
                title: 'Active Movie',
                tmdbId: 992001,
            });

            // Insert active suggestion
            await sql`
				INSERT INTO user_suggestions (
					user_id, media_id, cache_context, combined_score, expires_at
				)
				VALUES (
					${testUserId},
					${movie.id}::uuid,
					'general',
					0.9,
					NOW() + INTERVAL '1 day'
				)
			`;

            const deletedCount = await cleanupExpiredSuggestions(sql);

            expect(deletedCount).toBe(0);
        });
    });
});
