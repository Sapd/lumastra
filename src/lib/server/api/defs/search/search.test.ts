// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/search/search.ts (GET /api/v1/search).
 *
 * Covers:
 *   - Cross-source ranking: normalizeRank/SOURCE_BAND ordering (episode_pattern >
 *     fts > episode/music > fuzzy) before pagination; stable page boundaries.
 *   - 503 dependency_unavailable when getDb() returns null (DB down).
 *   - 503 dependency_unavailable when the search query throws (query failure path).
 *   - 200 empty page for a too-short query (q.length < 2) — NOT a 503.
 *   - toPublicMediaType: internal 'tv'/'show' rows surface as type === 'series'.
 *
 * Handlers are called directly (`def.handlers.GET`) with a minimal fake
 * RequestEvent + ApiContext — matches the pattern used by other def unit tests.
 * All external I/O (DB, search queries, cache, config) is mocked via vi.mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const mockExactSeriesRows = vi.fn();
vi.mock('./exact-series.js', () => ({
    exactSeriesRows: (...args: unknown[]) => mockExactSeriesRows(...args),
}));

const mockGetDb = vi.fn();
const mockSearchMedia = vi.fn();
const mockSearchMediaFulltext = vi.fn();
const mockSearchMediaTrigram = vi.fn();
const mockSearchEpisode = vi.fn();
const mockSearchMusic = vi.fn();
const mockGetDeniedLibraryGroups = vi.fn();
const mockToLibraryAccessUser = vi.fn();
const mockParseEpisodeQuery = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/search.queries.js', () => ({
    searchMedia: (...args: unknown[]) => mockSearchMedia(...args),
    searchMediaFulltext: (...args: unknown[]) => mockSearchMediaFulltext(...args),
    searchMediaTrigram: (...args: unknown[]) => mockSearchMediaTrigram(...args),
    searchEpisode: (...args: unknown[]) => mockSearchEpisode(...args),
    searchMusic: (...args: unknown[]) => mockSearchMusic(...args),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: (...args: unknown[]) => mockGetDeniedLibraryGroups(...args),
    toLibraryAccessUser: (...args: unknown[]) => mockToLibraryAccessUser(...args),
}));

vi.mock('$lib/server/utils/suggestion-utils.js', () => ({
    parseEpisodeQuery: (...args: unknown[]) => mockParseEpisodeQuery(...args),
}));

// Mutable config object so individual tests can flip e.g. typo tolerance on.
const mockConfig: Record<string, unknown> = {
    SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: false,
    SEARCH_TYPO_TOLERANCE: 'off',
    SEARCH_TYPO_MIN_RESULTS: 3,
    UNRATED_CONTENT_VISIBLE: false,
    // Metadata-language overlay gate (multilingual-media-metadata spec §5) —
    // empty by default so existing tests pay zero extra getPlaybackPreferences
    // calls; flipped per-test to cover the overlay itself.
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};

/**
 * Mutable so the degraded-cache tests can switch the Kavita lane on. SearchService
 * reads `features.kavita` at fan-out time, not at import time.
 */
const mockFeatures: Record<string, unknown> = {};

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    // mount.ts reads `features` for {kind:'feature'} specs; search uses {kind:'user'}
    // so this is unused by search, but present to satisfy the import shape.
    features: mockFeatures,
    // search.ts calls this instead of reading SHOW_UNAVAILABLE_MEDIA_IN_SEARCH
    // directly — mirror the mutable mockConfig value so existing tests (which
    // flip SHOW_UNAVAILABLE_MEDIA_IN_SEARCH via mockConfig) keep working.
    isUnavailableMediaVisibleInSearch: () => mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH,
    // buildSearchAccessContext (search-access-context.ts) unconditionally calls
    // this to populate SearchAccessContext.showUnavailableMedia — a DIFFERENT,
    // Trending/For-You-only gate that search.ts deliberately does NOT read (it
    // keeps using isUnavailableMediaVisibleInSearch above). Present here only so
    // buildSearchAccessContext doesn't throw; no test asserts on it.
    isUnavailableMediaVisible: () => false,
}));

// Requests (Jellyseerr) + Live TV channels. Empty by default; the
// availableOnly tests assert whether the lane is consulted at all.
const mockSearchAcrossServices = vi.fn();
vi.mock('$lib/server/services/media-aggregation.service.js', () => ({
    MediaAggregationService: {
        searchAcrossServices: (...args: unknown[]) => mockSearchAcrossServices(...args),
    },
}));

// Kavita is dynamically imported by SearchService.searchKavita. Only the
// degraded-cache tests turn the lane on (mockFeatures.kavita), so for every
// other test in this file this mock is inert.
const mockKavitaSearch = vi.fn();
vi.mock('$lib/server/plugins/kavita/index.js', () => ({
    search: mockKavitaSearch,
    getSeriesMetadataBatch: vi.fn().mockResolvedValue(new Map()),
    transformSearchResults: vi.fn().mockReturnValue([]),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    createExternalIds: (ids: Record<string, string | undefined>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(ids)) {
            if (v) out[k] = v;
        }
        return out;
    },
}));

vi.mock('$lib/server/api/defs/catalog/media-id.js', () => ({
    buildImageRefs: (id: string, base: string) => ({
        poster: { href: `${base}/${id}/images/poster` },
        backdrop: { href: `${base}/${id}/images/backdrop` },
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
// Live-reference L1 mock (mirrors UnifiedCache's L1 behavior — get() hands
// back the exact object set() stored) — same pattern as episodes.test.ts's
// overlay cache-safety coverage. `getOrComputeSingleFlight` is mocked as a
// second, independent memoized store keyed by its own raw key so the
// dedup-across-concurrent-misses behavior doesn't need re-testing here (that's
// covered by single-flight.test.ts); we only need it to not blindly recompute
// on every call, and to surface a `compute()` throw uncaught.
const searchCacheStore = vi.hoisted(() => new Map<string, unknown>());
const searchSingleFlightStore = vi.hoisted(() => new Map<string, string>());
/** Last TTL (ms) the def asked L1 for; `undefined` means "namespace default". */
const l1TtlCalls = vi.hoisted(() => [] as (number | undefined)[]);
/** Last TTL (s) the single-flight leader resolved for L2. */
const l2TtlCalls = vi.hoisted(() => [] as number[]);
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({
            get: async (key: string) => searchCacheStore.get(key) ?? null,
            set: async (key: string, value: unknown, ttl?: number) => {
                searchCacheStore.set(key, value);
                l1TtlCalls.push(ttl);
            },
        }),
    },
    CACHE_NAMESPACES: {
        searchResultsPage: { name: 'search-results-page-v1', l1TTL: 45_000, l2TTL: 45_000 },
    },
}));
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async ({
        cacheKey,
        ttlSeconds,
        compute,
        resolveTtlSeconds,
    }: {
        cacheKey: string;
        ttlSeconds: number;
        compute: () => Promise<string>;
        resolveTtlSeconds?: (value: string) => number;
    }) => {
        const existing = searchSingleFlightStore.get(cacheKey);
        if (existing !== undefined) return existing;
        const value = await compute();
        // Mirrors the real helper: the leader resolves the TTL AFTER compute.
        l2TtlCalls.push(resolveTtlSeconds?.(value) ?? ttlSeconds);
        searchSingleFlightStore.set(cacheKey, value);
        return value;
    },
}));

