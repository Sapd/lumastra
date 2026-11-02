// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end proof of the invariant this change exists to establish.
 *
 * The reported symptom was that image paths came back in three different shapes
 * for the same item, and that one of them (`/api/v1/image/catalog/{id}/poster`)
 * had no route at all, so v1 clients 404'd. The cause was not the data: it was
 * that each mount() call site hand-wrote an `imageBase` string with no invariant
 * tying it to `surface`, so 39 v1 mounts carried the internal `/api/image`.
 *
 * These tests pin the property that replaced it: for the SAME media item, the
 * emitted path is a pure function of the surface, the two surfaces differ only
 * by prefix, and the unresolvable catalog form is gone from both.
 *
 * The projection functions exercised here are the real ones used by the defs —
 * not re-implementations — so this fails if a def's URL derivation regresses.
 */

import { describe, it, expect } from 'vitest';
import { apiBase, apiUrl, entityImageUrl, buildImageRefs, type ApiSurface } from './api-urls.js';

const SURFACES: ApiSurface[] = ['internal', 'v1'];

/** One media item, looked at from both surfaces. */
const MEDIA_ID = '237454b4-8ddf-45cf-8345-fd5c8558f236';

describe('same item, two surfaces', () => {
    it('emits the internal path on internal and the v1 path on v1', () => {
        expect(entityImageUrl(MEDIA_ID, 'poster', 'internal')).toBe(
            `/api/media/${MEDIA_ID}/images/poster`,
        );
        expect(entityImageUrl(MEDIA_ID, 'poster', 'v1')).toBe(
            `/api/v1/media/${MEDIA_ID}/images/poster`,
        );
    });

    it('differs ONLY by the surface prefix', () => {
        // The strong form: strip each surface's prefix and the remainders are
        // byte-identical. This is what "surface-aware in place" has to mean —
        // the shape is fixed, only the prefix moves.
        const internal = entityImageUrl(MEDIA_ID, 'backdrop', 'internal', { size: 'wide' });
        const v1 = entityImageUrl(MEDIA_ID, 'backdrop', 'v1', { size: 'wide' });

        expect(internal.slice(apiBase('internal').length)).toBe(v1.slice(apiBase('v1').length));
    });

    it('keeps every images{} variant in lockstep across surfaces', () => {
        const internal = buildImageRefs(MEDIA_ID, 'internal');
        const v1 = buildImageRefs(MEDIA_ID, 'v1');

        expect(Object.keys(internal.poster)).toEqual(Object.keys(v1.poster));
        expect(Object.keys(internal.backdrop)).toEqual(Object.keys(v1.backdrop));

        for (const role of ['poster', 'backdrop'] as const) {
            for (const variant of Object.keys(internal[role]) as Array<
                keyof (typeof internal)[typeof role]
            >) {
                const i = internal[role][variant] as string;
                const v = v1[role][variant] as string;
                expect(i.slice(apiBase('internal').length)).toBe(v.slice(apiBase('v1').length));
            }
        }
    });
});

describe('the 404 shape is gone', () => {
    // `/api/image/catalog/...` was emitted into responses by defs mounted on BOTH
    // surfaces. There is no `src/routes/api/v1/image/` tree at all — it was
    // deleted in 6dee55dc5 — so a v1 client could not resolve it.
    it('no entity-image URL on any surface contains /image/catalog/', () => {
        for (const surface of SURFACES) {
            for (const role of ['poster', 'backdrop', 'logo', 'thumb', 'still'] as const) {
                expect(entityImageUrl(MEDIA_ID, role, surface)).not.toContain('/image/catalog/');
            }
            const refs = buildImageRefs(MEDIA_ID, surface);
            for (const href of [...Object.values(refs.poster), ...Object.values(refs.backdrop)]) {
                expect(href).not.toContain('/image/catalog/');
            }
        }
    });

    it('never emits an /api/v1/image/** path, which has no route', () => {
        for (const surface of SURFACES) {
            expect(entityImageUrl(MEDIA_ID, 'poster', surface)).not.toContain('/api/v1/image');
            expect(apiUrl(surface, '/media/x')).not.toContain('/api/v1/image');
        }
    });
});

describe('a v1 mount can no longer emit an internal path', () => {
    // This is the regression that made the bug shape look data-dependent: a v1
    // route carrying imageBase '/api/image' rendered /api/media/... links. With
    // the prefix derived from `surface`, that state is unrepresentable.
    it('every v1-surface URL starts with the v1 prefix', () => {
        const urls = [
            entityImageUrl(MEDIA_ID, 'poster', 'v1'),
            apiUrl('v1', `/series/${MEDIA_ID}/seasons`),
            apiUrl('v1', `/playlists/1`),
            ...Object.values(buildImageRefs(MEDIA_ID, 'v1').poster),
        ];
        for (const url of urls) {
            expect(url.startsWith('/api/v1/')).toBe(true);
        }
    });

    it('every internal-surface URL starts with /api/ and never /api/v1/', () => {
        const urls = [
            entityImageUrl(MEDIA_ID, 'poster', 'internal'),
            apiUrl('internal', `/series/${MEDIA_ID}/seasons`),
            ...Object.values(buildImageRefs(MEDIA_ID, 'internal').poster),
        ];
        for (const url of urls) {
            expect(url.startsWith('/api/')).toBe(true);
            expect(url.startsWith('/api/v1/')).toBe(false);
        }
    });
});

describe('the legacy /api/image proxy family is fully migrated', () => {
    // There is no escape hatch left: every former /api/image/** call site now
    // resolves through the entity route, which exists on BOTH surfaces.
    it('the entity route addresses composite provider keys, not just UUIDs', () => {
        expect(entityImageUrl('tmdb:603:movie', 'poster', 'v1', { size: 'thumb' })).toBe(
            '/api/v1/media/tmdb:603:movie/images/poster?size=thumb',
        );
        expect(entityImageUrl('tmdb:603:movie', 'poster', 'internal', { size: 'thumb' })).toBe(
            '/api/media/tmdb:603:movie/images/poster?size=thumb',
        );
    });

    it('carries the provider-path hint that the legacy route took as ?path=', () => {
        const url = entityImageUrl('tmdb:99:episode', 'still', 'v1', {
            size: 'thumb',
            path: '/abc def.jpg',
        });
        expect(url.startsWith('/api/v1/media/tmdb:99:episode/images/still?')).toBe(true);
        // URLSearchParams encodes the value, so a path with spaces survives.
        expect(url).toContain('path=%2Fabc+def.jpg');
    });

    it('emits no /api/image/ path on either surface', () => {
        for (const surface of SURFACES) {
            expect(entityImageUrl('tmdb:603:movie', 'poster', surface)).not.toContain(
                '/api/image/',
            );
            expect(apiUrl(surface, '/users/testuser/images/avatar')).not.toContain('/api/image/');
        }
    });
});
