// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => mockLogger) },
}));

vi.mock('$lib/server/utils/media-resolution.js', () => ({
    resolveExternalIdsToMediaId: vi.fn(),
}));

vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onWatchlistChange: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/services/activity-feed.service.js', () => ({
    activityFeedService: {
        trackWatchlistEvent: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/database/queries/watchlist.queries.js', () => ({
    upsertWatchlistItem: vi.fn(),
    getMediaTitle: vi.fn(),
    deleteWatchlistItem: vi.fn(),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

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

import { resolveExternalIdsToMediaId } from '$lib/server/utils/media-resolution.js';
import { cacheInvalidation } from '$lib/server/cache';
import { activityFeedService } from '$lib/server/services/activity-feed.service.js';
import {
    upsertWatchlistItem,
    getMediaTitle,
    deleteWatchlistItem,
} from '$lib/server/database/queries/watchlist.queries.js';
import { watchlistManager } from './watchlist-manager.service.js';

const mockSql = {} as postgres.Sql;

describe('WatchlistManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('addItem', () => {
        it('resolves ID, inserts, tracks feed, invalidates cache', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-1');
            vi.mocked(upsertWatchlistItem).mockResolvedValue([{ id: 1 }]);

            const result = await watchlistManager.addItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
                title: 'Quiet Orbit',
                user: TEST_USER,
            });

            expect(result.saved).toBe(true);
            expect(result.mediaId).toBe('uuid-1');
            expect(resolveExternalIdsToMediaId).toHaveBeenCalledWith(
                mockSql,
                { tmdb: '550' },
                'movie',
                'Quiet Orbit',
            );
            expect(upsertWatchlistItem).toHaveBeenCalledWith(mockSql, TEST_USER.userId, 'uuid-1');
            expect(activityFeedService.trackWatchlistEvent).toHaveBeenCalledWith(
                TEST_USER.userId,
                'add',
                // `media_id`, NOT `primary_ext_id`: this is the internal UUID.
                // Sent as primary_ext_id it reached watchlist_activities.tmdb_id
                // (an integer column), Postgres rejected every insert, and the
                // service's catch swallowed it — so watchlist add/remove events
                // were silently missing from the activity feed for months.
                expect.objectContaining({
                    media_id: 'uuid-1',
                    media_type: 'movie',
                    title: 'Quiet Orbit',
                }),
            );
            expect(cacheInvalidation.onWatchlistChange).toHaveBeenCalledWith(
                TEST_USER.userId,
                'uuid-1',
            );
        });

        it("passes mediaType 'audiobook' through unmangled to resolution and the activity feed", async () => {
            // Regression guard: mediaType was typed 'movie' | 'tv' only, blocking
            // audiobooks from ever reaching this call. Widened to include
            // 'audiobook' — this pins the passthrough, since resolveAndGate
            // wraps resolveExternalIdsToMediaId and would silently swallow a
            // wrong value.
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-ab-1');
            vi.mocked(upsertWatchlistItem).mockResolvedValue([{ id: 1 }]);

            const result = await watchlistManager.addItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { internal: 'uuid-ab-1' },
                mediaType: 'audiobook',
                title: 'A Book',
                user: TEST_USER,
            });

            expect(result.saved).toBe(true);
            expect(result.mediaId).toBe('uuid-ab-1');
            expect(resolveExternalIdsToMediaId).toHaveBeenCalledWith(
                mockSql,
                { internal: 'uuid-ab-1' },
                'audiobook',
                'A Book',
            );
            expect(activityFeedService.trackWatchlistEvent).toHaveBeenCalledWith(
                TEST_USER.userId,
                'add',
                expect.objectContaining({ media_type: 'audiobook' }),
            );
        });

        it('returns saved=false and null mediaId when resolution fails', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue(null);

            const result = await watchlistManager.addItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: {},
                mediaType: 'movie',
                title: 'Unknown',
                user: TEST_USER,
            });

            expect(result.saved).toBe(false);
            expect(result.mediaId).toBeNull();
            expect(upsertWatchlistItem).not.toHaveBeenCalled();
            expect(cacheInvalidation.onWatchlistChange).not.toHaveBeenCalled();
        });

        it('still invalidates cache even if activity feed fails', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-1');
            vi.mocked(upsertWatchlistItem).mockResolvedValue([{ id: 1 }]);
            vi.mocked(activityFeedService.trackWatchlistEvent).mockRejectedValue(
                new Error('feed down'),
            );

            const result = await watchlistManager.addItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
                title: 'Quiet Orbit',
                user: TEST_USER,
            });

            expect(result.saved).toBe(true);
            expect(cacheInvalidation.onWatchlistChange).toHaveBeenCalledWith(
                TEST_USER.userId,
                'uuid-1',
            );
        });

        it('skips activity-feed tracking when skipActivityFeed is true, but still invalidates cache', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-1');
            vi.mocked(upsertWatchlistItem).mockResolvedValue([{ id: 1 }]);

            const result = await watchlistManager.addItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
                title: 'Quiet Orbit',
                user: TEST_USER,
                skipActivityFeed: true,
            });

            expect(result.saved).toBe(true);
            expect(activityFeedService.trackWatchlistEvent).not.toHaveBeenCalled();
            expect(cacheInvalidation.onWatchlistChange).toHaveBeenCalledWith(
                TEST_USER.userId,
                'uuid-1',
            );
        });

        // N3 (2026-09-22 edge-case pass): `upsertWatchlistItem` can return []
        // even though resolution+access succeeded — the one race documented
        // on `WatchlistUpsertRow.inserted`, where the media row vanishes
        // between resolve and insert. Before this fix, the activity feed
        // still recorded an "add" event for a save that never happened.
        it('does NOT track an activity-feed "add" event when upsertWatchlistItem returns []', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-1');
            vi.mocked(upsertWatchlistItem).mockResolvedValue([]);

            const result = await watchlistManager.addItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
                title: 'Quiet Orbit',
                user: TEST_USER,
            });

            expect(result.saved).toBe(false);
            expect(activityFeedService.trackWatchlistEvent).not.toHaveBeenCalled();
            // Cache invalidation is unconditional today (matches removeItem's
            // shape) — only the feed write is guarded on a real change.
            expect(cacheInvalidation.onWatchlistChange).toHaveBeenCalledWith(
                TEST_USER.userId,
                'uuid-1',
            );
        });
    });

    describe('removeItem', () => {
        it('resolves ID, deletes, tracks feed, invalidates cache', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-1');
            vi.mocked(getMediaTitle).mockResolvedValue('Quiet Orbit');
            vi.mocked(deleteWatchlistItem).mockResolvedValue([{ id: 1 }]);

            const result = await watchlistManager.removeItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
            });

            expect(result.removed).toBe(true);
            expect(result.mediaId).toBe('uuid-1');
            expect(getMediaTitle).toHaveBeenCalledWith(mockSql, 'uuid-1');
            expect(deleteWatchlistItem).toHaveBeenCalledWith(mockSql, TEST_USER.userId, 'uuid-1');
            expect(cacheInvalidation.onWatchlistChange).toHaveBeenCalledWith(
                TEST_USER.userId,
                'uuid-1',
            );
        });

        it('returns removed=false when resolution fails', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue(null);

            const result = await watchlistManager.removeItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: {},
                mediaType: 'movie',
            });

            expect(result.removed).toBe(false);
            expect(result.mediaId).toBeNull();
            expect(deleteWatchlistItem).not.toHaveBeenCalled();
            expect(cacheInvalidation.onWatchlistChange).not.toHaveBeenCalled();
        });

        it('skips activity feed when nothing was deleted', async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-1');
            vi.mocked(getMediaTitle).mockResolvedValue('Quiet Orbit');
            vi.mocked(deleteWatchlistItem).mockResolvedValue([]);

            const result = await watchlistManager.removeItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { tmdb: '550' },
                mediaType: 'movie',
            });

            expect(result.removed).toBe(false);
            expect(activityFeedService.trackWatchlistEvent).not.toHaveBeenCalled();
            // Cache is still invalidated even if nothing was deleted
            expect(cacheInvalidation.onWatchlistChange).toHaveBeenCalledWith(
                TEST_USER.userId,
                'uuid-1',
            );
        });

        it("passes mediaType 'audiobook' through unmangled to resolution", async () => {
            vi.mocked(resolveExternalIdsToMediaId).mockResolvedValue('uuid-ab-1');
            vi.mocked(getMediaTitle).mockResolvedValue('A Book');
            vi.mocked(deleteWatchlistItem).mockResolvedValue([{ id: 1 }]);

            const result = await watchlistManager.removeItem({
                sql: mockSql,
                userId: TEST_USER.userId,
                externalIds: { internal: 'uuid-ab-1' },
                mediaType: 'audiobook',
            });

            expect(result.removed).toBe(true);
            expect(resolveExternalIdsToMediaId).toHaveBeenCalledWith(
                mockSql,
                { internal: 'uuid-ab-1' },
                'audiobook',
            );
            expect(activityFeedService.trackWatchlistEvent).toHaveBeenCalledWith(
                TEST_USER.userId,
                'remove',
                expect.objectContaining({ media_type: 'audiobook' }),
            );
        });
    });
});
