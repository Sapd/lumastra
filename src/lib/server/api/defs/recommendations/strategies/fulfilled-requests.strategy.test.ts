// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FulfilledRequestsStrategy — the "Your requests are ready" home rail caches its
 * pre-map rows. A repeat load must not go back to Seerr, two callers with
 * different access must never share an entry, and an empty list (which is
 * also what a Seerr failure looks like) is never remembered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext, RecommenderOptions } from '../recommender.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

const mockFetchFulfilled = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchFulfilledRequests: (...args: unknown[]) => mockFetchFulfilled(...args),
}));

const cacheStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { fulfilledRequests: { name: 'for-you-fulfilled-requests-v2' } },
    cacheManager: {
        for: () => ({
            get: async (k: string) => cacheStore.get(k) ?? null,
            set: async (k: string, v: unknown) => void cacheStore.set(k, v),
        }),
    },
}));

const { fulfilledRequestsStrategy } = await import('./fulfilled-requests.strategy.js');

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
    return {
        userId: 'u1' as UserId,
        username: 'Denis',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: false,
        isAgeRestricted: false,
        ...overrides,
    };
}

const opts = (extra: Partial<RecommenderOptions> = {}): RecommenderOptions =>
    ({ limit: 20, ...extra }) as RecommenderOptions;

const row = {
    externalIds: { internal: '11111111-1111-4111-8111-111111111111', tmdb: '1' },
    mediaType: 'movie',
    title: 'Ready',
    isAvailable: true,
};

describe('FulfilledRequestsStrategy cache', () => {
    beforeEach(() => {
        cacheStore.clear();
        mockFetchFulfilled.mockReset();
        mockFetchFulfilled.mockResolvedValue([row]);
    });

    it('serves a repeat load without asking Seerr again', async () => {
        const first = await fulfilledRequestsStrategy.fetch(ctx(), opts());
        const second = await fulfilledRequestsStrategy.fetch(ctx({ username: 'denis' }), opts());

        expect(first.items.map((i) => i.media.title)).toEqual(['Ready']);
        expect(second.items.map((i) => i.media.title)).toEqual(['Ready']);
        expect(mockFetchFulfilled).toHaveBeenCalledTimes(1);
    });

    it('filters unavailable requests before paging on fresh and cached reads, preserving cached candidates', async () => {
        const hidden = {
            ...row,
            isAvailable: false,
            title: 'Hidden',
            externalIds: { internal: '22222222-2222-4222-8222-222222222222', tmdb: '2' },
        };
        mockFetchFulfilled.mockResolvedValue([hidden, row]);
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await fulfilledRequestsStrategy.fetch(ctx(), opts({ limit: 1 }));
            expect(result.items.map((item) => item.media.title)).toEqual(['Ready']);
            expect(result.hasMore).toBe(false);
        }
        expect(
            (await fulfilledRequestsStrategy.fetch(ctx({ showUnavailableMedia: true }), opts()))
                .items,
        ).toHaveLength(2);
        expect(mockFetchFulfilled).toHaveBeenCalledTimes(1);
        expect([...cacheStore.values()]).toEqual([[hidden, row]]);
    });

    it('keeps callers with different access apart', async () => {
        await fulfilledRequestsStrategy.fetch(ctx(), opts());
        await fulfilledRequestsStrategy.fetch(ctx({ deniedGroupIds: ['g1'] }), opts());
        await fulfilledRequestsStrategy.fetch(ctx({ maxAgeRating: 12 }), opts());

        expect(mockFetchFulfilled).toHaveBeenCalledTimes(3);
    });

    it('never caches an empty list', async () => {
        mockFetchFulfilled.mockResolvedValueOnce([]);
        expect((await fulfilledRequestsStrategy.fetch(ctx(), opts())).items).toEqual([]);
        expect((await fulfilledRequestsStrategy.fetch(ctx(), opts())).items).toHaveLength(1);
        expect(mockFetchFulfilled).toHaveBeenCalledTimes(2);
    });

    it('refresh bypasses the cache', async () => {
        await fulfilledRequestsStrategy.fetch(ctx(), opts());
        await fulfilledRequestsStrategy.fetch(ctx(), opts({ refresh: true }));

        expect(mockFetchFulfilled).toHaveBeenCalledTimes(2);
    });
});

describe('FulfilledRequestsStrategy item mapping (home card subtitle)', () => {
    beforeEach(() => {
        cacheStore.clear();
        mockFetchFulfilled.mockReset();
    });

    it('does not put an internal token in reason and carries the release year', async () => {
        mockFetchFulfilled.mockResolvedValue([{ ...row, releaseDate: '2019-07-12' }]);

        const [item] = (await fulfilledRequestsStrategy.fetch(ctx(), opts())).items;

        expect(item.reason?.label).toBeUndefined();
        expect(item.media.year).toBe(2019);
    });

    it('omits the year when the request has no release date', async () => {
        mockFetchFulfilled.mockResolvedValue([{ ...row, releaseDate: undefined }]);

        const [item] = (await fulfilledRequestsStrategy.fetch(ctx(), opts())).items;

        expect(item.media.year).toBeUndefined();
        expect(item.reason?.label).toBeUndefined();
    });
});
