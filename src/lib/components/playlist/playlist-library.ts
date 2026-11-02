// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Playlist } from '$lib/types/api-playlists';

export type PlaylistScope = 'all' | 'owned' | 'shared';
export type PlaylistKind = 'all' | 'music' | 'video';
export type PlaylistSort = 'updated' | 'title' | 'size';

export interface PlaylistLibraryFilter {
    query: string;
    scope: PlaylistScope;
    kind: PlaylistKind;
    sort: PlaylistSort;
}

export function readPlaylistFilter(params: URLSearchParams): PlaylistLibraryFilter {
    const scope = params.get('scope');
    const kind = params.get('type');
    const sort = params.get('sort');
    return {
        query: params.get('q')?.slice(0, 120) ?? '',
        scope: scope === 'owned' || scope === 'shared' ? scope : 'all',
        kind: kind === 'music' || kind === 'video' ? kind : 'all',
        sort: sort === 'title' || sort === 'size' ? sort : 'updated',
    };
}

function searchable(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

/** Filter already-authorized summaries; never changes playlist membership or order. */
export function selectPlaylistLibrary(
    owned: Playlist[],
    shared: Playlist[],
    filter: PlaylistLibraryFilter,
): Playlist[] {
    const ownedIds = new Set(owned.map((playlist) => playlist.id));
    const source =
        filter.scope === 'owned'
            ? owned
            : filter.scope === 'shared'
              ? shared
              : [...owned, ...shared.filter((playlist) => !ownedIds.has(playlist.id))];
    const term = searchable(filter.query.trim());
    return source
        .filter((playlist) => {
            const matchesKind =
                filter.kind === 'all' ||
                (filter.kind === 'music'
                    ? playlist.playlistType === 'music'
                    : playlist.playlistType !== 'music');
            return (
                matchesKind &&
                (!term ||
                    searchable(
                        `${playlist.name} ${playlist.description ?? ''} ${playlist.owner.displayName ?? ''}`,
                    ).includes(term))
            );
        })
        .sort((a, b) => {
            const pinned = Number(b.isSystem === true) - Number(a.isSystem === true);
            if (pinned) return pinned;
            if (filter.sort === 'title')
                return a.name.localeCompare(b.name, undefined, {
                    numeric: true,
                    sensitivity: 'base',
                });
            if (filter.sort === 'size') return b.itemCount - a.itemCount;
            return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
        });
}
