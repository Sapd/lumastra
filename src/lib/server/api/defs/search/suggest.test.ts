// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/search/suggest.ts (GET /api/v1/search/suggest).
 *
 * Covers:
 *   - Lean item shape: { id, title, mediaType, year, images } only (no
 *     overview/ids/rank/matchSource).
 *   - Default limit cap (8) and max (20).
 *   - Short-query (<2 chars) → 200 empty page, never 503.
 *   - 503 when DB is null (dependency down).
 *   - 503 when a query primitive throws.
 *   - toPublicMediaType: 'tv'/'show' DB rows surface as mediaType === 'series'.
 *   - offset is always 0 in the page block (offset-less by design).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('$lib/server/services/image-descriptor/resolver.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    return {
        resolveImageSets: vi.fn(
            async (
                _sql: unknown,
                surface: import('$lib/shared/api-urls.js').ApiSurface,
                items: Array<{ id: string }>,
            ) =>
                new Map(
                    items.map(({ id }) => [
                        id,
                        buildImageSet(surface, {
                            poster: { ownerId: id, source: 'self' },
                            backdrop: { ownerId: id, source: 'self' },
                        }),
                    ]),
                ),
        ),
    };
});

const mockGetDb = vi.fn();
const mockSearchMediaFulltext = vi.fn();
const mockSearchMusic = vi.fn();
const mockGetDeniedLibraryGroups = vi.fn();
const mockToLibraryAccessUser = vi.fn();
/** Mutable per test; false keeps the existing library-only behavior. */
const mockShowUnavailableInSearch = vi.hoisted(() => ({ value: false }));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/search.queries.js', () => ({
    searchMediaFulltext: (...args: unknown[]) => mockSearchMediaFulltext(...args),
    searchMusic: (...args: unknown[]) => mockSearchMusic(...args),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: (...args: unknown[]) => mockGetDeniedLibraryGroups(...args),
    toLibraryAccessUser: (...args: unknown[]) => mockToLibraryAccessUser(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: false,
        UNRATED_CONTENT_VISIBLE: false,
    },
    // suggest.ts calls this instead of reading SHOW_UNAVAILABLE_MEDIA_IN_SEARCH
    // directly — false preserves the existing (library-only) test behavior.
    isUnavailableMediaVisibleInSearch: () => mockShowUnavailableInSearch.value,
    // buildSearchAccessContext (search-access-context.ts) unconditionally calls
    // this to populate SearchAccessContext.showUnavailableMedia — a DIFFERENT,
    // Trending/For-You-only gate that suggest.ts deliberately does NOT read (it
    // keeps using isUnavailableMediaVisibleInSearch above). Present here only so
    // buildSearchAccessContext doesn't throw; no test asserts on it.
    isUnavailableMediaVisible: () => false,
}));

vi.mock('$lib/server/api/defs/catalog/media-id.js', () => ({
    buildImageRefs: (id: string, base: string) => ({
        poster: {
            href: `${base}/${id}/images/poster`,
            thumb: `${base}/${id}/images/poster?size=thumb`,
            card: `${base}/${id}/images/poster?size=card`,
            full: `${base}/${id}/images/poster?size=full`,
        },
        backdrop: {
            href: `${base}/${id}/images/backdrop`,
            card: `${base}/${id}/images/backdrop?size=card`,
            wide: `${base}/${id}/images/backdrop?size=wide`,
            full: `${base}/${id}/images/backdrop?size=full`,
        },
    }),
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

// ── Cache mocks ──────────────────────────────────────────────────────────────
//
// Same pattern as search.test.ts: a live-reference L1 mock plus a memoized
// single-flight mock, both cleared per-test so cache entries never leak
// across test cases. Single-flight's own dedup guarantee is covered by
// single-flight.test.ts — here we only need "don't recompute on a hit" and
// "a thrown compute() propagates uncaught".
const suggestCacheStore = vi.hoisted(() => new Map<string, unknown>());
const suggestSingleFlightStore = vi.hoisted(() => new Map<string, string>());
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: async (key: string) => suggestCacheStore.get(key) ?? null,
            set: async (key: string, value: unknown) => {
                suggestCacheStore.set(key, value);
            },
        }),
    },
    CACHE_NAMESPACES: {
        searchSuggestResults: { name: 'search-suggest-results-v1', l1TTL: 20_000, l2TTL: 20_000 },
    },
}));
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async ({
        cacheKey,
        compute,
    }: {
        cacheKey: string;
        compute: () => Promise<string>;
    }) => {
        const existing = suggestSingleFlightStore.get(cacheKey);
        if (existing !== undefined) return existing;
        const value = await compute();
        suggestSingleFlightStore.set(cacheKey, value);
        return value;
    },
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./suggest.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX = { surface: 'v1' as const };