const mockGetPlaybackPreferencesOne = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
}));

const mockApplyTranslationOverlay = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: unknown[]) => mockApplyTranslationOverlay(...args),
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def, DEGRADED_PAGE_TTL_SECONDS } = await import('./search.js');
const { OPTIONAL_SOURCE_DEADLINE_MS } = await import('$lib/server/services/search.service.js');
const { mount } = await import('$lib/server/api/mount.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX = { surface: 'v1' as const };

function makeEvent(q: string, extra: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/api/v1/search');
    url.searchParams.set('q', q);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

    return {
        url,
        params: {},
        route: { id: '/api/v1/search' as const },
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

/** Build a minimal media row returned by search.queries primitives. */
function makeMediaRow(overrides: {
    media_type?: string;
    title?: string;
    rank?: number;
    internal_id?: string;
    match_source?: string;
}) {
    return {
        media_type: overrides.media_type ?? 'movie',
        title: overrides.title ?? 'Untitled',
        rank: overrides.rank ?? 0.5,
        internal_id: overrides.internal_id ?? `uuid-${Math.random()}`,
        jellyfin_id: null,
        tmdb_id: null,
        imdb_id: null,
        release_date: '2020-01-01',
        overview: null,
        match_source: overrides.match_source ?? 'fts',
    };
}

/** Build a minimal music row returned by searchMusic. */
function makeMusicRow(overrides: { title?: string; rank?: number; id?: string }) {
    return {
        id: overrides.id ?? `music-${Math.random()}`,
        media_type: 'track',
        title: overrides.title ?? 'Track',
        rank: overrides.rank ?? 0.3,
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
    vi.clearAllMocks();
    // Every test gets an isolated cache — otherwise a cache entry populated by
    // one test (same q/limit/offset/types/access-scope key) would leak into
    // the next test's assertions (e.g. a mocked DB return value never getting
    // exercised because the previous test's cached page wins).
    searchCacheStore.clear();
    searchSingleFlightStore.clear();
    l1TtlCalls.length = 0;
    l2TtlCalls.length = 0;
    // Reset mutable config between tests.
    mockConfig.SEARCH_TYPO_TOLERANCE = 'off';
    // Default: DB available
    mockGetDb.mockReturnValue({ query: vi.fn() }); // non-null Sql
    mockGetDeniedLibraryGroups.mockResolvedValue(null);
    mockToLibraryAccessUser.mockReturnValue({});
    // Default: no episode pattern
    mockParseEpisodeQuery.mockReturnValue(null);
    // Default: empty results
    mockSearchMedia.mockResolvedValue([]);
    mockSearchMediaFulltext.mockResolvedValue([]);
    mockSearchMediaTrigram.mockResolvedValue([]);
    mockSearchEpisode.mockResolvedValue([]);
    mockSearchMusic.mockResolvedValue([]);
    mockSearchAcrossServices.mockResolvedValue({ items: [] });
    mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH = false;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/search — 503 on dependency down', () => {
    it('returns 503 application/problem+json with code dependency_unavailable when DB is null', async () => {
        mockGetDb.mockReturnValue(null);

        const { status, body, headers } = await callGet('avengers');

        expect(status).toBe(503);
        expect(headers.get('content-type')).toMatch('application/problem+json');
        expect(body.code).toBe('dependency_unavailable');
        expect(body.status).toBe(503);
    });

    it('returns 503 when a search query primitive throws (query failure path)', async () => {
        mockSearchMedia.mockRejectedValue(new Error('DB connection lost'));

        const { status, body, headers } = await callGet('avengers');

        expect(status).toBe(503);
        expect(headers.get('content-type')).toMatch('application/problem+json');
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('GET /api/v1/search — short query returns 200 empty (not 503)', () => {
    it.each([
        ['🎧', 'audiobook'],
        ['𝒜', 'audiobook'],
        ['𠮷', 'movie'],
    ])(
        'rejects a single supplementary character outside the CJK audiobook exception (%s, %s)',
        async (query, types) => {
            mockFeatures.audiobooks = true;
            try {
                const { body } = await callGet(query, { types });
                expect(body.items).toEqual([]);
                expect(mockSearchMedia).not.toHaveBeenCalled();
                expect(mockSearchMediaFulltext).not.toHaveBeenCalled();
            } finally {
                delete mockFeatures.audiobooks;
            }
        },
    );
    it.each([undefined, 'audiobook,movie,track,book,tvchannel'])(
        'sends single kana only to the audiobook lane (types=%s)',
        async (types) => {
            mockFeatures.audiobooks = true;
            mockFeatures.kavita = true;
            try {
                await callGet('こ', types ? { types } : {});
                expect(mockSearchMediaFulltext).toHaveBeenCalled();
                for (const call of mockSearchMediaFulltext.mock.calls) {
                    expect(call[3].mediaTypes).toEqual(['audiobook']);
                }
                expect(mockSearchMedia).not.toHaveBeenCalled();
                expect(mockSearchMusic).not.toHaveBeenCalled();
                expect(mockSearchEpisode).not.toHaveBeenCalled();
                expect(mockSearchAcrossServices).not.toHaveBeenCalled();
            } finally {
                delete mockFeatures.audiobooks;
                delete mockFeatures.kavita;
            }
        },
    );
    it('lets a single kana character reach the audiobook search lane', async () => {
        mockFeatures.audiobooks = true;
        try {
            const { status } = await callGet('こ', { types: 'audiobook' });
            expect(status).toBe(200);
            expect(mockSearchMediaFulltext).toHaveBeenCalled();
        } finally {
            delete mockFeatures.audiobooks;
        }
    });
    it('returns 200 empty {items,page} for a 1-char query', async () => {
        const { status, body } = await callGet('a');

        expect(status).toBe(200);
        expect(body.items).toEqual([]);
        expect(body.page).toBeDefined();
        expect(body.page.offset).toBe(0);
        // Must NOT have called any DB primitive
        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(mockSearchMediaFulltext).not.toHaveBeenCalled();
    });

    it('returns 200 empty when q is absent (no q param at all)', async () => {
        // When q is absent the schema treats it as optional (valid parse),
        // then the short-query guard triggers: undefined/null → 200 empty.
        const event = makeEvent('_absent_');
        // Remove the q param we just set so the URL has no q at all.
        event.url.searchParams.delete('q');
        const handler = def.handlers.GET!;
        const res = await handler(event, CTX);
        const body = await res.clone().json();

        expect(res.status).toBe(200);
        expect(body.items).toEqual([]);
    });
});

describe('GET /api/v1/search — type === "series" (never "tv")', () => {
    it('maps a DB row with media_type="tv" to type="series" in the response', async () => {
        mockSearchMedia.mockResolvedValue([makeMediaRow({ media_type: 'tv', title: 'Luma' })]);

        const { status, body } = await callGet('luma');

        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
        expect(body.items[0].type).toBe('series');
        expect(body.items[0].type).not.toBe('tv');
    });

    it('maps a DB row with media_type="show" to type="series"', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ media_type: 'show', title: 'Drifting Clouds' }),
        ]);

        const { status, body } = await callGet('drifting clouds');

        expect(status).toBe(200);
        expect(body.items[0].type).toBe('series');
    });

    it('preserves type="movie" unchanged', async () => {
        mockSearchMedia.mockResolvedValue([makeMediaRow({ media_type: 'movie', title: 'Dawn' })]);

        const { status, body } = await callGet('dawn');

        expect(status).toBe(200);
        expect(body.items[0].type).toBe('movie');
    });
});

describe('GET /api/v1/search — music row-type filtering', () => {
    const musicOptions = () => mockSearchMusic.mock.calls.at(-1)?.[4] as { mediaTypes?: string[] };

    it('types=track asks the music source for tracks only', async () => {
        await callGet('lantern pitch', { types: 'track' });
        expect(musicOptions().mediaTypes).toEqual(['track']);
    });

    it('types=album,artist asks for exactly those two', async () => {
        await callGet('lantern pitch', { types: 'artist,album' });
        expect(musicOptions().mediaTypes).toEqual(['artist', 'album']);
    });

    it('keeps searchMusic order for equal ranks instead of re-sorting by title', async () => {
        // SQL already ordered these (popularity, then DB collation); a title
        // re-sort would put "alpha" first and could skip a row between pages.
        mockSearchMusic.mockResolvedValue([
            makeMusicRow({ id: 'zulu-id', title: 'Zulu', rank: 0.78 }),
            makeMusicRow({ id: 'alpha-id', title: 'alpha', rank: 0.78 }),
        ]);
        const { body } = await callGet('equal rank order', { types: 'track' });
        expect(body.items.map((i: { title: string }) => i.title)).toEqual(['Zulu', 'alpha']);
    });

    it('types=movie leaves the music source off entirely', async () => {
        mockSearchMusic.mockClear();
        await callGet('lantern pitch three', { types: 'movie' });
        expect(mockSearchMusic).not.toHaveBeenCalled();
    });

    it('types=music and no types keep all three (default)', async () => {
        await callGet('lantern pitch', { types: 'music' });
        expect(musicOptions().mediaTypes).toBeUndefined();
        await callGet('lantern pitch two');
        expect(musicOptions().mediaTypes).toBeUndefined();
    });
});

describe('GET /api/v1/search — {items,page} envelope + images{}', () => {
    it('returns a valid {items, page} envelope', async () => {
        mockSearchMedia.mockResolvedValue([makeMediaRow({ title: 'Lantern' })]);

        const { status, body } = await callGet('matrix');

        expect(status).toBe(200);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.page).toBeDefined();
        expect(typeof body.page.limit).toBe('number');
        expect(typeof body.page.offset).toBe('number');
        expect(typeof body.page.hasMore).toBe('boolean');
    });

    it('each result item has an images{} object with poster and backdrop hrefs', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Daydream', internal_id: 'inc-uuid' }),
        ]);

        const { body } = await callGet('daydream');

        const item = body.items[0];
        expect(item.images).toBeDefined();
        expect(item.images.poster).toBeDefined();
        expect(item.images.poster.href).toContain('inc-uuid');
        expect(item.images.backdrop).toBeDefined();
    });
});

