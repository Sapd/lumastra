// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// crossSiteForbiddenResponse: Sec-Fetch-Site first, Origin / Referer when the header is missing.

import { describe, expect, it, vi } from 'vitest';

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
