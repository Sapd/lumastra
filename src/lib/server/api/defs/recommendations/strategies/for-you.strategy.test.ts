// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ForYouStrategy — reason-label honesty + access-scoped cache-key isolation.
 *
 * ForYouStrategy is a non-personalized, quality-ranked LIBRARY fallback
 * (global `getQualityLibraryMedia` cache) — its items must carry an honest
 * generic reason kind, not the personalized `'for-you'` kind, which would
 * mislead consumers hitting `GET /api/recommendations?type=for-you` directly
 * into treating library-fallback content as tailored to the user.
 *
 * The cache key must fold in BOTH the search context (locale/livetv/lib-only)
 * AND the query boundary (`denyAll` distinction) — the combined case the
 * `ScopedCache` `searchScopedCacheWithBoundary(ns, ctx, boundary)` wrapper exists
 * to keep byte-identical. This is the migration's semantics-preserving proof:
 * the wrapper must produce exactly the string the previous
 * `${scopedCacheKey(base, ctx)}|${boundaryCacheKey(access)}` hand-concat
 * produced, and two callers with different access must never share an entry.
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

vi.mock('$lib/utils/external-ids.js', () => ({
    createExternalIds: vi.fn().mockReturnValue({}),
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    toPublicMediaType: (t: string) => (t === 'tv' ? 'series' : t),
}));

vi.mock('$lib/server/utils/rating-utils.js', () => ({
    pickDisplayRating: vi.fn().mockReturnValue(75),
}));

const mockGetDb = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

// hydrateRailMetadata (item-mapper.ts) issues a real getMediaRailMetadataBatch
// round trip after building items; mock the query out so it no-ops instead of
// calling the fake `sql` this suite's mockGetDb returns.
vi.mock('$lib/server/database/queries/media-rail-metadata.queries.js', () => ({
    getMediaRailMetadataBatch: vi.fn().mockResolvedValue(new Map()),
}));

const mockGetQualityLibraryMedia = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/hero-fallback.queries.js', () => ({
    getQualityLibraryMedia: (...args: unknown[]) => mockGetQualityLibraryMedia(...args),
}));

// The wrapper's single-flight substrate: run the leader path inline so the
// JSON round-trip + compute are exercised without a live Valkey.
const mockGetOrComputeSingleFlight = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: (...args: unknown[]) => mockGetOrComputeSingleFlight(...args),
}));

// Build a REAL ScopedCache over a recording fake UnifiedCache so the wrapper's
// actual key composition is exercised and observable. `get` is configurable per
// test: a non-null return short-circuits `getOrComputeSingleFlight` (key-only
// tests); `null` forces the miss + compute path (reason-honesty test).
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
            curatedContent: { name: 'curated-content-v1', l2TTL: 300_000 },
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
const { scopedCacheKey } = await import('$lib/server/utils/search-access-context.js');
const { restrictedAccess, boundaryCacheKey } =
    await import('$lib/server/database/queries/builders/media-access-boundary.js');

const { forYouStrategy } = await import('./for-you.strategy.js');

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

/** Reconstruct the exact string the pre-wrapper hand-concat produced for a ctx. */
function expectedKey(ctx: AccessContext, opts: RecommenderOptions): string {
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
    const base = `for-you:quality:v1:limit=${opts.limit + 1}:type=all`;
    return `${scopedCacheKey(base, searchCtx)}|${boundaryCacheKey(access)}`;
}

const LIBRARY_ITEM = {
    internal_id: 'media-1',
    tmdb_id: 100,
    media_type: 'movie',
    title: 'Some Movie',
    release_year: 2020,
    imdb_rating: 7.5,
    tmdb_rating: 7.0,
    vote_count: 500,
};

describe('ForYouStrategy — reason honesty', () => {
    it('tags items with a generic reason kind, not the personalized "for-you" kind', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockResolvedValue(null); // force the miss + compute path
        mockGetQualityLibraryMedia.mockResolvedValue([LIBRARY_ITEM]);
        mockGetOrComputeSingleFlight.mockImplementation(
            async ({ compute }: { compute: () => Promise<string> }) => compute(),
        );

        const result = await forYouStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items.length).toBeGreaterThan(0);
        for (const item of result.items) {
            expect(item.reason?.kind).toBe('trending');
        }
    });
});

describe('ForYouStrategy — access-scoped cache-key isolation', () => {
    it('produces a key byte-identical to the pre-wrapper scopedCacheKey|boundaryCacheKey concat', async () => {
        mockGetDb.mockReturnValue({});
        // A non-null cache hit short-circuits single-flight so we observe the key
        // the wrapper handed the underlying cache without touching compute.
        mockCacheGet.mockReset().mockResolvedValue([]);

        const ctx = makeCtx({ username: 'alice' });
        const opts = makeOpts();
        await forYouStrategy.fetch(ctx, opts);

        expect(mockCacheGet).toHaveBeenCalledTimes(1);
        expect(mockCacheGet.mock.calls[0][0]).toBe(expectedKey(ctx, opts));
        mockCacheGet.mockReset().mockResolvedValue(null);
    });

    it('uses different cache keys for two callers with different access scopes', async () => {
        mockGetDb.mockReturnValue({});
        mockCacheGet.mockReset().mockResolvedValue([]);

        await forYouStrategy.fetch(makeCtx({ deniedGroupIds: null }), makeOpts());
        await forYouStrategy.fetch(makeCtx({ deniedGroupIds: ['grp-1'] }), makeOpts());

        expect(mockCacheGet).toHaveBeenCalledTimes(2);
        const keyA = mockCacheGet.mock.calls[0][0] as string;
        const keyB = mockCacheGet.mock.calls[1][0] as string;
        expect(keyA).not.toBe(keyB);
        mockCacheGet.mockReset().mockResolvedValue(null);
    });
});