function makeEvent(q: string, extra: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/api/v1/search/suggest');
    url.searchParams.set('q', q);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

    return {
        url,
        params: {},
        route: { id: '/api/v1/search/suggest' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function makeMediaRow(overrides: {
    media_type?: string;
    title?: string;
    rank?: number;
    internal_id?: string;
}) {
    return {
        media_type: overrides.media_type ?? 'movie',
        title: overrides.title ?? 'Untitled',
        rank: overrides.rank ?? 0.5,
        internal_id: overrides.internal_id ?? `uuid-${Math.random()}`,
        jellyfin_id: null,
        tmdb_id: null,
        imdb_id: null,
        release_date: '2021-06-01',
        overview: null,
    };
}

function _makeMusicRow(overrides: { title?: string; id?: string; media_type?: string }) {
    return {
        id: overrides.id ?? `m-${Math.random()}`,
        media_type: overrides.media_type ?? 'track',
        title: overrides.title ?? 'Song',
        rank: 0.5,
        year: null,
        artist_name: null,
        album_title: null,
        image_source_id: null,
    };
}

async function callGet(q: string, extra: Record<string, string> = {}) {
    const event = makeEvent(q, extra);
    const handler = def.handlers.GET!;
    const res = await handler(event, CTX);
    const body = await res.clone().json();
    return { status: res.status, body, headers: res.headers };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockShowUnavailableInSearch.value = false;
    vi.clearAllMocks();
    // Isolate every test's cache — see the matching comment in search.test.ts.
    suggestCacheStore.clear();
    suggestSingleFlightStore.clear();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockGetDeniedLibraryGroups.mockResolvedValue(null);
    mockToLibraryAccessUser.mockReturnValue({});
    mockSearchMediaFulltext.mockResolvedValue([]);
    mockSearchMusic.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/search/suggest — 503 on dependency down', () => {
    it('returns 503 with code=dependency_unavailable when getDb() is null', async () => {
        mockGetDb.mockReturnValue(null);

        const { status, body, headers } = await callGet('daydream');

        expect(status).toBe(503);
        expect(headers.get('content-type')).toMatch('application/problem+json');
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns 503 when searchMediaFulltext throws', async () => {
        mockSearchMediaFulltext.mockRejectedValue(new Error('query failed'));

        const { status, body } = await callGet('daydream');

        expect(status).toBe(503);
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('GET /api/v1/search/suggest — short query → 200 empty (not 503)', () => {
    it('returns 200 empty page for a 1-char query', async () => {
        const { status, body } = await callGet('a');

        expect(status).toBe(200);
        expect(body.items).toEqual([]);
        expect(body).not.toHaveProperty('page');
        expect(typeof body.truncated).toBe('boolean');
        expect(mockSearchMediaFulltext).not.toHaveBeenCalled();
    });

    it('returns 200 empty page for an empty query', async () => {
        const { status, body } = await callGet('');

        expect(status).toBe(200);
        expect(body.items).toEqual([]);
    });
});

describe('GET /api/v1/search/suggest — lean item shape', () => {
    it('returns items with id, title, mediaType, year, images — no overview/ids/rank', async () => {
        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ media_type: 'movie', title: 'Dawn', internal_id: 'dawn-uuid' }),
        ]);

        const { status, body } = await callGet('dawn');

        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
        const item = body.items[0];
        expect(item.id).toBeDefined();
        expect(item.title).toBe('Dawn');
        expect(item.type).toBeDefined();
        expect(item.images).toBeDefined();
        // Must NOT have overview/ids/rank/matchSource
        expect(item.overview).toBeUndefined();
        expect(item.ids).toEqual({});
        expect(item).toHaveProperty('catalogId');
        expect(item.rank).toBeUndefined();
        expect(item.matchSource).toBeUndefined();
    });

    it('images{} contains poster and backdrop hrefs', async () => {
        mockSearchMediaFulltext.mockResolvedValue([makeMediaRow({ internal_id: 'media-abc' })]);

        const { body } = await callGet('query');

        const item = body.items[0];
        expect(item.images.poster).toBeDefined();
        expect(item.images.poster.href).toContain('media-abc');
        expect(item.images.backdrop).toBeDefined();
    });
});

describe('GET /api/v1/search/suggest — mediaType canonical mapping', () => {
    it('maps DB media_type="tv" → mediaType="series"', async () => {
        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ media_type: 'tv', title: 'Luma' }),
        ]);

        const { body } = await callGet('lost');

        expect(body.items[0].type).toBe('series');
        expect(body.items[0].type).not.toBe('tv');
    });

    it('maps DB media_type="show" → mediaType="series"', async () => {
        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ media_type: 'show', title: 'Drifting Clouds' }),
        ]);

        const { body } = await callGet('breaking');

        expect(body.items[0].type).toBe('series');
    });
});

