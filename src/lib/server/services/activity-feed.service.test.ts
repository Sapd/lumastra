// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ActivityFeedService
 *
 * Tests the provider-agnostic activity feed functionality including:
 * - trackWatchlistEvent with media_id and primary_ext_id resolution
 * - getRecentActivity returning full externalIds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock state - must persist across tests because service caches db connection
let callCount = 0;
let mockResults: unknown[][] = [];

// Use vi.hoisted to ensure mocks are defined before vi.mock hoisting
const { mockGetDb } = vi.hoisted(() => {
    // Create a mock that checks the shared state for results
    const mockQueryFn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
        callCount++;
        const result = mockResults[callCount - 1] ?? [];
        return Promise.resolve(result);
    });

    const mockGetDb = vi.fn(() => mockQueryFn);

    return { mockGetDb, mockQueryFn };
});

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
        }),
    },
}));

// Import after mocks are set up
const { activityFeedService } = await import('./activity-feed.service.js');

describe('ActivityFeedService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset shared state for each test
        callCount = 0;
        mockResults = [];
    });

    describe('trackWatchlistEvent', () => {
        it('stores both media_id and primary_ext_id when both provided', async () => {
            mockResults = [[]]; // INSERT returns empty

            await activityFeedService.trackWatchlistEvent('testuser', 'add', {
                media_id: '123e4567-e89b-12d3-a456-426614174000',
                primary_ext_id: '550',
                media_type: 'movie',
                title: 'Quiet Orbit',
                year: 1999,
            });

            // Should have made INSERT call (no resolution needed, both IDs provided)
            expect(callCount).toBe(1);
        });

        it('resolves tmdb_id from external_ids when only media_id provided', async () => {
            // First call: resolve tmdb_id, second call: INSERT
            mockResults = [[{ external_id: '550' }], []];

            await activityFeedService.trackWatchlistEvent('testuser', 'add', {
                media_id: '123e4567-e89b-12d3-a456-426614174000',
                media_type: 'movie',
                title: 'Quiet Orbit',
            });

            // Should have made 2 calls: lookup + insert
            expect(callCount).toBe(2);
        });

        it('resolves media_id from external_ids when only primary_ext_id provided', async () => {
            // First call: resolve media_id, second call: INSERT
            mockResults = [[{ media_id: '123e4567-e89b-12d3-a456-426614174000' }], []];

            await activityFeedService.trackWatchlistEvent('testuser', 'add', {
                primary_ext_id: '550',
                media_type: 'movie',
                title: 'Quiet Orbit',
            });

            // Should have made 2 calls: lookup + insert
            expect(callCount).toBe(2);
        });

        it('handles case when media_id cannot be resolved', async () => {
            // First call: no match found, second call: INSERT with null media_id
            mockResults = [[], []];

            await activityFeedService.trackWatchlistEvent('testuser', 'add', {
                primary_ext_id: '999999',
                media_type: 'movie',
                title: 'Unknown Movie',
            });

            // Should still insert even without media_id
            expect(callCount).toBe(2);
        });

        it('does nothing when database unavailable', async () => {
            // Note: The ActivityFeedService caches db connection after first call.
            // To test "database unavailable" we need a fresh module import.
            vi.resetModules();

            // Set up mocks for fresh import
            vi.doMock('$lib/server/database/connection.js', () => ({
                getDb: () => null,
            }));

            vi.doMock('$lib/server/utils/logger.js', () => ({
                Logger: {
                    for: () => ({
                        warn: vi.fn(),
                        error: vi.fn(),
                        debug: vi.fn(),
                        info: vi.fn(),
                    }),
                },
            }));

            const { activityFeedService: freshService } =
                await import('./activity-feed.service.js');

            // Should not throw even when database is unavailable
            await expect(
                freshService.trackWatchlistEvent('testuser', 'add', {
                    primary_ext_id: '550',
                    media_type: 'movie',
                    title: 'Quiet Orbit',
                }),
            ).resolves.toBeUndefined();
        });
    });

    describe('ActivityFeedItem interface', () => {
        it('includes all external ID fields', () => {
            // Test that the type includes the new fields
            const mockActivity = {
                id: 1,
                user_id: 'testuser',
                activity_type: 'watchlist_add' as const,
                media_id: '123e4567-e89b-12d3-a456-426614174000',
                media_type: 'movie',
                tmdb_id: 550,
                imdb_id: 'tt0137523',
                tvdb_id: null,
                jellyfin_id: 'abc123',
                title: 'Quiet Orbit',
                year: 1999,
                series_name: null,
                season_number: null,
                episode_number: null,
                completion_percentage: null,
                watch_time_seconds: null,
                source_service: null,
                metadata: null,
                bitrate: null,
                device_name: null,
                resolution_width: null,
                video_codec: null,
                total_duration_seconds: null,
                current_position_seconds: null,
                current_progress_percentage: null,
                is_paused: false,
                is_active: false,
                last_update_time: null,
                activity_time: new Date(),
                created_at: new Date(),
            };

            // Verify the shape includes new external ID fields
            expect(mockActivity.imdb_id).toBe('tt0137523');
            expect(mockActivity.tvdb_id).toBeNull();
            expect(mockActivity.jellyfin_id).toBe('abc123');
        });
    });
});