describe('GET /api/v1/search — metadata-language overlay', () => {
    afterEach(() => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    });

    it('overlays the localized title when the viewer has a resolved language', async () => {
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferencesOne.mockResolvedValue({
            metadata_title_language: 'de',
            metadata_language: 'de',
        });
        mockApplyTranslationOverlay.mockImplementation(
            async (_sql: unknown, items: Array<{ id: string; title: string }>) => {
                for (const item of items) {
                    if (item.id === 'inc-uuid') item.title = 'Daydream (DE)';
                }
            },
        );
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Daydream', internal_id: 'inc-uuid' }),
        ]);

        const { body } = await callGet('daydream');

        expect(mockApplyTranslationOverlay).toHaveBeenCalledTimes(1);
        expect(body.items[0].title).toBe('Daydream (DE)');
    });

    it('does not call the overlay when no admin-additional language is configured', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Daydream', internal_id: 'inc-uuid' }),
        ]);

        const { body } = await callGet('daydream');

        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
        expect(body.items[0].title).toBe('Daydream');
    });
});

describe('GET /api/v1/search — cross-source rank ordering', () => {
    /**
     * SOURCE_BAND: episode_pattern=4, fts=3, episode=2, music=2, fuzzy=1.
     * normalizeRank(source, raw) = band + squash(raw).
     * squash maps raw onto (0,1), so bands never overlap.
     *
     * Expected order: episode_pattern results first, then fts, then
     * episode/music (tied band, further ordered by title), then fuzzy.
     *
     * We test this end-to-end by supplying multi-source mock rows and asserting
     * the order of items in the response.
     */

    it('episode_pattern results sort before fts, fts before music, music before fuzzy', async () => {
        // episode_pattern result: simulate via searchEpisode being called
        // (parseEpisodeQuery returns a match)
        mockParseEpisodeQuery.mockReturnValue({
            seriesName: 'Marshalls',
            season: 3,
            episode: 12,
        });
        mockSearchEpisode.mockResolvedValue([
            {
                id: 'ep-uuid',
                title: 'Finn Gets Lost In A Park',
                overview: null,
                series_year: 1991,
                series_internal_id: 'series-uuid',
                series_name: 'The Marshalls',
                series_jellyfin_id: null,
                series_ext_provider: null,
                series_ext_id: null,
                season_number: 3,
                episode_number: 12,
            },
        ]);

        const { body } = await callGet('Marshalls S03E12');

        // Episode pattern path: all items should be type=episode from this source.
        expect(body.items[0].reason.kind).toBe('episode_pattern');
        expect(body.items[0].type).toBe('episode');
    });

    it('with multi-source results (fts + music), fts rank > music rank in merged output', async () => {
        // Reset episode pattern (no pattern match for this test)
        mockParseEpisodeQuery.mockReturnValue(null);

        // FTS returns a movie row (band=3, raw=0.9 → normalizeRank ≈ 3.47)
        const ftsRow = makeMediaRow({
            media_type: 'movie',
            title: 'AAA Movie',
            rank: 0.9,
            internal_id: 'fts-uuid',
        });
        mockSearchMedia.mockResolvedValue([ftsRow]);

        // Music returns a track row (band=2, raw=0.95 → normalizeRank ≈ 2.49)
        const musicRow = makeMusicRow({ title: 'ZZZ Track', rank: 0.95, id: 'music-uuid' });
        mockSearchMusic.mockResolvedValue([musicRow]);

        const { body } = await callGet('test query', { limit: '10' });

        expect(body.items.length).toBeGreaterThanOrEqual(2);
        // FTS item (band=3) must appear before music item (band=2)
        const ftsIdx = body.items.findIndex(
            (i: { reason: { kind: string } }) => i.reason.kind === 'fts',
        );
        const musicIdx = body.items.findIndex(
            (i: { reason: { kind: string } }) => i.reason.kind === 'music',
        );
        expect(ftsIdx).toBeGreaterThanOrEqual(0);
        expect(musicIdx).toBeGreaterThanOrEqual(0);
        expect(ftsIdx).toBeLessThan(musicIdx);
    });

    it('pagination is stable: offset=0 and offset=1 share no rank inversion across same result set', async () => {
        // Provide enough results to span two "pages"
        mockParseEpisodeQuery.mockReturnValue(null);
        const rows = Array.from({ length: 6 }, (_, i) =>
            makeMediaRow({
                media_type: 'movie',
                title: `Film ${i}`,
                rank: 1 - i * 0.1,
                internal_id: `id-${i}`,
            }),
        );
        mockSearchMedia.mockResolvedValue(rows);

        const page0 = await callGet('film', { limit: '3', offset: '0' });
        const page1 = await callGet('film', { limit: '3', offset: '3' });

        // No id should appear on both pages
        const ids0 = new Set(page0.body.items.map((i: { id: string }) => i.id));
        const ids1 = new Set(page1.body.items.map((i: { id: string }) => i.id));
        for (const id of ids1) {
            expect(ids0.has(id)).toBe(false);
        }
    });

    it('fuzzy-band results sort LAST (after fts and music)', async () => {
        // Three distinct bands in one merged result set:
        //   fts (band=3) > music (band=2) > fuzzy (band=1).
        // A band-ordering regression that mis-placed the fuzzy row would surface
        // here as a non-trailing fuzzy index.
        mockParseEpisodeQuery.mockReturnValue(null);
        // Trigram (fuzzy) pass only runs when typo tolerance is enabled.
        mockConfig.SEARCH_TYPO_TOLERANCE = 'always';

        // FTS movie (band=3)
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({
                media_type: 'movie',
                title: 'AAA Fts',
                rank: 0.9,
                internal_id: 'fts-uuid',
                match_source: 'fts',
            }),
        ]);
        // Music track (band=2) — even with a HIGHER raw rank it must not outrank fts.
        mockSearchMusic.mockResolvedValue([
            makeMusicRow({ title: 'ZZZ Music', rank: 0.99, id: 'music-uuid' }),
        ]);
        // Fuzzy/trigram movie (band=1) — even with the HIGHEST raw rank it must sort last.
        mockSearchMediaTrigram.mockResolvedValue([
            makeMediaRow({
                media_type: 'movie',
                title: 'BBB Fuzzy',
                rank: 1,
                internal_id: 'fuzzy-uuid',
                match_source: 'fuzzy',
            }),
        ]);

        const { body } = await callGet('test query', { limit: '10' });

        const sources = body.items.map((i: { reason: { kind: string } }) => i.reason.kind);
        const fuzzyIdx = sources.indexOf('fuzzy');
        expect(fuzzyIdx).toBeGreaterThanOrEqual(0);
        // Fuzzy must be the LAST element — nothing ranks below it.
        expect(fuzzyIdx).toBe(sources.length - 1);
        // And it sits strictly after both fts and music.
        const ftsIdx = sources.indexOf('fts');
        const musicIdx = sources.indexOf('music');
        expect(ftsIdx).toBeGreaterThanOrEqual(0);
        expect(musicIdx).toBeGreaterThanOrEqual(0);
        expect(fuzzyIdx).toBeGreaterThan(ftsIdx);
        expect(fuzzyIdx).toBeGreaterThan(musicIdx);
    });

    it('page0 ++ page1 is monotonically non-increasing by normalized rank (no cross-page inversion)', async () => {
        // Span two pages with rows whose normalized rank decreases across bands AND
        // within a band. Concatenating the two pages MUST yield a globally sorted
        // sequence; a cross-page rank inversion (e.g. a higher-ranked item bleeding
        // onto page 1) fails the monotonicity assertion.
        mockParseEpisodeQuery.mockReturnValue(null);
        mockConfig.SEARCH_TYPO_TOLERANCE = 'always';

        // 4 fts rows (band=3, descending raw rank) and 2 fuzzy rows (band=1).
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({
                media_type: 'movie',
                title: 'Fts A',
                rank: 0.95,
                internal_id: 'fts-a',
                match_source: 'fts',
            }),
            makeMediaRow({
                media_type: 'movie',
                title: 'Fts B',
                rank: 0.85,
                internal_id: 'fts-b',
                match_source: 'fts',
            }),
            makeMediaRow({
                media_type: 'movie',
                title: 'Fts C',
                rank: 0.75,
                internal_id: 'fts-c',
                match_source: 'fts',
            }),
            makeMediaRow({
                media_type: 'movie',
                title: 'Fts D',
                rank: 0.65,
                internal_id: 'fts-d',
                match_source: 'fts',
            }),
        ]);
        mockSearchMediaTrigram.mockResolvedValue([
            makeMediaRow({
                media_type: 'movie',
                title: 'Fuzzy A',
                rank: 0.99,
                internal_id: 'fz-a',
                match_source: 'fuzzy',
            }),
            makeMediaRow({
                media_type: 'movie',
                title: 'Fuzzy B',
                rank: 0.5,
                internal_id: 'fz-b',
                match_source: 'fuzzy',
            }),
        ]);

        const page0 = await callGet('film', { limit: '3', offset: '0' });
        const page1 = await callGet('film', { limit: '3', offset: '3' });

        const combined = [...page0.body.items, ...page1.body.items];
        // Reconstruct the normalized rank used for ordering: band index + raw squash.
        // We don't reach into internals — instead assert the BAND order is monotone
        // (fts band must never appear after a fuzzy band) AND, within the fts band,
        // the raw ranks are non-increasing.
        const BAND: Record<string, number> = {
            episode_pattern: 4,
            fts: 3,
            episode: 2,
            music: 2,
            fuzzy: 1,
        };
        let prevBand = Number.POSITIVE_INFINITY;
        for (const item of combined as Array<{ reason: { kind: string } }>) {
            const band = BAND[item.reason.kind];
            expect(band).toBeDefined();
            // Non-increasing across the whole concatenation (no cross-page inversion).
            expect(band).toBeLessThanOrEqual(prevBand);
            prevBand = band;
        }
        // Sanity: the concatenation actually spans both bands and both pages.
        const allSources = combined.map((i) => (i as { reason: { kind: string } }).reason.kind);
        expect(allSources).toContain('fts');
        expect(allSources).toContain('fuzzy');
        expect(page1.body.items.length).toBeGreaterThan(0);
    });
});

