// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * GET /api/for-you/watching/sources
 *
 * I5: when the minority-media-type recent pool is empty, the endpoint
 * substitutes a random popular library title the user did NOT watch. That
 * fallback source must carry `reason: 'popular'` (not 'watched') so the
 * client renders an honest header instead of "Because you watched X".
 *
 * M4: seed selection must honor the configured `limit` (not hard-cap at 3),
 * and shuffling must be deterministic per (user, day) — not `Math.random()`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

type Row = {
    tmdb_id: string;
    media_type: 'movie' | 'tv';
    title: string;
    watched_at: Date;
    media_id: string;
};

function makeRow(type: 'movie' | 'tv', idx: number): Row {
    return {
        tmdb_id: `${type}-tmdb-${idx}`,
        media_type: type,
        title: `${type === 'movie' ? 'Movie' : 'Show'} ${idx}`,
        watched_at: new Date('2026-07-01T00:00:00Z'),
        media_id: `${type}-media-${idx}`,
    };
}

const mockAvailability = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/availability.queries.js', () => ({
    batchGetAvailability: mockAvailability,
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockIsFeedKindHidden = vi.fn().mockResolvedValue(false);
vi.mock('$lib/server/utils/feed-prefs-gate.js', () => ({
    isFeedKindHidden: (...args: unknown[]) => mockIsFeedKindHidden(...args),
}));

vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: (_req: unknown, username: string) => username,
}));

const mockGetUserIdByUsername = vi.fn().mockResolvedValue('user-1');
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: (...args: unknown[]) => mockGetUserIdByUsername(...args),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: (ids: Record<string, string | null | undefined>, provider: string) =>
        ids[provider] ?? undefined,
}));

vi.mock('$lib/utils/media-id-helpers.js', () => ({
    createExternalIdsFromProvider: (provider: string, id: string | number) => ({
        [provider]: String(id),
    }),
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

const mockMoviesAll = vi.fn();
const mockTvAll = vi.fn();
const mockGetRandomPopularItem = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/database/queries/index.js', () => ({
    getRecentWatchedMoviesWithEmbeddings: { all: (...args: unknown[]) => mockMoviesAll(...args) },
    getRecentWatchedTvWithEmbeddings: { all: (...args: unknown[]) => mockTvAll(...args) },
    getRandomPopularItem: (...args: unknown[]) => mockGetRandomPopularItem(...args),
}));

const mockFilterAccessibleRows = vi.fn().mockImplementation(async (_sql, rows) => rows);
vi.mock('$lib/server/utils/media-access-batch.js', async (importOriginal) => {
    // `unrestrictedAccess` is deliberately NOT mocked: the two watched-source
    // queries now take a required MediaAccessBoundary and the assertions below
    // check the REAL value that reaches them.
    const actual = await importOriginal<typeof import('$lib/server/utils/media-access-batch.js')>();
    return {
        ...actual,
        filterAccessibleRows: (...args: unknown[]) => mockFilterAccessibleRows(...args),
    };
});

const mockBuildSearchAccessContext = vi.hoisted(() => vi.fn());
const mockScopedCacheKey = vi.hoisted(() => vi.fn().mockReturnValue('ws-key'));
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    // `searchAccessBoundary` is deliberately NOT mocked: getRandomPopularItem now
    // takes a required MediaAccessBoundary, and the point of the assertion below
    // is that the REAL projection of the access context reaches it.
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
        scopedCacheKey: (...args: unknown[]) => mockScopedCacheKey(...args),
    };
});

const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: vi.fn().mockReturnValue({
            get: (...args: unknown[]) => mockCacheGet(...args),
            set: (...args: unknown[]) => mockCacheSet(...args),
        }),
    },
    CACHE_NAMESPACES: { watchingSources: { name: 'for-you-watching-sources-v1' } },
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    // Mirrors toMovieOrSeries: 'movie'/'tv' only, null for everything else.
    // Returning `t` unchanged for an unknown type (as this mock used to) would let
    // the test pass while production dropped the item.
    toMovieOrSeries: (t: string) => (t === 'tv' ? 'series' : t === 'movie' ? 'movie' : null),
    isMovie: (t: string) => t === 'movie',
    isSeries: (t: string) => t === 'tv' || t === 'series',
}));

