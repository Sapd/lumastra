// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one outbound request, mocked at the pinned transport (ssrf-guard), so
 * the headers, status handling and host restriction are exercised exactly as
 * they leave the process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const pinnedFetch = vi.fn<(safe: { url: URL }, init: RequestInit) => Promise<Response>>();
vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn(async () => undefined),
    resolveSafePublicUrl: vi.fn(async (url: URL) => ({ url, resolvedIp: '140.82.121.6' })),
    pinnedFetch: (safe: { url: URL }, init: RequestInit) => pinnedFetch(safe, init),
}));

import {
    fetchLumastraReleases,
    MAX_PAGES,
    nextPageUrl,
    rateLimitRetryAt,
    toReleaseInfos,
} from './github-releases.js';

function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
}

const RELEASES = [
    {
        tag_name: 'v0.1.1',
        html_url: 'https://github.com/Sapd/lumastra/releases/tag/v0.1.1',
        published_at: '2026-10-20T00:00:00Z',
        body: '### Security\n- fix\n\nSecurity: yes',
        draft: false,
        prerelease: false,
    },
    { tag_name: 'v0.2.0', draft: true, body: 'Security: yes' },
    { tag_name: 'nightly', body: 'Security: yes' },
    {
        tag_name: 'v0.1.0',
        html_url: 'https://github.com/someone-else/repo/releases/tag/v0.1.0',
    },
    {
        tag_name: 'v0.2.0-rc.1',
        html_url: 'https://evil.example/phish',
        prerelease: true,
        body: null,
    },
];

beforeEach(() => {
    pinnedFetch.mockReset();
});

describe('fetchLumastraReleases', () => {
    it('asks api.github.com without a token, with UA and If-None-Match', async () => {
        pinnedFetch.mockResolvedValue(json(RELEASES, { headers: { etag: '"abc"' } }));
        const out = await fetchLumastraReleases({ etag: '"old"' });

        const [safe, init] = pinnedFetch.mock.calls[0];
        expect(safe.url.href).toBe(
            'https://api.github.com/repos/Sapd/lumastra/releases?per_page=100',
        );
        const headers = init.headers as Record<string, string>;
        expect(headers['If-None-Match']).toBe('"old"');
        // No version in the UA: IP + exact build would list unpatched installs.
        expect(headers['User-Agent']).toBe('Lumastra-update-check');
        expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
        expect(init.redirect).toBe('manual');

        expect(out).toMatchObject({ kind: 'ok', etag: '"abc"' });
        if (out.kind !== 'ok') throw new Error('unreachable');
        // Draft and non-semver tag dropped; security marker read; links outside
        // this repository's releases replaced.
        expect(out.releases.map((r) => r.version)).toEqual(['0.1.1', '0.1.0', '0.2.0-rc.1']);
        expect(out.releases[1].url).toBe('https://github.com/Sapd/lumastra/releases');
        expect(out.releases[0].security).toBe(true);
        expect(out.releases[2]).toMatchObject({
            prerelease: true,
            security: false,
            url: 'https://github.com/Sapd/lumastra/releases',
        });
    });

    it('omits If-None-Match without a stored ETag', async () => {
        pinnedFetch.mockResolvedValue(json([]));
        await fetchLumastraReleases({ etag: null });
        expect(pinnedFetch.mock.calls[0][1].headers).not.toHaveProperty('If-None-Match');
    });

    it('maps 304, 404 and the rate limit', async () => {
        pinnedFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
        expect(await fetchLumastraReleases({ etag: '"a"' })).toEqual({
            kind: 'not-modified',
        });

        pinnedFetch.mockResolvedValueOnce(json({ message: 'Not Found' }, { status: 404 }));
        expect(await fetchLumastraReleases({ etag: null })).toEqual({
            kind: 'not-found',
        });

        pinnedFetch.mockResolvedValueOnce(
            json(
                { message: 'API rate limit exceeded' },
                {
                    status: 403,
                    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' },
                },
            ),
        );
        const limited = await fetchLumastraReleases({ etag: null });
        expect(limited.kind).toBe('rate-limited');
        // A reset in the year 2100 is clamped to a day.
        if (limited.kind !== 'rate-limited') throw new Error('unreachable');
        expect(Date.parse(limited.retryAt) - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    });

    it('throws on other errors (the caller logs and carries on)', async () => {
        pinnedFetch.mockResolvedValueOnce(new Response('boom', { status: 502 }));
        await expect(fetchLumastraReleases({ etag: null })).rejects.toThrow('HTTP 502');
        pinnedFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        await expect(fetchLumastraReleases({ etag: null })).rejects.toThrow('fetch failed');
    });

    it('follows a redirect on api.github.com, refuses one off it', async () => {
        pinnedFetch
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 301,
                    headers: { location: 'https://api.github.com/repositories/1/releases' },
                }),
            )
            .mockResolvedValueOnce(json([]));
        expect(await fetchLumastraReleases({ etag: null })).toMatchObject({
            kind: 'ok',
        });

        pinnedFetch
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 308,
                    headers: { location: 'https://api.github.com/repositories/1/releases' },
                }),
            )
            .mockResolvedValueOnce(json([]));
        expect(await fetchLumastraReleases({ etag: null })).toMatchObject({ kind: 'ok' });

        pinnedFetch.mockResolvedValueOnce(
            new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
        );
        await expect(fetchLumastraReleases({ etag: null })).rejects.toThrow(/refusing to leave/);
    });

    it('caps the response size', async () => {
        pinnedFetch.mockResolvedValueOnce(
            new Response('[]', { headers: { 'content-length': String(10 * 1024 * 1024) } }),
        );
        await expect(fetchLumastraReleases({ etag: null })).rejects.toThrow(/size cap/);
    });
});

