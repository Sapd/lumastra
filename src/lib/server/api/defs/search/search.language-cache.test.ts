// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression guard for defs/search/search.ts (GET /api/v1/search): the
 * result-page cache MUST stay language-neutral.
 *
 * Language used to be stable per user; it is now negotiated per REQUEST
 * (Accept-Language / cookie), so the same userId can resolve a different
 * language on different devices. The 45s result-page cache is keyed on
 * (query, access scope, …) — NOT on language — so it must only ever store
 * the pre-overlay (primary-language) payload. The overlay is applied after
 * every cache read/write, on a per-request clone.
 *
 * If a future change accidentally cached the already-translated payload, one
 * device's language would leak to every other device sharing the same
 * cache key until the 45s TTL expired. These two tests catch that:
 *   - two "devices" (same userId, different Accept-Language) get their own
 *     language back from the SAME cache entry;
 *   - the raw value handed to the cache's `set()` never contains overlaid text.
 *
 * Mocking mirrors search.test.ts (DB/query primitives, cache, translation
 * overlay), plus the real `request-language-context` AsyncLocalStorage and
 * the real `metadata-language-resolve` negotiation so Accept-Language
 * actually drives which language wins — the two things this test exists to
 * exercise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { runWithRequestLanguage } from '$lib/server/utils/request-language-context.js';

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

// Fixed config: one admin-enabled additional language ('de') alongside the
// primary ('en-US') — the minimum needed for negotiateLanguage to have
// something to negotiate between.
const mockConfig = {
    SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: false,
    SEARCH_TYPO_TOLERANCE: 'off',
    SEARCH_TYPO_MIN_RESULTS: 3,
    UNRATED_CONTENT_VISIBLE: false,
    TMDB_LANGUAGE: 'en-US',
    METADATA_ADDITIONAL_LANGUAGES: ['de'] as string[],
};

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: {} as Record<string, unknown>,
    isUnavailableMediaVisibleInSearch: () => mockConfig.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH,
    isUnavailableMediaVisible: () => false,
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

// Result-page cache: a real Map-backed store PLUS vi.fn() spies, so tests can
// both exercise cache-hit behavior and inspect exactly what payload was
// handed to `set()`.
const searchCacheStore = vi.hoisted(() => new Map<string, unknown>());
const mockCacheSet = vi.hoisted(() =>
    vi.fn(async (key: string, value: unknown) => {
        searchCacheStore.set(key, value);
    }),
);
const mockCacheGet = vi.hoisted(() =>
    vi.fn(async (key: string) => searchCacheStore.get(key) ?? null),
);
const searchSingleFlightStore = vi.hoisted(() => new Map<string, string>());

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({ get: mockCacheGet, set: mockCacheSet }),
    },
    CACHE_NAMESPACES: {
        searchResultsPage: { name: 'search-results-page-v1', l1TTL: 45_000, l2TTL: 45_000 },
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
        const existing = searchSingleFlightStore.get(cacheKey);
        if (existing !== undefined) return existing;
        const value = await compute();
        searchSingleFlightStore.set(cacheKey, value);
        return value;
    },
}));

// Preferences: no stored per-user language pref, so resolution falls through
// to the ambient (request-scoped) Accept-Language hint — the real
// `metadata-language-resolve.ts` negotiation is NOT mocked, so this is what
// actually makes the two "devices" resolve different languages.
const mockGetPlaybackPreferencesOne = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
}));

const MATRIX_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';

// Overlay stub: only translates the Matrix item's title, and only when the
// resolved title language is 'de' — mirrors a real translation-row lookup
// closely enough to prove the cache-neutrality invariant.
const mockApplyTranslationOverlay = vi.fn(
    async (
        _sql: unknown,
        items: Array<Record<string, unknown>>,
        langs: { titleLang: string | null; textLang: string | null },
        accessors: {
            id: (it: Record<string, unknown>) => string | null;
            setTitle: (it: Record<string, unknown>, v: string) => void;
        },
    ) => {
        if (langs.titleLang !== 'de') return;
        for (const item of items) {
            if (accessors.id(item) === MATRIX_UUID) {
                accessors.setTitle(item, 'Die Matrix');
            }
        }
    },
);
vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: Parameters<typeof mockApplyTranslationOverlay>) =>
        mockApplyTranslationOverlay(...args),
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./search.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX = { surface: 'v1' as const };

