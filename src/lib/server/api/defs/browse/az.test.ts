// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for defs/browse/az.ts (GET /api/browse/az).
 *
 * Covers audit gap A4: the access-filter forwarding contract.
 *
 *   A4a — For a RESTRICTED access context (non-null deniedGroupIds and/or
 *          ageRating), the handler forwards both filters into EVERY DB query call
 *          (getMediaAlphabetical and getAlphabeticalBucketCounts).
 *
 *   A4b — The cache key for a RESTRICTED user encodes the access scope (it is
 *          NOT the same bare key an unrestricted user receives). This prevents
 *          shared-cache poisoning: a restricted user never receives a cache entry
 *          written by an unrestricted user, and vice versa.
 *          Note: az.ts never sets cacheKey=null for restricted users — instead it
 *          uses browseScopedCacheKey which appends the access-scope suffix. We
 *          assert the key written for a restricted user differs from the one
 *          written for an unrestricted user so the test is meaningful without
 *          pinning internal key string formats.
 *
 * All external I/O is mocked (no live DB). buildSearchAccessContext is mocked to
 * return a fully controlled SearchAccessContext; browseScopedCacheKey is real
 * (partial mock) so its scoping logic is exercised end-to-end.
 *
 * // TODO (integration): add a DB-level integration test that exercises
 * //   buildLibraryAccessFilter / buildAgeRatingFilter with real SQL to confirm
 * //   the denied rows are actually excluded from query results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockGetEpisodeCounts = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('$lib/server/database/queries/series-episode-counts.queries.js', () => ({
    getSeriesEpisodeCountsBatch: mockGetEpisodeCounts,
}));
const mockGetDb = vi.fn();
const mockGetMediaAlphabetical = vi.fn();
const mockGetAlphabeticalBucketCounts = vi.fn();
const mockGetGenreFacetCounts = vi.fn();
const mockGetKeywordFacetCounts = vi.fn();
const mockBuildSearchAccessContext = vi.fn();

// Cache mocks: each namespace gets a shared get/set pair so tests can inspect
// the key written to cache.set (revealing scoped vs bare key).
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getMediaAlphabetical: (...args: unknown[]) => mockGetMediaAlphabetical(...args),
    getAlphabeticalBucketCounts: (...args: unknown[]) => mockGetAlphabeticalBucketCounts(...args),
    getGenreFacetCounts: (...args: unknown[]) => mockGetGenreFacetCounts(...args),
    getKeywordFacetCounts: (...args: unknown[]) => mockGetKeywordFacetCounts(...args),
    // Other browse query exports — not called by az.ts; present to satisfy import.
    getFilteredRecentlyAddedMedia: vi.fn(),
    buildBrowseGenreSections: vi.fn(),
    getRecentlyAddedMedia: vi.fn(),
}));

