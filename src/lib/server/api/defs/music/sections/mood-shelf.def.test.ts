// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getMoodShelfTracks } from '$lib/server/database/queries/music-recommendations.queries.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';

const mockGetSql = vi.fn();
const mockCacheGet = vi.fn();
const mockScopedCacheKey = vi.fn((..._args: unknown[]) => 'k');

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({ deniedGroupIds: [], ageRating: null })),
    scopedCacheKey: (...args: unknown[]) => mockScopedCacheKey(...args),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { musicMoodShelf: {} },
    cacheManager: {
        for: () => ({ get: (...args: unknown[]) => mockCacheGet(...args), set: vi.fn() }),
    },
}));
vi.mock('$lib/server/database/queries/music-recommendations.queries.js', () => ({
    getMoodShelfTracks: vi.fn(),
}));
vi.mock('$lib/server/database/queries/sonic-queue.queries.js', () => ({
    musicMoodVectorKey: (genre: string) => `music:${genre}`,
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

const { def } = await import('./mood-shelf.js');

function makeEvent(): RequestEvent {
    const url = 'http://localhost/api/v1/music/sections/mood-shelf?mood=chill';
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(url),
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
}

describe('mood-shelf surface-resolved images', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockCacheGet.mockResolvedValue(null);
    });

    it('resolves each track ImageSet for the request surface and keys the cache by it', async () => {
        const images = {
            primary: {
                href: '/api/v1/media/t1/images/primary?v=r1',
                revision: 'r1',
                source: 'self' as const,
                variants: { thumb: '/api/v1/media/t1/images/primary?size=thumb&v=r1' },
            },
        };
        const tracks = ['t1', 't2', 't3', 't4'].map((id) => ({
            id,
            title: `Song ${id}`,
            artist_id: 'ar1',
            artist_title: 'Artist',
            album_id: 'al1',
            similarity: 0.7,
        }));
        vi.mocked(getMoodShelfTracks).mockResolvedValue(tracks as never);
        vi.mocked(resolveImageSets).mockResolvedValueOnce(new Map([['t1', images]]) as never);

        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);

        expect(res.status).toBe(200);
        expect(mockScopedCacheKey).toHaveBeenCalledWith(
            'music-mood-shelf-dto-v3',
            expect.anything(),
            ['u1', 'chill', 'v1'],
        );
        expect(resolveImageSets).toHaveBeenCalledWith(
            expect.anything(),
            'v1',
            tracks.map((t) => ({ id: t.id, mediaType: 'track' })),
        );
        const body = (await res.json()) as {
            items: Array<{ image: string; images: unknown }>;
        };
        expect(body.items[0].images).toEqual(images);
        expect(body.items[0].image).toBe('/api/v1/media/t1/images/primary?size=thumb&v=r1');
        expect(body.items[1].images).toEqual({});
    });
});
