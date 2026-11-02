// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the folded curated-rail thin adapters
 * (GET /api/for-you/{random-picks,recently-added,popular-shows,fresh-releases,
 * short-movies,binge-worthy,anime}).
 *
 * Each adapter delegates to the shared `getRailItems` dispatch and re-wraps the
 * result in the legacy `paginate(items, page)` envelope. These tests mock
 * `getRailItems` + `buildAccessContext` and assert:
 *   - the correct rail `type` is dispatched,
 *   - rail-specific query params map onto RecommenderOptions (watched CSVs → extra),
 *   - the canonical RecommendationItem shape (media/score/reason + images) passes
 *     through unchanged — the public compat contract,
 *   - the error contract (401 no-auth, 403 anime age-gate, 503 dependency-down).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { AccessContext, RecommendationItem } from '../recommendations/recommender.js';
import type { UserId } from '$lib/shared/user-id';
import { DependencyUnavailableError } from '$lib/server/api/problem.js';

vi.mock('../recommendations/recommender.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../recommendations/recommender.js')>();
    return {
        ...actual,
        buildAccessContext: vi.fn(),
        getRailItems: vi.fn(),
    };
});

import { getRailItems, buildAccessContext } from '../recommendations/recommender.js';

import { def as randomPicksDef } from './random-picks.js';
import { def as recentlyAddedDef } from './recently-added.js';
import { def as popularShowsDef } from './popular-shows.js';
import { def as freshReleasesDef } from './fresh-releases.js';
import { def as shortMoviesDef } from './short-movies.js';
import { def as bingeWorthyDef } from './binge-worthy.js';
import { def as animeDef } from './anime.js';

const mockedGetRailItems = vi.mocked(getRailItems);
const mockedBuildAccessContext = vi.mocked(buildAccessContext);

const FAKE_CTX: AccessContext = {
    userId: 'user-1' as UserId,
    username: 'alice',
    deniedGroupIds: null,
    maxAgeRating: null,
    allowUnrated: true,
    showUnavailableMedia: true,
    isAgeRestricted: false,
};

/** A canonical RecommendationItem carrying every legacy shape key. */
const SAMPLE_ITEM: RecommendationItem = {
    media: {
        id: 'uuid-1',
        type: 'movie',
        title: 'Sample Movie',
        year: 2020,
        ids: { internal: 'uuid-1', tmdb: '550' },
        images: { poster: { href: '/api/image/catalog/uuid-1/poster' } },
    },
    score: 0.7,
    reason: { kind: 'editorial' },
};

function makeEvent(
    path: string,
    search = '',
    user: Record<string, unknown> | undefined = { userId: 'user-1', username: 'alice' },
): RequestEvent {
    const url = new URL(`http://localhost${path}${search}`);
    return { url, locals: { user } } as unknown as RequestEvent;
}

const FAKE_API_CTX = {} as ApiContext;

// Every migrated adapter exposes a GET handler.
function callGet(def: typeof randomPicksDef, event: RequestEvent): Promise<Response> {
    const handler = def.handlers.GET;
    if (!handler) throw new Error('GET handler missing');
    return Promise.resolve(handler(event, FAKE_API_CTX));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedBuildAccessContext.mockResolvedValue(FAKE_CTX);
    mockedGetRailItems.mockResolvedValue({ items: [SAMPLE_ITEM], hasMore: false });
});

