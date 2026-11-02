// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    deriveImageProvider,
    selectImageCandidates,
    type SelectableImage,
} from './image-provenance.js';
import type { ImageProvider } from '$lib/schemas/image-candidates.js';
export const DERIVATION_CASES: [string | null, string | null, ImageProvider][] = [
    ['https://image.tmdb.org/t/p/original/a.jpg', null, 'tmdb'],
    ['https://artworks.thetvdb.com/a.jpg', null, 'tvdb'],
    ['https://assets.fanart.tv/a.jpg', null, 'fanart'],
    ['https://coverartarchive.org/release/a/front', null, 'musicbrainz-caa'],
    ['https://i.discogs.com/a.jpg', null, 'discogs'],
    ['https://e-cdns-images.dzcdn.net/a.jpg', null, 'deezer'],
    ['https://www.theaudiodb.com/a.jpg', null, 'theaudiodb'],
    ['https://lastfm.freetls.fastly.net/a.jpg', null, 'lastfm'],
    ['https://image.tmdb.org.evil.example/a.jpg', null, 'unknown'],
    ['admin:file', '/config/a.jpg', 'upload'],
    ['provider:tmdb', '/config/a.jpg', 'tmdb'],
    ['generated:ffmpeg', '/config/a.jpg', 'frame-extract'],
    ['generated:collage', null, 'generated'],
    ['embedded:cover', '/config/a.jpg', 'embedded'],
    [null, '/movies/folder.jpg', 'local-folder'],
    ['/api/image/custom/id/poster', null, 'unknown'],
    ['/api/images/upload/id', null, 'upload'],
    ['/api/images/frame/id', null, 'frame-extract'],
    ['album-enrichment', '/config/a.jpg', 'unknown'],
    ['jellyfin:abc', null, 'jellyfin'],
    ['audiobookshelf:abc', null, 'audiobookshelf'],
];
function candidate(
    id: string,
    provider: ImageProvider,
    options: Partial<SelectableImage> = {},
): SelectableImage {
    return {
        id,
        provider,
        chosen_by: 'auto',
        locked: false,
        sort_order: 0,
        created_at: '2026-01-01',
        ...options,
    };
}
describe('image provenance', () => {
    it.each(DERIVATION_CASES)('derives %s conservatively', (ref, path, provider) => {
        expect(deriveImageProvider(ref, path)).toBe(provider);
    });
    it('protects a locked manual choice from later candidates for every role', () => {
        const locked = candidate('z', 'deezer', { locked: true, chosen_by: 'admin' });
        for (const role of ['poster', 'thumb', 'backdrop', 'logo', 'banner']) {
            expect(
                selectImageCandidates(
                    [candidate('a', 'local-folder'), candidate('b', 'tmdb'), locked],
                    role,
                ),
            ).toEqual([locked]);
        }
    });
    it('orders local, providers and generated; reselects after removal', () => {
        const all = [
            candidate('f', 'frame-extract'),
            candidate('t', 'tmdb'),
            candidate('d', 'discogs'),
            candidate('l', 'embedded'),
        ];
        expect(selectImageCandidates(all, 'poster')[0].id).toBe('l');
        expect(selectImageCandidates(all.slice(0, 3), 'poster', ['discogs', 'tmdb'])[0].id).toBe(
            'd',
        );
        expect(selectImageCandidates(all.slice(0, 2), 'thumb', ['tmdb'], true)[0].id).toBe('f');
        expect(selectImageCandidates(all.slice(0, 1), 'thumb')[0].id).toBe('f');
    });
    it('keeps backdrops in stable order', () => {
        expect(
            selectImageCandidates(
                [candidate('b', 'tmdb', { sort_order: 1 }), candidate('a', 'tmdb')],
                'backdrop',
            ).map((c) => c.id),
        ).toEqual(['a', 'b']);
    });
});
