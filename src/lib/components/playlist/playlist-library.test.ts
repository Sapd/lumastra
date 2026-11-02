// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { readPlaylistFilter, selectPlaylistLibrary } from './playlist-library';
import type { Playlist } from '$lib/types/api-playlists';

const item = (
    id: number,
    name: string,
    playlistType: Playlist['playlistType'],
    other: Partial<Playlist> = {},
): Playlist => ({
    id,
    name,
    playlistType,
    owner: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        displayName: 'alice',
        images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
    },
    revision: 0,
    memberCount: 0,
    isSystem: false,
    description: null,
    images: {},
    visibility: 'private',
    role: 'owner',
    itemCount: 2,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...other,
});
const owned = [
    item(1, 'Watchlist', 'watchlist', { isSystem: true }),
    item(2, 'Café mix', 'music'),
    item(3, 'Weekend films', 'video', { itemCount: 12 }),
];
const shared = [
    item(4, 'Together', 'music', {
        role: 'readonly',
        owner: {
            userId: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'bob',
            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
        },
        revision: 0,
        memberCount: 0,
        isSystem: false,
        images: {},
        description: 'Quiet evenings',
    }),
];
const defaults = readPlaylistFilter(new URLSearchParams());

describe('playlist library', () => {
    it('composes type, ownership and accent-insensitive search without mutating summaries', () => {
        expect(
            selectPlaylistLibrary(owned, shared, {
                ...defaults,
                query: 'cafe',
                kind: 'music',
                scope: 'owned',
            }).map((p) => p.id),
        ).toEqual([2]);
        expect(owned.map((p) => p.id)).toEqual([1, 2, 3]);
    });
    it('finds shared lists by owner or description', () => {
        expect(
            selectPlaylistLibrary(owned, shared, { ...defaults, query: 'bob' }).map((p) => p.id),
        ).toEqual([4]);
        expect(
            selectPlaylistLibrary(owned, shared, {
                ...defaults,
                query: 'quiet',
                scope: 'shared',
            }).map((p) => p.id),
        ).toEqual([4]);
    });
    it('keeps the watchlist pinned for every sort but respects explicit music scope', () => {
        expect(
            selectPlaylistLibrary(owned, shared, { ...defaults, sort: 'size' }).map((p) => p.id),
        ).toEqual([1, 3, 2, 4]);
        expect(
            selectPlaylistLibrary(owned, shared, { ...defaults, kind: 'music' }).map((p) => p.id),
        ).toEqual([2, 4]);
    });
    it('normalizes malformed bookmarks and caps queries', () => {
        expect(readPlaylistFilter(new URLSearchParams('type=bad&scope=bad&sort=bad'))).toEqual(
            defaults,
        );
        expect(readPlaylistFilter(new URLSearchParams({ q: 'a'.repeat(150) })).query).toHaveLength(
            120,
        );
    });
    it('does not duplicate a list while an invitation refresh overlaps owned/shared data', () => {
        expect(selectPlaylistLibrary(owned, [owned[1], ...shared], defaults)).toHaveLength(4);
    });
});
