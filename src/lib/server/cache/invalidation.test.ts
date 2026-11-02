// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

// Mock all external dependencies before importing the module under test
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockDeleteUserCache = vi.fn().mockResolvedValue(undefined);
const mockClear = vi.fn().mockResolvedValue(undefined);

const mockCacheInstance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: mockDelete,
    deleteUserCache: mockDeleteUserCache,
    clear: mockClear,
};

vi.mock('./unified-cache', () => ({
    CacheManager: {
        getInstance: vi.fn(() => ({
            for: vi.fn(() => ({ ...mockCacheInstance })),
            clearAll: vi.fn().mockResolvedValue(undefined),
        })),
    },
}));

vi.mock('./namespaces', () => ({
    CACHE_NAMESPACES: {
        aiSuggestions: { name: 'ai-suggestions' },
        watchedContent: { name: 'watched-content' },
        trending: { name: 'trending' },
        mediaEmbeddings: { name: 'media-embeddings' },
        userRatings: { name: 'user-ratings' },
        browseRecentlyAdded: { name: 'browse-recently-added' },
        browseGenres: { name: 'browse-genres' },
        browseAZ: { name: 'browse-az' },
        browseLibraries: { name: 'browse-libraries' },
        newEpisodes: { name: 'new-episodes' },
        personalStats: { name: 'personal-stats' },
        nextEpisode: { name: 'next-episode' },
    },
}));

vi.mock('../utils/logger', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

vi.mock('$lib/utils/media-id-helpers', () => ({
    buildMediaKey: vi.fn((externalIds: { tmdb?: number }, mediaType: string) =>
        externalIds.tmdb ? `tmdb:${externalIds.tmdb}:${mediaType}` : null,
    ),
}));

vi.mock('../services/for-you.service', () => ({
    invalidateSimilarCacheForUser: vi.fn().mockResolvedValue(undefined),
}));

import { CacheInvalidationService } from './invalidation';

describe('CacheInvalidationService', () => {
    let service: CacheInvalidationService;

    // We need per-namespace tracking. The CacheManager mock creates a new object
    // per .for() call, but they all share the same mock functions via the spread.
    // To track which namespace gets which calls, we use the singleton and spy on it.
    beforeEach(() => {
        vi.clearAllMocks();
        service = new CacheInvalidationService();
    });

    describe('Bug 1: onWatchStateChanged invalidates next-episode cache', () => {
        it('calls deleteUserCache on nextEpisode namespace', async () => {
            await service.onWatchStateChanged('alice');

            // onWatchStateChanged should call deleteUserCache for both
            // nextEpisode and personalStats namespaces
            expect(mockDeleteUserCache).toHaveBeenCalledWith('alice');
            // Called twice: once for nextEpisode, once for personalStats
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(2);
        });
    });

    describe('Bug 2: personalStats invalidated on rating', () => {
        it('onUserRating invalidates personalStats cache', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 8, 10);

            // Should call deleteUserCache for userRatings AND personalStats
            expect(mockDeleteUserCache).toHaveBeenCalledWith(aliceId);
            // At minimum 2 calls: userRatings + personalStats
            expect(mockDeleteUserCache.mock.calls.length).toBeGreaterThanOrEqual(2);
        });

        it('onWatchlistChange invalidates personalStats cache', async () => {
            const bobId: UserId = toUserId(randomUUID());
            await service.onWatchlistChange(bobId);

            // Should call deleteUserCache for suggestions AND personalStats
            expect(mockDeleteUserCache).toHaveBeenCalledWith(bobId);
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(2);
        });
    });

    describe('Bug 3: onUserRating clears all userRatings keys', () => {
        it('uses deleteUserCache instead of single key delete', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 7, 3);

            // Should use deleteUserCache (clears stats + ratings-map-v2)
            // not delete('stats', userId) which only clears stats
            expect(mockDeleteUserCache).toHaveBeenCalledWith(aliceId);
        });
    });

    describe('Plan 2.5 Task 2: coherent significant-rating gate + real cache invalidation', () => {
        it('wipes the suggestions cache for a significant rating (8) between milestones', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            // ratingCount=7 is not a %5 milestone.
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 8, 7);

            // userRatings + personalStats + mood + suggestions = 4 deleteUserCache calls.
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(4);
        });

        it('wipes the suggestions cache for a significant rating (3) between milestones', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 3, 7);

            expect(mockDeleteUserCache).toHaveBeenCalledTimes(4);
        });

        it('does NOT wipe the suggestions cache for a non-significant rating (6) between milestones', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 6, 7);

            // userRatings + personalStats + mood — no suggestions wipe. Mood
            // clears for EVERY rating: it excludes <= 4 titles in SQL, so both
            // crossing and un-crossing that band must be visible immediately.
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(3);
        });

        it('wipes the suggestions cache for a rating of 4 between milestones', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            // ratingCount=7 is not a %5 milestone. A rating of 4 falls in the
            // same <= 4 dislike band that drops the user_suggestions DB row
            // (rating-manager.service.ts), so the composed feed cache must
            // clear too — not just filter the item out of a rebuilt list.
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 4, 7);

            // userRatings + personalStats + mood + suggestions = 4 deleteUserCache calls.
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(4);
        });

        it('does NOT wipe the suggestions cache for a rating of 5 between milestones', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 5, 7);

            // userRatings + personalStats + mood — no suggestions wipe.
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(3);
        });

        it('wipes the suggestions cache on a %5 milestone regardless of the triggering rating', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onUserRating(aliceId, { tmdb: '550' }, 'movie', 6, 5);

            // userRatings + personalStats + mood + (suggestions + watched +
            // mood via invalidateUserRecommendations) = 6 deleteUserCache calls.
            // Mood is cleared twice on the milestone path — once directly (it
            // must clear for every rating) and once inside the bulk helper.
            // deleteUserCache is idempotent, so the overlap is harmless.
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(6);
        });

        it('onRatingCacheChanged (undo path) also wipes the suggestions cache', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onRatingCacheChanged(aliceId);

            // userRatings + personalStats + suggestions + mood = 4 deleteUserCache calls.
            expect(mockDeleteUserCache).toHaveBeenCalledTimes(4);
        });

        it('onSuggestionSkipped no longer writes the orphaned suggestions:list key', async () => {
            const aliceId: UserId = toUserId(randomUUID());
            await service.onSuggestionSkipped(aliceId, { tmdb: '550' }, 'movie');

            expect(mockDelete).not.toHaveBeenCalledWith('suggestions:list', aliceId);
        });
    });
});
