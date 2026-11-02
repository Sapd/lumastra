// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    pickVariant,
    getCatalogBackdropSrcSet,
    getCatalogImageUrl,
    getAvatarUrl,
    getCatalogPosterUrl,
    imageFromIds,
} from './image-utils';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import type { ExternalIds } from '$lib/types/api-common';

describe('getCatalogBackdropSrcSet', () => {
    it('includes high-DPI backdrop variants', () => {
        const srcset = getCatalogBackdropSrcSet('abc');
        expect(srcset).toContain('1280w');
        expect(srcset).toContain('1920w');
        // and still the small ones for mobile
        expect(srcset).toContain('250w');
    });

    it('uses named presets (not raw maxWidth) for wide variants', () => {
        const srcset = getCatalogBackdropSrcSet('test-id');
        // Wide variants are bounded presets so they share immutable cache
        // entries with the API's self-describing images{} hrefs.
        expect(srcset).toContain('size=hd');
        expect(srcset).toContain('size=wide');
        expect(srcset).not.toContain('maxWidth=');
    });

    it('returns five comma-separated candidates', () => {
        const srcset = getCatalogBackdropSrcSet('xyz');
        const parts = srcset.split(', ');
        expect(parts).toHaveLength(5);
    });
});

describe('imageFromIds', () => {
    it('prioritizes the internal UUID over tmdb ids', () => {
        const externalIds: ExternalIds = {
            internal: 'uuid-1',
            tmdb: '550',
        };
        const url = imageFromIds(externalIds, 'poster', 'movie');
        expect(url).toBe('/api/media/uuid-1/images/poster');
    });

    it('never builds an image URL from a Jellyfin id', () => {
        const externalIds: ExternalIds = { jellyfin: 'jf-1' };
        expect(imageFromIds(externalIds, 'backdrop', 'movie')).toBeNull();
        expect(imageFromIds({ jellyfin: 'jf-1', tmdb: '550' }, 'poster', 'movie')).not.toContain(
            'jf-1',
        );
    });

    it('falls back to a tmdb composite-key URL, honoring the size option', () => {
        const externalIds: ExternalIds = { tmdb: '550' };
        const url = imageFromIds(externalIds, 'poster', 'movie', { size: 'thumb' });
        expect(url).toBe('/api/media/tmdb:550:movie/images/poster?size=thumb');
    });

    it('rejects a tmdb id of 0 (boundary)', () => {
        const externalIds: ExternalIds = { tmdb: '0' };
        expect(imageFromIds(externalIds, 'poster', 'movie')).toBeNull();
    });

    it('rejects a tmdb id at/above the 100000000 boundary', () => {
        expect(imageFromIds({ tmdb: '100000000' }, 'poster', 'movie')).toBeNull();
        expect(imageFromIds({ tmdb: '999999999' }, 'poster', 'movie')).toBeNull();
    });

    it('accepts a tmdb id just under the boundary', () => {
        const url = imageFromIds({ tmdb: '99999999' }, 'poster', 'movie');
        expect(url).toBe('/api/media/tmdb:99999999:movie/images/poster');
    });

    it('rejects a non-numeric tmdb id (NaN)', () => {
        expect(imageFromIds({ tmdb: 'not-a-number' }, 'poster', 'movie')).toBeNull();
    });

    it('returns null when externalIds is undefined', () => {
        expect(imageFromIds(undefined, 'poster', 'movie')).toBeNull();
    });

    it('returns null when no usable id is present', () => {
        expect(imageFromIds({}, 'poster', 'movie')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Client/server URL agreement
// ---------------------------------------------------------------------------

describe('client-computed image URLs match the server-emitted ones', () => {
    // The client used to build /api/image/catalog/{id}/{type} locally while the
    // API handed it /api/media/{id}/images/{role} for the SAME image — two shapes
    // for one asset, and neither carried the install base path. Both sides now
    // derive from the same helper, so this asserts they cannot drift apart again.
    it('getCatalogImageUrl equals entityImageUrl on the internal surface', () => {
        const id = '237454b4-8ddf-45cf-8345-fd5c8558f236';
        for (const role of ['poster', 'backdrop', 'logo', 'thumb'] as const) {
            expect(getCatalogImageUrl(id, role)).toBe(entityImageUrl(id, role, 'internal'));
            expect(getCatalogImageUrl(id, role, { size: 'thumb' })).toBe(
                entityImageUrl(id, role, 'internal', { size: 'thumb' }),
            );
        }
    });

    it('emits no retired /api/image/** proxy path', () => {
        const id = 'abc';
        expect(getCatalogImageUrl(id, 'poster')).not.toContain('/api/image/');
        expect(getAvatarUrl('testuser')).not.toContain('/api/image/');
        expect(imageFromIds({ tmdb: '550' } as never, 'poster')).not.toContain('/api/image/');
    });

    it('asks the avatar route for the initials fallback, with one query string', () => {
        expect(getAvatarUrl('testuser')).toBe(
            '/api/users/testuser/images/avatar?fallback=initials',
        );
        const url = getAvatarUrl('testuser', { width: 64, version: 3 });
        expect(url).toBe('/api/users/testuser/images/avatar?width=64&fallback=initials&v=3');
        expect(url.split('?')).toHaveLength(2);
    });

    it('keeps maxWidth/fallback alongside the size preset', () => {
        const url = getCatalogImageUrl('abc', 'poster', { size: 'card', fallback: 'none' });
        expect(url).toContain('size=card');
        expect(url).toContain('fallback=none');
        expect(url.startsWith('/api/media/abc/images/poster?')).toBe(true);
    });
});

describe('pickVariant', () => {
    const descriptor = {
        href: '/api/media/movie/images/poster?size=card&v=rev',
        source: 'self' as const,
        revision: 'rev',
        variants: { thumb: '/api/media/movie/images/poster?size=thumb&v=rev' },
    };
    it('selects the requested advertised preset', () => {
        expect(pickVariant(descriptor, 'thumb')).toBe(descriptor.variants.thumb);
    });
    it('falls back to href when the preset or variants map is absent', () => {
        expect(pickVariant(descriptor, 'wide')).toBe(descriptor.href);
        expect(pickVariant({ ...descriptor, variants: undefined }, 'card')).toBe(descriptor.href);
    });
    it('returns undefined for an absent role', () => {
        expect(pickVariant(undefined, 'card')).toBeUndefined();
    });
});

describe('avatar descriptors', () => {
    it('selects the server variant without appending client revision parameters', () => {
        expect(
            getAvatarUrl(
                {
                    href: '/avatar?v=stored',
                    variants: { thumb: '/small?v=stored' },
                    revision: 'stored',
                    source: 'self',
                },
                { version: 99 },
            ),
        ).toBe('/small?v=stored');
    });
});

describe('current image routes', () => {
    it('encodes avatar handles and refreshes the byte URL after a change', () => {
        expect(getAvatarUrl('alice/a?b', { version: 2 })).toBe(
            '/api/users/alice%2Fa%3Fb/images/avatar?fallback=initials&v=2',
        );
    });

    it('builds the media poster role URL', () => {
        expect(getCatalogPosterUrl('media-id')).toBe('/api/media/media-id/images/poster');
    });
});
