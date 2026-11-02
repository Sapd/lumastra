// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TrendingStrategy — access-boundary cache-key isolation.
 *
 * Regression coverage for a cross-user authorization leak: the query boundary
 * and the cache key used to derive independently. Two restricted users with
 * different `deniedGroupIds` could collide on the same cache key and read
 * back each other's (or an admin's) trending results filtered under the
 * wrong permissions. Both must now derive from the SAME real
 * `ctx.deniedGroupIds` / `ctx.maxAgeRating` values.
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

vi.mock('$lib/server/utils/media-types.js', () => ({
    toPublicMediaType: (t: string) => (t === 'tv' ? 'series' : t),
}));

vi.mock('../../for-you/item-mapper.js', () => ({
    resolveMediaRefId: vi.fn().mockReturnValue('media-1'),
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

const mockGetDb = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockFetchTrending = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchTrending: (...args: unknown[]) => mockFetchTrending(...args),
}));

// The strategy now goes through the ScopedCache wrapper's
// `searchScopedCacheWithBoundary(...).getOrComputeSingleFlight(base, …)`. Mock
// the cache index so the factory builds a REAL ScopedCache over a recording fake
// UnifiedCache — this exercises the wrapper's actual key composition (so the
// "different deniedGroupIds → different keys" regression assertions still bite on
// the real key string) while letting us observe the composed key via `get`.
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

const { trendingStrategy } = await import('./trending.strategy.js');

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

describe('TrendingStrategy — access-boundary cache-key isolation', () => {
    it('uses different cache keys for two real users with different deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchTrending.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctxA = makeCtx({ deniedGroupIds: ['group-a'] });
        const ctxB = makeCtx({ deniedGroupIds: ['group-b'] });

        await trendingStrategy.fetch(ctxA, makeOpts());
        await trendingStrategy.fetch(ctxB, makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;

        expect(keyA).not.toBe(keyB);
    });

    it('uses the same cache key for two requests with identical deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchTrending.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctxA = makeCtx({ deniedGroupIds: ['group-a'] });
        const ctxA2 = makeCtx({ deniedGroupIds: ['group-a'] });

        await trendingStrategy.fetch(ctxA, makeOpts());
        await trendingStrategy.fetch(ctxA2, makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const key1 = mockCacheGet.mock.calls[0][0] as string;
        const key2 = mockCacheGet.mock.calls[1][0] as string;

        expect(key1).toBe(key2);
    });

    it('the query boundary passed to fetchTrending matches the real deniedGroupIds', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchTrending.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();
        mockFetchTrending.mockClear();

        const ctxA = makeCtx({ deniedGroupIds: ['group-a'] });
        await trendingStrategy.fetch(ctxA, makeOpts());

        expect(mockFetchTrending).toHaveBeenCalledTimes(1);
        const boundary = mockFetchTrending.mock.calls[0][2];
        expect(boundary).toEqual({
            library: { kind: 'denyGroups', ids: ['group-a'] },
            age: { kind: 'any' },
        });
    });

    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        mockFetchTrending.mockResolvedValue([]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );
        mockCacheGet.mockClear();

        const ctx = makeCtx({ deniedGroupIds: ['group-a'] });
        await trendingStrategy.fetch(ctx, makeOpts({ limit: 10 }));

        // Reconstruct the exact string the old hand-concat produced. No mediaType
        // ⇒ overFetch = limit + 1 = 11, type = 'all'. This is the semantics-
        // preserving proof: the wrapper must not shift the key by a single byte.
        const overFetch = 11;
        const expectedBase = `trending:v2:fetch=${overFetch}:type=all`;
        const expectedScoped = scopedCacheKey(expectedBase, {
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