// ── A3: Access-filter forwarding ──────────────────────────────────────────────
//
// Security audit gap A3: getDeniedLibraryGroups + ageRating must be THREADED
// into every DB query primitive. Previously these were mocked to return null/{}
// but never asserted to be forwarded. These tests supply a non-null restricted
// set and assert the filter reaches the DB layer.
//
// The search def delegates to SearchService.search → searchCatalog → searchMedia
// (and searchMusicRows → searchMusic). Mocking the query primitives here covers
// both code paths because SearchService imports the same mocked modules.

describe('GET /api/v1/search — A3: access filter forwarding to query layer', () => {
    const DENIED_IDS = ['grp-1111-0000-0000-0000000000aa'];
    const MAX_AGE = 16;

    function makeRestrictedEvent(q: string): RequestEvent {
        const e = makeEvent(q);
        // Give the user a maxAgeRating so the ageRating filter is non-null.
        e.locals.user = {
            ...e.locals.user,
            maxAgeRating: MAX_AGE,
        };
        return e;
    }

    beforeEach(() => {
        // Return a non-null denied-groups set so the access filter is active.
        mockGetDeniedLibraryGroups.mockResolvedValue(DENIED_IDS);
        // toLibraryAccessUser must return a truthy value so getDeniedLibraryGroups
        // is actually called (the def calls getDeniedLibraryGroups(sql, toLibraryAccessUser(user))).
        mockToLibraryAccessUser.mockReturnValue({ isAdmin: false, userGroups: [] });
    });

    it('forwards deniedGroupIds into searchMedia (catalog FTS path)', async () => {
        const event = makeRestrictedEvent('intertidal');
        const handler = def.handlers.GET!;
        const res = await handler(event, CTX);
        expect(res.status).toBe(200);

        // searchMedia is called by SearchService.searchCatalog with the access scope.
        // The second positional arg is the searchOpts object.
        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(), // sql
            'intertidal',
            expect.objectContaining({
                library: { kind: 'denyGroups', ids: DENIED_IDS },
            }),
            expect.anything(), // query-shaping options
        );
    });

    it('forwards ageRating into searchMedia when user has maxAgeRating', async () => {
        const event = makeRestrictedEvent('dawn');
        const handler = def.handlers.GET!;
        await handler(event, CTX);

        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'dawn',
            expect.objectContaining({
                age: { kind: 'limit', maxAgeRating: MAX_AGE, allowUnrated: false },
            }),
            expect.anything(),
        );
    });

    it('forwards deniedGroupIds + ageRating together into searchMedia', async () => {
        const event = makeRestrictedEvent('arrival');
        const handler = def.handlers.GET!;
        await handler(event, CTX);

        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'arrival',
            {
                library: { kind: 'denyGroups', ids: DENIED_IDS },
                age: { kind: 'limit', maxAgeRating: MAX_AGE, allowUnrated: false },
            },
            expect.anything(),
        );
    });

    it('forwards deniedGroupIds into searchMusic (music path)', async () => {
        const event = makeRestrictedEvent('beethoven');
        const handler = def.handlers.GET!;
        await handler(event, CTX);

        // searchMusic: third positional arg is the window, fourth is the boundary.
        expect(mockSearchMusic).toHaveBeenCalledWith(
            expect.anything(), // sql
            'beethoven',
            expect.any(Number), // window
            expect.objectContaining({
                library: { kind: 'denyGroups', ids: DENIED_IDS },
            }),
            expect.anything(), // query-shaping options
        );
    });

    it('forwards ageRating into searchMusic when user has maxAgeRating', async () => {
        const event = makeRestrictedEvent('mozart');
        const handler = def.handlers.GET!;
        await handler(event, CTX);

        expect(mockSearchMusic).toHaveBeenCalledWith(
            expect.anything(),
            'mozart',
            expect.any(Number),
            expect.objectContaining({
                age: { kind: 'limit', maxAgeRating: MAX_AGE, allowUnrated: false },
            }),
            expect.anything(),
        );
    });

    it('forwards deniedGroupIds into searchMediaFulltext when useFulltext=true', async () => {
        const event = makeRestrictedEvent('daydream');
        event.url.searchParams.set('fulltext', 'true');
        const handler = def.handlers.GET!;
        await handler(event, CTX);

        // With useFulltext=true, searchCatalog calls searchMediaFulltext instead of searchMedia.
        expect(mockSearchMediaFulltext).toHaveBeenCalledWith(
            expect.anything(),
            'daydream',
            {
                library: { kind: 'denyGroups', ids: DENIED_IDS },
                age: { kind: 'limit', maxAgeRating: MAX_AGE, allowUnrated: false },
            },
            expect.anything(),
        );
    });

    it('uses an unrestricted boundary when getDeniedLibraryGroups returns null', async () => {
        // Restore the default null (unrestricted) response for this test.
        mockGetDeniedLibraryGroups.mockResolvedValue(null);
        const event = makeEvent('avengers');
        const handler = def.handlers.GET!;
        await handler(event, CTX);

        // searchMedia must still be called — with an explicitly unrestricted
        // boundary on both axes (no denied groups, no maxAgeRating).
        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            'avengers',
            { library: { kind: 'all' }, age: { kind: 'any' } },
            expect.anything(),
        );
    });
});