// Partial mock: stub only buildSearchAccessContext; let the real
// browseScopedCacheKey / browseAccessSuffix run so key-scoping is tested.
vi.mock('$lib/server/utils/search-access-context.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: {
        browseAZ: 'browseAZ',
        browseRecentlyAdded: 'browseRecentlyAdded',
        browseGenres: 'browseGenres',
    },
    browseGenresCacheKey: (type: string) => `genres:${type}`,
    cacheManager: {
        for: () => ({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('$lib/constants/images.js', () => ({
    FALLBACK_IMAGE: '/fallback.png',
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

// Mutable config: overlay gate off by default (matches real config default).
const mockConfig: Record<string, unknown> = {
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

const mockGetPlaybackPreferences = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: (...args: unknown[]) => mockGetPlaybackPreferences(...args) },
}));

const mockResolveMetadataLanguage = vi.hoisted(() =>
    vi.fn().mockReturnValue({ titleLang: null, textLang: null }),
);
vi.mock('$lib/server/utils/metadata-language-resolve.js', () => ({
    resolveMetadataLanguage: (...args: unknown[]) => mockResolveMetadataLanguage(...args),
}));

// Overlay mock that exercises the caller-provided accessors/setters exactly
// like the real helper: swaps title/overview in place on whatever array the
// handler hands it.
const mockApplyTranslationOverlay = vi.hoisted(() =>
    vi.fn(
        async (
            _sql: unknown,
            items: unknown[],
            _langs: unknown,
            opts: {
                id: (it: unknown) => string | null | undefined;
                setTitle?: (it: unknown, v: string) => void;
                setOverview?: (it: unknown, v: string) => void;
            },
        ) => {
            for (const item of items) {
                if (!opts.id(item)) continue;
                opts.setTitle?.(item, 'Lokalisierter Titel');
                opts.setOverview?.(item, 'Lokalisierte Beschreibung');
            }
        },
    ),
);
vi.mock('$lib/server/utils/translation-overlay.js', () => ({
    applyTranslationOverlay: (...args: unknown[]) =>
        mockApplyTranslationOverlay(...(args as Parameters<typeof mockApplyTranslationOverlay>)),
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./az.js');
import type { AZQuery } from '$lib/schemas/browse.js';
import type { AzBrowseResponse } from '$lib/schemas/api-browse-responses.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX: {
    surface: 'internal';
    input: { query: AZQuery; body: undefined; params: undefined };
} = {
    surface: 'internal',
    input: {
        query: {
            type: 'all',
            offset: 0,
            limit: 50,
            // Quality/language filter fields — azQuerySchema applies these
            // defaults in production (arrays via parseLangCsv/parseTierCsv,
            // booleans false, sort 'title_asc'); the handler assumes them.
            sort: 'title_asc',
            audio: [],
            subs: [],
            includeUnknown: false,
            res: [],
            hdr: [],
            codec: [],
            qUnknown: false,
        } as AZQuery,
        body: undefined,
        params: undefined,
    },
};

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/browse/az');
    return {
        url,
        params: {},
        route: { id: '/api/browse/az' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr-00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: ['viewer'],
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

/** Minimal AZ page result — item has internal_id so the mapper produces output. */
function makeAZResult() {
    return {
        items: [
            {
                internal_id: 'media-uuid-0001',
                primary_ext_id: null,
                media_type: 'movie',
                title: 'Awakening',
                jellyfin_id: null,
                poster_path: null,
                backdrop_path: null,
                tmdb_rating: null,
                imdb_rating: null,
                rt_rating: null,
                rt_audience_score: null,
                release_date: '2016-11-11',
                release_year: 2016,
                overview: null,
                is_available: true,
            },
        ],
        totalCount: 1,
    };
}

const FAKE_BUCKETS = [{ bucket: 'A', count: 1 }];

/** Run the handler with the given query overrides and return the parsed JSON body. */
async function invokeAz(query: Partial<AZQuery>): Promise<AzBrowseResponse> {
    const handler = def.handlers.GET!;
    const res = await handler(makeEvent(), {
        ...CTX,
        input: { ...CTX.input, query: { ...CTX.input.query, ...query } as AZQuery },
    });
    return (await res.clone().json()) as AzBrowseResponse;
}

/** Keys passed to azCache.get across every call made so far, in call order. */
function cacheGetKeys(): string[] {
    return (mockCacheGet.mock.calls as [string, ...unknown[]][]).map(([k]) => k);
}

// ── Shared access context fixtures ───────────────────────────────────────────

const UNRESTRICTED_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

const RESTRICTED_CTX = {
    username: 'bob',
    deniedGroupIds: ['grp-aaaa-0000-0000-0000000000ff'],
    ageRating: { maxAgeRating: 12, allowUnrated: false },
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockGetEpisodeCounts.mockResolvedValue([]);
    mockGetDb.mockReturnValue({ query: vi.fn() });
    // Default: no cached entries — forces the DB path on every test.
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    // Default: unrestricted context.
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    // Default: minimal results so the handler completes successfully.
    mockGetMediaAlphabetical.mockResolvedValue({ items: [], totalCount: 0 });
    mockGetAlphabeticalBucketCounts.mockResolvedValue([]);
    mockGetGenreFacetCounts.mockResolvedValue([]);
    mockGetKeywordFacetCounts.mockResolvedValue([]);
    // Default: overlay feature off (matches real config default).
    mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    mockGetPlaybackPreferences.mockResolvedValue(null);
    mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/browse/az — A4a: access filter forwarding', () => {
    it('forwards deniedGroupIds into getMediaAlphabetical for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);

        expect(res.status).toBe(200);
        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(), // sql
            expect.objectContaining({
                access: expect.objectContaining({
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                }),
            }),
        );
    });

    it('forwards ageRating into getMediaAlphabetical for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: expect.objectContaining({
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                }),
            }),
        );
    });

    it('forwards deniedGroupIds + ageRating together into getMediaAlphabetical', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: {
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                },
            }),
        );
    });

    it('forwards deniedGroupIds + ageRating into getAlphabeticalBucketCounts', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetAlphabeticalBucketCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: {
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                },
            }),
        );
    });

    it('passes an unrestricted boundary for an unrestricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: { library: { kind: 'all' }, age: { kind: 'any' } },
            }),
        );
    });
});