describe('pagination', () => {
    const page = (tag: string, next?: string): Response =>
        json([{ tag_name: tag, body: tag === 'v0.0.1' ? 'Security: yes' : '' }], {
            headers: next ? { link: `<${next}>; rel="next", <${next}>; rel="last"` } : {},
        });
    const P2 = 'https://api.github.com/repositories/1/releases?per_page=100&page=2';
    const P3 = 'https://api.github.com/repositories/1/releases?per_page=100&page=3';

    it('follows rel="next" so an old security release is still seen', async () => {
        pinnedFetch.mockResolvedValueOnce(page('v0.0.3', P2)).mockResolvedValueOnce(page('v0.0.1'));
        const out = await fetchLumastraReleases({ etag: '"e"' });
        expect(out).toMatchObject({ kind: 'ok', complete: true });
        expect(out.kind === 'ok' && out.releases.map((r) => [r.version, r.security])).toEqual([
            ['0.0.3', false],
            ['0.0.1', true],
        ]);
        // Only page 1 is conditional.
        expect(pinnedFetch.mock.calls[1][1].headers).not.toHaveProperty('If-None-Match');
        expect(pinnedFetch.mock.calls[1][0].url.href).toBe(P2);
    });

    it(`stops after ${MAX_PAGES} pages`, async () => {
        pinnedFetch
            .mockResolvedValueOnce(page('v0.0.5', P2))
            .mockResolvedValueOnce(page('v0.0.4', P3))
            .mockResolvedValueOnce(page('v0.0.3', P3));
        await fetchLumastraReleases({ etag: null });
        expect(pinnedFetch).toHaveBeenCalledTimes(MAX_PAGES);
    });

    it('a failing later page keeps page 1, and never leaves api.github.com', async () => {
        // Never queried: the off-host next link is refused before any request.
        pinnedFetch.mockResolvedValueOnce(page('v0.0.3', 'https://evil.example/releases?page=2'));
        const out = await fetchLumastraReleases({ etag: null });
        expect(out.kind === 'ok' && out.releases.map((r) => r.version)).toEqual(['0.0.3']);
        expect(pinnedFetch).toHaveBeenCalledTimes(1);

        pinnedFetch
            .mockResolvedValueOnce(page('v0.0.3', P2))
            .mockResolvedValueOnce(new Response('boom', { status: 502 }));
        const partial = await fetchLumastraReleases({ etag: null });
        expect(partial).toMatchObject({ kind: 'ok', complete: false });
        expect(partial.kind === 'ok' && partial.releases.map((r) => r.version)).toEqual(['0.0.3']);
    });

    it('nextPageUrl reads the Link header', () => {
        expect(nextPageUrl(`<${P2}>; rel="next", <${P3}>; rel="last"`)).toBe(P2);
        expect(nextPageUrl(`<${P3}>; rel="prev"`)).toBeNull();
        expect(nextPageUrl(null)).toBeNull();
        // Only a releases listing of this repository is followed.
        expect(
            nextPageUrl('<https://api.github.com/search/code?q=x&page=2>; rel="next"'),
        ).toBeNull();
        expect(
            nextPageUrl('<https://evil.example/repos/Sapd/lumastra/releases>; rel="next"'),
        ).toBeNull();
        expect(
            nextPageUrl('<https://api.github.com/repos/Sapd/lumastra/releases?page=2>; rel="next"'),
        ).toBe('https://api.github.com/repos/Sapd/lumastra/releases?page=2');
    });
});

describe('helpers', () => {
    it('rateLimitRetryAt prefers Retry-After, falls back to an hour', () => {
        const now = Date.parse('2026-11-01T00:00:00Z');
        expect(rateLimitRetryAt(new Headers({ 'retry-after': '120' }), now)).toBe(
            '2026-11-01T00:02:00.000Z',
        );
        expect(rateLimitRetryAt(new Headers(), now)).toBe('2026-11-01T01:00:00.000Z');
        // Clamped: a bogus header cannot park the check for months.
        expect(rateLimitRetryAt(new Headers({ 'retry-after': '99999999' }), now)).toBe(
            '2026-11-02T00:00:00.000Z',
        );
        expect(rateLimitRetryAt(new Headers({ 'retry-after': '1' }), now)).toBe(
            '2026-11-01T00:01:00.000Z',
        );
    });

    it('toReleaseInfos rejects a non-array payload', () => {
        expect(() => toReleaseInfos({ message: 'x' })).toThrow();
    });
});
