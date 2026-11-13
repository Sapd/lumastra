// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The anonymous update check against lumastra.org: what leaves the process
 * (exact URL and headers: no install ID, no hash, nothing per-install), how
 * the answer is read, and the fallback to GitHub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const pinnedFetch = vi.fn<(safe: { url: URL }, init: RequestInit) => Promise<Response>>();
vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn(async () => undefined),
    resolveSafePublicUrl: vi.fn(async (url: URL) => ({ url, resolvedIp: '104.21.0.1' })),
    pinnedFetch: (safe: { url: URL }, init: RequestInit) => pinnedFetch(safe, init),
}));

import {
    fetchLumastraOrgReleases,
    fetchReleasesPreferringLumastraOrg,
    updateCheckUrl,
} from './lumastra-org-releases.js';

function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
}

const ORG_ANSWER = {
    releases: [
        {
            version: '0.2.2',
            url: 'https://github.com/Sapd/lumastra/releases/tag/v0.2.2',
            publishedAt: '2026-11-21T00:00:00Z',
            security: false,
            prerelease: false,
        },
        {
            version: '0.2.1',
            url: 'https://github.com/Sapd/lumastra/releases/tag/v0.2.1',
            publishedAt: '2026-11-20T00:00:00Z',
            security: true,
            prerelease: false,
        },
    ],
    complete: true,
};

const GITHUB_ANSWER = [
    {
        tag_name: 'v0.2.1',
        html_url: 'https://github.com/Sapd/lumastra/releases/tag/v0.2.1',
        published_at: '2026-11-20T00:00:00Z',
        body: 'Security: yes',
    },
];

/** Routes each request by host so the test sees which service was contacted. */
function route(org: () => Response | Promise<Response>, github?: () => Response) {
    pinnedFetch.mockImplementation(async (safe) => {
        if (safe.url.hostname === 'lumastra.org') return org();
        if (safe.url.hostname === 'api.github.com') {
            if (!github) throw new Error('GitHub must not be contacted');
            return github();
        }
        throw new Error(`unexpected host ${safe.url.hostname}`);
    });
}

const hosts = () => pinnedFetch.mock.calls.map((c) => c[0].url.hostname);

beforeEach(() => {
    pinnedFetch.mockReset();
});

describe('updateCheckUrl', () => {
    it('carries only the version, in this exact shape', () => {
        expect(updateCheckUrl('0.2.0').href).toBe('https://lumastra.org/api/update-check?v=0.2.0');
        expect(updateCheckUrl('v0.2.0-12-gabc1234-dirty').href).toBe(
            'https://lumastra.org/api/update-check?v=v0.2.0-12-gabc1234-dirty',
        );
    });

    it('never sends a string the worker would reject', () => {
        expect(updateCheckUrl('').searchParams.get('v')).toBe('unknown');
        expect(updateCheckUrl('1.0 beta').searchParams.get('v')).toBe('other');
        expect(updateCheckUrl('x'.repeat(65)).searchParams.get('v')).toBe('other');
        expect(updateCheckUrl('a&b=c').searchParams.get('v')).toBe('other');
    });
});

