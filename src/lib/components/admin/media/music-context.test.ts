// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
    musicItemPath,
    musicAlbumPath,
    artistTracksReturnParams,
    musicContextParams,
} from './music-context.js';
describe('music return context', () => {
    it('carries an album workspace into track edit and canonical tools', () => {
        const href = musicItemPath(
            'track-a',
            new URLSearchParams(
                'tracks_q=Lantern&tracks_issue=missing-file&tracks_sort=title&tracks_page=3&albums_q=Collection&music_from_artist=artist-a',
            ),
            { kind: 'album', id: 'album-a' },
            'overview',
            true,
        );
        const params = new URL(href, 'https://example.invalid').searchParams;
        expect(params.get('tracks_q')).toBe('Lantern');
        expect(params.get('tracks_issue')).toBe('missing-file');
        expect(params.get('tracks_sort')).toBe('title');
        expect(params.get('tracks_page')).toBe('3');
        expect(params.get('music_from_album')).toBe('album-a');
        expect(params.get('albums_q')).toBe('Collection');
        expect(params.get('edit')).toBe('1');
    });
    it('keeps artist album search without applying a previous album track filter to a different album', () => {
        const href = musicItemPath(
            'album-b',
            new URLSearchParams('albums_q=Collection&tracks_q=OldTrack&music_from_album=album-a'),
            { kind: 'artist', id: 'artist-a' },
            'tracks',
        );
        const params = new URL(href, 'https://example.invalid').searchParams;
        expect(params.get('albums_q')).toBe('Collection');
        expect(params.has('tracks_q')).toBe(false);
        expect(params.has('music_from_album')).toBe(false);
    });
});

it('preserves artist inventory through actual albums and clears stale inventory on Discography navigation', () => {
    const artist = '11111111-1111-4111-8111-111111111111';
    const album = '22222222-2222-4222-8222-222222222222';
    const fromArtist = musicItemPath(
        album,
        new URLSearchParams('tracks_q=Guest&tracks_page=2'),
        { kind: 'artist-tracks', id: artist },
        'tracks',
    );
    const fromAlbum = musicItemPath(
        'track',
        new URL(fromArtist, 'https://example.invalid').searchParams,
        { kind: 'album', id: album },
    );
    expect(fromAlbum).toContain(`music_from_artist_tracks=${artist}`);
    expect(fromAlbum).toContain(`music_from_album=${album}`);
    const discography = musicItemPath(
        album,
        new URL(fromAlbum, 'https://example.invalid').searchParams,
        { kind: 'artist', id: artist },
    );
    expect(discography).not.toContain('music_from_artist_tracks');
    expect(discography).not.toContain('tracks_q');
});

it('separates nested artist page2 filters from an album workspace and restores each return', () => {
    const artist = '11111111-1111-4111-8111-111111111111';
    const album = '22222222-2222-4222-8222-222222222222';
    const toAlbum = musicItemPath(
        album,
        new URLSearchParams(
            'tracks_q=ArtistNeedle&tracks_issue=missing-lyrics&tracks_sort=title&tracks_page=2',
        ),
        { kind: 'artist-tracks', id: artist },
        'tracks',
    );
    const albumParams = new URL(toAlbum, 'https://example.invalid').searchParams;
    expect(albumParams.has('tracks_q')).toBe(false);
    expect(albumParams.get('artist_tracks_q')).toBe('ArtistNeedle');
    expect(albumParams.get('artist_tracks_page')).toBe('2');
    albumParams.set('tracks_q', 'AlbumNeedle');
    albumParams.set('tracks_issue', 'all');
    albumParams.set('tracks_sort', 'album');
    albumParams.set('tracks_page', '1');
    const toTrack = musicItemPath('track', albumParams, { kind: 'album', id: album });
    const trackParams = new URL(toTrack, 'https://example.invalid').searchParams;
    const backAlbum = musicContextParams(trackParams);
    backAlbum.delete('music_from_album');
    backAlbum.set('tab', 'tracks');
    expect(backAlbum.get('tracks_q')).toBe('AlbumNeedle');
    expect(backAlbum.get('tracks_page')).toBe('1');
    const backArtist = artistTracksReturnParams(backAlbum);
    expect(backArtist.get('tracks_q')).toBe('ArtistNeedle');
    expect(backArtist.get('tracks_issue')).toBe('missing-lyrics');
    expect(backArtist.get('tracks_sort')).toBe('title');
    expect(backArtist.get('tracks_page')).toBe('2');
    expect(backArtist.has('artist_tracks_page')).toBe(false);
});

it('snapshots artist context when a direct-track ownership link opens album Overview in edit mode', () => {
    const artist = '11111111-1111-4111-8111-111111111111';
    const album = '22222222-2222-4222-8222-222222222222';
    const direct = new URLSearchParams(
        `music_from_artist_tracks=${artist}&tracks_q=ArtistNeedle&tracks_issue=missing-file&tracks_sort=title&tracks_page=2&tab=overview&section=old&return_to=browser`,
    );
    expect(artistTracksReturnParams(direct).get('tracks_page')).toBe('2');
    const ownership = new URL(
        musicAlbumPath(album, direct, 'overview', true),
        'https://example.invalid',
    ).searchParams;
    expect(ownership.get('tab')).toBe('overview');
    expect(ownership.get('edit')).toBe('1');
    expect(ownership.has('section')).toBe(false);
    expect(ownership.get('return_to')).toBe('browser');
    expect(ownership.get('artist_tracks_page')).toBe('2');
    expect(ownership.has('tracks_q')).toBe(false);
    ownership.set('tracks_q', 'AlbumNeedle');
    ownership.set('tracks_page', '1');
    const track = new URL(
        musicItemPath('track', ownership, { kind: 'album', id: album }),
        'https://example.invalid',
    ).searchParams;
    const backAlbum = new URL(musicAlbumPath(album, track, 'tracks'), 'https://example.invalid')
        .searchParams;
    expect(backAlbum.get('tracks_q')).toBe('AlbumNeedle');
    expect(backAlbum.get('tracks_page')).toBe('1');
    const backArtist = artistTracksReturnParams(backAlbum);
    expect(backArtist.get('tracks_q')).toBe('ArtistNeedle');
    expect(backArtist.get('tracks_issue')).toBe('missing-file');
    expect(backArtist.get('tracks_sort')).toBe('title');
    expect(backArtist.get('tracks_page')).toBe('2');
});