function makeEvent(q: string, userId: string): RequestEvent {
    const url = new URL('http://localhost/api/v1/search');
    url.searchParams.set('q', q);

    return {
        url,
        params: {},
        route: { id: '/api/v1/search' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId,
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

function makeMatrixRow() {
    return {
        media_type: 'movie',
        title: 'The Lantern',
        rank: 0.9,
        internal_id: MATRIX_UUID,
        jellyfin_id: null,
        tmdb_id: null,
        imdb_id: null,
        release_date: '1999-03-31',
        overview: null,
        match_source: 'fts',
    };
}

async function callSearch({
    q,
    userId,
    types,
}: {
    q: string;
    userId: string;
    types?: string;
}): Promise<Response> {
    const event = makeEvent(q, userId);
    if (types) event.url.searchParams.set('types', types);
    const handler = def.handlers.GET!;
    return handler(event, CTX);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    searchCacheStore.clear();
    searchSingleFlightStore.clear();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockGetDeniedLibraryGroups.mockResolvedValue(null);
    mockToLibraryAccessUser.mockReturnValue({});
    mockParseEpisodeQuery.mockReturnValue(null);
    mockSearchMedia.mockResolvedValue([makeMatrixRow()]);
    mockSearchMediaFulltext.mockResolvedValue([]);
    mockSearchMediaTrigram.mockResolvedValue([]);
    mockSearchEpisode.mockResolvedValue([]);
    mockSearchMusic.mockResolvedValue([]);
    mockGetPlaybackPreferencesOne.mockResolvedValue(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('search cache is language-neutral', () => {
    it('serves each device its own language for the same user', async () => {
        const german = await runWithRequestLanguage(
            { cookieLocale: null, acceptLanguage: 'de-DE' },
            () => callSearch({ q: 'matrix', userId: 'u1' }),
        );
        const english = await runWithRequestLanguage(
            { cookieLocale: null, acceptLanguage: 'en-US' },
            () => callSearch({ q: 'matrix', userId: 'u1' }),
        );

        expect((await german.json()).items[0].title).toBe('Die Matrix');
        expect((await english.json()).items[0].title).toBe('The Lantern');
    });

    it('stores the primary-language payload in the cache, not the overlaid one', async () => {
        await runWithRequestLanguage({ cookieLocale: null, acceptLanguage: 'de-DE' }, () =>
            callSearch({ q: 'matrix', userId: 'u1' }),
        );

        const cached = mockCacheSet.mock.calls.at(-1)?.[1];
        expect(JSON.stringify(cached)).not.toContain('Die Matrix');
    });
});

/** Matched-title lookup runs inside sql.begin(): hand the same mock to the callback. */
function withTransaction<T extends object>(sql: T): T {
    return Object.assign(sql, {
        begin: async (fn: (trx: unknown) => Promise<unknown>) =>
            fn(Object.assign(sql, { unsafe: vi.fn().mockResolvedValue([]) })),
    });
}

it('decorates after each language overlay without changing shared cache rows', async () => {
    mockGetDb.mockReturnValue(
        withTransaction(
            Object.assign(
                vi.fn().mockResolvedValue([{ media_id: MATRIX_UUID, title: 'Die Matrix' }]),
                { query: vi.fn() },
            ),
        ),
    );
    const german = await runWithRequestLanguage(
        { cookieLocale: null, acceptLanguage: 'de-DE' },
        () => callSearch({ q: 'matrix', userId: 'u1', types: 'movie,series' }),
    );
    const english = await runWithRequestLanguage(
        { cookieLocale: null, acceptLanguage: 'en-US' },
        () => callSearch({ q: 'matrix', userId: 'u1', types: 'movie,series' }),
    );
    expect(german.status, JSON.stringify(await german.clone().json())).toBe(200);
    expect((await german.json()).items[0]).not.toHaveProperty('matchedTitle');
    expect((await english.json()).items[0]).toMatchObject({
        title: 'The Lantern',
        matchedTitle: 'Die Matrix',
    });
    const cached = mockCacheSet.mock.calls.at(-1)?.[1];
    expect(cached).toMatchObject({ items: [{ title: 'The Lantern' }] });
    expect(JSON.stringify(cached)).not.toContain('matchedTitle');
});

it('retains the response and neutral cache when the optional title query rejects', async () => {
    const query = vi.fn().mockRejectedValue(new Error('stored title lookup unavailable'));
    const sql = vi.fn((strings: TemplateStringsArray) =>
        strings[0].includes('WITH keys AS') ? query() : '',
    );
    mockGetDb.mockReturnValue(withTransaction(Object.assign(sql, { query: vi.fn() })));
    const german = await runWithRequestLanguage(
        { cookieLocale: null, acceptLanguage: 'de-DE' },
        () => callSearch({ q: 'matrix', userId: 'u1', types: 'movie,series' }),
    );
    expect(german.status).toBe(200);
    const germanBody = await german.json();
    const cached = structuredClone(mockCacheSet.mock.calls.at(-1)?.[1]);
    expect(germanBody.items[0]).toMatchObject({ id: MATRIX_UUID, title: 'Die Matrix' });
    expect(germanBody.items[0]).not.toHaveProperty('matchedTitle');
    expect(cached).toMatchObject({ items: [{ id: MATRIX_UUID, title: 'The Lantern' }] });
    const english = await runWithRequestLanguage(
        { cookieLocale: null, acceptLanguage: 'en-US' },
        () => callSearch({ q: 'matrix', userId: 'u1', types: 'movie,series' }),
    );
    expect(english.status).toBe(200);
    const englishBody = await english.json();
    expect(englishBody.items[0]).toMatchObject({ id: MATRIX_UUID, title: 'The Lantern' });
    expect(englishBody.items[0]).not.toHaveProperty('matchedTitle');
    expect(englishBody.page).toEqual(germanBody.page);
    expect(englishBody.page).toMatchObject({
        offset: 0,
        hasMore: (cached as { hasMore: boolean }).hasMore,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(mockSearchMedia).toHaveBeenCalledTimes(1);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    expect([...searchCacheStore.values()]).toEqual([cached]);
});
