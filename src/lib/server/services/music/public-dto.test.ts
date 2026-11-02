// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { ImageSet } from '$lib/schemas/api-image-descriptor';
import type { MusicTrackRow } from './track-projection';
import type { ApiSurface } from '$lib/shared/api-urls';
import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import { getImageDescriptorOwners } from '$lib/server/database/queries/image-descriptor.queries.js';
import { musicImageOwnerFixture } from './__tests__/image-fixtures';
vi.mock('$lib/server/database/queries/image-descriptor.queries.js', () => ({
    getImageDescriptorOwners: vi.fn(),
}));
import { ArtistSchema, AlbumSchema, TrackSchema } from '$lib/schemas/api-music-dto';
import {
    MusicAlbumDetailResponseSchema,
    MusicArtistDetailResponseSchema,
} from '$lib/schemas/api-music-responses';
import { toArtist, toAlbum, toMusicTrack } from './track-projection';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper';

async function imagesFor<T extends { id: string }>(
    row: T &
        Partial<MusicTrackRow> & { parent_id?: string | null; custom_logo_url?: string | null },
    kind: 'track' | 'album' | 'artist',
    surface: ApiSurface,
): Promise<ImageSet> {
    const ownPoster =
        row.own_custom_poster_url !== undefined ? row.own_custom_poster_url : row.custom_poster_url;
    const parent = row.album_id ?? row.parent_id ?? null;
    vi.mocked(getImageDescriptorOwners).mockResolvedValue([
        musicImageOwnerFixture(row.id, {
            media_type: kind,
            parent_id: parent,
            custom_urls: {
                poster: ownPoster,
                backdrop: row.custom_backdrop_url,
                logo: row.custom_logo_url,
            },
        }),
        ...(parent
            ? [
                  musicImageOwnerFixture(parent, {
                      media_type: kind === 'track' ? 'album' : 'artist',
                      custom_urls: { poster: row.album_custom_poster_url },
                  }),
              ]
            : []),
    ]);
    return resolveImageSet({} as postgres.Sql, surface, row.id, kind);
}

const artistId = 'aaaaaaaa-0000-4000-8000-000000000001';
const albumId = 'aaaaaaaa-0000-4000-8000-000000000002';
const trackId = 'aaaaaaaa-0000-4000-8000-000000000003';
const trackRow = {
    id: trackId,
    title: 'Track',
    album_id: albumId,
    album_title: 'Album',
    artist_id: artistId,
    artist_title: 'Artist',
    runtime_seconds: 240,
    track_artists: [
        { id: artistId, title: 'Artist' },
        { id: null, title: 'Guest' },
    ],
    file_path: '/private/music/track.flac',
    custom_poster_url: '/private/art.jpg',
    custom_backdrop_url: '/private/backdrop.jpg',
    custom_metadata: {
        track_number: '3/12',
        disc_number: '2/3',
        genre: ['House'],
        year: 2024,
        essentia: { bpm: 120, beat_grid: [0, 0.5], intro_end_ms: 4000, loudness_lufs: -12 },
        chapters: [{ title: 'Intro', start_ms: 0, end_ms: 4000 }],
    },
};