describe('fetchLumastraOrgReleases', () => {
    it('sends exactly one GET with only Accept and User-Agent: no ID, no hash, no body', async () => {
        route(() => json(ORG_ANSWER));
        await fetchLumastraOrgReleases({ version: '0.2.0' });
        expect(pinnedFetch).toHaveBeenCalledTimes(1);
        const [safe, init] = pinnedFetch.mock.calls[0];
        expect(safe.url.href).toBe('https://lumastra.org/api/update-check?v=0.2.0');
        expect(init.method ?? 'GET').toBe('GET');
        expect(init.body).toBeUndefined();
        expect(init.redirect).toBe('manual');
        expect(init.headers).toEqual({
            Accept: 'application/json',
            'User-Agent': 'Lumastra-update-check',
        });
    });

    it('reads the release list including the security flag', async () => {
        route(() => json(ORG_ANSWER));
        const out = await fetchLumastraOrgReleases({ version: '0.2.0' });
        expect(out).toEqual({
            kind: 'ok',
            etag: null,
            complete: true,
            releases: ORG_ANSWER.releases,
        });
    });

    it('replaces a release link outside the repository, and drops non-semver entries', async () => {
        route(() =>
            json({
                releases: [
                    { ...ORG_ANSWER.releases[0], url: 'https://evil.example/x' },
                    { ...ORG_ANSWER.releases[1], version: 'nightly' },
                ],
                complete: false,
            }),
        );
        const out = await fetchLumastraOrgReleases({ version: '0.2.0' });
        expect(out.kind).toBe('ok');
        if (out.kind !== 'ok') return;
        expect(out.releases).toHaveLength(1);
        expect(out.releases[0].url).toBe('https://github.com/Sapd/lumastra/releases');
        expect(out.complete).toBe(false);
    });

    it.each([
        ['HTTP 500', () => new Response('x', { status: 500 })],
        ['HTTP 429', () => new Response('x', { status: 429 })],
        [
            'a redirect',
            () => new Response(null, { status: 302, headers: { location: 'https://x.example/' } }),
        ],
        ['not JSON', () => new Response('<html>', { status: 200 })],
        ['a wrong shape', () => json({ latest: '0.2.2' })],
        [
            'a missing security flag',
            () =>
                json({
                    releases: [{ ...ORG_ANSWER.releases[0], security: undefined }],
                    complete: true,
                }),
        ],
    ])('%s is an error, never a verdict', async (_name, make) => {
        route(make);
        await expect(fetchLumastraOrgReleases({ version: '0.2.0' })).rejects.toThrow();
    });

    it('a network error rejects', async () => {
        pinnedFetch.mockRejectedValue(new TypeError('fetch failed'));
        await expect(fetchLumastraOrgReleases({ version: '0.2.0' })).rejects.toThrow(
            'fetch failed',
        );
    });
});

describe('fetchReleasesPreferringLumastraOrg', () => {
    const base = { version: '0.2.0', etag: null, signal: undefined };

    it('contact switched off: GitHub only, lumastra.org is never contacted', async () => {
        route(
            () => {
                throw new Error('lumastra.org must not be contacted');
            },
            () => json(GITHUB_ANSWER),
        );
        const onContact = vi.fn();
        const out = await fetchReleasesPreferringLumastraOrg({
            ...base,
            contact: false,
            contactAllowed: true,
            onContact,
        });
        expect(hosts()).toEqual(['api.github.com']);
        expect(onContact).not.toHaveBeenCalled();
        expect(out.kind).toBe('ok');
    });

    it('contact on: lumastra.org answers, GitHub is not contacted', async () => {
        route(() => json(ORG_ANSWER));
        const onContact = vi.fn();
        const out = await fetchReleasesPreferringLumastraOrg({
            ...base,
            contact: true,
            contactAllowed: true,
            onContact,
        });
        expect(hosts()).toEqual(['lumastra.org']);
        expect(onContact).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ kind: 'ok', etag: null });
    });

    it.each([
        ['HTTP 500', () => new Response('x', { status: 500 })],
        ['garbage', () => new Response('nope', { status: 200 })],
    ])('contact on, lumastra.org gives %s: falls back to GitHub', async (_n, make) => {
        route(make, () => json(GITHUB_ANSWER));
        const out = await fetchReleasesPreferringLumastraOrg({
            ...base,
            contact: true,
            contactAllowed: true,
        });
        expect(hosts()).toEqual(['lumastra.org', 'api.github.com']);
        expect(out.kind).toBe('ok');
        if (out.kind === 'ok')
            expect(out.releases[0]).toMatchObject({ version: '0.2.1', security: true });
    });

    it('contact on, network down: falls back to GitHub, and a GitHub failure is thrown', async () => {
        pinnedFetch.mockRejectedValue(new TypeError('fetch failed'));
        await expect(
            fetchReleasesPreferringLumastraOrg({ ...base, contact: true, contactAllowed: true }),
        ).rejects.toThrow('fetch failed');
        expect(pinnedFetch).toHaveBeenCalledTimes(2);
    });

    it('contact on but already tried today (contactAllowed false): straight to GitHub', async () => {
        route(
            () => {
                throw new Error('lumastra.org must not be contacted');
            },
            () => json(GITHUB_ANSWER),
        );
        await fetchReleasesPreferringLumastraOrg({ ...base, contact: true, contactAllowed: false });
        expect(hosts()).toEqual(['api.github.com']);
    });

    it('the opt-out is read when the request is made, not when the run started', async () => {
        route(
            () => json(ORG_ANSWER),
            () => json(GITHUB_ANSWER),
        );
        let on = true;
        const run = () =>
            fetchReleasesPreferringLumastraOrg({
                ...base,
                contact: () => on,
                contactAllowed: true,
            });
        on = false;
        await run();
        expect(hosts()).toEqual(['api.github.com']);
    });
});
