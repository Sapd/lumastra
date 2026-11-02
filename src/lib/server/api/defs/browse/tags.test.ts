// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/tags.ts (GET /api/browse/tags).
 *
 * The endpoint exists so a typeahead can suggest keywords without a client
 * hardcoding a list that drifts from the catalog, so the contract worth
 * pinning is:
 *   - the response shape is { keyword, count } under `tags`
 *   - `q` is forwarded as the raw prefix, and `limit` becomes `max`
 *   - a facet-query failure propagates rather than resolving to an empty
 *     list — the deliberate opposite of /browse/az's degrade-to-[] policy,
 *     because this endpoint's entire payload IS the facet list
 *
 * All external I/O is mocked (no live DB).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockSearchKeywordFacets = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    searchKeywordFacets: (...args: unknown[]) => mockSearchKeywordFacets(...args),
}));

// Partial mock: stub only buildSearchAccessContext; let the real
// browseScopedCacheKey run so key-scoping is exercised end-to-end.
vi.mock('$lib/server/utils/search-access-context.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { browseAZ: 'browseAZ' },
    cacheManager: {
        for: () => ({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./tags.js');
import type { TagsQuery } from '$lib/schemas/browse.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Query defaults exactly as tagsQuerySchema produces them. */
const BASE_QUERY: TagsQuery = {
    type: 'all',
    audio: [],
    subs: [],
    includeUnknown: false,
    res: [],
    hdr: [],
    codec: [],
    qUnknown: false,
    limit: 20,
};

function ctxWith(query: Partial<TagsQuery> = {}) {
    return {
        surface: 'internal' as const,
        input: {
            query: { ...BASE_QUERY, ...query } as TagsQuery,
            body: undefined,
            params: undefined,
        },
    };
}

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/browse/tags');
    return {
        url,
        params: {},
        route: { id: '/api/browse/tags' as const },
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

const UNRESTRICTED_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: false,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    mockSearchKeywordFacets.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/browse/tags — response shape', () => {
    it('returns facets under `tags`', async () => {
        mockSearchKeywordFacets.mockResolvedValue([
            { keyword: 'time travel', count: 41 },
            { keyword: 'whodunit', count: 12 },
        ]);

        const res = await def.handlers.GET!(makeEvent(), ctxWith());
        const body = await res.clone().json();

        expect(res.status).toBe(200);
        expect(body.tags).toEqual([
            { keyword: 'time travel', count: 41 },
            { keyword: 'whodunit', count: 12 },
        ]);
    });

    it('response objects carry exactly the keys `count` and `keyword`', async () => {
        mockSearchKeywordFacets.mockResolvedValue([
            { keyword: 'time travel', count: 41 },
            { keyword: 'whodunit', count: 12 },
        ]);

        const res = await def.handlers.GET!(makeEvent(), ctxWith());
        const body = await res.clone().json();

        // Guard against the empty-list trap: a list with zero entries would
        // make the loop below vacuously pass without exercising anything.
        expect(body.tags.length).toBeGreaterThan(0);
        for (const tag of body.tags) {
            expect(Object.keys(tag).sort()).toEqual(['count', 'keyword']);
        }
    });
});

describe('GET /api/browse/tags — forwards the prefix and limit', () => {
    it('forwards `q` as the raw prefix and `limit` as `max`', async () => {
        await def.handlers.GET!(makeEvent(), ctxWith({ q: 'Time Tra', limit: 7 }));

        expect(mockSearchKeywordFacets).toHaveBeenCalledWith(
            expect.anything(),
            'Time Tra',
            expect.objectContaining({ max: 7 }),
        );
    });
});

describe('GET /api/browse/tags — genre cache-key case sensitivity', () => {
    /** Run the handler with `query` and return the cache key it wrote. */
    async function keyFor(query: Partial<TagsQuery>): Promise<string> {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({ query: vi.fn() });
        mockCacheGet.mockResolvedValue(null);
        mockCacheSet.mockResolvedValue(undefined);
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
        mockSearchKeywordFacets.mockResolvedValue([]);

        await def.handlers.GET!(makeEvent(), ctxWith(query));
        const [[key]] = mockCacheSet.mock.calls as Array<[string, unknown]>;
        return key;
    }

    it('keys `Action` and `action` separately — the SQL genre match is case-sensitive', async () => {
        // Collapsing these would serve one casing's counts to the other, per
        // buildGenreMembershipFilter's unnormalized `genre_name = ${genreName}`.
        expect(await keyFor({ genre: 'Action' })).not.toBe(await keyFor({ genre: 'action' }));
    });

    it('keys a literal `?genre=-` apart from "no genre filter"', async () => {
        expect(await keyFor({ genre: '-' })).not.toBe(await keyFor({ genre: undefined }));
    });
});

describe('GET /api/browse/tags — failures are propagated, not disguised as "no tags"', () => {
    it('returns 503 when DB is null', async () => {
        mockGetDb.mockReturnValue(null);

        const res = await def.handlers.GET!(makeEvent(), ctxWith());

        expect(res.status).toBe(503);
        const body = await res.clone().json();
        expect(body.code).toBe('dependency_unavailable');
    });

    it('lets a facet-query failure propagate — never a 200 with an empty (misleading) list', async () => {
        mockSearchKeywordFacets.mockRejectedValue(new Error('connection terminated'));

        // No local try/catch in the def: this endpoint's entire payload IS the
        // facet list, so the failure is left to bubble to mount()'s outer error
        // handler (which turns it into a 500) instead of resolving to `[]`.
        await expect(def.handlers.GET!(makeEvent(), ctxWith())).rejects.toThrow(
            'connection terminated',
        );
        expect(mockCacheSet).not.toHaveBeenCalled();
    });
});
