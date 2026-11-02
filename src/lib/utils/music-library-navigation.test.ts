// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { get, writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createMusicLibraryNavigation, type MusicNavigationPage } from './music-library-navigation';
import { librarySegmentStorageKey } from './music-bottom-nav';

function location(
    routeId = '/music',
    username: string | undefined = 'alice',
    playlistType?: string,
    query = '',
): MusicNavigationPage {
    return {
        route: { id: routeId },
        url: { searchParams: new URLSearchParams(query) },
        data: { user: { username }, playlist: { playlistType } },
    };
}

function storage(values: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
    return {
        getItem: vi.fn((key: string) => values[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
            values[key] = value;
        }),
    };
}

describe('shared music Library destination', () => {
    it('adopts a changed persisted destination when returning after another tab updated it', () => {
        const key = librarySegmentStorageKey('alice');
        const values = { [key]: 'artists' };
        const source = writable(location());
        const disk = storage(values);
        const navigation = createMusicLibraryNavigation(source, () => disk);
        expect(get(navigation)).toBe('artists');
        source.set(location('/watch'));
        values[key] = 'playlists';
        source.set(location('/music/explore'));
        expect(get(navigation)).toBe('playlists');
    });

    it('keeps newer session memory over unchanged stale storage after a failed write', () => {
        const key = librarySegmentStorageKey('alice');
        const values = { [key]: 'artists' };
        const source = writable(location('/music/albums/[id]'));
        const disk = storage(values);
        disk.setItem = (): never => {
            throw new Error('quota exceeded');
        };
        const navigation = createMusicLibraryNavigation(source, () => disk);
        expect(get(navigation)).toBe('albums');
        source.set(location('/music/explore'));
        expect(get(navigation)).toBe('albums');
        expect(values[key]).toBe('artists');
        values[key] = 'playlists';
        source.set(location('/music/search'));
        expect(get(navigation)).toBe('playlists');
    });

    it.each([
        ['/music/albums/[id]', undefined, 'albums'],
        ['/music/artists/[id]', undefined, 'artists'],
        ['/playlists/[id]', 'music', 'playlists'],
        ['/playlists', undefined, 'playlists'],
    ] as const)(
        'remembers a direct %s visit after leaving and remounting',
        (route, type, segment) => {
            const source = writable(location(route, 'alice', type, 'type=music'));
            const disk = storage();
            const navigation = createMusicLibraryNavigation(source, () => disk);
            let current = '';
            const unsubscribe = navigation.subscribe((value) => {
                current = value;
            });
            expect(current).toBe(segment);
            expect(disk.setItem).toHaveBeenCalledWith(librarySegmentStorageKey('alice'), segment);
            source.set(location('/music/explore'));
            expect(current).toBe(segment);
            unsubscribe();
            expect(get(navigation)).toBe(segment);
        },
    );

    it('restores the incoming account without persisting the outgoing account into it', () => {
        const source = writable(location());
        const disk = storage({
            [librarySegmentStorageKey('alice')]: 'artists',
            [librarySegmentStorageKey('bob')]: 'playlists',
        });
        const navigation = createMusicLibraryNavigation(source, () => disk);
        const seen: string[] = [];
        const unsubscribe = navigation.subscribe((value) => {
            seen.push(value);
        });
        source.set(location('/music', 'bob'));
        source.set(location('/music', 'new-account'));
        source.set(location('/music', 'alice'));
        expect(seen).toEqual(['artists', 'playlists', 'albums', 'artists']);
        expect(disk.setItem).not.toHaveBeenCalled();
        unsubscribe();
    });

    it.each(['garbage', '', 'ARTISTS'])('uses Albums for invalid stored value %s', (value) => {
        const navigation = createMusicLibraryNavigation(writable(location()), () =>
            storage({ [librarySegmentStorageKey('alice')]: value }),
        );
        expect(get(navigation)).toBe('albums');
    });

    it.each(['access', 'read', 'write'])(
        'keeps account-scoped session memory when storage %s fails',
        (failure) => {
            const source = writable(location('/music/artists/[id]'));
            const disk = storage();
            if (failure === 'read')
                disk.getItem = (): never => {
                    throw new Error('blocked');
                };
            if (failure === 'write')
                disk.setItem = (): never => {
                    throw new Error('blocked');
                };
            const navigation = createMusicLibraryNavigation(source, () => {
                if (failure === 'access') throw new Error('blocked');
                return disk;
            });
            expect(get(navigation)).toBe('artists');
            source.set(location('/music/search'));
            expect(get(navigation)).toBe('artists');
            source.set(location('/music/search', 'bob'));
            expect(get(navigation)).toBe('albums');
            source.set(location('/music/search', 'alice'));
            expect(get(navigation)).toBe('artists');
        },
    );

    it('never remembers a video playlist as music even with a music query', () => {
        const source = writable(location('/playlists/[id]', 'alice', 'video', 'type=music'));
        const disk = storage({ [librarySegmentStorageKey('alice')]: 'artists' });
        const navigation = createMusicLibraryNavigation(source, () => disk);
        expect(get(navigation)).toBe('artists');
        expect(disk.setItem).not.toHaveBeenCalled();
    });

    it('does not carry signed-in memory into an anonymous page', () => {
        const source = writable(location('/music/artists'));
        const navigation = createMusicLibraryNavigation(source, () => storage());
        expect(get(navigation)).toBe('artists');
        source.set({ ...location('/music'), data: {} });
        expect(get(navigation)).toBe('albums');
    });
});
