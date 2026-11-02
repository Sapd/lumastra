// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/index.ts (GET /api/browse).
 *
 * Covers audit gap A4: the access-filter forwarding contract.
 *
 *   A4a — For a RESTRICTED access context (non-null deniedGroupIds and/or
 *          ageRating), the handler forwards both filters into:
 *            - getFilteredRecentlyAddedMedia (recently-added items)
 *            - buildBrowseGenreSections (genre carousels)
 *
 *   A4b — The recently-added cache key is set to null for a restricted user
 *          (deniedGroupIds !== null || ageRating !== null), so the handler
 *          bypasses the shared cache and never writes a restricted user's data
 *          into the unrestricted cache slot. Concretely:
 *            - restricted user: recentlyAddedCache.set must NOT be called.
 *            - unrestricted user: recentlyAddedCache.set IS called.
 *
 * All external I/O is mocked (no live DB). buildSearchAccessContext is mocked
 * to return a fully controlled SearchAccessContext; browseAccessSuffix is real
 * (partial mock) so the genre-cache key-scoping logic is tested end-to-end.
 *
 * // TODO (integration): verify at the DB level that buildLibraryAccessFilter
 * //   actually excludes rows from denied library groups — unit tests only check
 * //   that the filter values reach the query call site.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

const mockGetDb = vi.fn();
const mockGetFilteredRecentlyAddedMedia = vi.fn();
const mockBuildBrowseGenreSections = vi.fn();
const mockBuildSearchAccessContext = vi.fn();

// Per-namespace cache mocks — recentlyAdded and genres use different namespaces.
const mockRecentCacheGet = vi.fn();
const mockRecentCacheSet = vi.fn();
const mockGenresCacheGet = vi.fn();
const mockGenresCacheSet = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getFilteredRecentlyAddedMedia: (...args: unknown[]) =>
        mockGetFilteredRecentlyAddedMedia(...args),
    buildBrowseGenreSections: (...args: unknown[]) => mockBuildBrowseGenreSections(...args),
    // Other browse query exports — not called by index.ts; present to satisfy import.
    getMediaAlphabetical: vi.fn(),
    getAlphabeticalBucketCounts: vi.fn(),
    getRecentlyAddedMedia: vi.fn(),
}));

// Partial mock: stub only buildSearchAccessContext; let browseAccessSuffix run
// as real code so the genre-cache key-scoping logic is exercised end-to-end.
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
        for: (ns: string) => {
            if (ns === 'browseGenres') {
                return {
                    get: (...args: unknown[]) => mockGenresCacheGet(...args),
                    set: (...args: unknown[]) => mockGenresCacheSet(...args),
                };
            }
            // browseRecentlyAdded + any other namespace.
            return {
                get: (...args: unknown[]) => mockRecentCacheGet(...args),
                set: (...args: unknown[]) => mockRecentCacheSet(...args),
            };
        },
    },
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    isMovie: (type: string) => type === 'movie',
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
// handler hands it. If the handler passes the cached array instead of clones,
// the shared-cache assertions below catch it (mirrors search/episodes.test.ts).
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

const { def } = await import('./index.js');
import type { BrowseQuery } from '$lib/schemas/browse.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX: {
    surface: 'internal';
    input: { query: BrowseQuery; body: undefined; params: undefined };
} = {
    surface: 'internal',
    input: {
        query: {
            type: 'all',
            genreOffset: 0,
            genreLimit: 12,
        } as BrowseQuery,
        body: undefined,
        params: undefined,
    },
};

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/browse');
    return {
        url,
        params: {},
        route: { id: '/api/browse' as const },
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

/** Minimal recently-added row returned by getFilteredRecentlyAddedMedia. */
function makeRecentRow() {
    return {
        id: '123e4567-e89b-42d3-a456-426614174001',
        title: 'Awakening',
        media_type: 'movie',
        overview: null,
        is_available: true,
    };
}

const EMPTY_GENRE_SECTIONS = {
    genres: [],
    totalGenres: 0,
    hasMoreGenres: false,
};

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
    deniedGroupIds: ['grp-bbbb-0000-0000-0000000000ee'],
    ageRating: { maxAgeRating: 12, allowUnrated: false },
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    // Default: no cached entries so the DB path runs every test.
    mockRecentCacheGet.mockResolvedValue(null);
    mockRecentCacheSet.mockResolvedValue(undefined);
    mockGenresCacheGet.mockResolvedValue(null);
    mockGenresCacheSet.mockResolvedValue(undefined);
    // Default: unrestricted context.
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    // Default: minimal data so the handler completes.
    mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeRecentRow()]);
    mockBuildBrowseGenreSections.mockResolvedValue(EMPTY_GENRE_SECTIONS);
    // Default: overlay feature off (matches real config default).
    mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    mockGetPlaybackPreferences.mockResolvedValue(null);
    mockResolveMetadataLanguage.mockReturnValue({ titleLang: null, textLang: null });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/browse — A4a: access filter forwarding to getFilteredRecentlyAddedMedia', () => {
    it('forwards deniedGroupIds into getFilteredRecentlyAddedMedia for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);

        expect(res.status).toBe(200);
        expect(mockGetFilteredRecentlyAddedMedia).toHaveBeenCalledWith(
            expect.anything(), // sql
            expect.objectContaining({
                access: expect.objectContaining({
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                }),
            }),
        );
    });

    it('forwards ageRating into getFilteredRecentlyAddedMedia for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetFilteredRecentlyAddedMedia).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: expect.objectContaining({
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                }),
            }),
        );
    });

    it('forwards deniedGroupIds + ageRating together into getFilteredRecentlyAddedMedia', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetFilteredRecentlyAddedMedia).toHaveBeenCalledWith(
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

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockGetFilteredRecentlyAddedMedia).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: { library: { kind: 'all' }, age: { kind: 'any' } },
            }),
        );
    });
});

