// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for EpisodeOrderingService
 *
 * Tests the episode ordering service with mocked database (postgres.Sql).
 * Run with: npm test -- episode-ordering.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { EpisodeOrderingService, type EpisodeOrderingType } from './episode-ordering.service';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// Mock the TMDB API - not needed for most tests, only for getAvailableOrderings
vi.mock('../providers/implementations/tmdb/index.js', () => ({
    tmdbApi: {
        getEpisodeGroups: vi.fn(),
        getEpisodeGroupDetails: vi.fn(),
    },
    TMDBApiService: {
        mapEpisodeGroupType: vi.fn((type: number) => {
            const map: Record<number, string> = {
                1: 'other',
                2: 'absolute',
                3: 'dvd',
                4: 'dvd',
                5: 'other',
                6: 'other',
                7: 'other',
            };
            return map[type] || 'other';
        }),
    },
}));

/**
 * Creates a mock SQL function that handles postgres template literals.
 *
 * The postgres library uses tagged template literals where `sql`SELECT ...``
 * returns a promise. But for conditional fragments like:
 *   ${condition ? sql`AND x = ${y}` : sql``}
 * the inner sql calls return fragment objects, not promises.
 *
 * Our mock simplifies this by:
 * 1. Returning promises for "main" queries (detected by SELECT/INSERT/DELETE/UPDATE)
 * 2. Returning empty fragments for conditional expressions
 */
function createMockSql() {
    const queryResults: unknown[][] = [];
    let queryIndex = 0;

    // Create a fragment-like object for conditional parts
    const createFragment = () => ({
        __fragment: true,
        strings: [],
        values: [],
    });

    // The main SQL mock function. Keep the raw `vi.fn()` handle (`mockSqlFn`)
    // for mock controls — running `vi.mocked()` over the `postgres.Sql` cast
    // below trips TS2589 on its deeply generic callable type.
    const mockSqlFn = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join('');

        // Check if this is a main query (starts with SELECT, INSERT, DELETE, UPDATE)
        // or a conditional fragment
        const isMainQuery = /^\s*(SELECT|INSERT|DELETE|UPDATE|WITH)/i.test(query);

        if (isMainQuery) {
            // Return the next queued result
            const result = queryResults[queryIndex] ?? [];
            queryIndex++;
            return Promise.resolve(result);
        }

        // For conditional fragments (AND ..., empty strings, etc.)
        // Return a fragment-like object
        return createFragment();
    });
    const mockSql = mockSqlFn as unknown as postgres.Sql;

    // Add helper method to queue results
    const queueResults = (...results: unknown[][]) => {
        queryResults.length = 0;
        queryResults.push(...results);
        queryIndex = 0;
    };

    // Reset state between tests
    const reset = () => {
        queryResults.length = 0;
        queryIndex = 0;
        mockSqlFn.mockClear();
    };

    return { mockSql, queueResults, reset };
}

