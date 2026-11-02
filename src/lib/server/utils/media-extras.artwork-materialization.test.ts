// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the three vocabulary seams that broke three prior revisions of the
 * provider-artwork design:
 *   1. `thumb` maps to `still_path` / artwork->>'still' — NOT `thumb_path`.
 *   2. Every write tag starts with `provider:` (isManagedArtworkFile only
 *      recognises admin:/provider:/generated:).
 *   3. The season filename convention round-trips with the flat-layout reader.
 */

import { describe, it, expect } from 'vitest';
import {
    MATERIALIZABLE_ARTWORK_TYPES,
    ARTWORK_TYPE_TO_PROVIDER_KEYS,
    ARTWORK_TYPE_TO_TMDB_SIZE,
    providerSourceTag,
    seasonArtworkFileName,
} from './media-extras.js';

describe('MATERIALIZABLE_ARTWORK_TYPES', () => {
    it('is exactly poster/backdrop/logo/thumb — banner is deliberately excluded', () => {
        expect([...MATERIALIZABLE_ARTWORK_TYPES]).toEqual(['poster', 'backdrop', 'logo', 'thumb']);
    });
});

describe('ARTWORK_TYPE_TO_PROVIDER_KEYS', () => {
    it('maps thumb to still_path / still — never thumb_path', () => {
        expect(ARTWORK_TYPE_TO_PROVIDER_KEYS.thumb).toEqual({
            pathKey: 'still_path',
            artworkKey: 'still',
        });
    });

    it('mirrors catalog-operations.queries.ts:388-394 for the other three', () => {
        expect(ARTWORK_TYPE_TO_PROVIDER_KEYS.poster).toEqual({
            pathKey: 'poster_path',
            artworkKey: 'poster',
        });
        expect(ARTWORK_TYPE_TO_PROVIDER_KEYS.backdrop).toEqual({
            pathKey: 'backdrop_path',
            artworkKey: 'backdrop',
        });
        expect(ARTWORK_TYPE_TO_PROVIDER_KEYS.logo).toEqual({
            pathKey: 'logo_path',
            artworkKey: 'logo',
        });
    });

    it('has an entry for every materializable type', () => {
        for (const t of MATERIALIZABLE_ARTWORK_TYPES) {
            expect(ARTWORK_TYPE_TO_PROVIDER_KEYS[t]).toBeDefined();
        }
    });
});

describe('ARTWORK_TYPE_TO_TMDB_SIZE', () => {
    it('pins the CDN size tokens', () => {
        expect(ARTWORK_TYPE_TO_TMDB_SIZE).toEqual({
            poster: 'w342',
            backdrop: 'w780',
            logo: 'w300',
            thumb: 'w300',
        });
    });
});

describe('providerSourceTag', () => {
    it('always starts with the managed "provider:" prefix', () => {
        expect(providerSourceTag('tmdb', 'poster')).toBe('provider:tmdb:poster');
        expect(providerSourceTag('aggregated', 'thumb')).toBe('provider:aggregated:thumb');
    });

    it('never emits an admin: tag (those clear suppression tombstones)', () => {
        expect(providerSourceTag('admin', 'poster').startsWith('admin:')).toBe(false);
    });
});

describe('seasonArtworkFileName', () => {
    it('zero-pads a normal season', () => {
        expect(seasonArtworkFileName('poster', 1, '.jpg')).toBe('season01-poster.jpg');
        expect(seasonArtworkFileName('poster', 12, '.png')).toBe('season12-poster.png');
    });

    it('uses the specials label for season 0', () => {
        expect(seasonArtworkFileName('poster', 0, '.jpg')).toBe('season-specials-poster.jpg');
    });

    it('does not pad a three-digit season', () => {
        expect(seasonArtworkFileName('poster', 100, '.jpg')).toBe('season100-poster.jpg');
    });
});