describe('GET /api/browse — A4a: access filter forwarding to buildBrowseGenreSections', () => {
    it('forwards deniedGroupIds + ageRating into buildBrowseGenreSections for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockBuildBrowseGenreSections).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: {
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                },
            }),
        );
    });

    it('passes an unrestricted boundary into buildBrowseGenreSections for an unrestricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockBuildBrowseGenreSections).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: { library: { kind: 'all' }, age: { kind: 'any' } },
            }),
        );
    });
});

describe('GET /api/browse — A4b: restricted user bypasses shared recently-added cache', () => {
    /**
     * index.ts computes:
     *   const cacheKey =
     *     accessCtx.deniedGroupIds === null && accessCtx.ageRating === null
     *       ? `titles-v1:${mediaType}`
     *       : null;
     *
     * When cacheKey is null the handler skips both recentlyAddedCache.get and
     * recentlyAddedCache.set — a restricted user never poisons the unrestricted
     * slot and never receives stale unrestricted data from it.
     */

    it('does NOT write to the recently-added cache for a restricted user (cacheKey is null)', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);

        expect(res.status).toBe(200);
        expect(mockRecentCacheSet).not.toHaveBeenCalled();
    });

    it('does NOT read from the recently-added cache for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        // Pre-load cache with unrestricted data — the restricted user must not consume it.
        mockRecentCacheGet.mockResolvedValue([makeRecentRow()]);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        // DB must still be queried because cache is bypassed for restricted users.
        expect(mockGetFilteredRecentlyAddedMedia).toHaveBeenCalled();
    });

    it('writes to the recently-added cache for an unrestricted user (cacheKey is non-null)', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);

        const handler = def.handlers.GET!;
        await handler(makeEvent(), CTX);

        expect(mockRecentCacheSet).toHaveBeenCalled();
        const [[key]] = mockRecentCacheSet.mock.calls as [[string, unknown][]];
        expect(key).toContain('titles-v1:');
    });

    it('serves an unrestricted user from the recently-added cache on a warm hit (DB not called)', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockRecentCacheGet.mockResolvedValue([makeRecentRow()]);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);

        expect(res.status).toBe(200);
        // Cache hit path — DB must not be queried.
        expect(mockGetFilteredRecentlyAddedMedia).not.toHaveBeenCalled();
    });
});