describe('EpisodeOrderingService', () => {
    let service: EpisodeOrderingService;
    let mockSql: postgres.Sql;
    let queueResults: (...results: unknown[][]) => void;
    let reset: () => void;

    beforeEach(() => {
        const mock = createMockSql();
        mockSql = mock.mockSql;
        queueResults = mock.queueResults;
        reset = mock.reset;
        service = new EpisodeOrderingService(mockSql);
        reset();
    });

    // =========================================================================
    // getSeriesOrdering
    // =========================================================================

    describe('getSeriesOrdering', () => {
        it('returns null when series not found via mediaId', async () => {
            // No ordering row found
            queueResults([]);

            const result = await service.getSeriesOrdering({
                mediaId: 'uuid-123',
            });

            expect(result).toBeNull();
        });

        it('returns ordering when found by mediaId', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abc',
                created_at: new Date('2024-01-01'),
                updated_at: new Date('2024-01-02'),
            };

            queueResults([orderingRow]);

            const result = await service.getSeriesOrdering({
                mediaId: 'uuid-123',
            });

            expect(result).toEqual({
                id: 1,
                mediaId: 'uuid-123',
                orderingType: 'absolute',
                orderingSource: 'manual',
                orderingProvider: 'tmdb',
                orderingGroupId: 'group-abc',
                createdAt: new Date('2024-01-01'),
                updatedAt: new Date('2024-01-02'),
            });
        });

        it('returns null when the series cannot be resolved', async () => {
            // TMDB -> media_id lookup returns nothing
            queueResults([]);

            const result = await service.getSeriesOrdering({
                tmdbId: 999999,
            });

            expect(result).toBeNull();
        });

        it('resolves tmdbId to mediaId', async () => {
            const orderingRow = {
                id: 3,
                media_id: 'uuid-789',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-123',
                created_at: new Date('2024-03-01'),
                updated_at: new Date('2024-03-02'),
            };

            // 1) resolve tmdbId -> mediaId
            // 2) get ordering
            queueResults([{ media_id: 'uuid-789' }], [orderingRow]);

            const result = await service.getSeriesOrdering({ tmdbId: 1429 });

            expect(result).toEqual({
                id: 3,
                mediaId: 'uuid-789',
                orderingType: 'absolute',
                orderingSource: 'manual',
                orderingProvider: 'tmdb',
                orderingGroupId: 'group-123',
                createdAt: new Date('2024-03-01'),
                updatedAt: new Date('2024-03-02'),
            });
        });
    });

    // =========================================================================
    // setSeriesOrdering
    // =========================================================================

    describe('setSeriesOrdering', () => {
        it('throws when mediaId cannot be resolved', async () => {
            // Can't resolve the series
            queueResults([]);

            await expect(service.setSeriesOrdering({ tmdbId: 999999 }, 'absolute')).rejects.toThrow(
                'Could not resolve series to media_id',
            );
        });

        it('creates new ordering with default options', async () => {
            const createdRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: null,
                ordering_group_id: null,
                created_at: new Date('2024-01-01'),
                updated_at: new Date('2024-01-01'),
            };

            queueResults([createdRow]);

            const result = await service.setSeriesOrdering({ mediaId: 'uuid-123' }, 'absolute');

            expect(result).toEqual({
                id: 1,
                mediaId: 'uuid-123',
                orderingType: 'absolute',
                orderingSource: 'manual',
                orderingProvider: null,
                orderingGroupId: null,
                createdAt: new Date('2024-01-01'),
                updatedAt: new Date('2024-01-01'),
            });
        });

        it('creates ordering with provider and groupId options', async () => {
            const createdRow = {
                id: 2,
                media_id: 'uuid-456',
                ordering_type: 'dvd' as EpisodeOrderingType,
                ordering_source: 'auto' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abc',
                created_at: new Date('2024-01-01'),
                updated_at: new Date('2024-01-01'),
            };

            queueResults([createdRow]);

            const result = await service.setSeriesOrdering({ mediaId: 'uuid-456' }, 'dvd', {
                source: 'auto',
                provider: 'tmdb',
                groupId: 'group-abc',
            });

            expect(result).toEqual({
                id: 2,
                mediaId: 'uuid-456',
                orderingType: 'dvd',
                orderingSource: 'auto',
                orderingProvider: 'tmdb',
                orderingGroupId: 'group-abc',
                createdAt: new Date('2024-01-01'),
                updatedAt: new Date('2024-01-01'),
            });
        });
    });

    // =========================================================================
    // getOrderedEpisodes
    // =========================================================================

    describe('getOrderedEpisodes', () => {
        it('returns standard ordering when no preference set', async () => {
            // No ordering preference found
            queueResults([]);

            const episodes = [
                {
                    mediaId: 'ep-1',
                    providerEpisodeId: '101',
                    seasonNumber: 1,
                    episodeNumber: 1,
                },
                {
                    mediaId: 'ep-2',
                    providerEpisodeId: '102',
                    seasonNumber: 1,
                    episodeNumber: 2,
                },
            ];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                mediaId: 'ep-1',
                providerEpisodeId: '101',
                originalSeasonNumber: 1,
                originalEpisodeNumber: 1,
                displaySeasonNumber: 1,
                displayEpisodeNumber: 1,
                orderingType: 'standard',
            });
            expect(result[1]).toEqual({
                mediaId: 'ep-2',
                providerEpisodeId: '102',
                originalSeasonNumber: 1,
                originalEpisodeNumber: 2,
                displaySeasonNumber: 1,
                displayEpisodeNumber: 2,
                orderingType: 'standard',
            });
        });

        it('returns standard ordering when orderingType is standard', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'standard' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: null,
                ordering_group_id: null,
                created_at: new Date(),
                updated_at: new Date(),
            };

            queueResults([orderingRow]);

            const episodes = [
                { seasonNumber: 1, episodeNumber: 5 },
                { seasonNumber: 2, episodeNumber: 3 },
            ];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(2);
            expect(result[0].orderingType).toBe('standard');
            expect(result[0].displaySeasonNumber).toBe(1);
            expect(result[0].displayEpisodeNumber).toBe(5);
        });

        it('applies alternative ordering when preference exists', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            const orderingCache = [
                {
                    provider_episode_id: '101',
                    original_season_number: 1,
                    original_episode_number: 1,
                    order_season_number: null,
                    order_episode_number: 1,
                    absolute_number: 1,
                },
                {
                    provider_episode_id: '102',
                    original_season_number: 1,
                    original_episode_number: 2,
                    order_season_number: null,
                    order_episode_number: 2,
                    absolute_number: 2,
                },
                {
                    provider_episode_id: '201',
                    original_season_number: 2,
                    original_episode_number: 1,
                    order_season_number: null,
                    order_episode_number: 26,
                    absolute_number: 26,
                },
            ];

            // 1) get ordering preference
            // 2) get ordering cache
            queueResults([orderingRow], orderingCache);

            const episodes = [
                { seasonNumber: 1, episodeNumber: 1 },
                { seasonNumber: 2, episodeNumber: 1 },
            ];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(2);

            // First episode
            expect(result[0].originalSeasonNumber).toBe(1);
            expect(result[0].originalEpisodeNumber).toBe(1);
            expect(result[0].displaySeasonNumber).toBeNull(); // Absolute ordering
            expect(result[0].displayEpisodeNumber).toBe(1);
            expect(result[0].absoluteNumber).toBe(1);
            expect(result[0].orderingType).toBe('absolute');

            // Second episode (S2E1 -> Absolute 26)
            expect(result[1].originalSeasonNumber).toBe(2);
            expect(result[1].originalEpisodeNumber).toBe(1);
            expect(result[1].displaySeasonNumber).toBeNull();
            expect(result[1].displayEpisodeNumber).toBe(26);
            expect(result[1].absoluteNumber).toBe(26);
            expect(result[1].orderingType).toBe('absolute');
        });

        it('filters by ordering_provider and ordering_group_id', async () => {
            // This test verifies the SQL query filters correctly
            // We test this by setting up a preference with provider/group
            // and expecting only matching cache entries to be used
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'dvd' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'dvd-group',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // Cache entries that match the provider/group filter
            const orderingCache = [
                {
                    provider_episode_id: '101',
                    original_season_number: 1,
                    original_episode_number: 1,
                    order_season_number: 1,
                    order_episode_number: 3, // DVD order differs
                    absolute_number: null,
                },
            ];

            queueResults([orderingRow], orderingCache);

            const episodes = [{ seasonNumber: 1, episodeNumber: 1 }];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(1);
            expect(result[0].displaySeasonNumber).toBe(1);
            expect(result[0].displayEpisodeNumber).toBe(3); // DVD ordering
            expect(result[0].orderingType).toBe('dvd');
        });

        it('preserves configured orderingType even on fallback (not standard)', async () => {
            // When an episode is not in the ordering cache (e.g., a special),
            // it should still report the configured orderingType, not 'standard'
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // Empty cache - no episodes in the ordering
            queueResults([orderingRow], []);

            const episodes = [
                {
                    mediaId: 'special-1',
                    providerEpisodeId: 'sp-001',
                    seasonNumber: 0, // Special episode
                    episodeNumber: 1,
                },
            ];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(1);
            // Fallback to original numbers
            expect(result[0].displaySeasonNumber).toBe(0);
            expect(result[0].displayEpisodeNumber).toBe(1);
            // But orderingType should still be 'absolute' (configured type), not 'standard'
            expect(result[0].orderingType).toBe('absolute');
        });

        it('handles episodes not in ordering cache (fallback to original numbers)', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'dvd' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-dvd',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // Only S1E1 is in the cache
            const orderingCache = [
                {
                    provider_episode_id: '101',
                    original_season_number: 1,
                    original_episode_number: 1,
                    order_season_number: 1,
                    order_episode_number: 5,
                    absolute_number: null,
                },
            ];

            queueResults([orderingRow], orderingCache);

            const episodes = [
                { seasonNumber: 1, episodeNumber: 1 }, // In cache
                { seasonNumber: 1, episodeNumber: 2 }, // NOT in cache
            ];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(2);

            // First episode - from cache
            expect(result[0].displayEpisodeNumber).toBe(5);
            expect(result[0].orderingType).toBe('dvd');

            // Second episode - fallback to original
            expect(result[1].displaySeasonNumber).toBe(1);
            expect(result[1].displayEpisodeNumber).toBe(2);
            expect(result[1].orderingType).toBe('dvd'); // Still reports configured type
        });

        it('handles episodes without mediaId', async () => {
            queueResults([]);

            const episodes = [
                { seasonNumber: 1, episodeNumber: 1 }, // No mediaId
            ];

            const result = await service.getOrderedEpisodes({ mediaId: 'uuid-123' }, episodes);

            expect(result).toHaveLength(1);
            expect(result[0].mediaId).toBeUndefined();
            expect(result[0].providerEpisodeId).toBe('');
        });
    });

    // =========================================================================
    // findEpisodeByAbsoluteNumber
    // =========================================================================

    describe('findEpisodeByAbsoluteNumber', () => {
        it('returns null when no ordering preference exists', async () => {
            // No ordering preference
            queueResults([]);

            const result = await service.findEpisodeByAbsoluteNumber({ mediaId: 'uuid-123' }, 25);

            expect(result).toBeNull();
        });

        it('returns null when episode not found', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // 1) get ordering preference
            // 2) no episode found for absolute number
            queueResults([orderingRow], []);

            const result = await service.findEpisodeByAbsoluteNumber({ mediaId: 'uuid-123' }, 999);

            expect(result).toBeNull();
        });

        it('filters by provider and group from preference', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            const episodeRow = {
                provider_episode_id: '12345',
                original_season_number: 2,
                original_episode_number: 10,
            };

            queueResults([orderingRow], [episodeRow]);

            const result = await service.findEpisodeByAbsoluteNumber({ mediaId: 'uuid-123' }, 35);

            expect(result).toEqual({
                providerEpisodeId: '12345',
                originalSeasonNumber: 2,
                originalEpisodeNumber: 10,
            });
        });

        it('returns correct episode data', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            const episodeRow = {
                provider_episode_id: 'tmdb-ep-54321',
                original_season_number: 3,
                original_episode_number: 15,
            };

            queueResults([orderingRow], [episodeRow]);

            const result = await service.findEpisodeByAbsoluteNumber({ mediaId: 'uuid-123' }, 65);

            expect(result).not.toBeNull();
            expect(result?.providerEpisodeId).toBe('tmdb-ep-54321');
            expect(result?.originalSeasonNumber).toBe(3);
            expect(result?.originalEpisodeNumber).toBe(15);
        });
    });

    // =========================================================================
    // getAbsoluteNumber
    // =========================================================================

    describe('getAbsoluteNumber', () => {
        it('returns null when no ordering preference exists', async () => {
            // No ordering preference
            queueResults([]);

            const result = await service.getAbsoluteNumber({ mediaId: 'uuid-123' }, 1, 5);

            expect(result).toBeNull();
        });

        it('returns null when episode not found', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // 1) get ordering preference
            // 2) no absolute number found
            queueResults([orderingRow], []);

            const result = await service.getAbsoluteNumber({ mediaId: 'uuid-123' }, 99, 99);

            expect(result).toBeNull();
        });

        it('filters by provider and group from preference', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            queueResults([orderingRow], [{ absolute_number: 42 }]);

            const result = await service.getAbsoluteNumber({ mediaId: 'uuid-123' }, 2, 17);

            expect(result).toBe(42);
        });

        it('returns correct absolute number', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // S1E1 -> Absolute 1
            queueResults([orderingRow], [{ absolute_number: 1 }]);

            const result = await service.getAbsoluteNumber({ mediaId: 'uuid-123' }, 1, 1);

            expect(result).toBe(1);
        });

        it('returns correct absolute number for later episodes', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-123',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // S4E12 -> Absolute 87
            queueResults([orderingRow], [{ absolute_number: 87 }]);

            const result = await service.getAbsoluteNumber({ mediaId: 'uuid-123' }, 4, 12);

            expect(result).toBe(87);
        });

        it('works with tmdbId identifier', async () => {
            const orderingRow = {
                id: 1,
                media_id: 'uuid-789',
                ordering_type: 'absolute' as EpisodeOrderingType,
                ordering_source: 'manual' as const,
                ordering_provider: 'tmdb',
                ordering_group_id: 'group-abs',
                created_at: new Date(),
                updated_at: new Date(),
            };

            // 1) resolve tmdbId -> mediaId
            // 2) get ordering preference
            // 3) get absolute number
            queueResults([{ media_id: 'uuid-789' }], [orderingRow], [{ absolute_number: 100 }]);

            const result = await service.getAbsoluteNumber({ tmdbId: 1429 }, 5, 1);

            expect(result).toBe(100);
        });
    });

    // =========================================================================
    // resetSeriesOrdering
    // =========================================================================

    describe('resetSeriesOrdering', () => {
        it('does nothing when mediaId cannot be resolved', async () => {
            queueResults([]);

            // Should not throw
            await expect(service.resetSeriesOrdering({ tmdbId: 999999 })).resolves.not.toThrow();
        });

        it('deletes ordering for resolved mediaId', async () => {
            // Delete call returns empty
            queueResults([]);

            await service.resetSeriesOrdering({ mediaId: 'uuid-123' });

            // Verify delete was called (mockSql was invoked)
            expect(mockSql).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // hasOrderingsCache
    // =========================================================================

    describe('hasOrderingsCache', () => {
        it('returns false when mediaId cannot be resolved', async () => {
            queueResults([]);

            const result = await service.hasOrderingsCache({
                tmdbId: 999999,
            });

            expect(result).toBe(false);
        });

        it('returns true when cache exists', async () => {
            queueResults([{ exists: true }]);

            const result = await service.hasOrderingsCache({
                mediaId: 'uuid-123',
            });

            expect(result).toBe(true);
        });

        it('returns false when cache does not exist', async () => {
            queueResults([{ exists: false }]);

            const result = await service.hasOrderingsCache({
                mediaId: 'uuid-123',
            });

            expect(result).toBe(false);
        });

        it('checks specific ordering type when provided', async () => {
            queueResults([{ exists: true }]);

            const result = await service.hasOrderingsCache({ mediaId: 'uuid-123' }, 'absolute');

            expect(result).toBe(true);
        });
    });

    // =========================================================================
    // clearOrderingsCache
    // =========================================================================

    describe('clearOrderingsCache', () => {
        it('does nothing when mediaId cannot be resolved', async () => {
            queueResults([]);

            await expect(service.clearOrderingsCache({ tmdbId: 999999 })).resolves.not.toThrow();
        });

        it('clears all orderings for series when no options provided', async () => {
            queueResults([]);

            await service.clearOrderingsCache({ mediaId: 'uuid-123' });

            expect(mockSql).toHaveBeenCalled();
        });

        it('clears specific ordering type when provided', async () => {
            queueResults([]);

            await service.clearOrderingsCache({ mediaId: 'uuid-123' }, { orderingType: 'dvd' });

            expect(mockSql).toHaveBeenCalled();
        });

        it('clears specific provider when provided', async () => {
            queueResults([]);

            await service.clearOrderingsCache({ mediaId: 'uuid-123' }, { provider: 'tmdb' });

            expect(mockSql).toHaveBeenCalled();
        });

        it('clears specific groupId when provided', async () => {
            queueResults([]);

            await service.clearOrderingsCache({ mediaId: 'uuid-123' }, { groupId: 'group-abc' });

            expect(mockSql).toHaveBeenCalled();
        });
    });
});
