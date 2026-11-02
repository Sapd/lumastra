// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => {
    const fn = (() => Promise.resolve([])) as unknown as (...args: unknown[]) => Promise<unknown[]>;
    return fn;
});

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => sql },
}));
vi.mock('$lib/server/cache', () => ({
    cacheManager: { get: vi.fn(async () => null), mget: vi.fn(async () => []) },
    CACHE_NAMESPACES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
const getClusters = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/music/taste-clusters.service.js', () => ({
    getUserTasteClusters: getClusters,
}));
vi.mock('$lib/server/config.js', () => ({ features: { musicClustering: true } }));

import { loadMusicQuickPicksData } from './music-quick-picks-data';

describe('loadMusicQuickPicksData', () => {
    it('falls back for a ?userId= that is not a user id instead of "loading" forever', async () => {
        const data = await loadMusicQuickPicksData('not-a-uuid');
        expect(getClusters).not.toHaveBeenCalled();
        expect(data.selectedUserClusters).toBeNull();
        expect(data.selectedUserFallback).toBe(true);
    });
});