describe('GET /api/browse/az — A4b: restricted user receives an access-scoped cache key', () => {
    it('cache.set is called with an access-scoped key for a restricted user, not the bare unrestricted key', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockCacheSet).toHaveBeenCalled();
        // First call is pageCacheKey.
        const [[restrictedKey]] = mockCacheSet.mock.calls as [[string, unknown][]];

        // Run again with UNRESTRICTED context and capture its page cache key.
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({ query: vi.fn() });
        mockCacheGet.mockResolvedValue(null);
        mockCacheSet.mockResolvedValue(undefined);
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        await handler(makeEvent(), CTX);
        const [[unrestrictedKey]] = mockCacheSet.mock.calls as [[string, unknown][]];

        // The two keys must differ — collapsed keys would allow cache poisoning.
        expect(restrictedKey).not.toBe(unrestrictedKey);
        // The restricted key must encode the access scope suffix.
        expect(restrictedKey).toContain('denied:');
    });

    it('unrestricted user receives a bare (non-suffixed) cache key', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        const [[key]] = mockCacheSet.mock.calls as [[string, unknown][]];
        // No access-scope suffix — unrestricted users share the bare entry.
        // Match the DELIMITED suffix segments (`:denied:` / `:age:`) rather than
        // bare substrings: the base key legitimately contains "age:" inside
        // "...page:..." and a loose `.not.toContain('age:')` would false-positive.
        expect(key).not.toContain(':denied:');
        expect(key).not.toMatch(/:age:\d/);
    });
});

