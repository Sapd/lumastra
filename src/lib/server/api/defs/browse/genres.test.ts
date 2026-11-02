// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/browse/genres.ts (GET /api/browse/genres).
 *
 * The endpoint exists so a client stops hardcoding a genre list that drifts from
 * the catalog, so the contract worth pinning is:
 *   - the response shape is { name, count } — `name` is what goes back as ?genre=
 *   - the caller's access boundary reaches the query (a restricted user must not
 *     see counts computed over libraries they cannot browse)
 *   - the cache key is access-scoped (no cross-user count leakage)
 *   - DB down → 503, not an empty list that reads as "no genres exist"
 *
 * All external I/O is mocked (no live DB).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockGetGenreFacetCounts = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getGenreFacetCounts: (...args: unknown[]) => mockGetGenreFacetCounts(...args),
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

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./genres.js');
import type { BrowseGenresQuery } from '$lib/schemas/browse.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Query defaults exactly as browseGenresQuerySchema produces them. */
const BASE_QUERY: BrowseGenresQuery = {
    type: 'all',
    audio: [],
    subs: [],
    includeUnknown: false,
    res: [],
    hdr: [],
    codec: [],
    qUnknown: false,
};

function ctxWith(query: Partial<BrowseGenresQuery> = {}) {
    return {
        surface: 'internal' as const,
        input: {
            query: { ...BASE_QUERY, ...query } as BrowseGenresQuery,
            body: undefined,
            params: undefined,
        },
    };
}

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/browse/genres');
    return {
        url,
        params: {},
        route: { id: '/api/browse/genres' as const },
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
    mockGetDb.mockReturnValue({ query: vi.fn() });
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    mockGetGenreFacetCounts.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/browse/genres — response shape', () => {
    it('maps rows to { name, count }, count-descending as the query returned them', async () => {
        mockGetGenreFacetCounts.mockResolvedValue([
            { genre: 'Action', count: 412 },
            { genre: 'Science Fiction', count: 77 },
        ]);

        const res = await def.handlers.GET!(makeEvent(), ctxWith());
        const body = await res.clone().json();

        expect(res.status).toBe(200);
        expect(body.genres).toEqual([
            { name: 'Action', count: 412 },
            { name: 'Science Fiction', count: 77 },
        ]);
    });

    it('echoes the applied type filter under `mediaType` and omits an unset libraryGroupId', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctxWith({ type: 'series' }));
        const body = await res.clone().json();

        expect(body.mediaType).toBe('series');
        expect(body).not.toHaveProperty('type');
        expect(body.libraryGroupId).toBeUndefined();
    });

    it('translates the canonical `series` filter to the DB discriminator `tv`', async () => {
        await def.handlers.GET!(makeEvent(), ctxWith({ type: 'series' }));

        expect(mockGetGenreFacetCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mediaType: 'tv' }),
        );
    });

    it('returns an empty list (not an error) for a catalog with no genres', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctxWith());
        const body = await res.clone().json();

        expect(res.status).toBe(200);
        expect(body.genres).toEqual([]);
    });
});

describe('GET /api/browse/genres — scoping', () => {
    it('forwards the restricted access boundary into the query', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);

        await def.handlers.GET!(makeEvent(), ctxWith());

        expect(mockGetGenreFacetCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                access: {
                    library: { kind: 'denyGroups', ids: RESTRICTED_CTX.deniedGroupIds },
                    age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                },
                availableOnly: true,
            }),
        );
    });

    it('forwards libraryGroupId and the language/quality filters so counts match /browse/az', async () => {
        await def.handlers.GET!(
            makeEvent(),
            ctxWith({
                libraryGroupId: 'grp-1111-0000-0000-000000000001',
                audio: ['ja'],
                res: ['4K'],
                qUnknown: true,
            }),
        );

        expect(mockGetGenreFacetCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                groupId: 'grp-1111-0000-0000-000000000001',
                audioLangs: ['ja'],
                resolutions: ['4K'],
                qualityIncludeUnknown: true,
            }),
        );
    });

    it('writes an access-scoped cache key for a restricted user', async () => {
        mockBuildSearchAccessContext.mockResolvedValue(RESTRICTED_CTX);
        await def.handlers.GET!(makeEvent(), ctxWith());
        const [[restrictedKey]] = mockCacheSet.mock.calls as [[string, unknown][]];

        vi.clearAllMocks();
        mockGetDb.mockReturnValue({ query: vi.fn() });
        mockCacheGet.mockResolvedValue(null);
        mockCacheSet.mockResolvedValue(undefined);
        mockGetGenreFacetCounts.mockResolvedValue([]);
        mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);

        await def.handlers.GET!(makeEvent(), ctxWith());
        const [[unrestrictedKey]] = mockCacheSet.mock.calls as [[string, unknown][]];

        expect(restrictedKey).not.toBe(unrestrictedKey);
        expect(restrictedKey).toContain('denied:');
    });

    it('serves a cache hit without touching the DB', async () => {
        mockCacheGet.mockResolvedValue([{ name: 'Action', count: 9 }]);

        const res = await def.handlers.GET!(makeEvent(), ctxWith());
        const body = await res.clone().json();

        expect(mockGetGenreFacetCounts).not.toHaveBeenCalled();
        expect(body.genres).toEqual([{ name: 'Action', count: 9 }]);
    });
});