describe('public music DTO boundary', () => {
    it('rounds seconds to integer milliseconds at the projection boundary', () => {
        const track = toMusicTrack({ ...trackRow, runtime_seconds: 1.2346 }, {});
        expect(track.durationMs).toBe(1235);
        expect(track).not.toHaveProperty('durationSeconds');
        expect(TrackSchema.safeParse({ ...track, durationMs: 1.5 }).success).toBe(false);
        expect(toAlbum({ id: albumId, title: 'Album', total_duration: 2.3456 }, {}).durationMs)
            .toBe(2346);
        expect(toAlbum({ id: albumId, title: 'Album' }, {}).durationMs).toBeNull();
    });

    it('preserves zero and unknown durations and converts the metadata fallback', () => {
        expect(toMusicTrack({ ...trackRow, runtime_seconds: 0 }, {}).durationMs).toBe(0);
        expect(toMusicTrack({ ...trackRow, runtime_seconds: null }, {}).durationMs).toBeNull();
        expect(toMusicTrack({
            ...trackRow,
            runtime_seconds: null,
            custom_metadata: { duration_seconds: 1.2346 },
        }, {}).durationMs).toBe(1235);
        expect(toMusicTrack(trackRow, {}).audioFeatures?.beatGrid).toEqual([0, 0.5]);
    });

    it.each(['internal', 'v1'] as const)('projects tracks on the %s surface', async (surface) => {
        const track = TrackSchema.parse(
            toMusicTrack(trackRow, await imagesFor(trackRow, 'track', surface)),
        );
        expect(track).toMatchObject({
            id: trackId,
            type: 'track',
            title: 'Track',
            artists: trackRow.track_artists,
            album: { id: albumId, title: 'Album' },
            trackNumber: 3,
            discNumber: 2,
            durationMs: 240000,
            genres: ['House'],
            year: 2024,
            isRadio: false,
            audioFeatures: { beatGrid: [0, 0.5], introEndMs: 4000, loudnessLufs: -12 },
            chapters: [{ title: 'Intro', startMs: 0, endMs: 4000 }],
        });
        const base = surface === 'v1' ? '/api/v1' : '/api';
        expect(track.images.primary?.href).toBe(
            `${base}/media/${trackId}/images/poster?size=card&v=${track.images.primary?.revision}`,
        );
        expect(track.images).not.toHaveProperty('backdrop');
        expect(track.images.primary?.placeholder?.blurhash).toBe('stored-cover-blurhash');
        for (const field of [
            'custom_metadata',
            'file_path',
            'custom_poster_url',
            'artist',
            'albumId',
            'artistId',
            'duration',
            'runtime_seconds',
        ]) {
            expect(track).not.toHaveProperty(field);
        }
    });

    it('uses exactly the same projection for semantic-search rows', async () => {
        expect(
            musicSearchRowToTrack(
                { ...trackRow, media_id: trackId },
                await imagesFor({ ...trackRow, media_id: trackId }, 'track', 'v1'),
            ),
        ).toEqual(toMusicTrack(trackRow, await imagesFor(trackRow, 'track', 'v1')));
    });

    it('projects artist detail without exposing storage metadata or artwork URLs', async () => {
        const artist = toArtist(
            {
                id: artistId,
                title: 'Artist',
                overview: 'Biography',
                album_count: 2,
                track_count: 12,
                is_various_artists: false,
                created_at: '2026-10-16T00:00:00Z',
                custom_metadata: { country_code: 'AT', genre: ['House'], secret: 'private' },
            },
            await imagesFor(
                {
                    id: artistId,
                    title: 'Artist',
                    overview: 'Biography',
                    album_count: 2,
                    track_count: 12,
                    is_various_artists: false,
                    created_at: '2026-10-16T00:00:00Z',
                    custom_metadata: { country_code: 'AT', genre: ['House'], secret: 'private' },
                },
                'artist',
                'v1',
            ),
        );
        expect(ArtistSchema.parse(artist)).toEqual(artist);
        expect(artist).toMatchObject({
            biography: 'Biography',
            albumCount: 2,
            trackCount: 12,
            countryCode: 'AT',
            genres: ['House'],
            addedAt: '2026-10-16T00:00:00.000Z',
        });
        expect(artist).not.toHaveProperty('custom_metadata');
    });

    it('projects album duration, artist identity and added timestamp explicitly', async () => {
        const album = toAlbum(
            {
                id: albumId,
                title: 'Album',
                artist_id: artistId,
                artist_title: 'Artist',
                track_count: 12,
                total_duration: 2800,
                year: 2024,
                overview: 'Notes',
                created_at: '2026-10-16T00:00:00Z',
                custom_metadata: {},
            },
            await imagesFor(
                {
                    id: albumId,
                    title: 'Album',
                    artist_id: artistId,
                    artist_title: 'Artist',
                    track_count: 12,
                    total_duration: 2800,
                    year: 2024,
                    overview: 'Notes',
                    created_at: '2026-10-16T00:00:00Z',
                    custom_metadata: {},
                },
                'album',
                'internal',
            ),
        );
        expect(AlbumSchema.parse(album)).toEqual(album);
        expect(album).toMatchObject({
            artist: { id: artistId, title: 'Artist' },
            trackCount: 12,
            durationMs: 2800000,
            overview: 'Notes',
        });
        expect(album).not.toHaveProperty('total_duration');
    });
});