describe('GET /api/browse/az — 503 on dependency down', () => {
    it('returns 503 when DB is null', async () => {
        mockGetDb.mockReturnValue(null);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);

        expect(res.status).toBe(503);
        const body = await res.clone().json();
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('GET /api/browse/az — response field matches AzBrowseResponseSchema', () => {
    it('echoes the type filter under `mediaType`, not `type`', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        // AzBrowseResponseSchema (src/lib/schemas/api-browse-responses.ts) declares
        // `mediaType`, not `type` — a strict OpenAPI-generated client (e.g. tvOS)
        // rejects an undocumented top-level `type` key.
        expect(body.mediaType).toBe('all');
        expect(body).not.toHaveProperty('type');
    });
});

describe('GET /api/browse/az — genre filter composes with the rest of the surface', () => {
    /** CTX with a genre selected (and a non-default group + sort alongside it). */
    const GENRE_CTX = {
        ...CTX,
        input: {
            ...CTX.input,
            query: {
                ...CTX.input.query,
                genre: 'Science Fiction',
                libraryGroupId: 'grp-1111-0000-0000-000000000001',
                sort: 'year_desc',
            } as AZQuery,
        },
    };

    it('forwards genre + libraryGroupId + sort together into the page query', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        await handler(makeEvent(), GENRE_CTX);

        // The whole point of `genre` living here rather than on /browse/genre/{name}:
        // it does not displace the library scope or the sort order.
        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                genreName: 'Science Fiction',
                groupId: 'grp-1111-0000-0000-000000000001',
                sort: 'year_desc',
            }),
        );
    });

    it('forwards genre into the letter-bucket counts so the A–Z rail stays truthful', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        // title_asc so the letter rail is actually requested.
        await handler(makeEvent(), {
            ...CTX,
            input: {
                ...CTX.input,
                query: { ...CTX.input.query, genre: 'Horror' } as AZQuery,
            },
        });

        expect(mockGetAlphabeticalBucketCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ genreName: 'Horror' }),
        );
    });

    it('echoes the applied genre back on the response', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), GENRE_CTX);
        const body = await res.clone().json();

        expect(body.genre).toBe('Science Fiction');
    });

    it('omits `genre` from the response when no genre filter is applied', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.genre).toBeUndefined();
        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ genreName: undefined }),
        );
    });

    /** Run the handler with `query` and return the page cache key it wrote. */
    async function pageKeyFor(query: Partial<AZQuery>): Promise<string> {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({ query: vi.fn() });
        mockCacheGet.mockResolvedValue(null);
        mockCacheSet.mockResolvedValue(undefined);
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue([]);
        mockGetGenreFacetCounts.mockResolvedValue([]);

        await def.handlers.GET!(makeEvent(), {
            ...CTX,
            input: { ...CTX.input, query: { ...CTX.input.query, ...query } as AZQuery },
        });
        // First cache.set is the page key (the page is resolved before the rails).
        const [[key]] = mockCacheSet.mock.calls as Array<[string, unknown]>;
        return key;
    }

    it('keys `Action` and `action` separately — the SQL match is case-sensitive', async () => {
        // Collapsing these would serve one casing's rows (or its empty result) to
        // the other: `?genre=action` matches nothing, `?genre=Action` matches 412.
        expect(await pageKeyFor({ genre: 'Action' })).not.toBe(
            await pageKeyFor({ genre: 'action' }),
        );
    });

    it('keys a literal `?genre=-` apart from "no genre filter"', async () => {
        expect(await pageKeyFor({ genre: '-' })).not.toBe(await pageKeyFor({ genre: undefined }));
    });

    it('survives a genre containing the reserved cache-key delimiter', async () => {
        mockGetMediaAlphabetical.mockResolvedValue({ items: [], totalCount: 0 });

        // browseScopedCacheKey throws on a raw '|', and the keys are built BEFORE
        // the handler's try block — an unencoded genre would 500 here instead of
        // honouring the documented "unknown name simply matches nothing".
        const res = await def.handlers.GET!(makeEvent(), {
            ...CTX,
            input: {
                ...CTX.input,
                query: { ...CTX.input.query, genre: 'Action|Drama' } as AZQuery,
            },
        });

        expect(res.status).toBe(200);
        const body = await res.clone().json();
        expect(body.items).toEqual([]);
        expect(body.genre).toBe('Action|Drama');
    });

    it('passes the genre to SQL verbatim, however it was encoded for the key', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await def.handlers.GET!(makeEvent(), {
            ...CTX,
            input: {
                ...CTX.input,
                query: { ...CTX.input.query, genre: 'Action & Adventure' } as AZQuery,
            },
        });

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ genreName: 'Action & Adventure' }),
        );
    });

    it('gives a genre-filtered request a different page cache key than an unfiltered one', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);
        const [[unfilteredKey]] = mockCacheSet.mock.calls as [[string, unknown][]];

        vi.clearAllMocks();
        mockGetDb.mockReturnValue({ query: vi.fn() });
        mockCacheGet.mockResolvedValue(null);
        mockCacheSet.mockResolvedValue(undefined);
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue([]);
        mockGetGenreFacetCounts.mockResolvedValue([]);

        await handler(makeEvent(), GENRE_CTX);
        const [[filteredKey]] = mockCacheSet.mock.calls as [[string, unknown][]];

        // Collapsed keys would serve genre-filtered items to an unfiltered request.
        expect(filteredKey).not.toBe(unfilteredKey);
    });
});

