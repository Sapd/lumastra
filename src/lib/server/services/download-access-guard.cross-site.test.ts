// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// crossSiteForbiddenResponse: Sec-Fetch-Site first, Origin / Referer when the header is missing.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({ downloads_not_allowed: () => 'no' }));
vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: async () => true,
    userMayDownload: async () => true,
}));
vi.mock('$lib/server/auth/locals-admin.js', () => ({ localsIsAdmin: () => false }));

import { crossSiteForbiddenResponse } from './download-access-guard';

const URL_ = 'https://lumastra.example/api/media/m1/download';
const check = (headers: Record<string, string>) =>
    crossSiteForbiddenResponse(new Request(URL_, { headers }), new URL(URL_));

describe('crossSiteForbiddenResponse', () => {
    it('refuses Sec-Fetch-Site: cross-site', () => {
        expect(check({ 'sec-fetch-site': 'cross-site' })?.status).toBe(403);
    });

    it.each(['same-origin', 'none'])('allows Sec-Fetch-Site: %s', (v) => {
        expect(check({ 'sec-fetch-site': v })).toBeNull();
    });

    it('refuses Sec-Fetch-Site: same-site and unknown values', () => {
        expect(check({ 'sec-fetch-site': 'same-site' })?.status).toBe(403);
        expect(check({ 'sec-fetch-site': 'weird' })?.status).toBe(403);
    });

    it('the header wins: same-origin passes even with a foreign Referer', () => {
        expect(
            check({ 'sec-fetch-site': 'same-origin', referer: 'https://evil.example/x' }),
        ).toBeNull();
    });

    it('without the header, a cross-site Referer is refused', () => {
        expect(check({ referer: 'https://evil.example/page' })?.status).toBe(403);
    });

    it('without the header, a same-origin Referer or Origin is allowed', () => {
        expect(check({ referer: 'https://lumastra.example/library' })).toBeNull();
        expect(check({ origin: 'https://lumastra.example' })).toBeNull();
    });

    it('without the header, a foreign or null Origin is refused (it wins over a good Referer)', () => {
        expect(check({ origin: 'https://evil.example' })?.status).toBe(403);
        expect(check({ origin: 'null' })?.status).toBe(403);
        expect(
            check({ origin: 'https://evil.example', referer: 'https://lumastra.example/x' })
                ?.status,
        ).toBe(403);
    });

    it('without the header and with neither Origin nor Referer, the request is refused', () => {
        expect(check({})?.status).toBe(403);
    });

    it('an unparseable Referer is refused', () => {
        expect(check({ referer: 'not a url' })?.status).toBe(403);
    });
});

describe('crossSiteForbiddenResponse: full origin, not just the host', () => {
    afterEach(() => {
        delete process.env.ORIGIN;
    });

    it('an http Origin or Referer for an https site is refused, same host or not', () => {
        expect(check({ origin: 'http://lumastra.example' })?.status).toBe(403);
        expect(check({ referer: 'http://lumastra.example/library' })?.status).toBe(403);
    });

    it('a different port is refused', () => {
        expect(check({ origin: 'https://lumastra.example:8443' })?.status).toBe(403);
    });

    it('ORIGIN, when set, is the trusted origin (TLS proxy: the request URL may say http)', () => {
        process.env.ORIGIN = 'https://lumastra.example';
        const behindProxy = (headers: Record<string, string>) =>
            crossSiteForbiddenResponse(
                new Request('http://127.0.0.1:3000/x', { headers }),
                new URL('http://127.0.0.1:3000/x'),
            );
        expect(behindProxy({ origin: 'https://lumastra.example' })).toBeNull();
        expect(behindProxy({ referer: 'https://lumastra.example/a' })).toBeNull();
        expect(behindProxy({ origin: 'http://lumastra.example' })?.status).toBe(403);
        expect(behindProxy({ origin: 'http://127.0.0.1:3000' })?.status).toBe(403);
    });
});
