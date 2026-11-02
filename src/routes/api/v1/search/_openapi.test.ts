// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { def } from '$lib/server/api/defs/search/search.js';
import {
    SearchResponseSchema,
    SearchResultItemSchema,
} from '$lib/server/api/defs/search/search-item.schemas.js';

describe('SearchResultItemSchema — GET /api/v1/search contract parity', () => {
    it('publishes the canonical search schema on the route def', () => {
        expect(def.docs?.GET?.responses[200]).toMatchObject({ schema: SearchResponseSchema });
    });
    it('accepts an item with no backdrop image (external/auxiliary sources genuinely lack one)', () => {
        // SearchService.posterImage() only ever emits `{ poster }` for external
        // sources (Kavita/Audiobookshelf/Jellyseerr/etc.) — `images.backdrop` was
        // required here, so every backdrop-less result failed strict decoding
        // (e.g. on tvOS).
        const result = SearchResultItemSchema.safeParse({
            id: 'book-123',
            catalogId: null,
            type: 'book',
            ids: { kavita: '123' },
            title: 'Some Book',
            images: {
                poster: {
                    href: '/api/v1/media/tmdb:1:movie/images/poster?v=1',
                    variants: { card: '/api/v1/media/tmdb:1:movie/images/poster?size=card&v=1' },
                    revision: '1',
                    source: 'provider',
                },
            },
            score: 2.5,
            reason: { kind: 'external' },
        });

        expect(result.success).toBe(true);
    });

    it('accepts and preserves libraryId and requestMediaType (emitted by SearchService but previously undeclared)', () => {
        const result = SearchResultItemSchema.safeParse({
            id: 'req-456',
            catalogId: null,
            type: 'request',
            ids: { jellyseerr: '456' },
            title: 'Some Request',
            images: {
                poster: {
                    href: '/api/v1/media/tmdb:1:movie/images/poster?v=1',
                    variants: { card: '/api/v1/media/tmdb:1:movie/images/poster?size=card&v=1' },
                    revision: '1',
                    source: 'provider',
                },
            },
            score: 2.0,
            reason: { kind: 'external' },
            requestMediaType: 'tv',
            libraryId: 7,
        });

        expect(result.success).toBe(true);
        // Zod strips undeclared keys silently on a bare z.object(), so `success`
        // alone doesn't prove the fields are part of the schema — assert they
        // survive parsing (i.e. the schema declares them, not merely tolerates them).
        expect(result.data?.requestMediaType).toBe('tv');
        expect(result.data?.libraryId).toBe(7);
    });

    it('accepts and preserves every field SearchService emits for music rows', () => {
        // `mapMusicRow` (search.service.ts) emits artistId/albumId/artists plus
        // `album` (parent album title) and `duration` (seconds). The latter two
        // were undeclared, and since the generated spec carries
        // `additionalProperties: false`, a single undeclared key failed the whole
        // response for strict decoders — so any query with a music hit came back
        // empty on tvOS while movie/series-only queries worked.
        const result = SearchResultItemSchema.safeParse({
            id: 'track-1',
            catalogId: null,
            type: 'track',
            ids: {},
            title: 'Stutter',
            images: {
                poster: {
                    href: '/api/v1/media/track-1/images/primary?v=1',
                    revision: '1',
                    source: 'self',
                },
            },
            score: 3.2,
            reason: { kind: 'music' },
            artistId: 'artist-1',
            albumId: 'album-1',
            artists: [
                {
                    id: 'artist-1',
                    catalogId: null,
                    type: 'artist',
                    title: 'Mariner 5',
                    ids: {},
                    images: {},
                },
            ],
            album: 'Songs About Jane',
            durationMs: 189_000,
        });

        expect(result.success).toBe(true);
        // Parsing must PRESERVE these, not merely tolerate them — a bare
        // z.object() strips undeclared keys silently, which is exactly how the
        // drift stayed invisible.
        expect(result.data?.album).toBe('Songs About Jane');
        expect(result.data?.durationMs).toBe(189_000);
        expect(result.data?.artistId).toBe('artist-1');
        expect(result.data?.albumId).toBe('album-1');
        expect(result.data?.artists).toEqual([
            {
                id: 'artist-1',
                catalogId: null,
                type: 'artist',
                title: 'Mariner 5',
                ids: {},
                images: {},
            },
        ]);
    });

    it('requires the images map and rejects a fully missing images block', () => {
        const result = SearchResultItemSchema.safeParse({
            id: 'movie-789',
            catalogId: null,
            type: 'movie',
            ids: { tmdb: '789' },
            title: 'Some Movie',
            score: 4.1,
            reason: { kind: 'fts' },
        });

        expect(result.success).toBe(false);
    });
});