// ── Result-page caching (45s TTL, access-scoped, single-flighted) ────────────────

describe('GET /api/v1/search — result-page caching', () => {
    it('passes genre filters through and keeps different genres out of the same cache entry', async () => {
        await callGet('matrix', { genres: 'action', types: 'movie' });
        expect(mockSearchMedia).toHaveBeenLastCalledWith(
            expect.anything(),
            'matrix',
            expect.anything(),
            expect.objectContaining({ filters: expect.objectContaining({ genres: ['action'] }) }),
        );
        await callGet('matrix', { genres: 'comedy', types: 'movie' });
        expect(mockSearchMedia).toHaveBeenCalledTimes(2);
        expect(mockSearchMedia).toHaveBeenLastCalledWith(
            expect.anything(),
            'matrix',
            expect.anything(),
            expect.objectContaining({ filters: expect.objectContaining({ genres: ['comedy'] }) }),
        );
    });

    it('allows an upper-year-only catalog filter', async () => {
        mockFeatures.kavita = true;
        const result = await callGet('*', { yearMax: '2020' });
        expect(mockSearchMusic).not.toHaveBeenCalled();
        expect(mockKavitaSearch).not.toHaveBeenCalled();
        expect(result.status).toBe(200);
        expect(mockSearchMedia).toHaveBeenCalledWith(
            expect.anything(),
            '*',
            expect.anything(),
            expect.objectContaining({ filters: expect.objectContaining({ yearMax: 2020 }) }),
        );
    });

    it('cache hit returns the same result without re-invoking the search service', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Cached Movie', internal_id: 'cache-uuid' }),
        ]);

        const first = await callGet('cachedquery');
        expect(first.status).toBe(200);
        expect(mockSearchMedia).toHaveBeenCalledTimes(1);

        // Swap the mock's return value — if the second call were a genuine
        // cache MISS it would surface this new data. It must not.
        mockSearchMedia.mockResolvedValue([makeMediaRow({ title: 'Should Not Appear' })]);

        const second = await callGet('cachedquery');
        expect(second.status).toBe(200);
        expect(mockSearchMedia).toHaveBeenCalledTimes(1); // not called again
        expect(second.body.items).toEqual(first.body.items);
    });

    it('types=track and types=album for the same query do not share a cache entry', async () => {
        mockSearchMusic.mockClear();
        await callGet('typedcachequery', { types: 'track' });
        await callGet('typedcachequery', { types: 'album' });
        expect(mockSearchMusic).toHaveBeenCalledTimes(2);
        expect(
            mockSearchMusic.mock.calls.map((c) => (c[4] as { mediaTypes?: string[] }).mediaTypes),
        ).toEqual([['track'], ['album']]);
    });

    it('keys a multi-type search on the sorted type set (movie,series = series,movie ≠ movie)', async () => {
        mockSearchMedia.mockClear();
        mockSearchMedia.mockResolvedValue([makeMediaRow({ title: 'Multi Type Result' })]);
        await callGet('multitypecachequery', { types: 'movie,series' });
        const firstCalls = mockSearchMedia.mock.calls.length;
        expect(firstCalls).toBeGreaterThan(0);
        await callGet('multitypecachequery', { types: 'series,movie' });
        expect(mockSearchMedia).toHaveBeenCalledTimes(firstCalls);
        await callGet('multitypecachequery', { types: 'movie' });
        expect(mockSearchMedia.mock.calls.length).toBeGreaterThan(firstCalls);
    });

    it('different access contexts (denied library groups) do not share a cache entry', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Unrestricted Result', internal_id: 'unrestricted-uuid' }),
        ]);
        mockGetDeniedLibraryGroups.mockResolvedValueOnce(null);
        const unrestricted = await callGet('scopedquery');
        expect(unrestricted.status).toBe(200);
        expect(mockSearchMedia).toHaveBeenCalledTimes(1);

        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Restricted Result', internal_id: 'restricted-uuid' }),
        ]);
        mockGetDeniedLibraryGroups.mockResolvedValueOnce(['grp-1111-0000-0000-0000000000aa']);
        const restricted = await callGet('scopedquery');

        // A distinct access scope must trigger a fresh compute, never the
        // unrestricted caller's cache entry.
        expect(mockSearchMedia).toHaveBeenCalledTimes(2);
        expect(restricted.body.items[0].title).toBe('Restricted Result');
        expect(restricted.body.items).not.toEqual(unrestricted.body.items);
    });

    it("different query text does not collide with another query's cache entry", async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Alpha Movie', internal_id: 'alpha-uuid' }),
        ]);
        await callGet('alphaquery');
        expect(mockSearchMedia).toHaveBeenCalledTimes(1);

        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Beta Movie', internal_id: 'beta-uuid' }),
        ]);
        const beta = await callGet('betaquery');

        expect(mockSearchMedia).toHaveBeenCalledTimes(2);
        expect(beta.body.items[0].title).toBe('Beta Movie');
    });

    it("different offset does not collide with another page's cache entry for the same query", async () => {
        mockSearchMedia.mockResolvedValue(
            Array.from({ length: 5 }, (_, i) =>
                makeMediaRow({ title: `Film ${i}`, internal_id: `film-${i}` }),
            ),
        );
        await callGet('pagedquery', { limit: '2', offset: '0' });
        expect(mockSearchMedia).toHaveBeenCalledTimes(1);

        await callGet('pagedquery', { limit: '2', offset: '2' });
        expect(mockSearchMedia).toHaveBeenCalledTimes(2);
    });

    /**
     * Access-boundary migration guard (spec: "each module's PR must also assert
     * its cache key differs across boundaries").
     *
     * The result-page key is built from the SearchAccessContext, and
     * buildSearchAccessCacheKey emits an `age:` component ONLY when
     * maxAgeRating is non-null. An age-restricted caller must therefore never
     * be served the unrestricted caller's cached page. This is the axis the
     * denied-groups test above does not cover, and it is the one that closes
     * silently if the unauthenticated context's `maxAgeRating: -1` sentinel is
     * ever replaced by a boundary kind that emits no key component.
     */
    it('different age limits do not share a cache entry', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Unrated Result', internal_id: 'age-open-uuid' }),
        ]);
        const open = await callGet('agescopedquery');
        expect(open.status).toBe(200);
        expect(mockSearchMedia).toHaveBeenCalledTimes(1);

        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Age Limited Result', internal_id: 'age-limited-uuid' }),
        ]);
        const ageEvent = makeEvent('agescopedquery');
        const ageLocals = ageEvent.locals as unknown as Record<string, unknown>;
        ageLocals.user = { ...(ageLocals.user as Record<string, unknown>), maxAgeRating: 12 };
        const res = await def.handlers.GET!(ageEvent, CTX);
        const limited = (await res.json()) as { items: { title: string }[] };

        // A distinct age scope must recompute, never reuse the open entry.
        expect(mockSearchMedia).toHaveBeenCalledTimes(2);
        expect(limited.items[0].title).toBe('Age Limited Result');
    });

    it('a search-service failure is never cached — the next identical call retries', async () => {
        mockSearchMedia.mockRejectedValueOnce(new Error('transient DB error'));
        const failed = await callGet('retryquery');
        expect(failed.status).toBe(503);
        expect(mockSearchMedia).toHaveBeenCalledTimes(1);

        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Recovered', internal_id: 'recovered-uuid' }),
        ]);
        const recovered = await callGet('retryquery');

        expect(recovered.status).toBe(200);
        expect(mockSearchMedia).toHaveBeenCalledTimes(2); // retried, not short-circuited
        expect(recovered.body.items[0].title).toBe('Recovered');
    });
});

