// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/for-you.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { FreshReleaseRow } from '$lib/server/database/queries/for-you-helpers.queries.js';
import { toWatchedExclusionKey } from '$lib/server/database/queries/for-you-helpers.queries.js';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted)
const {
    mockSql,
    mockCacheGet,
    mockCacheSet,
    mockCacheDeleteUserCache,
    mockLogger,
    mockQueryFreshReleases,
    mockLookupAvailabilityByTmdbIds,
} = vi.hoisted(() => {
    return {
        mockSql: {} as postgres.Sql,
        mockCacheGet: vi.fn(),
        mockCacheSet: vi.fn(),
        mockCacheDeleteUserCache: vi.fn(),
        mockLogger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        mockQueryFreshReleases: vi.fn(),
        mockLookupAvailabilityByTmdbIds: vi.fn(),
    };
});

// for-you.service.ts imports from '$lib/server/cache' (without /index.js)
vi.mock('$lib/server/cache', () => ({
    cacheManager: {
        for: vi.fn(() => ({
            get: mockCacheGet,
            set: mockCacheSet,
            deleteUserCache: mockCacheDeleteUserCache,
        })),
    },
    CACHE_NAMESPACES: {
        similarContent: {
            name: 'test-similar',
            l1TTL: 300000,
            l2TTL: 900000,
        },
    },
}));

// Also mock the /index.js variant used by other imports in the tree
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: vi.fn(() => ({
            get: mockCacheGet,
            set: mockCacheSet,
            deleteUserCache: mockCacheDeleteUserCache,
        })),
    },
    CACHE_NAMESPACES: {
        similarContent: {
            name: 'test-similar',
            l1TTL: 300000,
            l2TTL: 900000,
        },
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

vi.mock('$lib/server/database/queries/for-you-helpers.queries.js', () => ({
    lookupAvailabilityByTmdbIds: mockLookupAvailabilityByTmdbIds,
    querySimilarMediaWithAvailability: vi.fn(),
    queryFreshReleases: mockQueryFreshReleases,
    // Real string builder so call-argument assertions stay meaningful.
    toWatchedExclusionKey: (externalId: string | number, mediaType: string) =>
        `${externalId}:${mediaType}`,
    buildWatchedExclusionFilter: vi.fn(),
}));

// Config: return stable defaults so tests don't depend on env state
vi.mock('$lib/server/config.js', () => ({
    config: {
        FORYOU_MIN_RATINGS: 5,
        FORYOU_DEFAULT_LIMIT: 10,
        FORYOU_SIMILAR_CACHE_HOURS: 4,
        FORYOU_SOURCES_LIMIT: 5,
        FORYOU_SIMILAR_PER_SOURCE: 8,
        FORYOU_SECOND_BECAUSE_SECTION: false,
        FORYOU_SECOND_BECAUSE_LIMIT: 6,
        FORYOU_KEYWORD_ROWS: 3,
        FORYOU_KEYWORD_ITEMS: 8,
        FORYOU_MOOD_LIMIT: 8,
        FORYOU_SIMILAR_AVAILABLE_RATIO: 0.7,
        FORYOU_BINGE_AVAILABLE_RATIO: 0.7,
        FORYOU_KEYWORDS_AVAILABLE_RATIO: 0.6,
        FORYOU_ANIME_MIN_WATCHED: 3,
        FORYOU_ANIME_RECENCY_MONTHS: 12,
        FORYOU_WEIGHT_AI_SIMILARITY: 0.6,
        FORYOU_WEIGHT_MDBLIST_SCORE: 0.25,
        FORYOU_WEIGHT_IMDB_RATING: 0.15,
        FORYOU_WEIGHT_LIKED_KEYWORD: 1.5,
        FORYOU_WEIGHT_DISLIKED_KEYWORD: -2.0,
        FORYOU_WEIGHT_LIKED_GENRE: 1.2,
        FORYOU_WEIGHT_DISLIKED_GENRE: -1.5,
        FORYOU_WEIGHT_LIKED_YEAR: 0.8,
        FORYOU_WEIGHT_DISLIKED_YEAR: -0.5,
        FORYOU_SIMILAR_WEIGHT_DISLIKED_KEYWORD: -1.5,
        FORYOU_SIMILAR_WEIGHT_DISLIKED_GENRE: -1.2,
        FORYOU_KEYWORD_WEIGHT_AI: 0.5,
        FORYOU_KEYWORD_WEIGHT_MDBLIST: 0.3,
        FORYOU_KEYWORD_WEIGHT_DISLIKED_KEYWORD: -1.5,
        FORYOU_KEYWORD_WEIGHT_DISLIKED_GENRE: -1.2,
        FORYOU_ANIME_WEIGHT_AI: 0.5,
        FORYOU_ANIME_WEIGHT_MDBLIST: 0.3,
        FORYOU_ANIME_WEIGHT_IMDB: 0.2,
    },
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn(() => 'tmdb'),
}));

vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: {
        resolveToTmdb: vi.fn(),
    },
}));