describe('GET /api/browse/az — genreCounts facet', () => {
    it('returns genre counts as { name, count }, hiding nothing the DB reported', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetGenreFacetCounts.mockResolvedValue([
            { genre: 'Action', count: 412 },
            { genre: 'Documentary', count: 1 },
        ]);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.genreCounts).toEqual([
            { name: 'Action', count: 412 },
            { name: 'Documentary', count: 1 },
        ]);
    });

    it('computes the facet WITHOUT the genre narrowing so a client can switch genres', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        await handler(makeEvent(), {
            ...CTX,
            input: {
                ...CTX.input,
                query: { ...CTX.input.query, genre: 'Action' } as AZQuery,
            },
        });

        const [, facetOpts] = mockGetGenreFacetCounts.mock.calls[0] as [unknown, AZQuery];
        expect(facetOpts).not.toHaveProperty('genreName');
    });

    it('is emitted for non-title sorts too (unlike the letter rail)', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetGenreFacetCounts.mockResolvedValue([{ genre: 'Action', count: 3 }]);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), {
            ...CTX,
            input: {
                ...CTX.input,
                query: { ...CTX.input.query, sort: 'added_desc' } as AZQuery,
            },
        });
        const body = await res.clone().json();

        expect(body.letterCounts).toEqual([]);
        expect(body.genreCounts).toEqual([{ name: 'Action', count: 3 }]);
    });

    it('drops a stale letter from the facet scope on sorts that ignore it', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        await handler(makeEvent(), {
            ...CTX,
            input: {
                ...CTX.input,
                query: { ...CTX.input.query, letter: 'A', sort: 'added_desc' } as AZQuery,
            },
        });

        // getMediaAlphabetical ignores `letter` outside the title sorts; counting
        // the facet under it would report totals no page can return.
        expect(mockGetGenreFacetCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ letter: undefined }),
        );
    });

    it('still serves the page when the facet query fails, and does NOT cache the empty rail', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);
        mockGetGenreFacetCounts.mockRejectedValue(new Error('connection terminated'));

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        // The rail is a navigation aid — a broken facet must not take down the
        // grid the caller asked for.
        expect(res.status).toBe(200);
        expect(body.items).toHaveLength(1);
        expect(body.genreCounts).toEqual([]);

        // Caching the empty rail would assert "this catalog has no genres" for
        // the namespace TTL (30 min) off one transient error. Scoped to the
        // genre facet key specifically — the keyword facet (mocked to resolve
        // `[]` by default, not to throw) legitimately caches its own empty
        // result and must not trip this assertion.
        const genreFacetCacheCalls = (mockCacheSet.mock.calls as [string, unknown][]).filter(
            ([key]) => key.includes('genrefacets'),
        );
        expect(genreFacetCacheCalls).toHaveLength(0);
    });

    it('forwards the access boundary into the facet query', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetGenreFacetCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: {
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                },
            }),
        );
    });
});

describe('GET /api/browse/az — image hrefs follow ctx.surface', () => {
    it('emits internal-prefixed entity-image URLs on the internal surface', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.items[0].image).toBe('/api/media/media-uuid-0001/images/poster?size=thumb');
        expect(body.items[0].backdrop).toBe(
            '/api/media/media-uuid-0001/images/backdrop?size=thumb',
        );
    });

    it('emits v1-prefixed entity-image URLs on the v1 surface', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        // `/api/image/catalog/...` has no v1 route, so a v1 client used to 404.
        const res = await handler(makeEvent(), { ...CTX, surface: 'v1' as const });
        const body = await res.clone().json();

        expect(body.items[0].image).toBe('/api/v1/media/media-uuid-0001/images/poster?size=thumb');
        expect(body.items[0].backdrop).toBe(
            '/api/v1/media/media-uuid-0001/images/backdrop?size=thumb',
        );
    });
});

