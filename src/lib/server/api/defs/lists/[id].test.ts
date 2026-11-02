// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for defs/lists/[id].ts GET (curated list items).
 *
 * `isAvailable`/`canRequest` were hardcoded `false`/`true` for every item in
 * every curated list (e.g. `apple-tv-all`, `netflix-movies`), regardless of
 * whether the title was actually in the library — unlike fetchTrending(),
 * which computes real availability via lookupAvailabilityByTmdbIds(). This
 * locks the fix: an item present in the availability map reports its real
 * flags; an item absent from it (not in the library) keeps the previous
 * not-available/requestable default.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get: mockCacheGet, set: mockCacheSet }) },
    CACHE_NAMESPACES: { curatedLists: 'curatedLists' },
}));

const mockGetCachedListItems = vi.fn();
const mockSyncList = vi.fn();
vi.mock('$lib/server/ai/list-sync.js', () => ({
    getCachedListItems: (...args: unknown[]) => mockGetCachedListItems(...args),
    syncList: (...args: unknown[]) => mockSyncList(...args),
    CURATED_LISTS: [
        { list_id: 'apple-tv-all', name: 'Apple TV+ All', list_path: 'x', media_type: 'mixed' },
    ],
}));

const mockGetMediaEmbeddingsByKeys = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getDatabase: async () => ({
            getMediaEmbeddingsByKeys: (...args: unknown[]) => mockGetMediaEmbeddingsByKeys(...args),
        }),
    },
}));

// Truthy sentinel — only used as a token passed to the mocked query modules below.
const FAKE_SQL = {} as never;
const mockGetDb = vi.fn(() => FAKE_SQL as unknown);
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const mockBuildSearchAccessContext = vi.fn();
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: () => ({ library: 'all', age: { kind: 'any' } }),
}));

// Pass-through to the real preview builder unless a test installs an override
// (items carrying a real internal id would otherwise hit the fake SQL token).
let previewOverride: ((...args: unknown[]) => unknown) | null = null;
vi.mock('$lib/server/services/media-preview.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/services/media-preview.service.js')>();
    return {
        ...actual,
        buildMediaPreviews: (...args: Parameters<typeof actual.buildMediaPreviews>) =>
            previewOverride ? previewOverride(...args) : actual.buildMediaPreviews(...args),
    };
});

const mockLookupAvailabilityByTmdbIds = vi.fn();
const mockLookupAvailabilityByInternalIds = vi.fn();
vi.mock('$lib/server/database/queries/for-you-helpers.queries.js', () => ({
    lookupAvailabilityByTmdbIds: (...args: unknown[]) => mockLookupAvailabilityByTmdbIds(...args),
    lookupAvailabilityByInternalIds: (...args: unknown[]) =>
        mockLookupAvailabilityByInternalIds(...args),
}));

const { def } = await import('./[id].js');

function makeEvent(listId = 'apple-tv-all'): RequestEvent {
    const url = new URL(`http://localhost/api/v1/lists/${listId}`);
    return {
        params: { id: listId },
        url,
        locals: { user: { userId: 'u1', username: 'alice', isAgeRestricted: false } },
        request: new Request(url),
    } as unknown as RequestEvent;
}

async function get(listId?: string): Promise<{
    status: number;
    body: {
        items: Array<{
            title: string;
            availability: { isAvailable: boolean; canRequest: boolean };
        }>;
    };
}> {
    const response = (await def.handlers.GET!(makeEvent(listId), {
        surface: 'v1',
    } as ApiContext)) as Response;
    return { status: response.status, body: await response.json() };
}