vi.mock('$lib/server/services/embedding-operations.service.js', () => ({
    EmbeddingOperationsService: vi.fn(),
}));

// Block deep dependency chains that connect to external services
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => null),
    Database: vi.fn(),
}));

vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: vi.fn(),
}));

vi.mock('$lib/server/providers/aggregator.js', () => ({
    getMetadataAggregator: vi.fn(),
}));

vi.mock('$lib/server/providers/registry.js', () => ({
    getProviderRegistry: vi.fn(() => ({ getAll: () => [] })),
}));

vi.mock('$lib/server/providers/implementations/tmdb/client.js', () => ({
    tmdbApi: {
        findByExternalId: vi.fn(),
        getMovie: vi.fn(),
        getTv: vi.fn(),
    },
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    resolveTmdbToUuid: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-queries.js', () => ({
    buildMetadataLateralJoinFragment: vi.fn(() => ''),
}));

vi.mock('$lib/server/database/queries/builders/provider-metadata.builder.js', () => ({
    buildOverrideAwareMetadataLateralJoinFragment: vi.fn(() => ''),
}));

vi.mock('$lib/server/utils/embedding-utils.js', () => ({
    cosineSimilarityOrDefault: vi.fn(() => 0),
    parseEmbedding: vi.fn(() => []),
}));

vi.mock('$lib/server/utils/availability-balancing.js', () => ({
    interleaveByAvailability: vi.fn((items: unknown[]) => items),
    capByAvailabilityClass: vi.fn((items: unknown[]) => items),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: vi.fn(
        (ids: Record<string, string>, provider: string) => ids[provider] ?? null,
    ),
    createExternalIds: vi.fn((ids: Record<string, string | number | null | undefined>) => {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(ids)) {
            if (v != null) result[k] = String(v);
        }
        return result;
    }),
}));

vi.mock('$lib/utils/image-utils.js', () => ({
    imageFromIds: vi.fn(() => null),
    getCatalogPosterUrl: vi.fn(() => '/api/image/catalog/mock-id/poster'),
    getCatalogBackdropUrl: vi.fn(() => '/api/image/catalog/mock-id/backdrop'),
}));

vi.mock('$lib/utils/media-id-helpers.js', () => ({
    createExternalIdsFromProvider: vi.fn(),
    buildMediaKey: vi.fn(() => 'mock-media-key'),
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    isMovie: vi.fn((t: string) => t === 'movie'),
    isSeries: vi.fn((t: string) => t === 'tv' || t === 'series'),
}));

vi.mock('$lib/server/utils/media-types', () => ({
    isMovie: vi.fn((t: string) => t === 'movie'),
    isSeries: vi.fn((t: string) => t === 'tv' || t === 'series'),
}));

// $lib/paraglide/messages is NOT mocked — the real module loads fine in tests
// (Vitest 4 strict mock validation causes hangs with Proxy mocks for this module)

