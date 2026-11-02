// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * G4 / A2 / C3 — Data-driven strategy registry security-contract tests.
 *
 * Covers:
 *   - All registered strategies expose a `.fetch` function (structural contract).
 *   - Age-sensitive strategies return { items: [], hasMore: false } when called
 *     with isAgeRestricted: true — without touching the DB (the ONLY guard that
 *     keeps age-restricted content out of /feed).
 *   - Strategies that perform the age-check early-return BEFORE any I/O: the DB
 *     mock must NOT be called when the early-return fires.
 *
 * Strategies known to carry the early-return age guard:
 *   anime, trending
 *
 * Strategies whose code passes isAgeRestricted to a downstream context
 * (for-you, short-movies, etc.) do NOT have a top-level early-return; the
 * downstream service propagates the flag. Those strategies are tested for
 * structural registration only. A TODO is left for DB-backed integration tests
 * that verify the downstream propagation.
 *
 * Mocking approach:
 *   - All dynamic imports inside strategy.fetch() (getDb, services, cache, …)
 *     are mocked at their module paths via vi.mock.
 *   - The `getDb` mock returns null (falsy) for the early-return tests: the
 *     guarded strategies must return { items:[], hasMore:false } BEFORE reaching
 *     the `if (!sql) throw` line.
 *   - No live DB is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext, RecommenderOptions } from '../recommender.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockGetDb = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// Stub out all services and caches that strategies may import dynamically.
// For the age-restricted early-return tests the strategy must return before
// reaching any of these, so their implementations are irrelevant — but they
// need to resolve so the dynamic imports don't throw ModuleNotFoundError.

vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchAnimeRecommendations: vi.fn().mockResolvedValue([]),
    fetchShortMovies: vi.fn().mockResolvedValue([]),
    fetchTrending: vi.fn().mockResolvedValue([]),
    fetchBingeWorthy: vi.fn().mockResolvedValue([]),
    getQualityLibraryMedia: vi.fn().mockResolvedValue([]),
    fetchFulfilledRequests: vi.fn().mockResolvedValue([]),
    fetchFreshReleases: vi.fn().mockResolvedValue([]),
    fetchPopularShows: vi.fn().mockResolvedValue([]),
    fetchRecentlyAdded: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/taste-damper.service.js', () => ({
    getTasteDamperService: vi.fn().mockReturnValue({
        getDamperContext: vi.fn().mockResolvedValue(null),
    }),
}));

vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getWatchedMediaIdsCached: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
        }),
    },
    CACHE_NAMESPACES: {
        curatedContent: { name: 'curated', l2TTL: 300_000 },
        recommendations: { name: 'recs', ttl: 60_000 },
        trending: { name: 'trending', ttl: 60_000 },
    },
}));

vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: vi.fn().mockResolvedValue(JSON.stringify([])),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({
        deniedGroupIds: null,
        showUnavailableMedia: true,
    }),
    scopedCacheKey: vi.fn().mockReturnValue('mock-cache-key'),
    searchAccessBoundary: vi.fn().mockReturnValue({
        library: { kind: 'all' },
        age: { kind: 'any' },
    }),
}));

vi.mock('$lib/server/database/queries/hero-fallback.queries.js', () => ({
    getQualityLibraryMedia: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/recommendations.queries.js', () => ({
    getRecommendations: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/trending.queries.js', () => ({
    getTrending: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/ai-recommendations.service.js', () => ({
    getAiRecommendations: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/cache/cache-manager.js', () => ({
    CacheManager: vi.fn(),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: vi.fn().mockReturnValue(null),
    createExternalIds: vi.fn().mockReturnValue({}),
}));

vi.mock('../../for-you/item-mapper.js', () => ({
    mapBatch: vi.fn().mockReturnValue({ items: [], hasMore: false }),
    resolveMediaRefId: vi.fn().mockReturnValue('media-1'),
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./rail-extra.js', () => ({
    readWatchedUuids: vi.fn().mockReturnValue([]),
    readWatchedTmdbIds: vi.fn().mockReturnValue([]),
}));

