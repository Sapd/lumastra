// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review 2026-09-12, C13 — /j/QuickConnect/Initiate's
 * rate limit must key on the STRICT (non-spoofable) client IP, not the
 * implicit-trust `getClientIp`. When `TRUSTED_PROXY_IPS` is unset, `getClientIp`
 * honors an attacker-supplied `X-Forwarded-For` by implicit proxy trust, so an
 * attacker could rotate the header to get a fresh bucket per request and flood
 * Initiate past its 30/min cap.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` or
 * `$lib/server/middleware/valkey-rate-limit.js` — both are exercised for real
 * so the strict-vs-spoofable distinction is genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const log = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: log, debug: vi.fn() }),
    },
}));

const mockCacheSet = vi.fn(async () => undefined);
vi.mock('$lib/server/cache/valkey', () => ({
    cacheSet: (...args: unknown[]) =>
        (mockCacheSet as unknown as (...a: unknown[]) => unknown)(...args),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    del: vi.fn(async () => undefined),
}));

const mockStoreRequest = vi.fn(async (_code: string, _secret: string, _data: string) => true);
vi.mock('$lib/server/jellyfin-compat/quick-connect-store', () => ({
    storeQuickConnectRequest: (...args: unknown[]) =>
        (mockStoreRequest as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Heavy transitive deps (session/PAT validation) aren't needed for Initiate —
// only parseEmbyAuthHeader is used, and only to read device metadata.
vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));

// NOTE: $lib/server/utils/client-ip.js and
// $lib/server/middleware/valkey-rate-limit.js are intentionally NOT mocked.

import { POST } from './+server.js';

function makeEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('http://localhost/j/QuickConnect/Initiate');
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, { method: 'POST', headers });

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
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockStoreRequest.mockResolvedValue(true);
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('C13 — /j/QuickConnect/Initiate rate limit uses the strict client IP', () => {
    it('31 requests from the SAME peer with a DIFFERENT X-Forwarded-For each time collapse into one bucket, and the 31st is 429', async () => {
        const PEER = '203.0.113.77';
        const LIMIT = 30;

        const statuses: number[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            const event = makeEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const response = await POST(event);
            statuses.push(response.status);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(statuses[i]).not.toBe(429);
        }
        expect(statuses[LIMIT]).toBe(429);
    });
});

describe('Quick Connect code reservation', () => {
    it('retries a collision instead of returning a code belonging to another request', async () => {
        mockStoreRequest.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const response = await POST(makeEvent({ peer: '203.0.113.90' }));
        expect(response.status).toBe(200);
        expect(mockStoreRequest).toHaveBeenCalledTimes(2);
        const body = (await response.json()) as { Secret: string; Code: string };
        expect(body.Code).toBe(mockStoreRequest.mock.calls[1]![0]);
        expect(body.Secret).toBe(mockStoreRequest.mock.calls[1]![1]);
        expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('fails closed after repeated collisions', async () => {
        mockStoreRequest.mockResolvedValue(false);
        const response = await POST(makeEvent({ peer: '203.0.113.91' }));
        expect(response.status).toBe(503);
        expect(mockStoreRequest).toHaveBeenCalledTimes(10);
    });
});

it('logs no code-derived Quick Connect identifier', async () => {
    const response = await POST(makeEvent({ peer: '203.0.113.92' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { Code: string };
    expect(JSON.stringify(log.mock.calls)).not.toContain(body.Code);
    expect(log).toHaveBeenCalledWith('Quick Connect initiated');
});
