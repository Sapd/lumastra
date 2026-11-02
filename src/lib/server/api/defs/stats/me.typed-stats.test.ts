// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/me/stats: typed response contract.
 *
 * Runs the real handler against a stubbed service and checks that the body
 * satisfies the DECLARED 200 schema, that `unavailable` carries typed reasons in
 * canonical order, that the cache keeps the INTERNAL shape, and that the old
 * kebab-case metric names are rejected with 422.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

vi.mock('$lib/server/config.js', () => ({
    features: { personalStats: true },
    config: { UNRATED_CONTENT_VISIBLE: false },
    isUnavailableMediaVisible: () => true,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/cache/library-group-permissions-cache.js')
    >('$lib/server/cache/library-group-permissions-cache.js');
    return { ...actual, getDeniedLibraryGroups: vi.fn(async () => null) };
});

const cacheSet = vi.fn(async () => undefined);
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personalStats: 'personalStats' },
    cacheManager: {
        for: () => ({ get: vi.fn(async () => null), set: cacheSet }),
    },
    buildVersionedCacheKey: (version: string, ...parts: (string | number)[]): string =>
        `${version}:${parts.join(':')}`,
}));

const overview = {
    totalWatchTimeSeconds: 90,
    totalWatchTimeFormatted: '1m',
    totalSessions: 4,
    uniqueContent: 1,
    completedCount: 1,
    abandonedCount: 0,
    avgCompletionPercentage: 100,
    moviesWatched: 1,
    episodesWatched: 0,
};

vi.mock('$lib/server/services/personal-stats.service.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/services/personal-stats.service.js')
    >('$lib/server/services/personal-stats.service.js');
    return {
        accessFingerprint: actual.accessFingerprint,
        personalStatsService: {
            getSessionCount: vi.fn(async () => 4),
            getOverviewStats: vi.fn(async () => overview),
            getRatingStats: vi.fn(async () => ({
                totalRatings: 3,
                avgRating: 7,
                medianRating: 7,
                distribution: [],
                ratingFrequency: 1,
            })),
            getWatchTimeStats: vi.fn(async () => {
                throw new Error('boom');
            }),
            getDeviceStats: vi.fn(async () => ({
                devices: [],
                primaryDevice: '',
                deviceCount: 0,
            })),
            getQualityStats: vi.fn(async () => ({
                totalSessions: 4,
                resolution: { uhd4k: 0, hd1080: 4, hd720: 0, sd: 0 },
            })),
            getFunRecords: vi.fn(async () => ({
                mostRewatchedMovies: [],
                mostRewatchedSeries: [],
                nightOwlScore: 0,
                bingeScore: 0,
                totalBingeDays: 0,
                longestStreak: 1,
                currentStreak: 1,
            })),
            getTopTitles: vi.fn(async () => ({ movies: [], shows: [] })),
        },
    };
});

import { def } from './me.js';
import { personalStatsService } from '$lib/server/services/personal-stats.service.js';
import { PublicPersonalStatsResponseSchema } from '$lib/schemas/public-personal-stats.js';

function user(): Record<string, unknown> {
    return {
        userId: ALICE,
        username: 'alice',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: false,
        isAdmin: false,
        maxAgeRating: null,
    };
}

async function get(query: string, input?: unknown): Promise<Response> {
    const url = new URL(`http://x/api/v1/me/stats${query}`);
    const locals = {
        user: user(),
        principal: { userId: ALICE, username: 'alice', isAdmin: false },
    };
    return (await def.handlers!.GET!(
        { url, locals } as never,
        { surface: 'v1', input } as never,
    )) as Response;
}

beforeEach(() => {
    cacheSet.mockClear();
});

