// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * routedPathname must agree with the path SvelteKit routes on: it decides which
 * auth branch a request takes (resolveAuth, the /api/v1 backstop, CSRF), and a
 * disagreement is exactly the 2026-10-07 bug, where `/de/api/v1/…` ran /api/v1
 * handlers through the forward-auth branch.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '' }));

import { routedPathname } from './routed-pathname';

const at = (path: string, basePath?: string): string =>
    routedPathname(new URL(`http://localhost${path}`), basePath);

describe('routedPathname', () => {
    it.each([
        ['/api/v1/me', '/api/v1/me'],
        ['/api/%76%31/me', '/api/v1/me'],
        ['/de/api/v1/me', '/api/v1/me'],
        ['/en/api/v1/me', '/api/v1/me'],
        ['/de/login', '/login'],
        ['/de/j/Users', '/j/Users'],
        ['/j/system/info/public', '/j/System/Info/Public'],
        ['/j/items/abc/Images/Primary/0', '/j/Items/abc/Images/Primary'],
        ['/browse', '/browse'],
    ])('%s routes as %s', (raw, routed) => {
        expect(at(raw)).toBe(routed);
    });

    it('keeps %2F and %25 encoded, as SvelteKit does', () => {
        expect(at('/api/v1/a%2Fb')).toBe('/api/v1/a%2Fb');
        expect(at('/api/v1/a%252Fb')).toBe('/api/v1/a%252Fb');
    });

    it('a malformed escape keeps the rerouted path, so the surface is still recognised', () => {
        expect(at('/de/api/v1/%E0%A4%A')).toBe('/api/v1/%E0%A4%A');
    });

    it('strips the base path of a subfolder install', () => {
        expect(at('/media/api/v1/me', '/media')).toBe('/api/v1/me');
        expect(at('/media', '/media')).toBe('/');
        expect(at('/mediathek/api/v1/me', '/media')).toBe('/mediathek/api/v1/me');
    });
});