// ── Import registry AFTER mocks ───────────────────────────────────────────────

const { STRATEGY_REGISTRY } = await import('./index.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(partial: Partial<AccessContext> = {}): AccessContext {
    return {
        userId: 'usr_00000000-0000-0000-0000-000000000001' as UserId,
        username: 'alice',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
        ...partial,
    };
}

function makeOpts(partial: Partial<RecommenderOptions> = {}): RecommenderOptions {
    return {
        surface: 'internal',
        limit: 10,
        offset: 0,
        ...partial,
    };
}

const AGE_RESTRICTED_CTX = makeCtx({ isAgeRestricted: true });
const EMPTY_RESULT = { items: [], hasMore: false };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('STRATEGY_REGISTRY — structural contract', () => {
    it('is non-empty (at least one strategy registered)', () => {
        expect(STRATEGY_REGISTRY.size).toBeGreaterThan(0);
    });

    it.each([...STRATEGY_REGISTRY.entries()])(
        'strategy "%s" exposes a .fetch function',
        (id, strategy) => {
            expect(typeof strategy.fetch).toBe('function');
        },
    );

    it.each([...STRATEGY_REGISTRY.entries()])(
        'strategy "%s" has a non-empty string id',
        (id, strategy) => {
            expect(typeof strategy.id).toBe('string');
            expect(strategy.id.length).toBeGreaterThan(0);
        },
    );

    it.each([...STRATEGY_REGISTRY.entries()])(
        'strategy "%s" has a label function that resolves per locale',
        (id, strategy) => {
            expect(typeof strategy.label).toBe('function');
            expect(strategy.label({}, { locale: 'en' })).toBeTruthy();
            expect(strategy.label({}, { locale: 'de' })).toBeTruthy();
        },
    );

    it('contains all expected strategy ids', () => {
        const expectedIds = [
            'trending',
            'ai',
            'mood',
            'for-you',
            'fulfilled-requests',
            'because-you-watched',
            'editorial',
            'popular-shows',
            'fresh-releases',
            'binge-worthy',
            'anime',
            'short-movies',
            'recently-added',
            'random-picks',
            'from-your-ratings',
        ];
        for (const id of expectedIds) {
            expect(STRATEGY_REGISTRY.has(id)).toBe(true);
        }
    });

    it('resolves "from-your-ratings" to the ai strategy (alias — same generator as the web taste rail)', () => {
        const alias = STRATEGY_REGISTRY.get('from-your-ratings');
        const ai = STRATEGY_REGISTRY.get('ai');
        expect(alias).toBeDefined();
        // The alias must be backed by the ai strategy so its output is identical
        // to the web "From your ratings" taste rail (aiStrategy, id 'ai').
        expect(alias).toBe(ai);
    });
});

describe('STRATEGY_REGISTRY — age-restricted profile guard (anime)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // DB returns null for these tests: the early-return must fire BEFORE
        // getDb() is reached for strategies that guard at the top.
        mockGetDb.mockReturnValue(null);
    });

    it('anime strategy returns empty result for isAgeRestricted:true without DB call', async () => {
        const strategy = STRATEGY_REGISTRY.get('anime')!;
        expect(strategy).toBeDefined();

        const result = await strategy.fetch(AGE_RESTRICTED_CTX, makeOpts());

        expect(result).toEqual(EMPTY_RESULT);
        // The early-return fires before getDb(), so getDb must NOT be called.
        expect(mockGetDb).not.toHaveBeenCalled();
    });

    it('anime strategy does NOT return empty for isAgeRestricted:false (proceeds to DB check)', async () => {
        // With isAgeRestricted=false the strategy proceeds past the guard and
        // hits getDb() → null → throws DependencyUnavailableError. That proves
        // the guard did NOT fire for a non-restricted user.
        const strategy = STRATEGY_REGISTRY.get('anime')!;

        await expect(
            strategy.fetch(makeCtx({ isAgeRestricted: false }), makeOpts()),
        ).rejects.toThrow();
        // getDb was called — the early-return did not fire.
        expect(mockGetDb).toHaveBeenCalled();
    });
});

