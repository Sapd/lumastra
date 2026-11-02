// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
    unrestrictedAccess,
    restrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary';

vi.mock('$lib/server/services/music/genre-plan.service', () => ({
    computeGenrePlan: vi.fn(),
}));

const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
};
vi.mock('$lib/server/cache', () => ({
    cacheManager: {
        for: vi.fn(() => mockCache),
    },
    CACHE_NAMESPACES: {
        musicGenrePlan: {
            name: 'music-genre-plan-v1',
            l1TTL: 60000,
            l2TTL: 180000,
            description: 'test',
        },
    },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

import { computeGenrePlan } from '$lib/server/services/music/genre-plan.service';
import { computeGenrePlanCached } from './genre-plan-cached.service';

const sqlStub = {} as postgres.Sql;

describe('computeGenrePlanCached', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCache.get.mockReset();
        mockCache.set.mockReset();
    });

    test('empty genreCarouselNames short-circuits without cache access', async () => {
        const plan = await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: [],
            access: unrestrictedAccess(),
        });
        expect(plan).toEqual({});
        expect(mockCache.get).not.toHaveBeenCalled();
        expect(computeGenrePlan).not.toHaveBeenCalled();
    });

    test('cache hit returns cached value without calling computeGenrePlan', async () => {
        const cached = { Rock: ['t1', 't2'], Pop: ['t3'] };
        mockCache.get.mockResolvedValue(cached);

        const plan = await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: ['rp1'],
            genreCarouselNames: ['Rock', 'Pop'],
            access: unrestrictedAccess(),
        });

        expect(plan).toEqual(cached);
        expect(mockCache.get).toHaveBeenCalledWith(expect.any(String), 'denis');
        expect(computeGenrePlan).not.toHaveBeenCalled();
        expect(mockCache.set).not.toHaveBeenCalled();
    });

    test('cache miss calls computeGenrePlan and writes result to cache', async () => {
        mockCache.get.mockResolvedValue(null);
        vi.mocked(computeGenrePlan).mockResolvedValue({ Rock: ['t1'] });

        const plan = await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });

        expect(plan).toEqual({ Rock: ['t1'] });
        expect(computeGenrePlan).toHaveBeenCalledTimes(1);
        expect(mockCache.set).toHaveBeenCalledTimes(1);
        const [key, value, , userId] = mockCache.set.mock.calls[0];
        expect(typeof key).toBe('string');
        expect(value).toEqual({ Rock: ['t1'] });
        expect(userId).toBe('denis');
    });

    test('cache get error falls through to computeGenrePlan', async () => {
        mockCache.get.mockRejectedValue(new Error('valkey down'));
        vi.mocked(computeGenrePlan).mockResolvedValue({ Rock: ['t1'] });

        const plan = await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });

        expect(plan).toEqual({ Rock: ['t1'] });
        expect(computeGenrePlan).toHaveBeenCalledTimes(1);
    });

    test('cache set error does not propagate (returns plan anyway)', async () => {
        mockCache.get.mockResolvedValue(null);
        mockCache.set.mockRejectedValue(new Error('valkey write failed'));
        vi.mocked(computeGenrePlan).mockResolvedValue({ Rock: ['t1'] });

        const plan = await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });

        expect(plan).toEqual({ Rock: ['t1'] });
    });

    test('cache hit filters stale excludes from the plan (matches current recently-played)', async () => {
        mockCache.get.mockResolvedValue({
            Rock: ['just-played-1', 'still-fresh-1', 'still-fresh-2'],
            Pop: ['just-played-1', 'pop-only-1'],
        });

        const plan = await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: ['just-played-1'],
            genreCarouselNames: ['Rock', 'Pop'],
            access: unrestrictedAccess(),
        });

        expect(plan.Rock).toEqual(['still-fresh-1', 'still-fresh-2']);
        expect(plan.Pop).toEqual(['pop-only-1']);
        expect(computeGenrePlan).not.toHaveBeenCalled();
    });

    test('empty userId bypasses cache entirely', async () => {
        vi.mocked(computeGenrePlan).mockResolvedValue({ Rock: ['t1'] });

        const plan = await computeGenrePlanCached(sqlStub, '', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });

        expect(plan).toEqual({ Rock: ['t1'] });
        expect(mockCache.get).not.toHaveBeenCalled();
        expect(mockCache.set).not.toHaveBeenCalled();
        expect(computeGenrePlan).toHaveBeenCalledTimes(1);
    });

    test('whitespace-only userId bypasses cache entirely', async () => {
        vi.mocked(computeGenrePlan).mockResolvedValue({ Rock: ['t1'] });

        const plan = await computeGenrePlanCached(sqlStub, '   ', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });

        expect(plan).toEqual({ Rock: ['t1'] });
        expect(mockCache.get).not.toHaveBeenCalled();
    });

    test('cache key uses JSON.stringify to avoid pipe collisions', async () => {
        mockCache.get.mockResolvedValue(null);
        vi.mocked(computeGenrePlan).mockResolvedValue({});

        await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['A|B', 'C'],
            access: unrestrictedAccess(),
        });
        const keyAB = mockCache.get.mock.calls[0][0];

        mockCache.get.mockClear();

        await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['A', 'B', 'C'],
            access: unrestrictedAccess(),
        });
        const keyABC = mockCache.get.mock.calls[0][0];

        expect(keyAB).not.toBe(keyABC);
    });

    test('cache key differs per access boundary for the same user and genres', async () => {
        mockCache.get.mockResolvedValue(null);
        vi.mocked(computeGenrePlan).mockResolvedValue({});

        await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: unrestrictedAccess(),
        });
        const keyOpen = mockCache.get.mock.calls[0][0];

        mockCache.get.mockClear();

        await computeGenrePlanCached(sqlStub, 'denis', {
            recentlyPlayedIds: [],
            genreCarouselNames: ['Rock'],
            access: restrictedAccess({
                deniedGroupIds: ['g1'],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        });
        const keyRestricted = mockCache.get.mock.calls[0][0];

        // A plan drawn under one boundary must never be served under another
        // (a user moved out of a group would keep seeing its tracks).
        expect(keyRestricted).not.toBe(keyOpen);
    });
});
