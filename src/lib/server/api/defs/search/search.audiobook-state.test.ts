// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression guard for defs/search/search.ts (GET /api/v1/search): audiobook
 * listening state MUST NOT reach the result-page cache.
 *
 * The 45s page cache is keyed on (query, access scope, …) — NOT on the viewer.
 * Two users inside one access scope share the entry, so a viewer's own
 * progress/finished flags may only ever be applied AFTER the cache read, on a
 * per-request clone. Cache the decorated payload instead and user A's position
 * in a book is served to user B for the rest of the TTL.
 *
 * Mirrors the mocking in search.language-cache.test.ts (the same invariant, one
 * field-set over), plus the LOCAL catalog path audiobook rows arrive through —
 * they used to come from a live AudiobookShelf call through the external
 * aggregator, which matched the raw query as one contiguous substring.
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
const mockSearchMedia = vi.fn();
const mockSearchMediaFulltext = vi.fn();
const mockSearchMediaTrigram = vi.fn();
const mockSearchEpisode = vi.fn();
const mockSearchMusic = vi.fn();
const mockGetDeniedLibraryGroups = vi.fn();
const mockToLibraryAccessUser = vi.fn();
const mockParseEpisodeQuery = vi.fn();
const mockSearchAcrossServices = vi.fn();
const mockBatchResolveExternalIds = vi.fn();
const mockBatchGetUserWatchStates = vi.fn();
const mockGetAbsItemIdsByMediaIds = vi.fn();

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

vi.mock('$lib/server/services/media-aggregation.service.js', () => ({
    MediaAggregationService: {
        searchAcrossServices: (...args: unknown[]) => mockSearchAcrossServices(...args),
    },
}));

vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    batchResolveExternalIds: (...args: unknown[]) => mockBatchResolveExternalIds(...args),
}));

vi.mock('$lib/server/database/queries/audiobooks.queries.js', () => ({
    AUDIOBOOKSHELF_PROVIDER: 'audiobookshelf',
    AUDIOBOOK_MEDIA_TYPE: 'audiobook',
    getAbsItemIdsByMediaIds: (...args: unknown[]) => mockGetAbsItemIdsByMediaIds(...args),
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    batchGetUserWatchStates: {
        all: (...args: unknown[]) => mockBatchGetUserWatchStates(...args),
    },
}));

const mockConfig = {
    SHOW_UNAVAILABLE_MEDIA_IN_SEARCH: false,
    SEARCH_TYPO_TOLERANCE: 'off',
    SEARCH_TYPO_MIN_RESULTS: 3,
    UNRATED_CONTENT_VISIBLE: false,
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: { audiobooks: true } as Record<string, unknown>,
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
    }),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

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

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./search.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX = { surface: 'v1' as const };
const BOOK_UUID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ABS_ID = 'li_book_1';

