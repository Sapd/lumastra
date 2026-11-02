// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    isMusicBottomNavRoute,
    activeMusicTab,
    libraryHref,
    librarySegmentStorageKey,
    segmentFromRoute,
    DEFAULT_LIBRARY_SEGMENT,
    isMusicPlaylistRoute,
} from './music-bottom-nav';

const sp = (s: string): URLSearchParams => new URLSearchParams(s);

describe('isMusicBottomNavRoute', () => {
    it('matches /music and all /music/* sub-routes', () => {
        expect(isMusicBottomNavRoute('/music', sp(''))).toBe(true);
        expect(isMusicBottomNavRoute('/music/albums', sp(''))).toBe(true);
        expect(isMusicBottomNavRoute('/music/albums/[id]', sp(''))).toBe(true);
        expect(isMusicBottomNavRoute('/music/search', sp('q=foo'))).toBe(true);
        expect(isMusicBottomNavRoute('/music/explore', sp(''))).toBe(true);
    });

    it('matches /playlists only when type=music', () => {
        expect(isMusicBottomNavRoute('/playlists', sp('type=music'))).toBe(true);
        expect(isMusicBottomNavRoute('/playlists', sp(''))).toBe(false);
        expect(isMusicBottomNavRoute('/playlists', sp('type=video'))).toBe(false);
    });

    it('matches a detail only when the loaded playlist is explicitly music', () => {
        expect(isMusicBottomNavRoute('/playlists/[id]', sp(''), 'music')).toBe(true);
        expect(isMusicBottomNavRoute('/playlists/[id]', sp('type=music'), 'video')).toBe(false);
        expect(isMusicBottomNavRoute('/playlists/[id]', sp('type=music'))).toBe(false);
    });

    it('never matches playlist detail or unrelated routes', () => {
        expect(isMusicBottomNavRoute('/playlists/[id]', sp('type=music'))).toBe(false);
        expect(isMusicBottomNavRoute('/watch', sp(''))).toBe(false);
        expect(isMusicBottomNavRoute('/rate', sp(''))).toBe(false);
        expect(isMusicBottomNavRoute('/', sp(''))).toBe(false);
        expect(isMusicBottomNavRoute(null, sp(''))).toBe(false);
    });
});

describe('activeMusicTab', () => {
    it('resolves each tab', () => {
        expect(activeMusicTab('/music', sp(''))).toBe('home');
        expect(activeMusicTab('/music/explore', sp(''))).toBe('explore');
        expect(activeMusicTab('/music/search', sp('q=x'))).toBe('search');
        expect(activeMusicTab('/music/albums', sp(''))).toBe('library');
        expect(activeMusicTab('/music/artists', sp(''))).toBe('library');
        expect(activeMusicTab('/playlists', sp('type=music'))).toBe('library');
        expect(activeMusicTab('/playlists/[id]', sp(''), 'music')).toBe('library');
    });

    it('keeps subpages in their owning tab and leaves video playlists unselected', () => {
        expect(activeMusicTab('/music/albums/[id]', sp(''))).toBe('library');
        expect(activeMusicTab('/music/map', sp(''))).toBe('explore');
        expect(activeMusicTab('/playlists', sp(''))).toBeNull();
    });
});

describe('libraryHref + storage key', () => {
    it('maps segments to hrefs', () => {
        expect(libraryHref('playlists')).toBe('/playlists?type=music');
        expect(libraryHref('albums')).toBe('/music/albums');
        expect(libraryHref('artists')).toBe('/music/artists');
    });
    it('scopes the storage key by username and defaults to albums', () => {
        expect(librarySegmentStorageKey('alice')).toBe('lumastra:music:last-library-segment:alice');
        expect(DEFAULT_LIBRARY_SEGMENT).toBe('albums');
    });
});

describe('segmentFromRoute', () => {
    it('maps library routes to their segment', () => {
        expect(segmentFromRoute('/music/albums', sp(''))).toBe('albums');
        expect(segmentFromRoute('/music/artists', sp(''))).toBe('artists');
        expect(segmentFromRoute('/music/albums/[id]', sp(''))).toBe('albums');
        expect(segmentFromRoute('/music/artists/[id]', sp(''))).toBe('artists');
        expect(segmentFromRoute('/playlists', sp('type=music'))).toBe('playlists');
        expect(segmentFromRoute('/playlists/[id]', sp(''), 'music')).toBe('playlists');
    });

    it('returns null for non-library or ambiguous routes', () => {
        expect(segmentFromRoute('/playlists', sp(''))).toBeNull();
        expect(segmentFromRoute('/playlists', sp('type=video'))).toBeNull();
        expect(segmentFromRoute('/playlists/[id]', sp('type=music'), 'video')).toBeNull();
        expect(segmentFromRoute('/music', sp(''))).toBeNull();
        expect(segmentFromRoute('/music/search', sp(''))).toBeNull();
        expect(segmentFromRoute(null, sp(''))).toBeNull();
    });
});

describe('isMusicPlaylistRoute', () => {
    it('uses the query only for the list and loaded type only for details', () => {
        expect(isMusicPlaylistRoute('/playlists', sp('type=music'))).toBe(true);
        expect(isMusicPlaylistRoute('/playlists/[id]', sp('type=music'))).toBe(false);
        expect(isMusicPlaylistRoute('/playlists/[id]', sp(''), 'music')).toBe(true);
        expect(isMusicPlaylistRoute('/playlists/[id]', sp(''), 'video')).toBe(false);
    });
});
