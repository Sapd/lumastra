// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

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
const mockGetArtistWithAlbums = vi.fn();
const mockGetArtistTracks = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockFilterAccessibleRows = vi.fn();
const mockGetArtistPopularity = vi.fn();
const mockGetTrackPopularityForArtist = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getArtistWithAlbums: (...args: unknown[]) => mockGetArtistWithAlbums(...args),
    getArtistTracks: (...args: unknown[]) => mockGetArtistTracks(...args),
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
    getTrackPopularityForArtist: (...args: unknown[]) => mockGetTrackPopularityForArtist(...args),
}));

const { artistDetailCore } = await import('./music-artist-detail.handler.js');

const TRACK = {
    id: 't1',
    custom_poster_url: '/track-cover.jpg',
    title: 'Track One',
    custom_metadata: { essentia: { bpm: 100, key: 'Cm', energy: 0.5 } },
    album_id: 'al1',
    artist_id: 'ar1',
    artist_title: 'Artist',
    file_path: '/data/media/libraries/music/artist/album/01.flac',
};

function makeEvent(): RequestEvent {
    return {
        params: { id: 'ar1' },
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/music/artists/ar1'),
        request: new Request('http://localhost/api/music/artists/ar1'),
    } as unknown as RequestEvent;
}

describe('artistDetailCore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockGetArtistWithAlbums.mockResolvedValue({
            artist: {
                id: 'ar1',
                custom_poster_url: '/artist.jpg',
                title: 'Artist One',
                is_various_artists: false,
            },
            albums: [{ id: 'al1', custom_poster_url: '/album.jpg', title: 'Album One' }],
        });
        mockGetArtistTracks.mockResolvedValue([TRACK]);
        mockCheckMediaAccess.mockResolvedValue(true);
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockFilterAccessibleRows.mockImplementation((_sql, rows: unknown[]) =>
            Promise.resolve(rows),
        );
        mockGetArtistPopularity.mockResolvedValue(null);
        mockGetTrackPopularityForArtist.mockResolvedValue([]);
    });

    it('internal: public audioFeatures, images use internal surface', async () => {
        const res = await artistDetailCore(makeEvent(), {
            surface: 'internal',
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.tracks[0].audioFeatures).toEqual({ bpm: 100, key: 'Cm', energy: 0.5 });
        expect(body.images.primary?.href).toContain('/api/media/ar1/images/poster');
        expect(JSON.stringify(body)).not.toContain('file_path');
    });

    it('v1: public audioFeatures, images use v1 surface', async () => {
        const res = await artistDetailCore(makeEvent(), {
            surface: 'v1',
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.tracks[0].audioFeatures).toEqual({
            bpm: 100,
            key: 'Cm',
            energy: 0.5,
        });
        expect(body.images.primary?.href).toContain('/api/v1/media/ar1/images/poster');
        expect(body.albums[0].images.primary?.href).toContain('/api/v1/media/al1/images/poster');
    });

    it('leaves out catalog-only tracks (no file on disk) that could not be streamed', async () => {
        mockGetArtistTracks.mockResolvedValue([
            TRACK,
            { ...TRACK, id: 't2', title: 'Catalog Only', file_path: null },
        ]);
        const res = await artistDetailCore(makeEvent(), {
            surface: 'v1',
        });
        const body = await res.json();
        expect(body.tracks.map((t: { id: string }) => t.id)).toEqual([TRACK.id]);
    });

    it.each([false, true])(
        'counts accessible releases and songs with Various Artists=%s',
        async (isVariousArtists) => {
            const boundary = {
                library: { kind: 'denyGroups', ids: ['denied'] },
                age: { kind: 'any' },
            };
            const sqlHandle = {};
            mockGetSql.mockResolvedValue(sqlHandle);
            mockBuildSearchAccessContext.mockResolvedValue(boundary);
            mockGetArtistWithAlbums.mockResolvedValue({
                artist: {
                    id: 'ar1',
                    title: 'Artist',
                    is_various_artists: isVariousArtists,
                    album_count: 99,
                    track_count: 999,
                },
                albums: [
                    { id: 'al1', title: 'Allowed', track_count: 3 },
                    { id: 'al2', title: 'Denied', track_count: 20 },
                ],
            });
            mockGetArtistTracks.mockResolvedValue([TRACK, { ...TRACK, id: 't2', album_id: 'al2' }]);
            mockFilterAccessibleRows.mockImplementation((_sql, rows: Array<{ id: string }>) =>
                Promise.resolve(rows.filter((row) => row.id !== 'al2' && row.id !== 't2')),
            );
            const res = await artistDetailCore(makeEvent(), {
                surface: 'v1',
            });
            const body = await res.json();
            expect(body.albumCount).toBe(1);
            expect(body.trackCount).toBe(isVariousArtists ? 3 : 1);
            expect(body.albums.map((a: { id: string }) => a.id)).toEqual(['al1']);
            expect(body.tracks.map((t: { id: string }) => t.id)).toEqual(
                isVariousArtists ? [] : ['t1'],
            );
            expect(mockGetArtistWithAlbums).toHaveBeenCalledWith(sqlHandle, 'ar1', boundary);
            if (isVariousArtists) expect(mockGetArtistTracks).not.toHaveBeenCalled();
            else expect(mockGetArtistTracks).toHaveBeenCalledWith(sqlHandle, 'ar1', 'u1', boundary);
        },
    );

    it('returns 404 when the artist is not found', async () => {
        mockGetArtistWithAlbums.mockResolvedValue(null);
        const res = await artistDetailCore(makeEvent(), {
            surface: 'internal',
        });
        expect(res.status).toBe(404);
    });

    it('returns 404 (not 403) when media access is denied', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await artistDetailCore(makeEvent(), {
            surface: 'internal',
        });
        expect(res.status).toBe(404);
    });
});
