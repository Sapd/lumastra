// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getImageDescriptorOwners } from '$lib/server/database/queries/image-descriptor.queries.js';
import { musicImageOwnerFixture } from '$lib/server/services/music/__tests__/image-fixtures.js';
vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockGetAlbumWithTracks = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockFilterAccessibleRows = vi.fn();
const mockGetArtistPopularity = vi.fn();
const mockGetTrackPopularityForAlbum = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getAlbumWithTracks: (...args: unknown[]) => mockGetAlbumWithTracks(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: (ctx: unknown) => ctx,
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: (...args: unknown[]) => mockFilterAccessibleRows(...args),
}));
vi.mock('$lib/server/database/queries/popularity.queries.js', () => ({
    getArtistPopularity: (...args: unknown[]) => mockGetArtistPopularity(...args),
    getTrackPopularityForAlbum: (...args: unknown[]) => mockGetTrackPopularityForAlbum(...args),
}));

const { albumDetailCore } = await import('./music-album-detail.handler.js');

const TRACK = {
    id: 't1',
    custom_poster_url: '/track-cover.jpg',
    title: 'Track One',
    custom_metadata: { essentia: { bpm: 128, key: 'Am', energy: 0.8 } },
    album_id: 'al1',
    artist_id: 'ar1',
    artist_title: 'Artist',
    file_path: '/data/media/libraries/music/artist/album/01.flac',
};

function makeEvent(): RequestEvent {
    return {
        params: { id: 'al1' },
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/music/albums/al1'),
        request: new Request('http://localhost/api/music/albums/al1'),
    } as unknown as RequestEvent;
}

describe('albumDetailCore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockGetAlbumWithTracks.mockResolvedValue({
            album: {
                id: 'al1',
                custom_poster_url: '/album.jpg',
                title: 'Album One',
                artist_id: 'ar1',
            },
            tracks: [TRACK],
        });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        mockGetArtistPopularity.mockResolvedValue(null);
        mockGetTrackPopularityForAlbum.mockResolvedValue([]);
    });

    it('internal: public audioFeatures, images use internal surface', async () => {
        const res = await albumDetailCore(makeEvent(), {
            surface: 'internal',
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        const track = body.tracks[0];
        expect(track.audioFeatures).toEqual({ bpm: 128, key: 'Am', energy: 0.8 });
        expect(track.images.primary?.href).toContain('/api/media/t1/images/poster');
        expect(JSON.stringify(body)).not.toContain('file_path');
    });

    it('v1: public audioFeatures, images use v1 surface', async () => {
        const res = await albumDetailCore(makeEvent(), {
            surface: 'v1',
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        const track = body.tracks[0];
        expect(track.audioFeatures).toEqual({ bpm: 128, key: 'Am', energy: 0.8 });
        expect(track.images.primary?.href).toContain('/api/v1/media/t1/images/poster');
    });

    it('returns 404 when the album is not found', async () => {
        mockGetAlbumWithTracks.mockResolvedValue(null);
        const res = await albumDetailCore(makeEvent(), {
            surface: 'internal',
        });
        expect(res.status).toBe(404);
    });

    it('resolves an album cover for a track without its own artwork', async () => {
        mockGetAlbumWithTracks.mockResolvedValue({
            album: { id: 'al1', title: 'Album One', custom_poster_url: '/album.jpg' },
            tracks: [{ ...TRACK, custom_poster_url: null }],
        });
        vi.mocked(getImageDescriptorOwners).mockResolvedValueOnce([
            musicImageOwnerFixture('al1', { media_type: 'album' }),
            musicImageOwnerFixture('t1', { parent_id: 'al1', custom_urls: {} }),
        ]);
        const response = await albumDetailCore(makeEvent(), { surface: 'v1' });
        const body = await response.json();
        expect(body.tracks[0].images.primary.source).toBe('album');
        expect(body.tracks[0].images.primary.href).toContain('/api/v1/media/al1/images/poster?');
    });

    it('leaves out catalog-only tracks (no file on disk) that could not be streamed', async () => {
        mockGetAlbumWithTracks.mockResolvedValue({
            album: {
                id: 'al1',
                custom_poster_url: '/album.jpg',
                title: 'Album One',
                artist_id: 'ar1',
            },
            tracks: [TRACK, { ...TRACK, id: 't2', title: 'Catalog Only', file_path: null }],
        });
        const res = await albumDetailCore(makeEvent(), {
            surface: 'v1',
        });
        const body = await res.json();
        expect(body.tracks.map((t: { id: string }) => t.id)).toEqual(['t1']);
    });

    it('returns 404 (not 403) when media access is denied', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await albumDetailCore(makeEvent(), {
            surface: 'internal',
        });
        expect(res.status).toBe(404);
    });
});
