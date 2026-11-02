// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * POST /j/Users/AuthenticateWithQuickConnect is anonymous. It used to call a
 * bare `request.json()` (bounded only by adapter-node's 50M BODY_SIZE_LIMIT)
 * and then sent the "secret" to Valkey as a key, with no per-IP limit. The body
 * must be capped before anything reads it, and the route must be rate limited
 * like its sibling QuickConnect/Initiate.
 *
 * The rate limiter is NOT mocked, so the strict-IP bucket is real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({
    userAllowsLiveTv: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const mockCacheGet = vi.fn(async (_key: string): Promise<string | null> => null);
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: (key: string) => mockCacheGet(key),
    cacheDel: vi.fn(async () => 0),
    cacheSet: vi.fn(async () => undefined),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    getKeysByPattern: vi.fn(async () => []),
    del: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/auth', () => ({
    createSession: vi.fn(async () => 'token'),
}));
vi.mock('$lib/server/auth', () => ({ hasGroupPermission: () => false }));
vi.mock('$lib/server/config', () => ({ config: { LIVETV_GROUPS: [] } }));
vi.mock('$lib/server/proprietary/jellyfin-compat/serializers/user', () => ({
    serializeUser: () => ({}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/playback-utils', () => ({
    clampJellyfinDeviceId: (raw: unknown) => (typeof raw === 'string' ? raw : ''),
}));

import { POST } from './+server.js';

function makeEvent(request: Request, peer = '203.0.113.20'): RequestEvent {
    return {
        url: new URL(request.url),
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
        getClientAddress: () => peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const URL_QC = 'http://localhost/j/Users/AuthenticateWithQuickConnect';

function jsonRequest(body: string): Request {
    return new Request(URL_QC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('AuthenticateWithQuickConnect body cap', () => {
    it('refuses a 1 MB body with 413 before the secret reaches Valkey', async () => {
        const res = await POST(
            makeEvent(
                jsonRequest(JSON.stringify({ Secret: 'A'.repeat(1024 * 1024) })),
                '203.0.113.21',
            ),
        );
        expect(res.status).toBe(413);
        expect(mockCacheGet).not.toHaveBeenCalled();
    });

    it('refuses an over-cap CHUNKED body (no Content-Length) with 413', async () => {
        const chunk = new TextEncoder().encode('{"Secret":"' + 'A'.repeat(64 * 1024));
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < 4; i++) controller.enqueue(chunk);
                controller.close();
            },
        });
        const request = new Request(URL_QC, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: stream,
            // @ts-expect-error Node's fetch needs duplex for a streamed body
            duplex: 'half',
        });
        expect(request.headers.get('content-length')).toBeNull();
        const res = await POST(makeEvent(request, '203.0.113.22'));
        expect(res.status).toBe(413);
        expect(mockCacheGet).not.toHaveBeenCalled();
    });

    it('refuses a Secret longer than a real one without a Valkey lookup', async () => {
        const res = await POST(
            makeEvent(jsonRequest(JSON.stringify({ Secret: 'a'.repeat(129) })), '203.0.113.23'),
        );
        expect(res.status).toBe(422);
        expect(mockCacheGet).not.toHaveBeenCalled();
    });

    it('still looks up a normal 32-char secret (unknown secret is a 404)', async () => {
        const secret = 'ab'.repeat(16);
        const res = await POST(
            makeEvent(jsonRequest(JSON.stringify({ Secret: secret })), '203.0.113.24'),
        );
        expect(res.status).toBe(404);
        expect(mockCacheGet).toHaveBeenCalledWith(expect.stringContaining(secret));
    });
});

describe('AuthenticateWithQuickConnect rate limit', () => {
    it('31 requests from one peer (rotating X-Forwarded-For) end in 429', async () => {
        const PEER = '203.0.113.99';
        const statuses: number[] = [];
        for (let i = 0; i <= 30; i++) {
            const request = new Request(URL_QC, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-forwarded-for': `198.51.100.${i % 255}`,
                },
                body: JSON.stringify({ Secret: 'ab'.repeat(16) }),
            });
            statuses.push((await POST(makeEvent(request, PEER))).status);
        }
        for (let i = 0; i < 30; i++) expect(statuses[i]).not.toBe(429);
        expect(statuses[30]).toBe(429);
    });
});

describe('AuthenticateWithQuickConnect rate limit behind a configured proxy', () => {
    it('with TRUSTED_PROXY_IPS set, each forwarded client gets its own bucket', async () => {
        // client-ip reads TRUSTED_PROXY_IPS once, at module load.
        process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
        vi.resetModules();
        const { POST: PostBehindProxy } = await import('./+server.js');
        try {
            const statuses: number[] = [];
            for (let i = 0; i < 35; i++) {
                const request = new Request(URL_QC, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-forwarded-for': `198.51.100.${i + 1}`,
                    },
                    body: JSON.stringify({ Secret: 'ab'.repeat(16) }),
                });
                statuses.push((await PostBehindProxy(makeEvent(request, '10.0.0.5'))).status);
            }
            expect(statuses).not.toContain(429);
        } finally {
            delete process.env.TRUSTED_PROXY_IPS;
        }
    });
});
