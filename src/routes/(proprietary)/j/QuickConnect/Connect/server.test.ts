// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review 2026-09-13, C24 — /j/QuickConnect/Connect's
 * rate limit must key on the STRICT (non-spoofable) client IP, not the
 * implicit-trust `getClientIp`. When `TRUSTED_PROXY_IPS` is unset, `getClientIp`
 * honors an attacker-supplied `X-Forwarded-For` by implicit proxy trust, so an
 * attacker could rotate the header to get a fresh bucket per request and flood
 * Connect (polled by clients) past its 30/min cap.
 *
 * Mirrors `src/routes/(proprietary)/j/QuickConnect/Initiate/server.test.ts`
 * (C13), which fixed the sibling Quick Connect endpoint the same way.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` or
 * `$lib/server/middleware/valkey-rate-limit.js` — both are exercised for real
 * so the strict-vs-spoofable distinction is genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const mockCacheGet = vi.fn(async () =>
    JSON.stringify({
        code: '123456',
        authenticated: false,
        userId: null,
        username: null,
        isAdmin: false,
        groups: [],
        displayName: null,
    }),
);
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: (...args: unknown[]) =>
        (mockCacheGet as unknown as (...a: unknown[]) => unknown)(...args),
    cacheSet: vi.fn(async () => undefined),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    del: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));

// NOTE: $lib/server/utils/client-ip.js and
// $lib/server/middleware/valkey-rate-limit.js are intentionally NOT mocked.

import { GET } from './+server.js';

function makeEvent(opts: { peer: string; xff?: string }): Parameters<typeof GET>[0] {
    const url = new URL('http://localhost/j/QuickConnect/Connect?Secret=abc123');
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, { method: 'GET', headers });

    return {
        url,
        request,
        params: {},
        route: { id: null },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCacheGet.mockResolvedValue(
        JSON.stringify({
            code: '123456',
            authenticated: false,
            userId: null,
            username: null,
            isAdmin: false,
            groups: [],
            displayName: null,
        }),
    );
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('C24 — /j/QuickConnect/Connect rate limit uses the strict client IP', () => {
    it('31 requests from the SAME peer with a DIFFERENT X-Forwarded-For each time collapse into one bucket, and the 31st is 429', async () => {
        const PEER = '203.0.113.88';
        const LIMIT = 30;

        const statuses: number[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            const event = makeEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const response = await GET(event);
            statuses.push(response.status);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(statuses[i]).not.toBe(429);
        }
        expect(statuses[LIMIT]).toBe(429);
    });
});