describe('STRATEGY_REGISTRY — age-restricted profile guard (trending)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue(null);
    });

    it('trending strategy returns empty result for isAgeRestricted:true without DB call', async () => {
        const strategy = STRATEGY_REGISTRY.get('trending')!;
        expect(strategy).toBeDefined();

        const result = await strategy.fetch(AGE_RESTRICTED_CTX, makeOpts());

        expect(result).toEqual(EMPTY_RESULT);
        // trending's early-return fires AFTER getDb() per the code structure —
        // it calls getDb() first, then checks isAgeRestricted. So we assert
        // the result shape but do NOT assert getDb was/wasn't called.
        // The critical invariant is: age-restricted users receive 0 items.
    });

    it('trending returns items shape (not a thrown error) for isAgeRestricted:true', async () => {
        const strategy = STRATEGY_REGISTRY.get('trending')!;

        const result = await strategy.fetch(AGE_RESTRICTED_CTX, makeOpts());

        // Must be a result, never a throw, for the /feed compositor to work.
        expect(result).toHaveProperty('items');
        expect(result).toHaveProperty('hasMore');
        expect(result.items).toHaveLength(0);
    });
});

describe('STRATEGY_REGISTRY — age-restricted profile guard (for-you)', () => {
    // for-you does NOT have a top-level isAgeRestricted early-return; instead
    // it passes the flag to buildSearchAccessContext / getQualityLibraryMedia.
    // We assert the structural contract only; DB-backed integration would be
    // needed to verify that the downstream filter actually excludes age-gated
    // content from the result set.

    beforeEach(() => {
        vi.clearAllMocks();
        // Return null so the strategy reaches the dependency-unavailable throw.
        mockGetDb.mockReturnValue(null);
    });

    it('for-you strategy is registered and has a fetch function', () => {
        const strategy = STRATEGY_REGISTRY.get('for-you');
        expect(strategy).toBeDefined();
        expect(typeof strategy!.fetch).toBe('function');
    });

    // TODO (integration): verify that for-you with isAgeRestricted:true calls
    // buildSearchAccessContext with the flag and that the query excludes
    // age-gated content (requires a DB fixture).
});

describe('STRATEGY_REGISTRY — age-restricted profile guard (short-movies)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue(null);
    });

    it('short-movies strategy is registered and has a fetch function', () => {
        const strategy = STRATEGY_REGISTRY.get('short-movies');
        expect(strategy).toBeDefined();
        expect(typeof strategy!.fetch).toBe('function');
    });

    // TODO (integration): short-movies passes isAgeRestricted to
    // buildSearchAccessContext — a DB-backed test should confirm the flag is
    // propagated and restricts query output.
});

describe('STRATEGY_REGISTRY — all strategies: age-restricted call does not throw (fault isolation)', () => {
    // /feed calls each strategy in a per-section try/catch. A strategy that
    // throws instead of returning { items:[], hasMore:false } for age-restricted
    // callers causes the section to be dropped, which is acceptable — but a
    // strategy that returns the WRONG shape (not a result object) is a contract
    // violation. We verify the early-return strategies return a proper result.

    const AGE_GUARD_STRATEGIES = ['anime', 'trending'] as const;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue(null);
    });

    it.each(AGE_GUARD_STRATEGIES)(
        'strategy "%s" returns { items: [], hasMore: false } (not a throw) for age-restricted callers',
        async (id) => {
            const strategy = STRATEGY_REGISTRY.get(id)!;
            const result = await strategy.fetch(AGE_RESTRICTED_CTX, makeOpts());

            expect(result.items).toEqual([]);
            expect(result.hasMore).toBe(false);
        },
    );
});