it('uses flat public album and artist detail payloads', async () => {
    const track = toMusicTrack(trackRow, await imagesFor(trackRow, 'track', 'internal'));
    const album = toAlbum(
        { id: albumId, title: 'Album', artist_id: artistId, artist_title: 'Artist' },
        await imagesFor(
            { id: albumId, title: 'Album', artist_id: artistId, artist_title: 'Artist' },
            'album',
            'internal',
        ),
    );
    const artist = toArtist(
        { id: artistId, title: 'Artist' },
        await imagesFor({ id: artistId, title: 'Artist' }, 'artist', 'internal'),
    );
    const albumDetail = MusicAlbumDetailResponseSchema.parse({ ...album, tracks: [track] });
    const artistDetail = MusicArtistDetailResponseSchema.parse({
        ...artist,
        albums: [album],
        tracks: [track],
    });
    expect(albumDetail.id).toBe(albumId);
    expect(albumDetail.tracks[0].album?.id).toBe(albumId);
    expect(albumDetail).not.toHaveProperty('album');
    expect(artistDetail.id).toBe(artistId);
    expect(artistDetail.albums[0].artist.id).toBe(artistId);
    expect(artistDetail).not.toHaveProperty('artist');
});

it('uses album-owned cover URLs only after the track cover is absent', async () => {
    const row = { ...trackRow, custom_poster_url: null, album_custom_poster_url: '/album.jpg' };
    const inherited = toMusicTrack(row, await imagesFor(row, 'track', 'v1')).images;
    expect(inherited.primary).toMatchObject({ source: 'album', revision: expect.any(String) });
    expect(inherited.primary?.href).toContain(`/api/v1/media/${albumId}/images/poster?`);
    expect(inherited).not.toHaveProperty('poster');
    const own = toMusicTrack(
        { ...row, custom_poster_url: '/track.jpg' },
        await imagesFor({ ...row, custom_poster_url: '/track.jpg' }, 'track', 'v1'),
    ).images;
    expect(own.primary?.source).toBe('self');
    expect(own.primary?.href).toContain(`/api/v1/media/${trackId}/images/poster?`);
});

it('omits missing artwork and never falls back to the artist photo', async () => {
    const row = { ...trackRow, custom_poster_url: null, custom_backdrop_url: null };
    expect(toMusicTrack(row, await imagesFor(row, 'track', 'v1')).images).toEqual({});
    expect(
        toAlbum(
            { id: albumId, title: 'Album', parent_id: artistId },
            await imagesFor({ id: albumId, title: 'Album', parent_id: artistId }, 'album', 'v1'),
        ).images,
    ).toEqual({});
    const images = toArtist(
        {
            id: artistId,
            title: 'Artist',
            custom_poster_url: '/photo.jpg',
            custom_backdrop_url: '/backdrop.jpg',
            custom_logo_url: '/logo.png',
        },
        await imagesFor(
            {
                id: artistId,
                title: 'Artist',
                custom_poster_url: '/photo.jpg',
                custom_backdrop_url: '/backdrop.jpg',
                custom_logo_url: '/logo.png',
            },
            'artist',
            'v1',
        ),
    ).images;
    expect(Object.keys(images).sort()).toEqual(['backdrop', 'logo', 'primary']);
});

it('preserves the album owner when a shared query also returns a coalesced cover', async () => {
    const track = toMusicTrack(
        {
            ...trackRow,
            custom_poster_url: '/album.jpg',
            own_custom_poster_url: null,
            album_custom_poster_url: '/album.jpg',
        },
        await imagesFor(
            {
                ...trackRow,
                custom_poster_url: '/album.jpg',
                own_custom_poster_url: null,
                album_custom_poster_url: '/album.jpg',
            },
            'track',
            'v1',
        ),
    );
    expect(track.images.primary?.source).toBe('album');
    expect(track.images.primary?.href).toContain(`/media/${albumId}/images/poster?`);
});