describe('GET /api/browse/genres — tag axis (agrees with /browse/az)', () => {
    it('forwards `tag` into getGenreFacetCounts as `keyword` so counts narrow like /browse/az', async () => {
        await def.handlers.GET!(makeEvent(), ctxWith({ tag: 'whodunit' }));

        expect(mockGetGenreFacetCounts).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ keyword: 'whodunit' }),
        );
    });

    it('gives a tagged and an untagged request distinct cache keys', async () => {
        mockGetGenreFacetCounts.mockResolvedValue([{ genre: 'Action', count: 5 }]);

        await def.handlers.GET!(makeEvent(), ctxWith());
        await def.handlers.GET!(makeEvent(), ctxWith({ tag: 'whodunit' }));

        const keys = (mockCacheSet.mock.calls as [string, unknown][]).map(([k]) => k);
        expect(keys).toHaveLength(2);
        expect(keys[0]).not.toBe(keys[1]);
    });

    it('does not collide two different tags onto the same cache key', async () => {
        mockGetGenreFacetCounts.mockResolvedValue([{ genre: 'Action', count: 5 }]);

        await def.handlers.GET!(makeEvent(), ctxWith({ tag: 'whodunit' }));
        await def.handlers.GET!(makeEvent(), ctxWith({ tag: 'heist' }));

        const keys = (mockCacheSet.mock.calls as [string, unknown][]).map(([k]) => k);
        expect(keys).toHaveLength(2);
        expect(keys[0]).not.toBe(keys[1]);
    });
});

describe('GET /api/browse/genres — failures are reported, not disguised as "no genres"', () => {
    it('returns 503 when DB is null', async () => {
        mockGetDb.mockReturnValue(null);

        const res = await def.handlers.GET!(makeEvent(), ctxWith());

        expect(res.status).toBe(503);
        const body = await res.clone().json();
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns 500 when the query fails — never 200 with an empty list', async () => {
        mockGetGenreFacetCounts.mockRejectedValue(new Error('connection terminated'));

        const res = await def.handlers.GET!(makeEvent(), ctxWith());

        // This endpoint's entire payload IS the list, so an empty 200 is a lie the
        // client would render as a catalog with no genres (house rule: dependency
        // failure is never 200 + []).
        expect(res.status).toBe(500);
        expect(mockCacheSet).not.toHaveBeenCalled();
    });
});

describe('renamed library filter cache isolation', () => {
    it('separates selected libraries and user access scopes, including age', async () => {
        for (const access of [
            UNRESTRICTED_CTX,
            RESTRICTED_CTX,
            {
                ...UNRESTRICTED_CTX,
                username: 'child',
                ageRating: { maxAgeRating: 12, allowUnrated: false },
            },
        ]) {
            mockBuildSearchAccessContext.mockResolvedValue(access);
            for (const libraryGroupId of ['shelf-a', 'shelf-b']) {
                await def.handlers.GET!(makeEvent(), ctxWith({ libraryGroupId }));
            }
        }
        const keys = mockCacheSet.mock.calls.map(([key]) => key);
        expect(keys).toHaveLength(6);
        expect(new Set(keys).size).toBe(6);
        expect(keys.filter((key: string) => key.includes('shelf-a'))).toHaveLength(3);
        expect(mockGetGenreFacetCounts.mock.calls.map(([, options]) => options.groupId)).toEqual([
            'shelf-a',
            'shelf-b',
            'shelf-a',
            'shelf-b',
            'shelf-a',
            'shelf-b',
        ]);
    });
});
