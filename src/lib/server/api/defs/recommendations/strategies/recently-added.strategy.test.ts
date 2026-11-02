// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RecentlyAddedStrategy — access-scoped cache-key isolation.
 *
 * The strategy caches ONE fixed max-size list per access scope. Its key must
 * fold in BOTH the search context (locale/livetv/lib-only) AND the query
 * boundary (`denyAll` distinction) — the combined case the `ScopedCache`
 * `searchScopedCacheWithBoundary` wrapper exists to keep byte-identical.
 *
 * This is the migration's semantics-preserving proof: the wrapper must produce
 * exactly the string the previous `${scopedCacheKey(...)}|${boundaryCacheKey(access)}`
 * hand-concat produced, and two callers with different access must never share
 * an entry.
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

// A fixed SearchAccessContext derived from the fake user the strategy builds.
// Deriving `deniedGroupIds` from the username lets two distinct users produce
// distinct keys while identical users collide, without touching the real
// (DB-backed) `buildSearchAccessContext`.
const buildFakeCtx = vi.hoisted(
    () => (user: { username: string | null; maxAgeRating: number | null }) => ({
        username: user.username,
        deniedGroupIds: user.username ? [`${user.username}-group`] : null,
        ageRating:
            user.maxAgeRating != null
                ? { maxAgeRating: user.maxAgeRating, allowUnrated: true }
                : null,
        liveTvAllowed: false,
        showUnavailableMedia: true,
    }),
);

// Keep the REAL `scopedCacheKey` / `searchAccessBoundary` (needed to reconstruct
// the byte-identical expected key) and only stub the DB-backed context builder.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: vi.fn(
            async (_sql: unknown, user: { username: string | null; maxAgeRating: number | null }) =>
                buildFakeCtx(user),
        ),
    };
});

vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    getRecentlyAddedItems: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../for-you/item-mapper.js', () => ({
    mapBatch: vi.fn().mockReturnValue({ items: [], hasMore: false }),
    libraryRowsToItems: vi.fn().mockReturnValue([]),
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

// Build a REAL ScopedCache over a recording fake UnifiedCache so the wrapper's
// actual key composition is exercised and observable via `get`.
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
            browseRecentlyAdded: { name: 'browse-recently-added', l2TTL: 300_000 },
        },
        searchScopedCacheWithBoundary: (ns: unknown, ctx: unknown, boundary: unknown) =>
            new ScopedCache(fakeUnified, ns as never, {
                kind: 'search',
                ctx: ctx as never,
                boundary: boundary as never,
            }),
    };
});

// Real (un-mocked) key helpers to reconstruct the pre-wrapper hand-concat.
const { scopedCacheKey, searchAccessBoundary } =
    await import('$lib/server/utils/search-access-context.js');
const { boundaryCacheKey } =
    await import('$lib/server/database/queries/builders/media-access-boundary.js');

const { recentlyAddedStrategy } = await import('./recently-added.strategy.js');

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

describe('RecentlyAddedStrategy — access-scoped cache-key isolation', () => {
    it('uses different cache keys for two users with different access scopes', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        await recentlyAddedStrategy.fetch(makeCtx({ username: 'alice' }), makeOpts());
        await recentlyAddedStrategy.fetch(makeCtx({ username: 'bob' }), makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;

        expect(keyA).not.toBe(keyB);
    });

    it('uses the same cache key for two requests with identical access scopes', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        await recentlyAddedStrategy.fetch(makeCtx({ username: 'alice' }), makeOpts());
        await recentlyAddedStrategy.fetch(makeCtx({ username: 'alice' }), makeOpts({ limit: 20 }));

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const key1 = mockCacheGet.mock.calls[0][0] as string;
        const key2 = mockCacheGet.mock.calls[1][0] as string;

        // Limit-independent: different limits share one entry.
        expect(key1).toBe(key2);
    });

    it('reads and writes under the same access-scoped key', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();
        mockCacheGet.mockResolvedValue(null); // force a miss so `set` runs
        mockCacheSet.mockClear();

        await recentlyAddedStrategy.fetch(makeCtx({ username: 'alice' }), makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheSet).toHaveBeenCalledTimes(1);
        expect(mockCacheSet.mock.calls[0][0]).toBe(mockCacheGet.mock.calls[0][0]);
    });

    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockClear();

        const ctx = makeCtx({ username: 'alice' });
        await recentlyAddedStrategy.fetch(ctx, makeOpts({ limit: 10 }));

        // Reconstruct the exact string the old hand-concat produced.
        const searchCtx = buildFakeCtx({
            username: ctx.username,
            maxAgeRating: ctx.maxAgeRating,
        });
        const expectedScoped = scopedCacheKey('for-you-recently-added:v5:max', searchCtx);
        const expectedBoundary = boundaryCacheKey(searchAccessBoundary(searchCtx));
        const expectedKey = `${expectedScoped}|${expectedBoundary}`;

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey);
    });
});