import { randomUUID } from 'node:crypto';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import {
    getForYouConfig,
    invalidateSimilarCacheForUser,
    fetchFreshReleases,
    fetchBingeWorthySeries,
    bandedShuffle,
    excludeDismissedSimilarItems,
    excludeDislikedFreshReleases,
} from './for-you.service.js';
import {
    denyAllAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFreshReleaseRow(overrides: Partial<FreshReleaseRow> = {}): FreshReleaseRow {
    return {
        media_id: 'uuid-fresh-1',
        internal_id: 'uuid-fresh-1',
        primary_ext_id: '550',
        title: 'Quiet Orbit',
        media_type: 'movie',
        release_date: new Date('2024-10-01'),
        overview: 'An insomniac office worker...',
        tmdb_rating: 8.4,
        imdb_rating: 8.8,
        mdblist_score: 90,
        rt_critic: 79,
        rt_audience: 96,
        release_year: 2024,
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        trailer_url: 'https://yt.com/watch?v=abc',
        is_available: true,
        vote_count: null,
        ...overrides,
    };
}

describe('getForYouConfig', () => {
    it('returns config values from the centralized config object', () => {
        const cfg = getForYouConfig();

        expect(cfg.minRatings).toBe(5);
        expect(cfg.defaultLimit).toBe(10);
        expect(cfg.bingeAvailableRatio).toBe(0.7);
        expect(cfg.similarAvailableRatio).toBe(0.7);
        expect(cfg.secondBecauseSection).toBe(false);
    });

    it('returns all required config keys', () => {
        const cfg = getForYouConfig();

        // Basic settings
        expect(cfg).toHaveProperty('minRatings');
        expect(cfg).toHaveProperty('defaultLimit');
        expect(cfg).toHaveProperty('similarCacheHours');

        // "Because you watched" settings
        expect(cfg).toHaveProperty('sourcesLimit');
        expect(cfg).toHaveProperty('similarPerSource');
        expect(cfg).toHaveProperty('secondBecauseSection');
        expect(cfg).toHaveProperty('secondBecauseLimit');

        // Content mix ratios
        expect(cfg).toHaveProperty('similarAvailableRatio');
        expect(cfg).toHaveProperty('bingeAvailableRatio');
        expect(cfg).toHaveProperty('keywordsAvailableRatio');

        // Advanced weights
        expect(cfg).toHaveProperty('weightAiSimilarity');
        expect(cfg).toHaveProperty('weightMdblistScore');
        expect(cfg).toHaveProperty('weightImdbRating');
    });
});

describe('invalidateSimilarCacheForUser', () => {
    const testUserId: UserId = toUserId(randomUUID());

    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheDeleteUserCache.mockResolvedValue(undefined);
    });

    it('calls deleteUserCache with the given userId', async () => {
        await invalidateSimilarCacheForUser(testUserId);

        expect(mockCacheDeleteUserCache).toHaveBeenCalledWith(testUserId);
    });

    it('logs a debug message after invalidation', async () => {
        await invalidateSimilarCacheForUser(testUserId);

        expect(mockLogger.debug).toHaveBeenCalledWith('Invalidated similar media cache for user', {
            userId: testUserId,
        });
    });
});

// =========================================================================
// fetchFreshReleases
// =========================================================================