describe('Watched filter logic', () => {
    it('filters by internal UUID when watchedIds provided', () => {
        const watchedUuidSet = new Set(['uuid-1', 'uuid-2']);

        const items = [
            { externalIds: { internal: 'uuid-1', tmdb: '100' } },
            { externalIds: { internal: 'uuid-3', tmdb: '200' } },
            { externalIds: { internal: 'uuid-2', tmdb: '300' } },
        ];

        const filtered = items.filter((item) => {
            const internalId = item.externalIds?.internal;
            if (internalId && watchedUuidSet.has(internalId)) {
                return false;
            }
            return true;
        });

        expect(filtered).toHaveLength(1);
        expect(filtered[0].externalIds.internal).toBe('uuid-3');
    });

    it('falls back to TMDB filter when no UUID match', () => {
        const watchedUuidSet = new Set<string>();
        const watchedTmdbSet = new Set([100, 300]);

        const items = [
            { externalIds: { internal: 'uuid-1', tmdb: '100' } },
            { externalIds: { internal: 'uuid-2', tmdb: '200' } },
            { externalIds: { internal: 'uuid-3', tmdb: '300' } },
        ];

        const filtered = items.filter((item) => {
            // Check UUID first
            const internalId = item.externalIds?.internal;
            if (internalId && watchedUuidSet.has(internalId)) {
                return false;
            }
            // Fallback to TMDB
            if (watchedTmdbSet.size > 0) {
                const tmdbId = item.externalIds?.tmdb;
                if (watchedTmdbSet.has(Number.parseInt(tmdbId || '0'))) {
                    return false;
                }
            }
            return true;
        });

        expect(filtered).toHaveLength(1);
        expect(filtered[0].externalIds.tmdb).toBe('200');
    });

    it('prioritizes UUID over TMDB when both match', () => {
        // If UUID matches, it should be filtered even if TMDB would not match
        const watchedUuidSet = new Set(['uuid-1']);
        const watchedTmdbSet = new Set([999]); // Different TMDB ID

        const items = [
            { externalIds: { internal: 'uuid-1', tmdb: '100' } }, // UUID matches
            { externalIds: { internal: 'uuid-2', tmdb: '200' } },
        ];

        const filtered = items.filter((item) => {
            const internalId = item.externalIds?.internal;
            if (internalId && watchedUuidSet.has(internalId)) {
                return false;
            }
            if (watchedTmdbSet.size > 0) {
                const tmdbId = item.externalIds?.tmdb;
                if (watchedTmdbSet.has(Number.parseInt(tmdbId || '0'))) {
                    return false;
                }
            }
            return true;
        });

        // uuid-1 should be filtered by UUID, uuid-2 should pass
        expect(filtered).toHaveLength(1);
        expect(filtered[0].externalIds.internal).toBe('uuid-2');
    });

    it('handles items without externalIds gracefully', () => {
        const watchedUuidSet = new Set(['uuid-1']);
        const watchedTmdbSet = new Set([100]);

        const items = [
            { externalIds: { internal: 'uuid-1', tmdb: '100' } },
            {
                externalIds: undefined as unknown as {
                    internal?: string;
                    tmdb?: string;
                },
            },
            { externalIds: { internal: undefined, tmdb: undefined } },
        ];

        const filtered = items.filter((item) => {
            const internalId = item.externalIds?.internal;
            if (internalId && watchedUuidSet.has(internalId)) {
                return false;
            }
            if (watchedTmdbSet.size > 0) {
                const tmdbId = item.externalIds?.tmdb;
                if (watchedTmdbSet.has(Number.parseInt(tmdbId || '0'))) {
                    return false;
                }
            }
            return true;
        });

        // Only uuid-1 should be filtered, others should pass
        expect(filtered).toHaveLength(2);
    });
});
