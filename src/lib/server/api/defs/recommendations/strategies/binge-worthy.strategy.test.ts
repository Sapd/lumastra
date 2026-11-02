// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BingeWorthyStrategy — access-scoped cache-key isolation.
 *
 * The strategy caches ONE fixed max-size list per (access scope × user). Its key
 * must fold in BOTH the search context (locale/livetv/lib-only) AND the query
 * boundary (`denyAll` distinction), AND thread the per-user partition
 * (`ctx.userId`) into the physical key — the combined case the `ScopedCache`
 * `searchScopedCacheWithBoundary(ns, ctx, boundary, userId)` wrapper exists to
 * keep byte-identical.
 *
 * This is the migration's semantics-preserving proof: the wrapper must produce
 * exactly the string the previous
 * `${scopedCacheKey(base, ctx)}|${boundaryCacheKey(access)}` hand-concat produced
 * (read under `cache.get(key, ctx.userId)`), and two callers with different
 * access must never share an entry.
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

// fetchBingeWorthySeries must never be reached in these tests: `cache.get` returns
// a cached hit, so `getOrComputeSingleFlight` short-circuits before compute.
const mockFetchBingeWorthySeries = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchBingeWorthySeries: (...args: unknown[]) => mockFetchBingeWorthySeries(...args),
}));

// Fixed damper hash so the cache base string is deterministic.
vi.mock('$lib/server/services/taste-damper.service.js', () => ({
    getTasteDamperService: () => ({
        getDamperContext: vi.fn().mockResolvedValue({ hash: 'testhash' }),
    }),
}));

vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getWatchedMediaIdsCached: vi.fn().mockResolvedValue([]),
    },
}));

// Fixed suppress flags → suppressTag = 'supK0A0'.
vi.mock('$lib/server/services/content-affinity.service.js', () => ({
    shouldSuppressContent: vi.fn().mockResolvedValue({ kids: false, anime: false }),
}));

vi.mock('../../for-you/item-mapper.js', () => ({
    mapBatch: vi.fn().mockReturnValue({ items: [], hasMore: false }),
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

// Keep the REAL restrictedAccess / boundaryCacheKey — needed to reconstruct the
// byte-identical expected key.

// Build a REAL ScopedCache over a recording fake UnifiedCache so the wrapper's
// actual key composition (and userId threading) is exercised and observable.
// `get` returns a non-null cached hit so `getOrComputeSingleFlight` returns
// before touching the single-flight substrate.
const mockCacheGet = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockCacheSet = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$lib/server/cache/index.js', async () => {
    const { ScopedCache } = await import('$lib/server/cache/scoped-cache');
    const fakeUnified = {
        get: (...args: unknown[]) => mockCacheGet(...args),
        set: (...args: unknown[]) => mockCacheSet(...args),
    } as unknown as import('$lib/server/cache/unified-cache').UnifiedCache;
    return {
        CACHE_NAMESPACES: {
            curatedContent: { name: 'curated-content-v1', l2TTL: 3_600_000 },
        },
        searchScopedCacheWithBoundary: (
            ns: unknown,
            ctx: unknown,
            boundary: unknown,
            userId?: string,
        ) =>
            new ScopedCache(
                fakeUnified,
                ns as never,
                { kind: 'search', ctx: ctx as never, boundary: boundary as never },
                userId,
            ),
    };
});

// Real (un-mocked) key helpers to reconstruct the pre-wrapper hand-concat.
const { scopedCacheKey } = await import('$lib/server/utils/search-access-context.js');
const { restrictedAccess, boundaryCacheKey } =
    await import('$lib/server/database/queries/builders/media-access-boundary.js');

const { bingeWorthyStrategy } = await import('./binge-worthy.strategy.js');

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

/** Reconstruct the exact string the pre-wrapper hand-concat produced for a ctx. */
function expectedKey(ctx: AccessContext): string {
    const searchCtx = {
        username: ctx.username,
        deniedGroupIds: ctx.deniedGroupIds,
        ageRating:
            ctx.maxAgeRating != null
                ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                : null,
        liveTvAllowed: false,
        showUnavailableMedia: ctx.showUnavailableMedia,
    };
    const access = restrictedAccess({
        deniedGroupIds: ctx.deniedGroupIds ?? [],
        maxAgeRating: ctx.maxAgeRating,
        allowUnrated: ctx.allowUnrated,
    });
    const base = 'v7:binge-worthy:user:testhash:supK0A0';
    return `${scopedCacheKey(base, searchCtx)}|${boundaryCacheKey(access)}`;
}

describe('BingeWorthyStrategy — access-scoped cache-key isolation', () => {
    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        const ctx = makeCtx({ username: 'alice' });
        await bingeWorthyStrategy.fetch(ctx, makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey(ctx));
    });

    it('threads ctx.userId into the physical cache read (per-user partition)', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        const ctx = makeCtx({ userId: 'usr_partition-token' as UserId });
        await bingeWorthyStrategy.fetch(ctx, makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        // UnifiedCache.get(key, userId) — the userId is the SECOND arg and must be
        // preserved, else all users collapse onto one shared physical entry.
        expect(mockCacheGet.mock.calls[0][1]).toBe('usr_partition-token');
    });

    it('uses different cache keys for two callers with different access scopes', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        await bingeWorthyStrategy.fetch(makeCtx({ deniedGroupIds: null }), makeOpts());
        await bingeWorthyStrategy.fetch(makeCtx({ deniedGroupIds: ['grp-1'] }), makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;
        expect(keyA).not.toBe(keyB);
    });

    it('uses the same cache key for two requests with identical access scopes but different limits', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        await bingeWorthyStrategy.fetch(makeCtx({ username: 'alice' }), makeOpts({ limit: 10 }));
        await bingeWorthyStrategy.fetch(makeCtx({ username: 'alice' }), makeOpts({ limit: 20 }));

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        expect(mockCacheGet.mock.calls[0][0]).toBe(mockCacheGet.mock.calls[1][0]);
    });
});
