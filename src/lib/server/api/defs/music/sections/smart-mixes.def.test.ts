// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getMusicSmartMixes } from '$lib/server/database/queries/music-recommendations.queries.js';
import { musicCollageImages } from '$lib/server/services/music/collage-images.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';

const mockGetSql = vi.fn();
const mockCacheGet = vi.fn();
const mockWarm = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/services/music/collage-warmup.js', () => ({
    warmCollageUrls: (...args: unknown[]) => mockWarm(...args),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({ deniedGroupIds: [], ageRating: null })),
    scopedCacheKey: vi.fn(() => 'k'),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { musicSmartMixes: {} },
    cacheManager: { for: () => ({ get: mockCacheGet, set: vi.fn() }) },
}));

vi.mock('$lib/server/database/queries/music-recommendations.queries.js', () => ({
    getMusicSmartMixes: vi.fn(),
}));
vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getDislikedTrackIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

const { def } = await import('./smart-mixes.js');

function makeEvent(): RequestEvent {
    const url = 'http://localhost/api/v1/music/sections/smart-mixes';
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(url),
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
}

const section = {
    id: 'music-mix-rock',
    type: 'carousel',
    title: 'Rock Mix',
    meta: { icon: 'musical-note' },
    items: [
        { id: 'mix:t1', externalIds: { internal: 't1' }, clickData: { albumId: 'al1' } },
        { id: 'mix:t2', externalIds: { internal: 't2' }, clickData: { albumId: 'al1' } },
        { id: 'mix:t3', externalIds: { internal: 't3' }, clickData: {} },
    ],
};

describe('smart-mixes surface-resolved images', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveImageSets).mockResolvedValue(new Map());
        mockGetSql.mockResolvedValue({});
    });

    it('resolves each track ImageSet for the request surface on a cold miss', async () => {
        const images = {
            primary: {
                href: '/api/v1/media/t1/images/primary?v=r1',
                revision: 'r1',
                source: 'self' as const,
                variants: { thumb: '/api/v1/media/t1/images/primary?size=thumb&v=r1' },
            },
        };
        mockCacheGet.mockResolvedValueOnce(null);
        vi.mocked(getMusicSmartMixes).mockResolvedValueOnce([
            {
                genre: 'rock',
                tracks: [
                    {
                        id: 't1',
                        title: 'Rock song',
                        artist_id: 'ar1',
                        artist_title: 'Rocker',
                        album_id: 'al1',
                    },
                ],
            },
        ] as never);
        vi.mocked(resolveImageSets).mockResolvedValueOnce(new Map([['t1', images]]) as never);

        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);

        expect(resolveImageSets).toHaveBeenCalledWith(expect.anything(), 'v1', [
            { id: 't1', mediaType: 'track' },
        ]);
        const body = (await res.json()) as {
            sections: Array<{
                meta: { coverImage: string };
                items: Array<{ image: string; images: unknown }>;
            }>;
        };
        expect(mockWarm).toHaveBeenCalledWith([body.sections[0].meta.coverImage]);
        expect(body.sections[0].meta.coverImage).toContain('&v=');
        expect(body.sections[0].items[0].images).toEqual(images);
        expect(body.sections[0].items[0].image).toBe(
            '/api/v1/media/t1/images/primary?size=thumb&v=r1',
        );
    });
});

describe('smart-mixes cover', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveImageSets).mockResolvedValue(new Map());
        mockGetSql.mockResolvedValue({});
        mockCacheGet.mockResolvedValue({ sections: [section] });
    });

    it.each([
        ['v1', '/api/v1/music/images/collage?ids=al1,t3&size=card'],
        ['internal', '/api/music/images/collage?ids=al1,t3&size=card'],
    ])(
        'adds a %s-surface collage built per request from one cache entry',
        async (surface, href) => {
            const res = await def.handlers.GET!(makeEvent(), { surface } as never);
            const body = (await res.json()) as {
                sections: Array<{ meta: Record<string, unknown> }>;
            };
            const expected = musicCollageImages(
                ['al1', 't3'],
                surface as 'v1' | 'internal',
                new Map(),
            );
            expect(body.sections[0].meta).toEqual({
                icon: 'musical-note',
                coverImage: expected.primary!.href,
            });
            expect(expected.primary!.href).toMatch(`${href}&v=`);
        },
    );
});

it('revises the collage from album artwork even when its track has its own cover', async () => {
    mockGetSql.mockResolvedValue({});
    const albumImages = {
        primary: { href: '/album-cover', revision: 'album-before', source: 'self' as const },
    };
    mockCacheGet.mockResolvedValue({
        sections: [
            {
                ...section,
                items: [
                    {
                        ...section.items[0],
                        images: {
                            primary: {
                                href: '/track-cover',
                                revision: 'track-cover',
                                source: 'self',
                            },
                        },
                    },
                ],
            },
        ],
    });
    vi.mocked(resolveImageSets).mockResolvedValue(new Map([['al1', albumImages]]));
    const before = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
    const expected = musicCollageImages(['al1'], 'v1', new Map([['al1', albumImages]]));
    albumImages.primary.revision = 'album-after';
    const after = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
    const first = await before.json();
    const second = await after.json();
    expect(resolveImageSets).toHaveBeenCalledWith(expect.anything(), 'v1', [{ id: 'al1' }]);
    expect(first.sections[0].meta.coverImage).toBe(expected.primary!.href);
    expect(second.sections[0].meta.coverImage).not.toBe(first.sections[0].meta.coverImage);
});