describe('GET /api/browse/az — overview truncation follows ctx.surface', () => {
    /**
     * `overview` truncation (see truncate-overview.ts) is applied ONLY on the
     * internal surface — this def is also mounted at /api/v1/browse/az, which
     * must stay byte-identical for native clients. A dropped or flipped
     * `ctx.surface === 'internal'` gate at the response boundary would not
     * fail any OTHER test in this file (none of them use an overview long
     * enough to need truncation), so this pins it directly.
     */
    const LONG_OVERVIEW =
        'Awakening is a 2016 science fiction film. '.repeat(6) +
        'It is definitely over 150 characters long.';

    function makeLongOverviewResult() {
        const result = makeAZResult();
        return {
            ...result,
            items: [{ ...result.items[0], overview: LONG_OVERVIEW }],
        };
    }

    it('trims item overview to <=150 chars ending with the ellipsis on the internal surface', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeLongOverviewResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.items[0].overview.length).toBeLessThanOrEqual(150);
        expect(body.items[0].overview.endsWith('...')).toBe(true);
    });

    it('leaves item overview FULL/untouched on the v1 surface', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeLongOverviewResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), { ...CTX, surface: 'v1' as const });
        const body = await res.clone().json();

        expect(body.items[0].overview).toBe(LONG_OVERVIEW);
    });
});

describe('GET /api/browse/az — metadata-language overlay (multilingual-media-metadata §5)', () => {
    it('overlays localized title/overview onto items when the feature is enabled', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockApplyTranslationOverlay).toHaveBeenCalled();
        expect(body.items[0].title).toBe('Lokalisierter Titel');
        expect(body.items[0].overview).toBe('Lokalisierte Beschreibung');
    });

    it('pays zero extra queries and skips the overlay when the feature is off', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetAlphabeticalBucketCounts.mockResolvedValue(FAKE_BUCKETS);
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockGetPlaybackPreferences).not.toHaveBeenCalled();
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(body.items[0].title).toBe('Awakening');
    });
});

describe('GET /api/browse/az — free-text q', () => {
    it('threads q through to the page read as `query`', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ q: 'dawn' });

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ query: 'dawn' }),
        );
    });

    it('applies q to every facet count, so no rail disagrees with the grid', async () => {
        // A letter rail or genre count computed WITHOUT the query would offer
        // buckets the filtered grid cannot fill — worse than no rail.
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ q: 'dawn' });

        for (const spy of [
            mockGetAlphabeticalBucketCounts,
            mockGetGenreFacetCounts,
            mockGetKeywordFacetCounts,
        ]) {
            expect(spy).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ query: 'dawn' }),
            );
        }
    });

    it('gives queried and unqueried requests distinct page cache keys', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({});
        await invokeAz({ q: 'dawn' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys[0]).not.toBe(pageKeys[1]);
    });

    it('shares one page cache entry across letters while a query is active', async () => {
        // q overrides letter in SQL, so keying on the ignored letter would split
        // one identical result set across two entries.
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ q: 'dawn', letter: 'A' });
        await invokeAz({ q: 'dawn', letter: 'B' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys[0]).toBe(pageKeys[1]);
    });

    it('still separates letters when no query is active', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ letter: 'A' });
        await invokeAz({ letter: 'B' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys[0]).not.toBe(pageKeys[1]);
    });

    it('matches case-insensitively in the cache key', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ q: 'Dawn' });
        await invokeAz({ q: 'dawn' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys[0]).toBe(pageKeys[1]);
    });

    it('a q containing a pipe does not throw', async () => {
        // browseScopedCacheKey reserves '|' and THROWS on it, and these keys are
        // built before the handler's try block.
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await expect(invokeAz({ q: 'a|b' })).resolves.toBeTruthy();
    });
});