describe('fetchFreshReleases', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty array on database error (graceful degradation)', async () => {
        mockQueryFreshReleases.mockRejectedValue(new Error('DB connection refused'));

        const result = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(result).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Failed to fetch fresh releases',
            expect.any(Error),
        );
    });

    it('returns mapped items when query succeeds', async () => {
        const rows: FreshReleaseRow[] = [makeFreshReleaseRow()];
        mockQueryFreshReleases.mockResolvedValue(rows);

        const result = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('Quiet Orbit');
        expect(result[0].mediaType).toBe('movie');
        expect(result[0].isAvailable).toBe(true);
        expect(result[0].canRequest).toBe(false);
    });

    it('sets canRequest to false when item is available', async () => {
        mockQueryFreshReleases.mockResolvedValue([makeFreshReleaseRow({ is_available: true })]);

        const [item] = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(item.isAvailable).toBe(true);
        expect(item.canRequest).toBe(false);
    });

    it('sets canRequest to true when item is not available', async () => {
        mockQueryFreshReleases.mockResolvedValue([makeFreshReleaseRow({ is_available: false })]);

        const [item] = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(item.isAvailable).toBe(false);
        expect(item.canRequest).toBe(true);
        expect(item.externalIds).not.toHaveProperty('jellyfin');
    });

    it('uses imdb_rating as fallback when tmdb_rating is null', async () => {
        mockQueryFreshReleases.mockResolvedValue([
            makeFreshReleaseRow({ tmdb_rating: null, imdb_rating: 7.5 }),
        ]);

        const [item] = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(item.rating).toBe(7.5);
    });

    it('falls back to 0 when both ratings are null', async () => {
        mockQueryFreshReleases.mockResolvedValue([
            makeFreshReleaseRow({ tmdb_rating: null, imdb_rating: null }),
        ]);

        const [item] = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(item.rating).toBe(0);
    });

    it('respects the limit parameter', async () => {
        const rows: FreshReleaseRow[] = Array.from({ length: 5 }, (_, i) =>
            makeFreshReleaseRow({
                internal_id: `uuid-${i}`,
                primary_ext_id: String(100 + i),
                title: `Movie ${i}`,
            }),
        );
        mockQueryFreshReleases.mockResolvedValue(rows);

        const result = await fetchFreshReleases(mockSql, 3, [], unrestrictedAccess());

        expect(result).toHaveLength(3);
    });

    it('returns empty array when query returns no rows', async () => {
        mockQueryFreshReleases.mockResolvedValue([]);

        const result = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(result).toEqual([]);
    });

    it('short-circuits a denyAll boundary without querying', async () => {
        mockQueryFreshReleases.mockResolvedValue([makeFreshReleaseRow()]);

        const result = await fetchFreshReleases(mockSql, 10, [], denyAllAccess());

        expect(result).toEqual([]);
        // The query module short-circuits denyAll itself now, but the rail must
        // ALSO short-circuit before it: scopedCacheKey's access suffix cannot
        // distinguish denyAll from unrestricted, so a denyAll caller must never
        // read or write a key an unrestricted caller could share.
        expect(mockQueryFreshReleases).not.toHaveBeenCalled();
    });

    it('passes type-scoped watched exclusion keys to the query module', async () => {
        mockQueryFreshReleases.mockResolvedValue([]);

        await fetchFreshReleases(
            mockSql,
            10,
            [toWatchedExclusionKey(603, 'movie'), toWatchedExclusionKey(1438, 'tv')],
            unrestrictedAccess(),
        );

        expect(mockQueryFreshReleases).toHaveBeenCalledWith(
            mockSql,
            expect.any(String),
            ['603:movie', '1438:tv'],
            10,
            // The boundary is now passed through whole — the query module takes
            // it as a REQUIRED parameter, so there is no legacy pair to
            // decompose to and no permissive default to fall back on.
            unrestrictedAccess(),
        );
    });

    it('includes externalIds with tmdb and internal keys', async () => {
        mockQueryFreshReleases.mockResolvedValue([
            makeFreshReleaseRow({
                primary_ext_id: '550',
                internal_id: 'my-uuid',
            }),
        ]);

        const [item] = await fetchFreshReleases(mockSql, 10, [], unrestrictedAccess());

        expect(item.externalIds).toMatchObject({
            tmdb: '550',
            internal: 'my-uuid',
        });
    });
});

// =========================================================================
// fetchBingeWorthySeries
// =========================================================================

describe('fetchBingeWorthySeries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty array when no userId is provided (new user guard)', async () => {
        const result = await fetchBingeWorthySeries(
            mockSql,
            10,
            [],
            undefined,
            unrestrictedAccess(),
        );

        expect(result).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledWith('No userId provided for binge-worthy series');
    });

    it('returns empty array and logs warning when userId is undefined', async () => {
        const result = await fetchBingeWorthySeries(
            mockSql,
            10,
            [],
            undefined,
            unrestrictedAccess(),
        );

        expect(result).toEqual([]);
    });

    it('returns empty array on database error (graceful degradation)', async () => {
        // Mock the dynamic import to throw
        vi.doMock('$lib/server/database/queries/binge-worthy.queries.js', () => {
            throw new Error('Module load failed');
        });

        const result = await fetchBingeWorthySeries(
            mockSql,
            10,
            [],
            toUserId(randomUUID()),
            unrestrictedAccess(),
        );

        expect(result).toEqual([]);
    });

    it('passing { suppressAnime: true } alone leaves suppressKids false (destructure default)', async () => {
        // Guards the RailSuppressionOpts destructure defaults: an omitted
        // suppressKids must resolve to false, not leak the sibling flag.
        const getBingeWorthySeries = vi.fn().mockResolvedValue([]);
        vi.doMock('$lib/server/database/queries/binge-worthy.queries.js', () => ({
            getBingeWorthySeries,
        }));

        await fetchBingeWorthySeries(
            mockSql,
            10,
            [],
            toUserId(randomUUID()),
            unrestrictedAccess(),
            { suppressAnime: true },
        );

        expect(getBingeWorthySeries).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({
                suppressKidsContent: false,
                suppressAnimeContent: true,
            }),
        );

        vi.doUnmock('$lib/server/database/queries/binge-worthy.queries.js');
    });
});

