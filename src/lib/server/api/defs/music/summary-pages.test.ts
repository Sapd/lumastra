// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    sql: {},
    access: { library: { kind: 'denyGroups', ids: ['denied'] }, age: { kind: 'any' } },
    albumSummaries: vi.fn(),
    artistSummaries: vi.fn(),
    personal: vi.fn(),
    catalog: vi.fn(),
    series: vi.fn(),
    cached: vi.fn(),
    isType: vi.fn(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => mocks.sql },
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: async () => new Map(),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: async () => ({ deniedGroupIds: ['denied'], ageRating: null }),
    searchAccessBoundary: () => mocks.access,
    scopedCacheKey: () => 'scoped',
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: async () => true }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: async () => ({ allowed: true }),
    withRateLimitHeaders: (response: Response) => response,
}));
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get: mocks.cached }) },
    CACHE_NAMESPACES: { musicSimilarAlbums: {}, musicSimilarArtists: {} },
}));
vi.mock('$lib/server/cache/single-flight.js', () => ({ getOrComputeSingleFlight: vi.fn() }));
vi.mock('$lib/server/database/queries/sonic-similarity.queries.js', () => ({
    findSonicNeighborAlbums: vi.fn(),
    findSonicNeighborArtists: vi.fn(),
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getAlbumSummaries: mocks.albumSummaries,
    getArtistSummaries: mocks.artistSummaries,
    isMediaItemOfType: mocks.isType,
    getMostPlayedArtists: mocks.personal,
    getTopArtistsByAlbumCount: mocks.catalog,
}));
vi.mock('$lib/server/database/queries/music-album-series.queries.js', () => ({
    getAlbumSeries: mocks.series,
}));

const { def: albums } = await import('./albums/[id]/similar.js');
const { def: artists } = await import('./artists/[id]/similar.js');
const { def: top } = await import('../user/music/top-artists.js');
const { def: series } = await import('./albums/series.js');

const event = {
    locals: { user: { userId: 'user', username: 'alice' } },
    params: { id: 'seed' },
    url: new URL('http://localhost/api/v1/me/music/top-artists?limit=2'),
} as unknown as RequestEvent;
const ctx = { surface: 'v1', input: { query: { limit: 2 } } } as never;
const rows = ['first', 'second'].map((id) => ({
    id,
    album_id: id,
    artist_id: id,
    title: id,
    similarity_score: 0.98765,
    track_count: 1,
    album_count: 1,
    play_count: 4,
    volume: 2,
}));

describe('music summary pages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cached.mockResolvedValue(rows);
        mocks.isType.mockResolvedValue(true);
        mocks.personal.mockResolvedValue(rows);
        mocks.catalog.mockResolvedValue(rows);
        mocks.series.mockResolvedValue(rows);
        // Deliberately reverse the DB order: associate summaries by ID.
        mocks.albumSummaries.mockResolvedValue(
            [...rows].reverse().map((row) => ({
                id: row.id,
                title: row.title,
                artist_id: null,
                artist_title: 'Artist',
                track_count: 1,
                total_duration: 60,
            })),
        );
        mocks.artistSummaries.mockResolvedValue(
            [...rows].reverse().map((row) => ({
                id: row.id,
                title: row.title,
                album_count: 1,
                track_count: 1,
            })),
        );
    });

    it('batches sonic albums with scoped totals and preserves the neighbour artist ID', async () => {
        const response = await albums.handlers.GET!(event, ctx);
        expect(mocks.albumSummaries).toHaveBeenCalledExactlyOnceWith(
            mocks.sql,
            ['first', 'second'],
            mocks.access,
        );
        expect((await response.json()).items).toEqual(
            rows.map((row) =>
                expect.objectContaining({
                    id: row.id,
                    trackCount: 1,
                    durationMs: 60000,
                    artist: { id: row.artist_id, title: 'Artist' },
                    similarityScore: 0.9877,
                }),
            ),
        );
    });

    it('batches sonic artists with scoped counts', async () => {
        const response = await artists.handlers.GET!(event, ctx);
        expect(mocks.artistSummaries).toHaveBeenCalledExactlyOnceWith(
            mocks.sql,
            ['first', 'second'],
            mocks.access,
        );
        expect((await response.json()).items).toEqual(
            rows.map((row) =>
                expect.objectContaining({
                    id: row.id,
                    albumCount: 1,
                    trackCount: 1,
                }),
            ),
        );
    });

    it.each(['personal', 'catalog'])(
        'batches %s top artists with scoped counts',
        async (source) => {
            if (source === 'catalog') mocks.personal.mockResolvedValue([]);
            const response = await top.handlers.GET!(event, ctx);
            expect(mocks.artistSummaries).toHaveBeenCalledExactlyOnceWith(
                mocks.sql,
                ['first', 'second'],
                mocks.access,
            );
            expect((await response.json()).items).toEqual(
                rows.map((row) =>
                    expect.objectContaining({
                        id: row.id,
                        albumCount: 1,
                        trackCount: 1,
                        source,
                        playCount: 4,
                    }),
                ),
            );
        },
    );

    it('batches album series and keeps volume and list order', async () => {
        const response = await series.handlers.GET!(event, ctx);
        expect(mocks.albumSummaries).toHaveBeenCalledExactlyOnceWith(
            mocks.sql,
            ['first', 'second'],
            mocks.access,
        );
        expect((await response.json()).albums).toEqual(
            rows.map((row) =>
                expect.objectContaining({
                    id: row.id,
                    volume: 2,
                    trackCount: 1,
                    durationMs: 60000,
                }),
            ),
        );
    });

    describe.each([
        ['albums', albums, 'album', 'albumSummaries'],
        ['artists', artists, 'artist', 'artistSummaries'],
    ] as const)('similar %s page envelope', (_name, defn, type, summaryKey) => {
        const third = {
            ...rows[0],
            id: 'third',
            album_id: 'third',
            artist_id: 'third',
            title: 'third',
        };

        it('is truncated when more visible rows than the limit exist, with source and limit', async () => {
            mocks.cached.mockResolvedValue([...rows, third]);
            mocks[summaryKey].mockResolvedValue(
                [...rows, third].map((row) => ({
                    id: row.id,
                    title: row.title,
                    artist_id: null,
                    artist_title: 'Artist',
                    track_count: 1,
                    total_duration: 60,
                    album_count: 1,
                })),
            );
            const body = await (await defn.handlers.GET!(event, ctx)).json();
            expect(body.items).toHaveLength(2);
            expect(body.source).toBe('sonic');
            expect(body.page).toEqual({ limit: 2, truncated: true });
        });

        it('does not count neighbours the summary join dropped', async () => {
            mocks.cached.mockResolvedValue([...rows, third]);
            // The third neighbour is not visible to the caller.
            const body = await (await defn.handlers.GET!(event, ctx)).json();
            expect(body.items).toHaveLength(2);
            expect(body.page).toEqual({ limit: 2, truncated: false });
        });

        it(`404s when the id is not ${type === 'album' ? 'an' : 'an'} ${type}`, async () => {
            mocks.isType.mockResolvedValue(false);
            const response = await defn.handlers.GET!(event, ctx);
            expect(response.status).toBe(404);
            expect(mocks.isType).toHaveBeenCalledWith(mocks.sql, 'seed', type);
            expect(mocks.cached).not.toHaveBeenCalled();
        });
    });
});
