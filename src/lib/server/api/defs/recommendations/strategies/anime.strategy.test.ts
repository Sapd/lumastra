// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AnimeStrategy — access-scoped cache-key isolation.
 *
 * Anime caches a per-user curated payload. Its key must fold in BOTH the request
 * search context (username/denied-groups/age/livetv/showUnavailable) AND the
 * query boundary (`denyAll` distinction) — the combined case the `ScopedCache`
 * `searchScopedCacheWithBoundary` wrapper exists to keep byte-identical — AND it
 * threads `ctx.userId` so two users never share a physical entry.
 *
 * This is the migration's semantics-preserving proof: the wrapper must produce
 * exactly the string the previous
 * `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat produced, pass
 * `ctx.userId` on every read, and read/write under the same key.
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

// Deterministic damper hash so the cache base string is fixed.
vi.mock('$lib/server/services/taste-damper.service.js', () => ({
    getTasteDamperService: () => ({
        getDamperContext: vi.fn().mockResolvedValue({ hash: 'dh' }),
    }),
}));

vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getWatchedMediaIdsCached: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('$lib/server/database/queries/for-you-helpers.queries.js', () => ({
    getDislikedMediaIds: vi.fn().mockResolvedValue([]),
}));

// The strategy never reaches fetchAnimeRecommendations in these tests because the
// cache read is stubbed to a hit — but mock it so a regression that DOES call it
// fails loudly rather than importing the real service.
const mockFetchAnime = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchAnimeRecommendations: (...args: unknown[]) => mockFetchAnime(...args),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: vi.fn().mockReturnValue(null),
}));

vi.mock('../../for-you/item-mapper.js', () => ({
    mapBatch: vi.fn().mockReturnValue({ items: [], hasMore: false }),
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

// Build a REAL ScopedCache over a recording fake UnifiedCache so the wrapper's
// actual key composition (search ctx + boundary + userId threading) is exercised
// and observable via `get`. `get` returns a non-null hit so the single-flight /
// compute path is skipped and the test stays focused on the key.
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
            curatedContent: { name: 'curated-content', l2TTL: 300_000 },
        },
        searchScopedCacheWithBoundary: (
            ns: unknown,
            ctx: unknown,
            boundary: unknown,
            userId: string | undefined,
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
const { boundaryCacheKey, restrictedAccess } =
    await import('$lib/server/database/queries/builders/media-access-boundary.js');

const { animeStrategy } = await import('./anime.strategy.js');

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
    const scoped = scopedCacheKey('anime:user:v8:dh', {
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

describe('AnimeStrategy — access-scoped cache-key isolation', () => {
    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();
        mockCacheGet.mockResolvedValue([]);

        const ctx = makeCtx({ username: 'alice' });
        await animeStrategy.fetch(ctx, makeOpts({ limit: 10 }));

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey(ctx));
    });

    it('threads ctx.userId to the underlying cache read', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();
        mockCacheGet.mockResolvedValue([]);

        const ctx = makeCtx({ userId: 'usr_00000000-0000-0000-0000-0000000000ab' as UserId });
        await animeStrategy.fetch(ctx, makeOpts());

        expect(mockCacheGet.mock.calls[0][1]).toBe(ctx.userId);
    });

    it('uses different cache keys for two users with different access scopes', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();
        mockCacheGet.mockResolvedValue([]);

        await animeStrategy.fetch(makeCtx({ deniedGroupIds: null }), makeOpts());
        await animeStrategy.fetch(makeCtx({ deniedGroupIds: ['group-a'] }), makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;
        expect(keyA).not.toBe(keyB);
    });

    it('reads and writes under the same access-scoped key on a miss', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();
        mockCacheSet.mockClear();
        // Force a miss so getOrComputeSingleFlight computes and promotes to L1.
        mockCacheGet.mockResolvedValue(null);
        mockFetchAnime.mockResolvedValue([]);

        const ctx = makeCtx({ username: 'alice' });
        await animeStrategy.fetch(ctx, makeOpts());

        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey(ctx));
        // L1 promotion writes under the same key, with the same userId.
        expect(mockCacheSet).toHaveBeenCalledTimes(1);
        expect(mockCacheSet.mock.calls[0][0]).toBe(expectedKey(ctx));
        expect(mockCacheSet.mock.calls[0][3]).toBe(ctx.userId);
    });
});
