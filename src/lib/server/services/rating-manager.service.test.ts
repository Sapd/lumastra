// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/rating-manager.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserRating } from '$lib/server/database/connection.js';

const { mockSql, mockLogger } = vi.hoisted(() => ({
    mockSql: {} as postgres.Sql,
    mockLogger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getSql: vi.fn(async () => mockSql),
        getUserProfileService: vi.fn(),
        getUserRatingsService: vi.fn(),
        getSuggestionEngine: vi.fn(),
    },
}));

vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onUserRating: vi.fn().mockResolvedValue(undefined),
        onSuggestionSkipped: vi.fn().mockResolvedValue(undefined),
        onRatingCacheChanged: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/utils/media-resolution.js', () => ({
    resolveExternalIdsToMediaId: vi.fn(),
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    isEpisode: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserExists: vi.fn().mockResolvedValue(undefined),
    ensureUserProfileExists: vi.fn().mockResolvedValue(undefined),
    deleteUserSuggestionByMediaId: vi.fn().mockResolvedValue(undefined),
    deleteUserSuggestions: vi.fn().mockResolvedValue(undefined),
    deleteUserRating: { execute: vi.fn().mockResolvedValue([{ id: 1 }]) },
    getMediaTypeById: vi.fn(),
    countUserRatings: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/services/activity-feed.service.js', () => ({
    activityFeedService: {
        trackRatingEvent: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

import { aiDbService } from '$lib/server/services/database.service.js';
import { cacheInvalidation } from '$lib/server/cache';
import { resolveExternalIdsToMediaId } from '$lib/server/utils/media-resolution.js';
import { isEpisode } from '$lib/server/utils/media-types.js';
import {
    deleteUserSuggestionByMediaId,
    deleteUserSuggestions,
    deleteUserRating,
    getMediaTypeById,
    countUserRatings,
} from '$lib/server/database/queries/user-ratings.queries.js';
import { activityFeedService } from '$lib/server/services/activity-feed.service.js';
import { ratingManager } from './rating-manager.service.js';

// The stable users.id UUID that keys all user-data writes/reads (mig 16.46.0).
// Matches TEST_USER.userId below; assertions on user-data keys use this, not the
// 'alice' username (which only seeds the users row via ensureUserExists).
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

const makeRating = (overrides?: Partial<UserRating>): UserRating => ({
    id: 1,
    user_id: TEST_USER_ID,
    media_id: 'media-uuid-1',
    media_type: 'movie',
    rating: 7,
    created_at: new Date(),
    ...overrides,
});

const mockProfileService = {
    getUserProfile: vi.fn(),
    createUserProfileFromRatings: vi.fn(),
    rebuildUserProfile: vi.fn(),
};

const mockRatingsService = {
    addUserRating: vi.fn(),
};

const mockSuggestionEngine = {
    generateSuggestionsFromProfile: vi.fn(),
};

const baseExternalIds = { tmdb: '550' };

// Minimal UserContext for rating-manager calls. checkMediaAccess is mocked
// to always return true above, so the shape here only needs to satisfy the
// type at the call site.
const TEST_USER = {
    userId: toUserId('00000000-0000-0000-0000-000000000001'),
    username: 'alice',
    groups: '',
    userGroups: [],
    hasWatchPermission: true,
    hasLiveTvPermission: false,
    hasRequestPermission: false,
    ownerIsAdmin: false,
    maxAgeRating: null,
    isAgeRestricted: false,
    isModerator: false,
    liveTvPriority: 'low' as const,
};

describe('RatingManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(aiDbService.getSql).mockResolvedValue(mockSql);
        vi.mocked(aiDbService.getUserProfileService).mockResolvedValue(mockProfileService as never);
        vi.mocked(aiDbService.getUserRatingsService).mockResolvedValue(mockRatingsService as never);
        vi.mocked(aiDbService.getSuggestionEngine).mockResolvedValue(mockSuggestionEngine as never);
        mockProfileService.getUserProfile.mockResolvedValue({
            user_id: TEST_USER_ID,
        });
        mockProfileService.createUserProfileFromRatings.mockResolvedValue({
            user_id: TEST_USER_ID,
        });
        mockProfileService.rebuildUserProfile.mockResolvedValue({
            user_id: TEST_USER_ID,
        });
        // Default: generation actually produces suggestion rows. Tests for
        // the "generation returned zero rows" observability gap override
        // this with an empty array.
        mockSuggestionEngine.generateSuggestionsFromProfile.mockResolvedValue([
            { id: 1, user_id: TEST_USER_ID, media_id: 'media-uuid-suggested' },
        ]);
        // Default: a genuinely NEW rating (fresh INSERT). Re-rating tests
        // override with wasNewRating: false.
        mockRatingsService.addUserRating.mockResolvedValue({
            ...makeRating(),
            wasNewRating: true,
        });
        vi.mocked(countUserRatings).mockResolvedValue(0);
        vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('media-uuid-1');
        vi.mocked(isEpisode).mockReturnValue(false);
        vi.mocked(getMediaTypeById).mockResolvedValue('movie');
    });

    // =========================================================================
    // recordRating
    // =========================================================================

    describe('recordRating', () => {
        it('episode skips AI pipeline — returns isEpisodeMedia=true, learningApplied=false', async () => {
            vi.mocked(getMediaTypeById).mockResolvedValue('episode');
            vi.mocked(isEpisode).mockReturnValue(true);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 8,
                user: TEST_USER,
            });

            expect(result.isEpisodeMedia).toBe(true);
            expect(result.learningApplied).toBe(false);
            expect(result.profileUpdated).toBe(false);
            expect(result.recommendationsReady).toBe(false);
            expect(mockProfileService.createUserProfileFromRatings).not.toHaveBeenCalled();
        });

        it('milestone at 5 ratings — clears suggestions, rebuilds profile, milestoneReached=true', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(5);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(deleteUserSuggestions).toHaveBeenCalledWith(mockSql, TEST_USER_ID);
            expect(mockProfileService.rebuildUserProfile).toHaveBeenCalledWith(TEST_USER_ID);
            expect(result.milestoneReached).toBe(true);
            expect(result.profileUpdated).toBe(true);
            expect(result.learningApplied).toBe(true);
            expect(result.wasNewRating).toBe(true);
        });

        it('re-rating an existing item at a boundary count — milestoneReached=false', async () => {
            // Upsert conflict-updated an existing row: COUNT stays at exactly 5
            // (a boundary), but no milestone was genuinely crossed.
            mockRatingsService.addUserRating.mockResolvedValue({
                ...makeRating(),
                wasNewRating: false,
            });
            vi.mocked(countUserRatings).mockResolvedValue(5);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 9,
                user: TEST_USER,
            });

            expect(result.wasNewRating).toBe(false);
            expect(result.milestoneReached).toBe(false);
        });

        it('recommendationsReady=true at the shared unlock threshold (5 ratings)', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(5);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(mockSuggestionEngine.generateSuggestionsFromProfile).toHaveBeenCalledWith(
                TEST_USER_ID,
                10,
            );
            expect(result.recommendationsReady).toBe(true);
        });

        it('recommendationsReady=false below the unlock threshold (4 ratings)', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(4);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(mockSuggestionEngine.generateSuggestionsFromProfile).not.toHaveBeenCalled();
            expect(result.recommendationsReady).toBe(false);
            expect(result.milestoneReached).toBe(false);
        });

        it('milestone at 10 ratings — also generates fresh recommendations, recommendationsReady=true', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(10);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(mockSuggestionEngine.generateSuggestionsFromProfile).toHaveBeenCalledWith(
                TEST_USER_ID,
                10,
            );
            expect(result.recommendationsReady).toBe(true);
            expect(result.milestoneReached).toBe(true);
        });

        it('milestone generation returning zero rows logs ERROR with userId + ratingCount, recommendationsReady stays false', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(10);
            mockSuggestionEngine.generateSuggestionsFromProfile.mockResolvedValue([]);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(result.recommendationsReady).toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringMatching(/zero rows/i),
                undefined,
                expect.objectContaining({ userId: TEST_USER_ID, ratingCount: 10 }),
            );
        });

        it('milestone generation throwing logs ERROR with userId + ratingCount, never swallowed silently', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(10);
            const generationError = new Error('vector search backend unavailable');
            mockSuggestionEngine.generateSuggestionsFromProfile.mockRejectedValue(generationError);

            const result = await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(result.recommendationsReady).toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.any(String),
                generationError,
                expect.objectContaining({ userId: TEST_USER_ID, ratingCount: 10 }),
            );
        });

        it('significant rating between milestones (rating >= 8) — deletes specific suggestion only', async () => {
            // 7 ratings — between milestones (not a multiple of 5)
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 9,
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).toHaveBeenCalledWith(
                mockSql,
                TEST_USER_ID,
                'media-uuid-1',
            );
            expect(deleteUserSuggestions).not.toHaveBeenCalled();
            expect(mockProfileService.createUserProfileFromRatings).not.toHaveBeenCalled();
        });

        it('significant rating at the exact love boundary (rating = 8) — deletes specific suggestion', async () => {
            // 7 ratings — between milestones (not a multiple of 5)
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 8,
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).toHaveBeenCalledWith(
                mockSql,
                TEST_USER_ID,
                'media-uuid-1',
            );
        });

        it('significant rating at the exact dislike boundary (rating = 3) — deletes specific suggestion', async () => {
            // 7 ratings — between milestones (not a multiple of 5)
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 3,
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).toHaveBeenCalledWith(
                mockSql,
                TEST_USER_ID,
                'media-uuid-1',
            );
        });

        it('non-significant rating between milestones — only invalidates cache, no suggestion changes', async () => {
            // 7 ratings — between milestones (not a multiple of 5)
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 6, // neutral, not significant
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).not.toHaveBeenCalled();
            expect(deleteUserSuggestions).not.toHaveBeenCalled();
            expect(cacheInvalidation.onUserRating).toHaveBeenCalled();
        });

        it('a rating of exactly 4 between milestones — deletes specific suggestion (widened dislike band)', async () => {
            // 7 ratings — between milestones (not a multiple of 5)
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 4,
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).toHaveBeenCalledWith(
                mockSql,
                TEST_USER_ID,
                'media-uuid-1',
            );
            expect(deleteUserSuggestions).not.toHaveBeenCalled();
        });

        it('a rating of 5 between milestones — does NOT delete the specific suggestion', async () => {
            // 7 ratings — between milestones (not a multiple of 5)
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 5,
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).not.toHaveBeenCalled();
        });

        it('always invalidates cache in non-episode cases', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(1);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(cacheInvalidation.onUserRating).toHaveBeenCalledWith(
                TEST_USER_ID,
                baseExternalIds,
                'movie',
                7,
                expect.any(Number),
            );
        });

        it('tracks rating in activity feed after successful rating', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(1);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 8,
                title: 'Quiet Orbit',
                user: TEST_USER,
            });

            expect(activityFeedService.trackRatingEvent).toHaveBeenCalledWith(TEST_USER_ID, {
                media_id: 'media-uuid-1',
                media_type: 'movie',
                title: 'Quiet Orbit',
                rating: 8,
            });
        });

        it('does not track activity feed for episode ratings', async () => {
            vi.mocked(getMediaTypeById).mockResolvedValue('episode');
            vi.mocked(isEpisode).mockReturnValue(true);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 8,
                user: TEST_USER,
            });

            expect(activityFeedService.trackRatingEvent).not.toHaveBeenCalled();
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                ratingManager.recordRating({
                    username: 'alice',
                    externalIds: baseExternalIds,
                    mediaType: 'movie',
                    rating: 7,
                    user: TEST_USER,
                }),
            ).rejects.toThrow('Database unavailable');
        });

        it('throws when mediaId cannot be resolved', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue(null);

            await expect(
                ratingManager.recordRating({
                    username: 'alice',
                    externalIds: baseExternalIds,
                    mediaType: 'movie',
                    rating: 7,
                    user: TEST_USER,
                }),
            ).rejects.toThrow('No valid external IDs provided');
        });

        it('significant rating between milestones — calls onUserRating exactly once', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 9,
                user: TEST_USER,
            });

            expect(cacheInvalidation.onUserRating).toHaveBeenCalledTimes(1);
        });

        it('milestone rating — calls onUserRating exactly once', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(10);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 7,
                user: TEST_USER,
            });

            expect(cacheInvalidation.onUserRating).toHaveBeenCalledTimes(1);
        });

        it('weak non-milestone rating — calls onUserRating exactly once', async () => {
            vi.mocked(countUserRatings).mockResolvedValue(7);

            await ratingManager.recordRating({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                rating: 6,
                user: TEST_USER,
            });

            expect(cacheInvalidation.onUserRating).toHaveBeenCalledTimes(1);
        });
    });

    // =========================================================================
    // skipSuggestion
    // =========================================================================

    describe('skipSuggestion', () => {
        it('saves skip rating with rating=5 and skipped=true', async () => {
            await ratingManager.skipSuggestion({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(mockRatingsService.addUserRating).toHaveBeenCalledWith(
                expect.objectContaining({
                    user_id: TEST_USER_ID,
                    media_id: 'media-uuid-1',
                    rating: 5,
                    skipped: true,
                }),
            );
        });

        it('removes from user_suggestions', async () => {
            await ratingManager.skipSuggestion({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(deleteUserSuggestionByMediaId).toHaveBeenCalledWith(
                mockSql,
                TEST_USER_ID,
                'media-uuid-1',
            );
        });

        it('calls cacheInvalidation.onSuggestionSkipped', async () => {
            await ratingManager.skipSuggestion({
                username: 'alice',
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(cacheInvalidation.onSuggestionSkipped).toHaveBeenCalledWith(
                TEST_USER_ID,
                baseExternalIds,
                'movie',
            );
        });

        it('throws when mediaId not resolved', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue(null);

            await expect(
                ratingManager.skipSuggestion({
                    username: 'alice',
                    externalIds: baseExternalIds,
                    mediaType: 'movie',
                    user: TEST_USER,
                }),
            ).rejects.toThrow('No valid external IDs provided');
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                ratingManager.skipSuggestion({
                    username: 'alice',
                    externalIds: baseExternalIds,
                    mediaType: 'movie',
                    user: TEST_USER,
                }),
            ).rejects.toThrow('Database unavailable');
        });
    });

    // =========================================================================
    // clearRating
    // =========================================================================

    describe('clearRating', () => {
        it('deletes the rating row for the resolved media', async () => {
            await ratingManager.clearRating({
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(deleteUserRating.execute).toHaveBeenCalledWith(mockSql, {
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
            });
        });

        it('invalidates userRatings/personalStats caches (lightweight)', async () => {
            await ratingManager.clearRating({
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(cacheInvalidation.onRatingCacheChanged).toHaveBeenCalledWith(TEST_USER_ID);
        });

        it('returns cleared=true when a row was deleted', async () => {
            vi.mocked(deleteUserRating.execute).mockResolvedValue([{ id: 1 }]);

            const result = await ratingManager.clearRating({
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(result).toEqual({ cleared: true });
        });

        it('returns cleared=false when there was no existing rating to delete', async () => {
            vi.mocked(deleteUserRating.execute).mockResolvedValue([]);

            const result = await ratingManager.clearRating({
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(result).toEqual({ cleared: false });
        });

        it('does not rebuild the profile or touch suggestions', async () => {
            await ratingManager.clearRating({
                externalIds: baseExternalIds,
                mediaType: 'movie',
                user: TEST_USER,
            });

            expect(mockProfileService.rebuildUserProfile).not.toHaveBeenCalled();
            expect(deleteUserSuggestionByMediaId).not.toHaveBeenCalled();
            expect(deleteUserSuggestions).not.toHaveBeenCalled();
        });

        it('throws when mediaId cannot be resolved', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue(null);

            await expect(
                ratingManager.clearRating({
                    externalIds: baseExternalIds,
                    mediaType: 'movie',
                    user: TEST_USER,
                }),
            ).rejects.toThrow('No valid external IDs provided');
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                ratingManager.clearRating({
                    externalIds: baseExternalIds,
                    mediaType: 'movie',
                    user: TEST_USER,
                }),
            ).rejects.toThrow('Database unavailable');
        });
    });
});
