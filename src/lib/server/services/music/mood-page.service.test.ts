// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context.js';

const { warm, get, set, recommendations } = vi.hoisted(() => ({
    warm: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    recommendations: vi.fn(),
}));
vi.mock('./collage-warmup.js', () => ({ warmMusicCollages: warm }));
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get, set }) },
    CACHE_NAMESPACES: { musicMoodRecommendations: { name: 'mood', l2TTL: 1000 } },
}));
vi.mock('$lib/server/cache/single-flight.js', () => ({
    getOrComputeSingleFlight: ({ compute }: { compute: () => Promise<string> }) => compute(),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({ scopedCacheKey: () => 'key' }));
vi.mock('$lib/server/database/queries/music-recommendations.queries.js', () => ({
    getMusicMoodRecommendations: recommendations,
}));
import { getCachedMoodPage, DEFAULT_MOOD_PAGE_LIMIT } from './mood-page.service.js';

it('warms the published mood cover candidates after computing the default page', async () => {
    get.mockResolvedValue(null);
    set.mockResolvedValue(undefined);
    recommendations.mockResolvedValue([{ id: 'track', album_id: 'album' }, { id: 'solo' }]);
    const sql = {} as Sql;
    const page = await getCachedMoodPage(
        sql,
        'happy',
        DEFAULT_MOOD_PAGE_LIMIT,
        {} as SearchAccessContext,
    );
    expect(warm).toHaveBeenCalledWith(sql, [page.rows.map((row) => row.album_id ?? row.id)]);
    expect(warm.mock.invocationCallOrder[0]).toBeGreaterThan(set.mock.invocationCallOrder[0]);
});