function makeEvent(userId: string | null): RequestEvent {
    const url = new URL('http://localhost/api/v1/search');
    url.searchParams.set('q', 'grimm');

    return {
        url,
        params: {},
        route: { id: '/api/v1/search' as const },
        request: new Request(url.toString()),
        locals: userId
            ? {
                  user: {
                      userId,
                      username: 'alice',
                      groups: '',
                      userGroups: [],
                      isAdmin: false,
                      maxAgeRating: null,
                  },
              }
            : {},
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function callSearch(userId: string | null): Promise<Response> {
    return def.handlers.GET!(makeEvent(userId), CTX);
}

/** One `is_watched`/position row as `user_media_state` returns it. */
function state(overrides: { is_watched?: boolean; position?: number; runtime?: number | null }) {
    return {
        media_id: BOOK_UUID,
        is_watched: overrides.is_watched ?? false,
        resume_position_ms: overrides.position ?? 0,
        runtime_ms: overrides.runtime === undefined ? 3_600_000 : overrides.runtime,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    searchCacheStore.clear();
    searchSingleFlightStore.clear();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockGetDeniedLibraryGroups.mockResolvedValue(null);
    mockToLibraryAccessUser.mockReturnValue({});
    mockParseEpisodeQuery.mockReturnValue(null);
    mockSearchMedia.mockResolvedValue([]);
    // The book is a `media_items` row now, found by the same fulltext primitive
    // movies and episodes use — dispatch on the requested media types so the
    // episode lane in the same fan-out still sees nothing.
    mockSearchMediaFulltext.mockImplementation(
        async (_sql: unknown, _q: unknown, _access: unknown, opts?: { mediaTypes?: string[] }) =>
            opts?.mediaTypes?.includes('audiobook')
                ? [
                      {
                          internal_id: BOOK_UUID,
                          title: 'Grimms Märchen',
                          overview: null,
                          release_date: '2019-01-01',
                          rank: 1,
                          match_source: 'title',
                      },
                  ]
                : [],
    );
    mockSearchMediaTrigram.mockResolvedValue([]);
    mockSearchEpisode.mockResolvedValue([]);
    mockSearchMusic.mockResolvedValue([]);
    mockGetAbsItemIdsByMediaIds.mockResolvedValue(new Map([[BOOK_UUID, ABS_ID]]));
    mockSearchAcrossServices.mockResolvedValue({ items: [] });
    mockBatchResolveExternalIds.mockResolvedValue(new Map());
    mockBatchGetUserWatchStates.mockResolvedValue([]);
});

describe('audiobook listening state in search', () => {
    it('decorates a part-way book with progress and no played flag', async () => {
        mockBatchGetUserWatchStates.mockResolvedValue([state({ position: 900_000 })]);

        const body = await (await callSearch('u1')).json();
        const book = body.items.find((i: { type: string }) => i.type === 'audiobook');

        expect(book).toMatchObject({
            id: BOOK_UUID,
            progress: {
                positionMs: 900_000,
                durationMs: 3_600_000,
                fraction: 0.25,
                finished: false,
            },
        });
        expect(book.isPlayed).toBeUndefined();
    });

    it('marks a finished book played and full despite its reset position', async () => {
        mockBatchGetUserWatchStates.mockResolvedValue([state({ is_watched: true, position: 0 })]);

        const body = await (await callSearch('u1')).json();
        const book = body.items.find((i: { type: string }) => i.type === 'audiobook');

        expect(book).toMatchObject({ progress: { positionMs: 0, fraction: 1, finished: true } });
    });

    it('keeps position with null duration and fraction when duration is unknown', async () => {
        mockBatchGetUserWatchStates.mockResolvedValue([
            state({ position: 900_000, runtime: null }),
        ]);

        const body = await (await callSearch('u1')).json();
        const book = body.items.find((i: { type: string }) => i.type === 'audiobook');

        expect(book.progress).toMatchObject({
            positionMs: 900_000,
            durationMs: null,
            fraction: null,
        });
        expect(book.isPlayed).toBeUndefined();
    });

    it('leaves an untouched book bare', async () => {
        const body = await (await callSearch('u1')).json();
        const book = body.items.find((i: { type: string }) => i.type === 'audiobook');

        expect(book.progress).toBeUndefined();
        expect(book.isPlayed).toBeUndefined();
    });

    it('never writes one viewer state into the shared page cache', async () => {
        // THE invariant. Same query, same access scope, two users: the second
        // reads the FIRST user's cached page, so if the decoration had been
        // cached, user two would inherit user one's progress.
        mockBatchGetUserWatchStates.mockResolvedValueOnce([
            state({ is_watched: true, position: 0 }),
        ]);
        const first = await (await callSearch('u1')).json();
        expect(first.items[0].progress.finished).toBe(true);

        mockBatchGetUserWatchStates.mockResolvedValueOnce([]);
        const second = await (await callSearch('u2')).json();

        expect(mockCacheGet).toHaveBeenCalled();
        expect(second.items[0].isPlayed).toBeUndefined();
        expect(second.items[0].progress).toBeUndefined();

        // And the payload actually handed to the cache carries no state at all.
        const cached = [...searchCacheStore.values()][0] as {
            items: Array<Record<string, unknown>>;
        };
        expect(cached.items[0].isPlayed).toBeUndefined();
        expect(cached.items[0].progress).toBeUndefined();
    });

    it('serves plain rows when the state read fails', async () => {
        mockBatchGetUserWatchStates.mockRejectedValue(new Error('db down'));

        const res = await callSearch('u1');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.items[0].progress).toBeUndefined();
    });

    it('does not query state for an anonymous caller', async () => {
        await callSearch(null);
        expect(mockBatchGetUserWatchStates).not.toHaveBeenCalled();
    });
});