describe('GET /api/browse/az — tag axis', () => {
    it('threads tag through to getMediaAlphabetical as keyword', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ tag: 'whodunit' });

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ keyword: 'whodunit' }),
        );
    });

    it('gives tagged and untagged requests distinct page cache keys', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({});
        await invokeAz({ tag: 'whodunit' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys[0]).not.toBe(pageKeys[1]);
    });

    it('a literal tag of "-" does not collide with the absent sentinel', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({});
        await invokeAz({ tag: '-' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys[0]).not.toBe(pageKeys[1]);
    });

    it('a tag containing a pipe does not throw', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await expect(invokeAz({ tag: 'a|b' })).resolves.toBeDefined();
    });

    it('keyword facet key ignores tag but honours genre', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ tag: 'whodunit' });
        await invokeAz({ tag: 'heist' });

        const facetKeys = cacheGetKeys().filter((k) => k.startsWith('v4keywordfacets:'));
        expect(facetKeys[0]).toBe(facetKeys[1]);
    });

    it('keyword facet key varies with genre — the other half of the mirror', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ genre: 'Action' });
        await invokeAz({ genre: 'Horror' });

        const facetKeys = cacheGetKeys().filter((k) => k.startsWith('v4keywordfacets:'));
        expect(facetKeys[0]).not.toBe(facetKeys[1]);
    });

    it('caps the keyword facet so keywordCounts can never ship unbounded', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({});

        expect(mockGetKeywordFacetCounts).toHaveBeenCalledTimes(1);
        const [, options] = mockGetKeywordFacetCounts.mock.calls[0] as [unknown, { max?: number }];
        // A missing/undefined `max` emits no LIMIT — the regression that put
        // ~4 MB and 84k Zod validations on every /browse/az response.
        expect(options.max).toBeTypeOf('number');
        expect(options.max).toBeGreaterThan(0);
        expect(options.max).toBeLessThanOrEqual(50);
    });

    it('echoes the applied tag back so a client can read its own filter', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const withTag = await invokeAz({ tag: 'whodunit' });
        expect(withTag.tag).toBe('whodunit');

        const withoutTag = await invokeAz({});
        expect(withoutTag.tag).toBeUndefined();
    });

    it('degrades to an empty keyword rail without caching when the facet throws', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());
        mockGetKeywordFacetCounts.mockRejectedValueOnce(new Error('boom'));

        const res = await invokeAz({});

        expect(res.keywordCounts).toEqual([]);
        expect(res.items).toBeDefined();

        const facetSets = (mockCacheSet.mock.calls as [string, unknown][]).filter(([k]) =>
            k.includes('keywordfacets'),
        );
        expect(facetSets).toHaveLength(0);
    });
});

describe('GET /api/browse/az — whitespace-only tag/genre behave as absent', () => {
    // The schema (browseAzQuerySchema) trims a whitespace-only value down to ''
    // before it ever reaches this handler — these tests confirm the handler's
    // own cache-key logic treats that '' as the absent sentinel ('-') rather
    // than as a new, distinct "present but empty" key, which would silently
    // fragment the cache instead of matching the plain unfiltered request.
    it('an empty-string tag gets the same page cache key as an omitted tag', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({});
        await invokeAz({ tag: '' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys).toHaveLength(2);
        expect(pageKeys[0]).toBe(pageKeys[1]);
    });

    it('an empty-string genre gets the same page cache key as an omitted genre', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({});
        await invokeAz({ genre: '' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys).toHaveLength(2);
        expect(pageKeys[0]).toBe(pageKeys[1]);
    });

    it('an empty-string tag does NOT get the same page cache key as a genuinely present tag', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ tag: '' });
        await invokeAz({ tag: 'whodunit' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys).toHaveLength(2);
        expect(pageKeys[0]).not.toBe(pageKeys[1]);
    });

    it('an empty-string genre does NOT get the same page cache key as a genuinely present genre', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ genre: '' });
        await invokeAz({ genre: 'Action' });

        const pageKeys = cacheGetKeys().filter((k) => k.startsWith('v13page:'));
        expect(pageKeys).toHaveLength(2);
        expect(pageKeys[0]).not.toBe(pageKeys[1]);
    });

    it('an empty-string tag is not forwarded as a keyword narrowing to getMediaAlphabetical', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        await invokeAz({ tag: '' });

        expect(mockGetMediaAlphabetical).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ keyword: '' }),
        );
    });

    it('echoes no tag/genre back to the client for an empty-string value', async () => {
        mockGetMediaAlphabetical.mockResolvedValue(makeAZResult());

        const body = await invokeAz({ tag: '', genre: '' });

        expect(body.tag).toBeUndefined();
        expect(body.genre).toBeUndefined();
    });
});

