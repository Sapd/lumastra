// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Contract tests for the single source of URL prefixes in API responses.
 *
 * The invariant these pin down: for ANY surface, every emitted path starts with
 * that surface's prefix and nothing else. The bug this replaces produced
 * `/api/image/catalog/...` (no v1 route → 404 for v1 clients) and
 * `/api/media/...` from v1 mounts carrying an internal imageBase.
 */

import { describe, it, expect } from 'vitest';
import {
    apiBase,
    appPath,
    apiUrl,
    entityImageUrl,
    buildImageRefs,
    buildCollageRefs,
    COVER_COLLAGE_MAX_IDS,
    type ApiSurface,
} from './api-urls.js';

const SURFACES: ApiSurface[] = ['internal', 'v1'];
const UUID = '237454b4-8ddf-45cf-8345-fd5c8558f236';

describe('apiBase', () => {
    it('maps each surface to its prefix', () => {
        expect(apiBase('internal')).toBe('/api');
        expect(apiBase('v1')).toBe('/api/v1');
    });
});

describe('apiUrl', () => {
    it('prefixes an entity path per surface', () => {
        expect(apiUrl('internal', `/series/${UUID}/seasons`)).toBe(`/api/series/${UUID}/seasons`);
        expect(apiUrl('v1', `/series/${UUID}/seasons`)).toBe(`/api/v1/series/${UUID}/seasons`);
    });

    it('tolerates a path given without a leading slash', () => {
        expect(apiUrl('v1', `series/${UUID}`)).toBe(`/api/v1/series/${UUID}`);
    });

    it('never emits a doubled prefix', () => {
        for (const surface of SURFACES) {
            const url = apiUrl(surface, '/series/x');
            expect(url.startsWith('/api/v1/api')).toBe(false);
            expect(url.startsWith('/api/api')).toBe(false);
        }
    });
});

describe('entityImageUrl', () => {
    it('builds the canonical media-images path per surface', () => {
        expect(entityImageUrl(UUID, 'poster', 'internal')).toBe(`/api/media/${UUID}/images/poster`);
        expect(entityImageUrl(UUID, 'poster', 'v1')).toBe(`/api/v1/media/${UUID}/images/poster`);
    });

    it('appends a named size preset', () => {
        expect(entityImageUrl(UUID, 'poster', 'v1', { size: 'thumb' })).toBe(
            `/api/v1/media/${UUID}/images/poster?size=thumb`,
        );
    });

    it('omits the query entirely when no size is given', () => {
        expect(entityImageUrl(UUID, 'backdrop', 'v1')).not.toContain('?');
    });

    // The whole point of the change: the legacy catalog family has no versioned
    // route, so a v1 client could not resolve it without special-casing.
    it('never emits the legacy /api/image/catalog form on any surface', () => {
        for (const surface of SURFACES) {
            for (const role of ['poster', 'backdrop', 'thumb', 'logo'] as const) {
                expect(entityImageUrl(UUID, role, surface)).not.toContain('/image/catalog/');
            }
        }
    });

    it('emits a v1-resolvable path for every role on the v1 surface', () => {
        for (const role of ['poster', 'backdrop', 'thumb', 'logo', 'still'] as const) {
            expect(entityImageUrl(UUID, role, 'v1')).toBe(`/api/v1/media/${UUID}/images/${role}`);
        }
    });
});

describe('buildImageRefs', () => {
    it('emits every variant under the surface prefix', () => {
        const refs = buildImageRefs(UUID, 'v1');
        const all = [...Object.values(refs.poster), ...Object.values(refs.backdrop)];
        expect(all.length).toBeGreaterThan(0);
        for (const href of all) {
            expect(href.startsWith(`/api/v1/media/${UUID}/images/`)).toBe(true);
        }
    });

    it('emits the internal prefix on the internal surface', () => {
        const refs = buildImageRefs(UUID, 'internal');
        for (const href of [...Object.values(refs.poster), ...Object.values(refs.backdrop)]) {
            expect(href.startsWith(`/api/media/${UUID}/images/`)).toBe(true);
            expect(href.startsWith('/api/v1/')).toBe(false);
        }
    });

    it('keeps the documented variant sets', () => {
        const refs = buildImageRefs(UUID, 'v1');
        expect(Object.keys(refs.poster).sort()).toEqual(['card', 'full', 'href', 'thumb']);
        expect(Object.keys(refs.backdrop).sort()).toEqual([
            'card',
            'full',
            'href',
            'thumb',
            'wide',
        ]);
    });
});

describe('buildCollageRefs', () => {
    it('builds the size variants on the surface prefix', () => {
        const refs = buildCollageRefs(['a', 'b'], 'v1');
        expect(refs).toEqual({
            href: '/api/v1/music/images/collage?ids=a,b',
            thumb: '/api/v1/music/images/collage?ids=a,b&size=thumb',
            card: '/api/v1/music/images/collage?ids=a,b&size=card',
            full: '/api/v1/music/images/collage?ids=a,b&size=full',
        });
        expect(buildCollageRefs(['a'], 'internal')?.href).toBe('/api/music/images/collage?ids=a');
    });

    it('drops empty and duplicate ids, keeping first-seen order', () => {
        expect(buildCollageRefs(['b', null, 'a', undefined, 'b', ''], 'v1')?.href).toBe(
            '/api/v1/music/images/collage?ids=b,a',
        );
    });

    it('caps the id list', () => {
        const ids = Array.from({ length: COVER_COLLAGE_MAX_IDS + 3 }, (_, i) => `id${i}`);
        const href = buildCollageRefs(ids, 'v1')?.href ?? '';
        expect(new URL(href, 'http://x').searchParams.get('ids')?.split(',')).toHaveLength(
            COVER_COLLAGE_MAX_IDS,
        );
    });

    it('returns undefined when there is nothing to render', () => {
        expect(buildCollageRefs([], 'v1')).toBeUndefined();
        expect(buildCollageRefs([null, undefined], 'v1')).toBeUndefined();
    });
});

describe('appPath', () => {
    it('is identity at a root install', () => {
        expect(appPath('/')).toBe('/');
        expect(appPath('/browse')).toBe('/browse');
        expect(appPath('/settings/connections?link=error')).toBe(
            '/settings/connections?link=error',
        );
    });

    it('passes through anything that is not an in-app absolute path', () => {
        expect(appPath('https://example.com/x')).toBe('https://example.com/x');
        expect(appPath('//cdn.example.com/x')).toBe('//cdn.example.com/x');
        expect(appPath('relative/path')).toBe('relative/path');
        expect(appPath('#section')).toBe('#section');
    });
});