describe('GET /lists/{id} availability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheGet.mockResolvedValue(null);
        mockGetCachedListItems.mockResolvedValue([
            {
                list_id: 'apple-tv-all',
                rank: 1,
                internal_id: '',
                primary_ext_id: '550',
                imdb_id: null,
                media_type: 'movie',
                title: 'Owned Movie',
                release_year: 1999,
                score: 80,
                poster_path: null,
                overview: null,
            },
            {
                list_id: 'apple-tv-all',
                rank: 2,
                internal_id: '',
                primary_ext_id: '999',
                imdb_id: null,
                media_type: 'movie',
                title: 'Not In Library',
                release_year: 2024,
                score: 70,
                poster_path: null,
                overview: null,
            },
        ]);
        previewOverride = null;
        mockGetDb.mockReturnValue(FAKE_SQL);
        mockLookupAvailabilityByInternalIds.mockResolvedValue(new Map());
        mockGetMediaEmbeddingsByKeys.mockResolvedValue([]);
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: true,
        });
        mockLookupAvailabilityByTmdbIds.mockResolvedValue(
            new Map([
                [
                    '550:movie',
                    {
                        primary_ext_id: '550',
                        media_type: 'movie',
                        is_available: true,
                        can_request: false,
                    },
                ],
            ]),
        );
    });

    it('reports real availability for an item present in the availability map', async () => {
        const { status, body } = await get();

        expect(status).toBe(200);
        const owned = body.items.find((i) => i.title === 'Owned Movie');
        expect(owned?.availability).toEqual({ isAvailable: true, canRequest: false });
    });

    it('keeps the not-available/requestable default for an item absent from the map', async () => {
        const { body } = await get();

        const notInLibrary = body.items.find((i) => i.title === 'Not In Library');
        expect(notInLibrary?.availability).toEqual({ isAvailable: false, canRequest: true });
    });

    it('drops file-less items when unavailable media is not visible', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: false,
        });
        const { status, body } = await get();

        expect(status).toBe(200);
        expect(body.items.map((i) => i.title)).toEqual(['Owned Movie']);
    });

    it('applies the limit after dropping file-less items', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: false,
        });
        const row = (id: string, title: string, rank: number) => ({
            list_id: 'apple-tv-all',
            rank,
            internal_id: '',
            primary_ext_id: id,
            imdb_id: null,
            media_type: 'movie',
            title,
            release_year: 2000,
            score: 50,
            poster_path: null,
            overview: null,
        });
        mockGetCachedListItems.mockResolvedValue([
            row('999', 'Ghost A', 1),
            row('550', 'Owned Movie', 2),
            row('998', 'Ghost B', 3),
        ]);
        mockLookupAvailabilityByTmdbIds.mockResolvedValue(
            new Map([
                ['550:movie', { primary_ext_id: '550', media_type: 'movie', is_available: true }],
            ]),
        );
        const response = (await def.handlers.GET!(
            {
                ...makeEvent(),
                url: new URL('http://localhost/api/v1/lists/apple-tv-all?limit=1'),
            } as RequestEvent,
            { surface: 'v1' } as ApiContext,
        )) as Response;
        const body = (await response.json()) as {
            items: Array<{ title: string }>;
            truncated: boolean;
        };

        expect(body.items.map((i) => i.title)).toEqual(['Owned Movie']);
        expect(body.truncated).toBe(false);
    });

    describe('fail-closed when unavailable media is hidden', () => {
        const hidden = { deniedGroupIds: null, ageRating: null, showUnavailableMedia: false };

        it('drops every item when the database is unavailable for the access context', async () => {
            mockGetDb.mockReturnValue(null);
            mockBuildSearchAccessContext.mockResolvedValue(hidden);
            const { status, body } = await get();

            // buildMediaPreviews needs a DB, so this is the 503 problem; no item leaks.
            expect(status).toBe(503);
            expect(body).not.toHaveProperty('items');
        });

        it('drops every item when the access context cannot be built', async () => {
            mockBuildSearchAccessContext.mockRejectedValue(new Error('boom'));
            const { status, body } = await get();

            expect(status).toBe(200);
            expect(body.items).toEqual([]);
        });

        it('applies the restrictive default (no 500) when the availability lookup throws', async () => {
            mockBuildSearchAccessContext.mockResolvedValue(hidden);
            mockLookupAvailabilityByTmdbIds.mockRejectedValue(new Error('db down'));
            const { status, body } = await get();

            expect(status).toBe(200);
            expect(body.items).toEqual([]);
        });

        it('keeps items when the availability lookup throws but unavailable media is visible', async () => {
            mockLookupAvailabilityByTmdbIds.mockRejectedValue(new Error('db down'));
            const { status, body } = await get();

            expect(status).toBe(200);
            expect(body.items).toHaveLength(2);
        });

        it('resolves an item without a numeric primary id via its internal id', async () => {
            mockBuildSearchAccessContext.mockResolvedValue(hidden);
            const INTERNAL = '00000000-0000-4000-a000-0000000000b1';
            const GHOST = '00000000-0000-4000-a000-0000000000b2';
            const row = (primary: string, internal: string, title: string, rank: number) => ({
                list_id: 'apple-tv-all',
                rank,
                internal_id: internal,
                primary_ext_id: primary,
                imdb_id: null,
                media_type: 'movie',
                title,
                release_year: 2000,
                score: 50,
                poster_path: null,
                overview: null,
            });
            mockGetCachedListItems.mockResolvedValue([
                row('imdb-tt1', INTERNAL, 'Owned By Uuid', 1),
                row('imdb-tt2', GHOST, 'Ghost By Uuid', 2),
            ]);
            mockLookupAvailabilityByTmdbIds.mockResolvedValue(new Map());
            mockLookupAvailabilityByInternalIds.mockResolvedValue(
                new Map([
                    [
                        INTERNAL,
                        {
                            primary_ext_id: '',
                            media_type: 'movie',
                            is_available: true,
                            internal_id: INTERNAL,
                        },
                    ],
                    [
                        GHOST,
                        {
                            primary_ext_id: '',
                            media_type: 'movie',
                            is_available: false,
                            internal_id: GHOST,
                        },
                    ],
                ]),
            );
            previewOverride = async (_sql, _surface, items) => items;
            const { body } = await get();

            expect((body.items as unknown as Array<{ id: string; title: string }>).map((i) => [i.id, i.title])).toEqual([
                [INTERNAL, 'Owned By Uuid'],
            ]);
        });
    });

    it('passes the numeric TMDB ids from the list to the availability lookup', async () => {
        await get();

        expect(mockLookupAvailabilityByTmdbIds).toHaveBeenCalledWith(
            FAKE_SQL,
            expect.arrayContaining(['550', '999']),
            expect.anything(),
        );
    });
});

// A fresh install has every curated list configured but none synced (no MDBList
// key yet). Those used to 404 — a console error on every web Home load — although
// the list exists and is merely empty.
describe('GET /lists/{id} with nothing synced', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheGet.mockResolvedValue(null);
        mockGetCachedListItems.mockResolvedValue([]);
        mockSyncList.mockResolvedValue(undefined);
    });

    it('answers a configured list with 200 and no items', async () => {
        const { status, body } = await get('apple-tv-all');
        expect(status).toBe(200);
        expect(body).toEqual({
            items: [],
            truncated: false,
        });
        expect(mockSyncList).toHaveBeenCalledTimes(1);
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('still 404s an unknown list id', async () => {
        const { status } = await get('no-such-list');
        expect(status).toBe(404);
        expect(mockSyncList).not.toHaveBeenCalled();
    });
});
