// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FreshReleasesStrategy — access-boundary cache-key isolation.
 *
 * Regression coverage for the same cross-user authorization leak class that
 * forced the `trending-v19` bump: the query boundary and the cache key must
 * derive from the SAME real access facts (`ctx.deniedGroupIds` /
 * `ctx.maxAgeRating`), so two restricted users can never collide on one cache
 * entry and read back each other's rails under the wrong permissions.
 *
 * Also the semantics-preserving proof for the E3 migration onto ScopedCache:
 * the wrapper's composed key must be byte-identical to the pre-wrapper
 * `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat.
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

// hydrateRailMetadata (item-mapper.ts, used via the real mapBatch this suite
// keeps unmocked) issues a real getMediaRailMetadataBatch round trip after
// mapBatch; mock the query out so it no-ops instead of calling the fake `sql`
// mockGetDb returns. Currently a no-op in practice (every fixture here is
// empty, so hydrateRailMetadata's own uuidIds.length===0 guard short-circuits
// first) but the fixtures aren't guaranteed to stay that way.
vi.mock('$lib/server/database/queries/media-rail-metadata.queries.js', () => ({
    getMediaRailMetadataBatch: vi.fn().mockResolvedValue(new Map()),
}));

const mockFetchFreshReleases = vi.hoisted(() => vi.fn());
const mockExcludeDisliked = vi.hoisted(
    () => vi.fn((items: unknown) => items) as (...args: unknown[]) => unknown,
);
vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchFreshReleases: <T extends unknown[]>(...args: T) => mockFetchFreshReleases(...args),
    excludeDislikedFreshReleases: <T extends unknown[]>(...args: T) => mockExcludeDisliked(...args),
}));

const mockGetWatchedIds = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getWatchedMediaIdsCached: (...args: unknown[]) => mockGetWatchedIds(...args),
    },
}));

const mockGetDisliked = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('$lib/server/database/queries/for-you-helpers.queries.js', () => ({
    getDislikedMediaIds: (...args: unknown[]) => mockGetDisliked(...args),
}));

// The strategy goes through the ScopedCache wrapper's
// `searchScopedCacheWithBoundary(...).getOrComputeSingleFlight(base, …)`. Mock
// the cache index so the factory builds a REAL ScopedCache over a recording fake
// UnifiedCache — this exercises the wrapper's actual key composition (so the
// "different deniedGroupIds → different keys" regression assertions bite on the
// real key string) while letting us observe the composed key via `get`.
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

const { freshReleasesStrategy } = await import('./fresh-releases.strategy.js');

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

describe('FreshReleasesStrategy — access-boundary cache-key isolation', () => {
    it('uses different cache keys for two real users with different deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchFreshReleases.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctxA = makeCtx({ deniedGroupIds: ['group-a'] });
        const ctxB = makeCtx({ deniedGroupIds: ['group-b'] });

        await freshReleasesStrategy.fetch(ctxA, makeOpts());
        await freshReleasesStrategy.fetch(ctxB, makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;

        expect(keyA).not.toBe(keyB);
    });

    it('uses the same cache key for two requests with identical deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchFreshReleases.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctxA = makeCtx({ deniedGroupIds: ['group-a'] });
        const ctxA2 = makeCtx({ deniedGroupIds: ['group-a'] });

        await freshReleasesStrategy.fetch(ctxA, makeOpts());
        await freshReleasesStrategy.fetch(ctxA2, makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const key1 = mockCacheGet.mock.calls[0][0] as string;
        const key2 = mockCacheGet.mock.calls[1][0] as string;

        expect(key1).toBe(key2);
    });

    it('the query boundary passed to fetchFreshReleases matches the real deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchFreshReleases.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();
        mockFetchFreshReleases.mockClear();

        const ctxA = makeCtx({ deniedGroupIds: ['group-a'] });
        await freshReleasesStrategy.fetch(ctxA, makeOpts());

        expect(mockFetchFreshReleases).toHaveBeenCalledTimes(1);
        // fetchFreshReleases(sql, CACHE_FETCH_SIZE, [], access)
        const boundary = mockFetchFreshReleases.mock.calls[0][3];
        expect(boundary).toEqual({
            library: { kind: 'denyGroups', ids: ['group-a'] },
            age: { kind: 'any' },
        });
    });

    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchFreshReleases.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctx = makeCtx({ deniedGroupIds: ['group-a'] });
        await freshReleasesStrategy.fetch(ctx, makeOpts({ limit: 10 }));

        // Reconstruct the exact string the old hand-concat produced. This is the
        // semantics-preserving proof: the wrapper must not shift the key by a byte.
        const expectedScoped = scopedCacheKey('fresh-releases:global:v2', {
            username: ctx.username,
            deniedGroupIds: ctx.deniedGroupIds,
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: ctx.showUnavailableMedia,
        });
        const expectedBoundary = boundaryCacheKey(
            restrictedAccess({
                deniedGroupIds: ['group-a'],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        const expectedKey = `${expectedScoped}|${expectedBoundary}`;

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey);
    });
});