describe('curated-rail thin adapters — shape + dispatch', () => {
    const cases: Array<{ name: string; def: typeof randomPicksDef; type: string; path: string }> = [
        {
            name: 'random-picks',
            def: randomPicksDef,
            type: 'random-picks',
            path: '/api/for-you/random-picks',
        },
        {
            name: 'recently-added',
            def: recentlyAddedDef,
            type: 'recently-added',
            path: '/api/for-you/recently-added',
        },
        {
            name: 'popular-shows',
            def: popularShowsDef,
            type: 'popular-shows',
            path: '/api/for-you/popular-shows',
        },
        {
            name: 'fresh-releases',
            def: freshReleasesDef,
            type: 'fresh-releases',
            path: '/api/for-you/fresh-releases',
        },
        {
            name: 'short-movies',
            def: shortMoviesDef,
            type: 'short-movies',
            path: '/api/for-you/short-movies',
        },
        {
            name: 'binge-worthy',
            def: bingeWorthyDef,
            type: 'binge-worthy',
            path: '/api/for-you/binge-worthy',
        },
        { name: 'anime', def: animeDef, type: 'anime', path: '/api/for-you/anime' },
    ];

    for (const c of cases) {
        it(`${c.name}: dispatches type='${c.type}' and preserves the legacy item shape`, async () => {
            const res = await callGet(c.def, makeEvent(c.path, '?limit=5'));
            expect(res.status).toBe(200);

            // Correct rail dispatched.
            expect(mockedGetRailItems).toHaveBeenCalledTimes(1);
            const [dispatchedType, ctxArg, opts] = mockedGetRailItems.mock.calls[0];
            expect(dispatchedType).toBe(c.type);
            expect(ctxArg).toBe(FAKE_CTX);
            expect(opts.limit).toBe(5);

            // Legacy envelope + item shape survives unchanged.
            const body = (await res.json()) as {
                items: RecommendationItem[];
                page: { limit: number; offset: number; hasMore: boolean };
            };
            expect(Array.isArray(body.items)).toBe(true);
            expect(body.page).toEqual({ limit: 5, offset: 0, hasMore: false });

            const item = body.items[0];
            expect(item.media.id).toBe('uuid-1');
            expect(item.media.type).toBe('movie');
            expect(item.media.title).toBe('Sample Movie');
            expect(item.media.year).toBe(2020);
            expect(item.media.ids).toEqual({ internal: 'uuid-1', tmdb: '550' });
            expect(item.media.images?.poster?.href).toBe('/api/image/catalog/uuid-1/poster');
            expect(item.score).toBe(0.7);
            expect(item.reason?.kind).toBe('editorial');
        });
    }

    it('applies each rail default limit when none is supplied (random-picks → 20)', async () => {
        await callGet(randomPicksDef, makeEvent('/api/for-you/random-picks'));
        expect(mockedGetRailItems.mock.calls[0][2].limit).toBe(20);
    });
});

describe('rail-specific params map onto RecommenderOptions.extra', () => {
    it('fresh-releases forwards watched= CSV as extra.watchedTmdbIds', async () => {
        await callGet(
            freshReleasesDef,
            makeEvent('/api/for-you/fresh-releases', '?watched=550,551,notanumber'),
        );
        const opts = mockedGetRailItems.mock.calls[0][2];
        expect(opts.extra).toEqual({ watchedTmdbIds: [550, 551] });
    });

    it('short-movies forwards watched= CSV as extra.watchedTmdbIds', async () => {
        await callGet(shortMoviesDef, makeEvent('/api/for-you/short-movies', '?watched=42'));
        expect(mockedGetRailItems.mock.calls[0][2].extra).toEqual({ watchedTmdbIds: [42] });
    });

    it('binge-worthy forwards watched= + watchedIds= as extra.watchedTmdbIds + watchedUuids', async () => {
        await callGet(
            bingeWorthyDef,
            makeEvent('/api/for-you/binge-worthy', '?watched=7&watchedIds=uuid-a,uuid-b'),
        );
        expect(mockedGetRailItems.mock.calls[0][2].extra).toEqual({
            watchedTmdbIds: [7],
            watchedUuids: ['uuid-a', 'uuid-b'],
        });
    });

    it('anime forwards watched= + watchedIds= as extra', async () => {
        await callGet(animeDef, makeEvent('/api/for-you/anime', '?watched=9&watchedIds=uuid-c'));
        expect(mockedGetRailItems.mock.calls[0][2].extra).toEqual({
            watchedTmdbIds: [9],
            watchedUuids: ['uuid-c'],
        });
    });

    it('omits extra entirely when no watched params are supplied', async () => {
        await callGet(freshReleasesDef, makeEvent('/api/for-you/fresh-releases'));
        expect(mockedGetRailItems.mock.calls[0][2].extra).toBeUndefined();
    });
});

describe('error contract', () => {
    it('returns 401 when there is no access context', async () => {
        mockedBuildAccessContext.mockResolvedValue(null);
        const res = await callGet(randomPicksDef, makeEvent('/api/for-you/random-picks'));
        expect(res.status).toBe(401);
        expect(mockedGetRailItems).not.toHaveBeenCalled();
    });

    it('anime returns 403 for age-restricted profiles WITHOUT dispatching', async () => {
        const res = await callGet(
            animeDef,
            makeEvent('/api/for-you/anime', '', {
                userId: 'user-1',
                username: 'alice',
                isAgeRestricted: true,
            }),
        );
        expect(res.status).toBe(403);
        expect(mockedGetRailItems).not.toHaveBeenCalled();
    });

    it('maps a dependency-down throw to 503', async () => {
        mockedGetRailItems.mockRejectedValue(
            new DependencyUnavailableError('Database unavailable', 'postgres'),
        );
        const res = await callGet(popularShowsDef, makeEvent('/api/for-you/popular-shows'));
        expect(res.status).toBe(503);
    });
});