// ---------------------------------------------------------------------------
// bandedShuffle (Task 6, Fix 3/5) — banded rotation helper
// ---------------------------------------------------------------------------
describe('bandedShuffle', () => {
    it('preserves band order: every item stays within its score band', () => {
        const items = Array.from({ length: 12 }, (_, i) => i); // 0..11 (ranked)
        const bands = 4; // bandSize = 3 → [0,1,2][3,4,5][6,7,8][9,10,11]
        const out = bandedShuffle(items, 123456, bands);

        expect(out).toHaveLength(items.length);
        // Each band's members are a permutation of the original band slice.
        for (let b = 0; b < bands; b++) {
            const start = b * 3;
            const originalBand = items.slice(start, start + 3).sort((a, z) => a - z);
            const resultBand = out.slice(start, start + 3).sort((a, z) => a - z);
            expect(resultBand).toEqual(originalBand);
        }
    });

    it('is deterministic for a given seed and rotates with the seed', () => {
        const items = Array.from({ length: 20 }, (_, i) => i);
        const a1 = bandedShuffle(items, 42, 4);
        const a2 = bandedShuffle(items, 42, 4);
        const b = bandedShuffle(items, 43, 4);
        expect(a1).toEqual(a2); // same seed → same order
        expect(a1).not.toEqual(b); // different seed → (very likely) different order
    });

    it('actually permutes within a band (not a no-op)', () => {
        // 6 items, 2 bands (bandSize 3). For at least one seed the intra-band
        // order must differ from the input (guards against an identity bug).
        const items = [0, 1, 2, 3, 4, 5];
        const shuffles = [1, 2, 3, 4, 5, 6, 7].map((s) => bandedShuffle(items, s, 2));
        expect(shuffles.some((s) => JSON.stringify(s) !== JSON.stringify(items))).toBe(true);
    });

    it('returns a copy for trivial inputs (<=1 item or <=1 band)', () => {
        expect(bandedShuffle([7], 1, 4)).toEqual([7]);
        expect(bandedShuffle([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
    });
});

// ---------------------------------------------------------------------------
// excludeDismissedSimilarItems (Task 6, Fix 1) — dismissed-item exclusion
// ---------------------------------------------------------------------------
describe('excludeDismissedSimilarItems', () => {
    const item = (tmdb: string, mediaType: 'movie' | 'tv', internal?: string) => ({
        externalIds: { tmdb, ...(internal ? { internal } : {}) } as Record<string, string>,
        mediaType,
    });

    it('drops a dismissed item matched by composite (id, mediaType)', () => {
        const items = [item('550', 'movie'), item('551', 'movie')];
        const out = excludeDismissedSimilarItems(items, ['tmdb:550:movie']);
        expect(out.map((i) => i.externalIds.tmdb)).toEqual(['551']);
    });

    it('does NOT cross-suppress the other media type on id collision', () => {
        const items = [item('1429', 'tv')]; // dismissed the MOVIE 1429, keep the tv
        const out = excludeDismissedSimilarItems(items, ['tmdb:1429:movie']);
        expect(out).toHaveLength(1);
    });

    it('drops a dismissed item matched by UUID', () => {
        const uuid = '11111111-2222-3333-4444-555555555555';
        const items = [item('550', 'movie', uuid), item('551', 'movie')];
        const out = excludeDismissedSimilarItems(items, [uuid]);
        expect(out.map((i) => i.externalIds.tmdb)).toEqual(['551']);
    });

    it('returns all items when there are no dismissals', () => {
        const items = [item('550', 'movie')];
        expect(excludeDismissedSimilarItems(items, [])).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// excludeDislikedFreshReleases (Task 6, Fix 4) — post-cache dislike filter
// ---------------------------------------------------------------------------
describe('excludeDislikedFreshReleases', () => {
    const item = (internal: string) => ({
        externalIds: { internal } as Record<string, string>,
    });

    it('drops items whose internal UUID is in the disliked set', () => {
        const items = [item('uuid-a'), item('uuid-b'), item('uuid-c')];
        const out = excludeDislikedFreshReleases(items, new Set(['uuid-b']));
        expect(out.map((i) => i.externalIds.internal)).toEqual(['uuid-a', 'uuid-c']);
    });

    it('returns a copy unchanged when the disliked set is empty', () => {
        const items = [item('uuid-a')];
        const out = excludeDislikedFreshReleases(items, new Set());
        expect(out).toEqual(items);
        expect(out).not.toBe(items);
    });
});