describe('A–Z cached pages retain viewer count isolation', () => {
    it('enriches a cache miss and subsequent viewer hit without personal fields in the shared cache', async () => {
        const id = '10000000-0000-0000-0000-000000000001';
        const cachedPage = makeAZResult();
        cachedPage.items[0].internal_id = id;
        cachedPage.items[0].media_type = 'tv';
        let pageReads = 0;
        mockCacheGet.mockImplementation((key: string) => {
            if (!key.startsWith('v13page:')) return Promise.resolve([]);
            return Promise.resolve(pageReads++ === 0 ? null : cachedPage);
        });
        mockGetMediaAlphabetical.mockResolvedValue(cachedPage);
        mockGetEpisodeCounts.mockImplementation(
            async (_sql: unknown, _ids: string[], userId: string) => [
                {
                    id,
                    seasonCount: 3,
                    episodeCount: 60,
                    availableEpisodeCount: 24,
                    watchedEpisodeCount: userId === '20000000-0000-0000-0000-000000000001' ? 24 : 0,
                    unwatchedEpisodeCount:
                        userId === '20000000-0000-0000-0000-000000000001' ? 0 : 24,
                },
            ],
        );
        const first = makeEvent();
        first.locals.user!.userId = toUserId('20000000-0000-0000-0000-000000000001');
        const second = makeEvent();
        second.locals.user!.userId = toUserId('20000000-0000-0000-0000-000000000002');
        const firstResponse = await def.handlers.GET!(first, CTX);
        const secondResponse = await def.handlers.GET!(second, CTX);
        const alice = (await firstResponse.json()) as AzBrowseResponse;
        const bob = (await secondResponse.json()) as AzBrowseResponse;
        expect(alice.items?.[0]).toMatchObject({
            watchedEpisodeCount: 24,
            unwatchedEpisodeCount: 0,
        });
        expect(bob.items?.[0]).toMatchObject({ watchedEpisodeCount: 0, unwatchedEpisodeCount: 24 });
        expect(mockGetEpisodeCounts.mock.calls.map((call) => call[2])).toEqual([
            '20000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000002',
        ]);
        expect(mockGetMediaAlphabetical).toHaveBeenCalledTimes(1);
        const pageWrites = mockCacheSet.mock.calls.filter(([key]) => key.startsWith('v13page:'));
        expect(pageWrites).toHaveLength(1);
        expect(pageWrites[0][1]).toBe(cachedPage);
        const writtenItem = pageWrites[0][1].items[0];
        expect(writtenItem).not.toHaveProperty('watchedEpisodeCount');
        expect(writtenItem).not.toHaveProperty('unwatchedEpisodeCount');
        expect(writtenItem).not.toHaveProperty('availableEpisodeCount');
        expect(cachedPage.items[0]).not.toHaveProperty('watchedEpisodeCount');
        expect(cachedPage.items[0]).not.toHaveProperty('unwatchedEpisodeCount');
        expect(cachedPage.items[0]).not.toHaveProperty('availableEpisodeCount');
    });
});
