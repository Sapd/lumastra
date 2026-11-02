// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '/lumastra' }));

const { diagnosticPathTemplate } = await import('./route-template.js');

describe('diagnosticPathTemplate', () => {
    it('keeps literal route names, the base path and codec-style file names', () => {
        expect(diagnosticPathTemplate('/lumastra/api/v1/play-sessions')).toBe(
            '/lumastra/api/v1/play-sessions',
        );
        expect(diagnosticPathTemplate('/api/media/x/stream/master.m3u8')).toBe(
            '/api/media/:id/stream/master.m3u8',
        );
    });

    it.each([
        ['a search term', '/api/search/inception', '/api/search/:id'],
        ['a user name', '/api/users/denis/avatar', '/api/users/:id/avatar'],
        ['a letters-only share token', '/api/share/qwertyuiopasdfgh', '/api/:id/:id'],
        ['a short mixed code', '/api/media/Ab3dE9', '/api/media/:id'],
        ['a composite id', '/api/items/tmdb:550:movie/rating', '/api/items/:id/rating'],
        ['a uuid', '/api/media/6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11', '/api/media/:id'],
        ['an encoded slug', '/api/search/the%20dark%20knight', '/api/search/:id'],
    ])('replaces %s', (_label, path, expected) => {
        expect(diagnosticPathTemplate(path)).toBe(expected);
    });

    it('drops the query string and fragment of an absolute URL', () => {
        expect(
            diagnosticPathTemplate('https://host.test/api/media?grant=SECRET&api_key=KEY#x'),
        ).toBe('/api/media');
    });

    it('knows the route tree (the build-time word list is compiled in)', () => {
        expect(__DIAGNOSTIC_ROUTE_WORDS__).toContain('play-sessions');
        expect(__DIAGNOSTIC_ROUTE_WORDS__).not.toContain('[id]');
        expect(__DIAGNOSTIC_ROUTE_WORDS__?.some((w) => w.startsWith('('))).toBe(false);
    });
});
