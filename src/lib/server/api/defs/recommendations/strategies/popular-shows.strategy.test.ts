// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PopularShowsStrategy — access-boundary cache-key isolation.
 *
 * Regression coverage for the same cross-user authorization leak class that
 * forced the `trending-v19` bump: the query boundary and the cache key must
 * derive from the SAME real access facts (`ctx.deniedGroupIds` /
 * `ctx.maxAgeRating`), so two restricted users can never collide on one cache
 * entry and read back each other's rails under the wrong permissions.
 *
 * Also the semantics-preserving proof for the E3 migration onto ScopedCache:
 * the wrapper's composed key must be byte-identical to the pre-wrapper
 * `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat. This is a
 * GLOBAL (non-user) curated cache, so NO `userId` is threaded to the underlying
 * read/write — the entry is shared across users with the same access scope.
 */

import { describe, it, expect, vi } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext, RecommenderOptions } from '../recommender.js';

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

const mockGetDb = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockFetchPopularShows = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchPopularShows: (...args: unknown[]) => mockFetchPopularShows(...args),
}));

const mockGetWatchedIds = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getWatchedMediaIdsCached: (...args: unknown[]) => mockGetWatchedIds(...args),
    },
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: vi.fn().mockReturnValue(null),
}));

vi.mock('../../for-you/item-mapper.js', () => ({
    mapBatch: vi.fn().mockReturnValue({ items: [], hasMore: false }),
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

// The strategy goes through the ScopedCache wrapper's
// `searchScopedCacheWithBoundary(...).getOrComputeSingleFlight(base, …)`. Mock
// the cache index so the factory builds a REAL ScopedCache over a recording fake
// UnifiedCache — this exercises the wrapper's actual key composition (so the
// "different deniedGroupIds → different keys" regression assertions bite on the
// real key string) while letting us observe the composed key via `get`. No
// userId is passed, matching the global (non-user) curated cache.
const mockCacheGet = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockCacheSet = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$lib/server/cache/index.js', async () => {
    const { ScopedCache } = await import('$lib/server/cache/scoped-cache');
    const fakeUnified = {
        get: (...args: unknown[]) => mockCacheGet(...args),
        set: (...args: unknown[]) => mockCacheSet(...args),
    } as unknown as import('$lib/server/cache/unified-cache').UnifiedCache;
    return {
        CACHE_NAMESPACES: {
            curatedContent: { name: 'curated', l2TTL: 300_000 },
        },
        searchScopedCacheWithBoundary: (ns: unknown, ctx: unknown, boundary: unknown) =>
            new ScopedCache(fakeUnified, ns as never, {
                kind: 'search',
                ctx: ctx as never,
                boundary: boundary as never,
            }),
    };
});

const mockGetOrComputeSingleFlight = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: (...args: unknown[]) => mockGetOrComputeSingleFlight(...args),
}));

// Real (un-mocked) key helpers — used to reconstruct the exact key string the
// pre-wrapper hand-concat produced, proving the migration is byte-identical.
const { scopedCacheKey } = await import('$lib/server/utils/search-access-context.js');
const { restrictedAccess, boundaryCacheKey } =
    await import('$lib/server/database/queries/builders/media-access-boundary.js');

const { popularShowsStrategy } = await import('./popular-shows.strategy.js');

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
        ...partial,
    };
}

/** Reconstruct the exact key the pre-wrapper hand-concat produced for a ctx. */
function expectedKey(ctx: AccessContext): string {
    const scoped = scopedCacheKey('popular-shows:global:v5', {
        username: ctx.username,
        deniedGroupIds: ctx.deniedGroupIds,
        ageRating:
            ctx.maxAgeRating != null
                ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                : null,
        liveTvAllowed: false,
        showUnavailableMedia: ctx.showUnavailableMedia,
    });
    const boundary = boundaryCacheKey(
        restrictedAccess({
            deniedGroupIds: ctx.deniedGroupIds ?? [],
            maxAgeRating: ctx.maxAgeRating,
            allowUnrated: ctx.allowUnrated,
        }),
    );
    return `${scoped}|${boundary}`;
}

describe('PopularShowsStrategy — access-boundary cache-key isolation', () => {
    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchPopularShows.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctx = makeCtx({ deniedGroupIds: ['group-a'] });
        await popularShowsStrategy.fetch(ctx, makeOpts({ limit: 10 }));

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey(ctx));
    });

    it('does NOT thread a userId to the underlying cache read (global entry)', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchPopularShows.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctx = makeCtx();
        await popularShowsStrategy.fetch(ctx, makeOpts());

        // Second positional arg is the userId param on UnifiedCache.get — global
        // cache means it stays undefined so all users share one physical entry.
        expect(mockCacheGet.mock.calls[0][1]).toBeUndefined();
    });

    it('uses different cache keys for two users with different deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchPopularShows.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        await popularShowsStrategy.fetch(makeCtx({ deniedGroupIds: ['group-a'] }), makeOpts());
        await popularShowsStrategy.fetch(makeCtx({ deniedGroupIds: ['group-b'] }), makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;
        expect(keyA).not.toBe(keyB);
    });

    it('the query boundary passed to fetchPopularShows matches the real deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchPopularShows.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();
        mockFetchPopularShows.mockClear();

        await popularShowsStrategy.fetch(makeCtx({ deniedGroupIds: ['group-a'] }), makeOpts());

        expect(mockFetchPopularShows).toHaveBeenCalledTimes(1);
        // fetchPopularShows(sql, CACHE_FETCH_SIZE, access)
        const boundary = mockFetchPopularShows.mock.calls[0][2];
        expect(boundary).toEqual({
            library: { kind: 'denyGroups', ids: ['group-a'] },
            age: { kind: 'any' },
        });
    });

    it('reads and writes under the same access-scoped key on a miss', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchPopularShows.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();
        mockCacheSet.mockClear();
        mockCacheGet.mockResolvedValue(null);

        const ctx = makeCtx({ deniedGroupIds: ['group-a'] });
        await popularShowsStrategy.fetch(ctx, makeOpts());

        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey(ctx));
        // L1 promotion writes under the same key, with no userId.
        expect(mockCacheSet).toHaveBeenCalledTimes(1);
        expect(mockCacheSet.mock.calls[0][0]).toBe(expectedKey(ctx));
        expect(mockCacheSet.mock.calls[0][3]).toBeUndefined();
    });
});