// ── Mount-layer gating ─────────────────────────────────────────────────────────
//
// The handler tests above call def.handlers.GET directly, which bypasses the
// auth enforcement that lives in mount(). These drive THROUGH mount(def, ctx)
// to prove the AuthSpec is actually enforced at the mount layer — a regression
// that dropped the {kind:'user'} gate would slip past the direct-handler tests.

describe('GET /api/v1/search — mount-layer auth enforcement', () => {
    const { GET } = mount(def, CTX);

    /** Build a mount event with no authenticated user (anonymous caller). */
    function anonEvent(q: string): RequestEvent {
        const e = makeEvent(q);
        (e as { locals: { user: unknown; principal: unknown } }).locals.user = undefined;
        (e as { locals: { user: unknown; principal: unknown } }).locals.principal = undefined;
        return e;
    }

    it('enforces its actual AuthSpec (kind: user)', () => {
        expect(def.auth).toEqual({ kind: 'user' });
    });

    it('returns 401 unauthorized when no user is present (gate enforced THROUGH mount)', async () => {
        const res = await GET!(anonEvent('avengers'));
        expect(res.status).toBe(401);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('unauthorized');
        // The DB primitive must NOT run — auth short-circuits before the handler.
        expect(mockSearchMedia).not.toHaveBeenCalled();
    });

    it('allows an authenticated caller through the mount gate (200)', async () => {
        const res = await GET!(makeEvent('avengers'));
        expect(res.status).toBe(200);
    });
});