describe('GET /me/stats typed response', () => {
    it('satisfies the declared 200 schema and types every unavailable reason', async () => {
        const res = await get('');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(PublicPersonalStatsResponseSchema.safeParse(body).success).toBe(true);

        // 4 sessions: peakHours(10), completion(5), genres(5), keywords(5) and tasteProfile(5)
        // need more; watchTime(3) is computed but throws.
        expect(Object.keys(body.metrics)).toEqual([
            'overview',
            'devices',
            'quality',
            'ratings',
            'records',
            'topTitles',
        ]);
        expect(body.unavailable).toEqual([
            { metric: 'watchTime', reason: 'failed' },
            {
                metric: 'peakHours',
                reason: 'insufficient_data',
                requiredSessions: 10,
                sessionCount: 4,
            },
            {
                metric: 'completion',
                reason: 'insufficient_data',
                requiredSessions: 5,
                sessionCount: 4,
            },
            { metric: 'genres', reason: 'insufficient_data', requiredSessions: 5, sessionCount: 4 },
            {
                metric: 'keywords',
                reason: 'insufficient_data',
                requiredSessions: 5,
                sessionCount: 4,
            },
            {
                metric: 'tasteProfile',
                reason: 'insufficient_data',
                requiredSessions: 5,
                sessionCount: 4,
            },
        ]);
    });

    it('serves millisecond units and keeps the INTERNAL shape in the cache', async () => {
        const body = await (await get('?include=overview')).json();
        expect(body.metrics.overview.totalWatchTimeMs).toBe(90_000);
        expect(body.metrics.overview.totalWatchTimeSeconds).toBeUndefined();
        expect(body.metrics.overview.totalWatchTimeFormatted).toBeUndefined();

        const stored = cacheSet.mock.calls[0] as unknown as [string, { stats: unknown }];
        expect(stored[1].stats).toEqual(overview);
    });

    it.each(['watch-time', 'top-titles', 'bogus', 'overview,peak-hours'])(
        'rejects include=%s with 422',
        async (include) => {
            const res = await get(`?include=${include}`);
            expect(res.status).toBe(422);
        },
    );

    it('accepts camelCase include names', async () => {
        const res = await get('?include=topTitles,overview');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Object.keys(body.metrics)).toEqual(['overview', 'topTitles']);
        expect(body.metrics.topTitles).toEqual({
            items: [],
            page: { limit: 30, offset: 0, hasMore: false, total: 0 },
        });
    });

    it('reports every requested metric failed when the session count cannot be read', async () => {
        vi.mocked(personalStatsService.getSessionCount).mockRejectedValueOnce(new Error('db'));
        const body = await (await get('?include=overview,peakHours')).json();
        expect(body.metrics).toEqual({});
        expect(body.unavailable).toEqual([
            { metric: 'overview', reason: 'failed' },
            { metric: 'peakHours', reason: 'failed' },
        ]);
    });

    it('reports a metric failed when its converted value breaks the schema', async () => {
        vi.mocked(personalStatsService.getOverviewStats).mockResolvedValueOnce({
            ...overview,
            totalSessions: Number.NaN,
        } as never);
        const res = await get('?include=overview');
        const body = await res.json();
        expect(PublicPersonalStatsResponseSchema.safeParse(body).success).toBe(true);
        expect(body.metrics).toEqual({});
        expect(body.unavailable).toEqual([{ metric: 'overview', reason: 'failed' }]);
    });

    it('pages the ranked metrics with the validated limit/offset from ctx.input', async () => {
        const body = await (
            await get('?include=topTitles', { query: { limit: 5, offset: 10 } })
        ).json();
        expect(body.metrics.topTitles.page).toMatchObject({ limit: 5, offset: 10 });
    });

    it('bounds limit and offset in the runtime query schema (out of range is a 422)', () => {
        const query = def.request!.query!;
        expect(query.safeParse({}).data).toMatchObject({ limit: 30, offset: 0 });
        for (const bad of [
            { limit: '0' },
            { limit: '101' },
            { offset: '-1' },
            { offset: '10001' },
            { limit: '1.5' },
        ]) {
            expect(query.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
        }
        expect(query.safeParse({ limit: '100', offset: '10000' }).success).toBe(true);
    });
});