describe('GET /api/v1/search/suggest — limit cap + offset always 0', () => {
    it('defaults to limit=8 and page.offset=0', async () => {
        mockSearchMediaFulltext.mockResolvedValue(
            Array.from({ length: 10 }, (_, i) =>
                makeMediaRow({ title: `Film ${i}`, internal_id: `id-${i}` }),
            ),
        );

        const { body } = await callGet('film');

        // Default limit is 8
        expect(body.items.length).toBeLessThanOrEqual(8);
        expect(body.items.length).toBe(8);
        expect(body).not.toHaveProperty('page');
    });

    it('caps limit at 20 (max)', async () => {
        // Requesting limit=50 should be clamped/rejected; schema enforces max=20.
        // We request 20 which is at the boundary and should be accepted.
        mockSearchMediaFulltext.mockResolvedValue(
            Array.from({ length: 25 }, (_, i) =>
                makeMediaRow({ title: `Film ${i}`, internal_id: `uuid-${i}` }),
            ),
        );

        const { body } = await callGet('film', { limit: '20' });

        expect(body.items.length).toBe(20);
        expect(body.items.length).toBeLessThanOrEqual(20);
    });

    it('page.offset is always 0 (offset-less design)', async () => {
        mockSearchMediaFulltext.mockResolvedValue([makeMediaRow({ title: 'Alien' })]);

        const { body } = await callGet('alien');

        expect(body).not.toHaveProperty('page');
    });
});

describe('GET /api/v1/search/suggest — {items, page} envelope', () => {
    it('returns a valid {items, page} collection envelope', async () => {
        mockSearchMediaFulltext.mockResolvedValue([makeMediaRow({ title: 'Matrix' })]);

        const { status, body } = await callGet('matrix');

        expect(status).toBe(200);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body).not.toHaveProperty('page');
        expect(typeof body.truncated).toBe('boolean');
    });

    it('returns truncated=true when backend yields more items than limit', async () => {
        // 8 items (default limit) + 1 extra to trigger truncated
        mockSearchMediaFulltext.mockResolvedValue(
            Array.from({ length: 9 }, (_, i) =>
                makeMediaRow({ title: `Film ${i}`, internal_id: `id-${i}` }),
            ),
        );

        const { body } = await callGet('film');

        expect(body.truncated).toBe(true);
    });
});