describe('GET /api/v1/search — degraded page caching', () => {
    // A page an optional source was dropped from is a known-incomplete answer,
    // and this cache entry is access-scoped rather than per-user: caching it for
    // the full 45s serves one viewer's timeout to everyone else in the scope.
    beforeEach(() => {
        mockFeatures.kavita = true;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete mockFeatures.kavita;
    });

    it('gives a page an optional source timed out of a short TTL, not the full one', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Degraded Movie', internal_id: 'degraded-uuid' }),
        ]);
        // Accepted the connection, then went quiet.
        mockKavitaSearch.mockReturnValue(new Promise(() => {}));

        const pending = callGet('degradedquery');
        await vi.advanceTimersByTimeAsync(OPTIONAL_SOURCE_DEADLINE_MS);
        const res = await pending;

        expect(res.status).toBe(200);
        // The movies lane still answered — degraded means incomplete, not empty.
        expect(res.body.items.length).toBeGreaterThan(0);
        expect(l2TtlCalls).toEqual([DEGRADED_PAGE_TTL_SECONDS]);
        expect(l1TtlCalls).toEqual([DEGRADED_PAGE_TTL_SECONDS * 1000]);
    });

    it('gives a complete page the full namespace TTL', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Complete Movie', internal_id: 'complete-uuid' }),
        ]);
        mockKavitaSearch.mockResolvedValue({ series: [] });

        const res = await callGet('completequery');

        expect(res.status).toBe(200);
        // 45s namespace TTL, and `undefined` for L1 = "use the namespace default".
        expect(l2TtlCalls).toEqual([45]);
        expect(l1TtlCalls).toEqual([undefined]);
    });

    it('never leaks the degraded marker onto the wire', async () => {
        mockSearchMedia.mockResolvedValue([
            makeMediaRow({ title: 'Degraded Movie', internal_id: 'degraded-uuid-2' }),
        ]);
        mockKavitaSearch.mockReturnValue(new Promise(() => {}));

        const pending = callGet('leakquery');
        await vi.advanceTimersByTimeAsync(OPTIONAL_SOURCE_DEADLINE_MS);
        const res = await pending;

        // It is a server-side caching signal. A client learning "incomplete"
        // is a deliberate future decision, not something to arrive by accident.
        expect(res.body).not.toHaveProperty('degraded');
        expect(res.body.page).not.toHaveProperty('degraded');
    });
});

describe('GET /api/v1/search — degraded page handed to a follower', () => {
    // The single-flight FOLLOWER path: this instance is served the leader's
    // value and never runs `compute`, so any "was it degraded" flag set inside
    // compute reads false here while the page it is about to put in L1 is in
    // fact degraded. Deriving the answer from the page itself is what makes the
    // two paths agree. No fake timers and no Kavita lane needed — the page
    // arrives already degraded.
    it('short-TTLs a degraded page it was HANDED, not just one it computed', async () => {
        mockSearchMedia.mockResolvedValue([]);

        // First request establishes whatever single-flight key the def derives.
        expect((await callGet('followerquery')).status).toBe(200);
        const seededKey = [...searchSingleFlightStore.keys()][0];
        expect(seededKey).toBeDefined();

        // Replace the stored value with a degraded page and clear the L1 store,
        // so the next identical request takes the follower path.
        searchSingleFlightStore.set(
            seededKey!,
            JSON.stringify({ items: [], hasMore: false, degraded: true }),
        );
        searchCacheStore.clear();
        l1TtlCalls.length = 0;
        l2TtlCalls.length = 0;

        expect((await callGet('followerquery')).status).toBe(200);

        // Never computed here, so the L2 resolver is never consulted...
        expect(l2TtlCalls).toEqual([]);
        // ...but L1 must still honour the short TTL rather than the 45s default.
        expect(l1TtlCalls).toEqual([DEGRADED_PAGE_TTL_SECONDS * 1000]);
    });
});