describe('GET /api/browse — 503 on dependency down', () => {
    it('returns 503 when DB is null', async () => {
        mockGetDb.mockReturnValue(null);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);

        expect(res.status).toBe(503);
        const body = await res.clone().json();
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('GET /api/browse — overview truncation follows ctx.surface', () => {
    /**
     * `overview` truncation (see truncate-overview.ts) is applied ONLY on the
     * internal surface — this def is also mounted at /api/v1/browse, which
     * must stay byte-identical for native clients. A dropped or flipped
     * `ctx.surface === 'internal'` gate at the response boundary would not
     * fail any OTHER test in this file (none of them use an overview long
     * enough to need truncation), so this pins it directly.
     */
    const LONG_OVERVIEW =
        'Awakening is a 2016 science fiction film. '.repeat(6) +
        'It is definitely over 150 characters long.';

    function makeLongRecentRow() {
        return { ...makeRecentRow(), overview: LONG_OVERVIEW };
    }

    function makeLongGenreSections() {
        return {
            genres: [
                {
                    genre: 'Sci-Fi',
                    items: [
                        {
                            id: '123e4567-e89b-42d3-a456-426614174002',
                            name: 'Contact',
                            type: 'movie' as const,
                            overview: LONG_OVERVIEW,
                        },
                    ],
                },
            ],
            totalGenres: 1,
            hasMoreGenres: false,
        };
    }

    it('trims recentlyAdded + genre item overviews to <=150 chars, ending with the ellipsis, on the internal surface', async () => {
        mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeLongRecentRow()]);
        mockBuildBrowseGenreSections.mockResolvedValue(makeLongGenreSections());

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.recentlyAdded[0].overview.length).toBeLessThanOrEqual(150);
        expect(body.recentlyAdded[0].overview.endsWith('...')).toBe(true);
        expect(body.genres[0].items[0].overview.length).toBeLessThanOrEqual(150);
        expect(body.genres[0].items[0].overview.endsWith('...')).toBe(true);
    });

    it('leaves recentlyAdded + genre item overviews FULL/untouched on the v1 surface', async () => {
        mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeLongRecentRow()]);
        mockBuildBrowseGenreSections.mockResolvedValue(makeLongGenreSections());

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), { ...CTX, surface: 'v1' as const });
        const body = await res.clone().json();

        expect(body.recentlyAdded[0].overview).toBe(LONG_OVERVIEW);
        expect(body.genres[0].items[0].overview).toBe(LONG_OVERVIEW);
    });
});

describe('GET /api/browse — metadata-language overlay (multilingual-media-metadata §5)', () => {
    /**
     * CRITICAL regression pin: both the recently-added cache (UnifiedCache L1,
     * live reference) and the genres cache can serve a warm hit. The overlay
     * must run on shallow clones of both so a translated title/overview is
     * never written back into either shared cache entry (mirrors
     * search/episodes.test.ts).
     */
    function makeGenreSections() {
        return {
            genres: [
                {
                    genre: 'Sci-Fi',
                    items: [
                        {
                            id: '123e4567-e89b-42d3-a456-426614174002',
                            name: 'Contact',
                            type: 'movie' as const,
                            overview: 'Primary genre overview',
                        },
                    ],
                },
            ],
            totalGenres: 1,
            hasMoreGenres: false,
        };
    }

    it('overlays localized title/overview onto both recently-added and genre items', async () => {
        mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeRecentRow()]);
        mockBuildBrowseGenreSections.mockResolvedValue(makeGenreSections());
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockApplyTranslationOverlay).toHaveBeenCalledTimes(1);
        expect(body.recentlyAdded[0].title).toBe('Lokalisierter Titel');
        expect(body.recentlyAdded[0].overview).toBe('Lokalisierte Beschreibung');
        expect(body.genres[0].items[0].title).toBe('Lokalisierter Titel');
        expect(body.genres[0].items[0].overview).toBe('Lokalisierte Beschreibung');
    });

    it('does not mutate the cached recently-added array (shared L1 reference stays primary-language)', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        // The cache holds mapped BrowseItems (name/type), not raw DB rows.
        const cachedRecent = [
            { id: '123e4567-e89b-42d3-a456-426614174001', name: 'Awakening', type: 'movie' },
        ];
        mockRecentCacheGet.mockResolvedValue(cachedRecent);
        mockBuildBrowseGenreSections.mockResolvedValue(EMPTY_GENRE_SECTIONS);
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de'];
        mockGetPlaybackPreferences.mockResolvedValue({
            metadata_language: 'de',
            metadata_title_language: 'de',
        });
        mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.recentlyAdded[0].title).toBe('Lokalisierter Titel');
        // The live cached reference must still hold the primary-language title —
        // an in-place mutation here would leak into every other user reading
        // the same warm cache entry.
        expect(cachedRecent[0].name).toBe('Awakening');
    });

    it('pays zero extra queries and skips the overlay when the feature is off', async () => {
        mockGetFilteredRecentlyAddedMedia.mockResolvedValue([makeRecentRow()]);
        mockBuildBrowseGenreSections.mockResolvedValue(makeGenreSections());
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(mockGetPlaybackPreferences).not.toHaveBeenCalled();
        expect(mockApplyTranslationOverlay).not.toHaveBeenCalled();
        expect(body.recentlyAdded[0].title).toBe('Awakening');
    });
});