const mockConfig: Record<string, unknown> = {
    DEFAULT_USER: 'default-user',
    FORYOU_SECOND_BECAUSE_SECTION: true,
    METADATA_ADDITIONAL_LANGUAGES: [] as string[],
};
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

const { def } = await import('./watching-sources.js');

function makeEvent(query = ''): RequestEvent {
    const url = new URL(`http://localhost/api/for-you/watching/sources${query}`);
    return {
        url,
        request: new Request(url),
        locals: { user: { userId: 'user-1', username: 'alice', isAgeRestricted: false } },
    } as unknown as RequestEvent;
}

async function callGet(query = ''): Promise<{
    status: number;
    body: {
        sources: Array<{ title: string; reason?: string }>;
        secondBecauseSource: { title: string; reason?: string } | null;
    };
}> {
    const handler = def.handlers.GET;
    if (!handler) throw new Error('GET handler missing');
    const res = await handler(makeEvent(query), {} as ApiContext);
    return { status: res.status, body: await res.json() };
}

describe('watching-sources — honest header for fallback because-row (I5)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGetUserIdByUsername.mockResolvedValue('user-1');
        mockIsFeedKindHidden.mockResolvedValue(false);
        mockCacheGet.mockResolvedValue(null);
        mockFilterAccessibleRows.mockImplementation(async (_sql, rows) => rows);
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: true,
        });
        mockConfig.FORYOU_SECOND_BECAUSE_SECTION = true;
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    });

    it('hides unavailable watched sources on fresh and cached reads without changing cached candidates', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: false,
        });
        mockConfig.FORYOU_SECOND_BECAUSE_SECTION = false;
        mockMoviesAll.mockResolvedValue([makeRow('movie', 0), makeRow('movie', 1)]);
        mockTvAll.mockResolvedValue([]);
        mockAvailability.mockResolvedValue(
            new Map([
                ['movie-media-0', true],
                ['movie-media-1', false],
            ]),
        );
        const first = await callGet();
        expect(first.body.sources.map((source) => source.title)).toEqual(['Movie 0']);
        const cached = {
            sources: [0, 1].map((index) => ({
                id: `movie-media-${index}`,
                title: `Movie ${index}`,
                type: 'movie',
                ids: {},
            })),
            secondBecauseSource: null,
        };
        mockCacheGet.mockResolvedValue(cached);
        expect((await callGet()).body.sources.map((source) => source.title)).toEqual(['Movie 0']);
        expect(cached.sources).toHaveLength(2);
        mockAvailability.mockResolvedValue(
            new Map([
                ['movie-media-0', true],
                ['movie-media-1', true],
            ]),
        );
        expect((await callGet()).body.sources.map((source) => source.title)).toEqual([
            'Movie 0',
            'Movie 1',
        ]);
    });

    it('tags the substituted popular fallback as reason "popular"', async () => {
        // Minority pool (tv) is completely empty, forcing the popular-item
        // fallback for secondBecauseSource.
        mockMoviesAll.mockResolvedValue([makeRow('movie', 0)]);
        mockTvAll.mockResolvedValue([]);
        mockGetRandomPopularItem.mockResolvedValue({
            internal_id: 'popular-media-1',
            primary_ext_id: 'popular-tmdb-1',
            media_type: 'tv',
            title: 'Drifting Clouds',
        });

        const { status, body } = await callGet();

        expect(status).toBe(200);
        expect(mockGetRandomPopularItem).toHaveBeenCalledTimes(1);
        // The access boundary must arrive as a real MediaAccessBoundary, not be
        // dropped. An unrestricted context projects to all/any; a restricted one
        // is covered by the case below.
        expect(mockGetRandomPopularItem).toHaveBeenCalledWith({}, 'tv', {
            library: { kind: 'all' },
            age: { kind: 'any' },
        });
        expect(body.secondBecauseSource).not.toBeNull();
        expect(body.secondBecauseSource?.title).toBe('Drifting Clouds');
        expect(body.secondBecauseSource?.reason).toBe('popular');
    });

    it("threads a RESTRICTED user's real boundary into the popular fallback", async () => {
        // Regression lock on the axis this migration exists to protect: before
        // the boundary was required, both access arguments were optional and a
        // dropped one silently returned unfiltered rows.
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: ['group-a'],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
            showUnavailableMedia: true,
        });
        mockMoviesAll.mockResolvedValue([makeRow('movie', 0)]);
        mockTvAll.mockResolvedValue([]);
        mockGetRandomPopularItem.mockResolvedValue(null);

        await callGet();

        expect(mockGetRandomPopularItem).toHaveBeenCalledWith({}, 'tv', {
            library: { kind: 'denyGroups', ids: ['group-a'] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
    });

    it('tags a genuine unselected watched item as reason "watched" (not popular)', async () => {
        // limit=2 selects exactly one movie + one tv; the *other* movie
        // remains available as a genuine (never-fabricated) secondBecause seed.
        mockMoviesAll.mockResolvedValue([makeRow('movie', 0), makeRow('movie', 1)]);
        mockTvAll.mockResolvedValue([makeRow('tv', 0)]);

        const { status, body } = await callGet('?limit=2');

        expect(status).toBe(200);
        expect(mockGetRandomPopularItem).not.toHaveBeenCalled();
        expect(body.secondBecauseSource).not.toBeNull();
        expect(body.secondBecauseSource?.reason).toBe('watched');
        expect(['Movie 0', 'Movie 1']).toContain(body.secondBecauseSource?.title);
    });

    it('genuine primary sources are always tagged "watched"', async () => {
        mockMoviesAll.mockResolvedValue([makeRow('movie', 0)]);
        mockTvAll.mockResolvedValue([makeRow('tv', 0)]);

        const { status, body } = await callGet('?limit=2');

        expect(status).toBe(200);
        expect(body.sources.length).toBeGreaterThan(0);
        for (const source of body.sources) {
            expect(source.reason).toBe('watched');
        }
    });
});

