// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { joinUpstreamUrl, tryJoinUpstreamUrl } from './upstream-url.js';

describe.each(['jellyfin', 'audiobookshelf'])('%s base URL', (prefix) => {
    it.each(['', '/', '///'])('appends within the base path with trailing %j', (suffix) => {
        expect(joinUpstreamUrl(`https://proxy/${prefix}${suffix}`, '/api/items')).toBe(
            `https://proxy/${prefix}/api/items`,
        );
    });

    it('retains nested paths, the port and percent-encoded segments', () => {
        expect(joinUpstreamUrl(`http://proxy:8096/media/${prefix}`, '/Items/a%2Fb')).toBe(
            `http://proxy:8096/media/${prefix}/Items/a%2Fb`,
        );
    });

    it('normalizes duplicate path slashes without changing query values', () => {
        expect(
            joinUpstreamUrl(
                `https://proxy//${prefix}//`,
                '//api//items?q=https%3A%2F%2Fa&tag=x&tag=y',
            ),
        ).toBe(`https://proxy/${prefix}/api/items?q=https%3A%2F%2Fa&tag=x&tag=y`);
    });

    it('keeps base query parameters and appends endpoint query parameters', () => {
        const url = new URL(
            joinUpstreamUrl(`https://proxy/${prefix}/?tenant=one`, '/Items?q=a%2Fb'),
        );
        expect(url.pathname).toBe(`/${prefix}/Items`);
        expect(url.searchParams.get('tenant')).toBe('one');
        expect(url.searchParams.get('q')).toBe('a/b');
    });

    it('supports a subdomain without a path', () => {
        expect(joinUpstreamUrl(`https://${prefix}.test/`, 'api/items')).toBe(
            `https://${prefix}.test/api/items`,
        );
    });

    it('supports a root-relative public URL without adding Lumastra’s own prefix', () => {
        expect(joinUpstreamUrl(`/media/${prefix}/`, '/web/#/home.html')).toBe(
            `/media/${prefix}/web/#/home.html`,
        );
    });

    it('does not let dot segments escape the configured prefix', () => {
        expect(() => joinUpstreamUrl(`https://proxy/${prefix}`, '/api/../Users')).toThrow();
        expect(() => joinUpstreamUrl(`https://proxy/${prefix}`, '/%2e%2e/Users')).toThrow();
    });
});

it('preserves Jellyfin web-client fragments under the public base path', () => {
    expect(joinUpstreamUrl('https://proxy/jellyfin/', '/web/#/home.html')).toBe(
        'https://proxy/jellyfin/web/#/home.html',
    );
});

describe('upstream URL validation', () => {
    it.each(['a\\..\\..\\b', '/a/.\t./b', '/a/.\n./b', '/a/.\r./b', '/a/\0/b', '/a/\x7f/b'])(
        'rejects backslashes or control characters in endpoint path %j',
        (endpoint) => {
            expect(() => joinUpstreamUrl('http://h/jf', endpoint)).toThrow();
        },
    );

    it.each(['https://other.test/api', '//other.test/api'])(
        'treats %s as a path under the configured host and prefix',
        (endpoint) => {
            const url = new URL(joinUpstreamUrl('https://proxy/jf', endpoint));
            expect(url.origin).toBe('https://proxy');
            expect(url.pathname.startsWith('/jf/')).toBe(true);
            expect(url.pathname.endsWith('/other.test/api')).toBe(true);
        },
    );

    it.each(['', 'jellyfin.local', 'jellyfin.local:8096', 'ftp://host/jf', 'file:///jf'])(
        'throws for invalid server base %j but returns null for a rendered link',
        (base) => {
            expect(() => joinUpstreamUrl(base, '/api/items')).toThrow();
            expect(tryJoinUpstreamUrl(base, '/api/items')).toBeNull();
        },
    );

    it.each(['', '?'])('preserves a base query with endpoint %j', (endpoint) => {
        expect(joinUpstreamUrl('https://proxy/jf/?tenant=one&tag=a&tag=b', endpoint)).toBe(
            'https://proxy/jf?tenant=one&tag=a&tag=b',
        );
    });

    it('returns the same valid URL from the render-safe helper', () => {
        expect(tryJoinUpstreamUrl('/jellyfin/', '/web/#/home.html')).toBe(
            '/jellyfin/web/#/home.html',
        );
        expect(tryJoinUpstreamUrl('https://proxy/jf?tenant=one', '/Items?id=two')).toBe(
            'https://proxy/jf/Items?tenant=one&id=two',
        );
        expect(tryJoinUpstreamUrl('https://proxy/jf', '/api/../Users')).toBeNull();
    });
});
