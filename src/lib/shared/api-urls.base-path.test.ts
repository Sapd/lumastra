// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subpath-install contract for the URL helpers.
 *
 * Same assertions as api-urls.test.ts (which covers the root install,
 * base=''), but with SvelteKit's `base` set to `/lumastra`. Every emitted path
 * must carry the install prefix — that is the whole reason defs are forbidden
 * from writing `/api/...` literals: a literal is root-absolute and 404s on a
 * subpath install.
 *
 * `vi.mock` is hoisted, so this lives in its own file: the module under test
 * reads `base` at call time, but the mock must be installed before the import.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '/lumastra' }));

const { apiBase, appPath, apiUrl, entityImageUrl, buildImageRefs } = await import('./api-urls.js');
type ApiSurface = import('./api-urls.js').ApiSurface;

const SURFACES: ApiSurface[] = ['internal', 'v1'];
const UUID = '237454b4-8ddf-45cf-8345-fd5c8558f236';

describe('apiBase under a subpath install', () => {
    it('prefixes each surface with the install base', () => {
        expect(apiBase('internal')).toBe('/lumastra/api');
        expect(apiBase('v1')).toBe('/lumastra/api/v1');
    });
});

describe('apiUrl under a subpath install', () => {
    it('prefixes an entity path with base + surface', () => {
        expect(apiUrl('internal', `/series/${UUID}`)).toBe(`/lumastra/api/series/${UUID}`);
        expect(apiUrl('v1', `/series/${UUID}`)).toBe(`/lumastra/api/v1/series/${UUID}`);
    });

    it('tolerates a path given without a leading slash', () => {
        expect(apiUrl('v1', `series/${UUID}`)).toBe(`/lumastra/api/v1/series/${UUID}`);
    });

    it('never doubles the base', () => {
        for (const surface of SURFACES) {
            expect(apiUrl(surface, '/series/x')).not.toContain('/lumastra/lumastra');
        }
    });
});

describe('entityImageUrl under a subpath install', () => {
    it('builds the canonical media-images path per surface', () => {
        expect(entityImageUrl(UUID, 'poster', 'internal')).toBe(
            `/lumastra/api/media/${UUID}/images/poster`,
        );
        expect(entityImageUrl(UUID, 'poster', 'v1')).toBe(
            `/lumastra/api/v1/media/${UUID}/images/poster`,
        );
    });

    it('keeps the size preset after the base rewrite', () => {
        expect(entityImageUrl(UUID, 'backdrop', 'v1', { size: 'wide' })).toBe(
            `/lumastra/api/v1/media/${UUID}/images/backdrop?size=wide`,
        );
    });

    it('emits no root-absolute /api path on any surface', () => {
        for (const surface of SURFACES) {
            for (const role of ['poster', 'backdrop', 'thumb', 'logo', 'still'] as const) {
                expect(entityImageUrl(UUID, role, surface).startsWith('/lumastra/')).toBe(true);
            }
        }
    });
});

describe('buildImageRefs under a subpath install', () => {
    it('emits every variant under base + surface prefix', () => {
        for (const surface of SURFACES) {
            const refs = buildImageRefs(UUID, surface);
            const expected = `${apiBase(surface)}/media/${UUID}/images/`;
            for (const href of [...Object.values(refs.poster), ...Object.values(refs.backdrop)]) {
                expect(href.startsWith(expected)).toBe(true);
            }
        }
    });
});

describe('appPath under a subpath install', () => {
    it('keeps the user inside the app', () => {
        // The bug this exists for: `redirect(302, '/')` sent the user to the HOST
        // root, i.e. out of the app entirely, at 47 call sites.
        expect(appPath('/')).toBe('/lumastra/');
        expect(appPath('/browse')).toBe('/lumastra/browse');
        expect(appPath('/settings/connections?link=error')).toBe(
            '/lumastra/settings/connections?link=error',
        );
    });

    it('never double-prefixes an already-based path', () => {
        expect(appPath('/lumastra/browse')).toBe('/lumastra/browse');
        expect(appPath('/lumastra')).toBe('/lumastra');
    });

    it('leaves absolute and protocol-relative URLs alone', () => {
        expect(appPath('https://example.com/x')).toBe('https://example.com/x');
        expect(appPath('//cdn.example.com/x')).toBe('//cdn.example.com/x');
    });
});