describe('watching-sources — seed limit + deterministic shuffle (M4)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGetUserIdByUsername.mockResolvedValue('user-1');
        mockIsFeedKindHidden.mockResolvedValue(false);
        mockCacheGet.mockResolvedValue(null);
        mockFilterAccessibleRows.mockImplementation(async (_sql, rows) => rows);
        mockBuildSearchAccessContext.mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: true,
        });
        mockConfig.FORYOU_SECOND_BECAUSE_SECTION = true;
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = [];
    });

    it('honors a configured limit greater than 3 when enough seeds exist', async () => {
        const movies = Array.from({ length: 6 }, (_, i) => makeRow('movie', i));
        const tv = Array.from({ length: 6 }, (_, i) => makeRow('tv', i));
        mockMoviesAll.mockResolvedValue(movies);
        mockTvAll.mockResolvedValue(tv);

        const { status, body } = await callGet('?limit=5');

        expect(status).toBe(200);
        expect(body.sources.length).toBe(5);
    });

    it('produces a stable seed order for a fixed (user, day)', async () => {
        const movies = Array.from({ length: 4 }, (_, i) => makeRow('movie', i));
        const tv = Array.from({ length: 4 }, (_, i) => makeRow('tv', i));
        mockMoviesAll.mockResolvedValue(movies);
        mockTvAll.mockResolvedValue(tv);

        const first = await callGet('?limit=4');
        const second = await callGet('?limit=4');

        expect(first.body.sources.map((s) => s.title)).toEqual(
            second.body.sources.map((s) => s.title),
        );
    });
});
