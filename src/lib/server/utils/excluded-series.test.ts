// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getExcludedSeriesKeys caching: the keys it writes are the keys
 * invalidateExcludedSeriesCache deletes, and the short TTL applies only while
 * a TMDB mute has no catalog item, including on the username backfill.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, setCalls, loadMock } = vi.hoisted(() => ({
    store: new Map<string, unknown>(),
    setCalls: [] as Array<{ key: string; scope: string; ttl: number | undefined }>,
    loadMock: vi.fn(),
}));

vi.mock('$lib/server/cache', () => ({
    CACHE_NAMESPACES: { excludedSeries: 'excludedSeries' },
    cacheManager: {
        for: () => ({
            get: async (key: string, scope: string) => store.get(`${scope}|${key}`) ?? null,
            set: async (key: string, value: unknown, ttl: number | undefined, scope: string) => {
                setCalls.push({ key, scope, ttl });
                store.set(`${scope}|${key}`, value);
            },
            delete: async (key: string, scope: string) => {
                store.delete(`${scope}|${key}`);
            },
        }),
    },
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries', () => ({
    getUserIdByUsername: async () => 'user-uuid',
}));
vi.mock('$lib/server/services/series-interest.service', () => ({
    loadSeriesExclusionsForUser: (...args: unknown[]) => loadMock(...args),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

import { getExcludedSeriesKeys, invalidateExcludedSeriesCache } from './excluded-series';

function exclusions(unresolvedTmdb: boolean) {
    return {
        itemIds: new Set(['a']),
        tmdbTv: new Set(['1']),
        tmdbMovie: new Set<string>(),
        tvdbTv: new Set<string>(),
        unresolvedTmdb,
    };
}

describe('getExcludedSeriesKeys cache', () => {
    beforeEach(() => {
        store.clear();
        setCalls.length = 0;
        loadMock.mockReset();
    });

    it('re-reads the database after invalidateExcludedSeriesCache', async () => {
        loadMock.mockResolvedValue(exclusions(false));

        await getExcludedSeriesKeys('alice');
        await getExcludedSeriesKeys('alice');
        expect(loadMock).toHaveBeenCalledTimes(1);

        await invalidateExcludedSeriesCache('user-uuid', 'alice');
        await getExcludedSeriesKeys('alice');
        expect(loadMock).toHaveBeenCalledTimes(2);
    });

    it('uses the default TTL when every TMDB key resolved', async () => {
        loadMock.mockResolvedValue(exclusions(false));

        await getExcludedSeriesKeys('alice');

        expect(setCalls.map((c) => c.ttl)).toEqual([undefined, undefined]);
    });

    it('keeps the short TTL for an unresolved TMDB mute, also on the username backfill', async () => {
        loadMock.mockResolvedValue(exclusions(true));

        await getExcludedSeriesKeys('alice');
        const shortTtl = setCalls[0].ttl;
        expect(shortTtl).toBeGreaterThan(0);
        expect(setCalls[1].ttl).toBe(shortTtl);

        // Only the uid entry survives (e.g. a rename): the backfill must not
        // fall back to the long default.
        for (const key of [...store.keys()]) if (key.startsWith('alice|')) store.delete(key);
        setCalls.length = 0;
        await getExcludedSeriesKeys('alice');
        expect(loadMock).toHaveBeenCalledTimes(1);
        expect(setCalls).toEqual([expect.objectContaining({ scope: 'alice', ttl: shortTtl })]);
    });
});