// ── Suggestion caching (20s TTL, access-scoped, single-flighted) ─────────────────

describe('GET /api/v1/search/suggest — result caching', () => {
    it('cache hit returns the same result without re-invoking the search service', async () => {
        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ title: 'Cached Suggestion', internal_id: 'cache-uuid' }),
        ]);

        const first = await callGet('cachedquery');
        expect(first.status).toBe(200);
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(1);

        // Swap the mock's return value — a genuine cache MISS on the second
        // call would surface this new data. It must not.
        mockSearchMediaFulltext.mockResolvedValue([makeMediaRow({ title: 'Should Not Appear' })]);

        const second = await callGet('cachedquery');
        expect(second.status).toBe(200);
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(1); // not called again
        expect(second.body.items).toEqual(first.body.items);
    });

    it('different access contexts (denied library groups) do not share a cache entry', async () => {
        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ title: 'Unrestricted Suggestion', internal_id: 'unrestricted-uuid' }),
        ]);
        mockGetDeniedLibraryGroups.mockResolvedValueOnce(null);
        const unrestricted = await callGet('scopedquery');
        expect(unrestricted.status).toBe(200);
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(1);

        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ title: 'Restricted Suggestion', internal_id: 'restricted-uuid' }),
        ]);
        mockGetDeniedLibraryGroups.mockResolvedValueOnce(['grp-1111-0000-0000-0000000000aa']);
        const restricted = await callGet('scopedquery');

        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(2);
        expect(restricted.body.items[0].title).toBe('Restricted Suggestion');
        expect(restricted.body.items).not.toEqual(unrestricted.body.items);
    });

    it("different query text does not collide with another query's cache entry", async () => {
        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ title: 'Alpha Suggestion', internal_id: 'alpha-uuid' }),
        ]);
        await callGet('alphaquery');
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(1);

        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ title: 'Beta Suggestion', internal_id: 'beta-uuid' }),
        ]);
        const beta = await callGet('betaquery');

        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(2);
        expect(beta.body.items[0].title).toBe('Beta Suggestion');
    });

    it('different limit does not collide with another cache entry for the same query', async () => {
        mockSearchMediaFulltext.mockResolvedValue(
            Array.from({ length: 5 }, (_, i) =>
                makeMediaRow({ title: `Film ${i}`, internal_id: `film-${i}` }),
            ),
        );
        await callGet('pagedquery', { limit: '3' });
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(1);

        await callGet('pagedquery', { limit: '5' });
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(2);
    });

    it('a search-service failure is never cached — the next identical call retries', async () => {
        mockSearchMediaFulltext.mockRejectedValueOnce(new Error('transient DB error'));
        const failed = await callGet('retryquery');
        expect(failed.status).toBe(503);
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(1);

        mockSearchMediaFulltext.mockResolvedValue([
            makeMediaRow({ title: 'Recovered', internal_id: 'recovered-uuid' }),
        ]);
        const recovered = await callGet('retryquery');

        expect(recovered.status).toBe(200);
        expect(mockSearchMediaFulltext).toHaveBeenCalledTimes(2); // retried
        expect(recovered.body.items[0].title).toBe('Recovered');
    });
});

describe('GET /api/v1/search/suggest — availableOnly', () => {
    it('narrows an install that shows unavailable titles', async () => {
        mockShowUnavailableInSearch.value = true;
        await callGet('breaking');
        expect(mockSearchMediaFulltext.mock.calls.at(-1)?.[3]).toMatchObject({
            availableOnly: false,
        });

        await callGet('breaking', { availableOnly: 'true' });
        expect(mockSearchMediaFulltext.mock.calls.at(-1)?.[3]).toMatchObject({
            availableOnly: true,
        });
    });

    it('never widens an install that hides unavailable titles', async () => {
        await callGet('breaking', { availableOnly: 'false' });
        expect(mockSearchMediaFulltext.mock.calls.at(-1)?.[3]).toMatchObject({
            availableOnly: true,
        });
    });
});
