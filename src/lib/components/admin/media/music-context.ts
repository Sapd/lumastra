// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const MUSIC_CONTEXT_KEYS = [
    'music_from_album',
    'music_from_artist',
    'music_from_artist_tracks',
    'tracks_q',
    'tracks_issue',
    'tracks_sort',
    'tracks_page',
    'albums_q',
    'artist_tracks_q',
    'artist_tracks_issue',
    'artist_tracks_sort',
    'artist_tracks_page',
] as const;
export function musicContextParams(source: URLSearchParams): URLSearchParams {
    const target = new URLSearchParams();
    for (const key of MUSIC_CONTEXT_KEYS) {
        const value = source.get(key);
        if (
            value &&
            (!key.startsWith('music_from_') ||
                /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
        )
            target.set(key, value);
    }
    return target;
}
export function musicItemPath(
    id: string,
    source: URLSearchParams,
    parent: { kind: 'album' | 'artist' | 'artist-tracks'; id: string },
    tab = 'overview',
    edit = false,
): string {
    const params = musicContextParams(source);
    if (parent.kind === 'artist') {
        params.delete('music_from_artist_tracks');
        for (const suffix of ['q', 'issue', 'sort', 'page'])
            params.delete(`artist_tracks_${suffix}`);
        for (const key of [
            'tracks_q',
            'tracks_issue',
            'tracks_sort',
            'tracks_page',
            'music_from_album',
        ])
            params.delete(key);
    }
    if (parent.kind === 'artist-tracks') {
        params.delete('music_from_album');
        params.set('music_from_artist_tracks', parent.id);
        if (tab === 'tracks') return musicAlbumPath(id, params, tab, edit);
    } else params.set(`music_from_${parent.kind}`, parent.id);
    params.set('tab', tab);
    if (edit) params.set('edit', '1');
    return `/admin/library/media/${id}?${params.toString()}`;
}

export function artistTracksReturnParams(source: URLSearchParams): URLSearchParams {
    const params = musicContextParams(source);
    if (params.has('artist_tracks_page')) {
        for (const suffix of ['q', 'issue', 'sort', 'page']) {
            const value = params.get(`artist_tracks_${suffix}`);
            params.delete(`tracks_${suffix}`);
            if (value) params.set(`tracks_${suffix}`, value);
            params.delete(`artist_tracks_${suffix}`);
        }
    }
    params.delete('music_from_artist_tracks');
    params.delete('music_from_album');
    params.set('tab', 'tracks');
    return params;
}

/** The destination is an album regardless of its opening tab (including edit). */
export function musicAlbumPath(
    id: string,
    source: URLSearchParams,
    tab = 'overview',
    edit = false,
): string {
    const params = new URLSearchParams(source);
    const context = musicContextParams(source);
    if (
        context.has('music_from_artist_tracks') &&
        !context.has('artist_tracks_page') &&
        !context.has('music_from_album')
    ) {
        for (const [suffix, fallback] of [
            ['q', ''],
            ['issue', 'all'],
            ['sort', 'album'],
            ['page', '1'],
        ]) {
            params.set(`artist_tracks_${suffix}`, params.get(`tracks_${suffix}`) ?? fallback);
            params.delete(`tracks_${suffix}`);
        }
    }
    params.delete('music_from_album');
    params.delete('section');
    params.delete('edit');
    params.set('tab', tab);
    if (edit) params.set('edit', '1');
    return `/admin/library/media/${id}?${params.toString()}`;
}