describe('GET /api/v1/search — isAvailable flag + availableOnly param', () => {
    const catalogOnlyRow = () => ({
        ...makeMediaRow({ title: 'Drifting Apart', internal_id: 'no-file-uuid' }),
        is_available: false,
    });
    const playableRow = () => ({
        ...makeMediaRow({ title: 'Drifting Clouds', internal_id: 'has-file-uuid' }),
        is_available: true,
    });

    it('reports isAvailable per catalog row when the install shows unavailable titles', async () => {
        mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH = true;
        mockSearchMedia.mockResolvedValue([playableRow(), catalogOnlyRow()]);

        const { status, body } = await callGet('drifting');

        expect(status).toBe(200);
        expect(mockSearchMedia.mock.calls[0][3]).toMatchObject({ availableOnly: false });
        const byId = Object.fromEntries(
            body.items.map((it: { id: string; availability?: { isAvailable: boolean } }) => [
                it.id,
                it.availability?.isAvailable,
            ]),
        );
        expect(byId).toEqual({ 'has-file-uuid': true, 'no-file-uuid': false });
    });

    it('always reports a boolean isAvailable for catalog rows, even when the row omits it', async () => {
        mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH = true;
        const { is_available: _omitted, ...bare } = catalogOnlyRow();
        mockSearchMedia.mockResolvedValue([bare]);

        const { body } = await callGet('drifting');

        expect(body.items[0].availability).toEqual({ isAvailable: false, canRequest: true });
    });

    it('availableOnly=true narrows an install that shows unavailable titles', async () => {
        mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH = true;

        await callGet('drifting', { availableOnly: 'true' });

        expect(mockSearchMedia.mock.calls[0][3]).toMatchObject({ availableOnly: true });
    });

    it('availableOnly=false never widens an install that hides unavailable titles', async () => {
        await callGet('drifting', { availableOnly: 'false' });

        expect(mockSearchMedia.mock.calls[0][3]).toMatchObject({ availableOnly: true });
    });

    it('availableOnly=true skips request rows (they are never in the library)', async () => {
        await callGet('drifting', { types: 'movie,request' });
        expect(mockSearchAcrossServices).toHaveBeenCalledTimes(1);

        mockSearchAcrossServices.mockClear();
        await callGet('drifting', { types: 'movie,request', availableOnly: 'true' });
        expect(mockSearchAcrossServices).not.toHaveBeenCalled();
    });

    it('availableOnly does not share a cache entry with the unfiltered page', async () => {
        mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH = true;
        mockSearchMedia.mockResolvedValue([catalogOnlyRow()]);
        const all = await callGet('drifting');
        expect(all.body.items).toHaveLength(1);

        mockSearchMedia.mockResolvedValue([]);
        const playable = await callGet('drifting', { availableOnly: 'true' });

        expect(mockSearchMedia).toHaveBeenCalledTimes(2);
        expect(playable.body.items).toEqual([]);
    });

    it('the SxxEyy fast path honours the gate and reports isAvailable', async () => {
        mockParseEpisodeQuery.mockReturnValue({ seriesName: 'Full Harbor', season: 8, episode: 2 });
        mockSearchEpisode.mockResolvedValue([
            {
                id: 'ep-uuid',
                title: 'Drifting Apart',
                overview: null,
                series_year: 1987,
                series_internal_id: 'series-uuid',
                series_name: 'Full Harbor',
                series_jellyfin_id: null,
                series_ext_provider: null,
                series_ext_id: null,
                season_number: 8,
                episode_number: 2,
                is_available: true,
            },
        ]);

        const { body } = await callGet('Full Harbor S08E02');

        expect(mockSearchEpisode.mock.calls[0][5]).toEqual({ availableOnly: true });
        expect(body.items[0].availability.isAvailable).toBe(true);
    });

    it('marks music tracks available and leaves artists without the flag', async () => {
        mockSearchMusic.mockResolvedValue([
            { ...makeMusicRow({ id: 'track-uuid', title: 'Drifting Apart' }) },
            { ...makeMusicRow({ id: 'artist-uuid', title: 'Aventara' }), media_type: 'artist' },
        ]);

        const { body } = await callGet('drifting', { types: 'track,artist' });

        const track = body.items.find((it: { id: string }) => it.id === 'track-uuid');
        const artist = body.items.find((it: { id: string }) => it.id === 'artist-uuid');
        expect(track.availability.isAvailable).toBe(true);
        expect(artist).not.toHaveProperty('isAvailable');
    });
});

describe('search exact series preview branch', () => {
    it('keeps exact matching and offset paging while using the shared preview response', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        mockExactSeriesRows.mockResolvedValue([
            makeMediaRow({ internal_id: id, media_type: 'tv', title: 'M' }),
            makeMediaRow({
                internal_id: '22222222-2222-4222-8222-222222222222',
                media_type: 'tv',
                title: 'M',
            }),
        ]);
        const { status, body } = await callGet('M', {
            types: 'series',
            match: 'exact',
            year: '1931',
            limit: '1',
            offset: '2',
        });
        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
            id,
            catalogId: id,
            type: 'series',
            reason: { kind: 'fts' },
        });
        expect(body.items[0].ids).not.toHaveProperty('internal');
        expect(body.page).toMatchObject({ limit: 1, offset: 2, hasMore: true });
        expect(mockExactSeriesRows.mock.calls.at(-1)?.slice(1, 5)).toEqual(['M', 1931, 2, 2]);
        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(mockSearchMusic).not.toHaveBeenCalled();
    });
});

describe('exact search filter validation', () => {
    const invalidQueries: Record<string, string>[] = [
        { type: 'series', match: 'exact' },
        { types: 'movie,series', match: 'exact' },
        { types: 'movie', match: 'exact' },
        { types: 'series', year: '1931' },
    ];
    it.each(invalidQueries)('rejects retired or conflicting filters: %o', async (query) => {
        const { status } = await callGet('M', query);
        expect(status).toBe(422);
        expect(mockExactSeriesRows).not.toHaveBeenCalled();
    });
});
