// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/auth/native/setup: the per-IP rate-limit bucket
 * (`setup:ip:${ip}`) must key on the STRICT (non-spoofable) client IP
 * (`getClientIpStrict`), not the implicit-trust `getClientIp`. When
 * `TRUSTED_PROXY_IPS` is unset (the common fresh-box default), `getClientIp`
 * honors an attacker-supplied `X-Forwarded-For` by implicit proxy trust, so
 * keying the bucket on it would let an attacker rotate the header per request
 * to dodge the cap while running unauthenticated scrypt (hashPassword) on
 * every attempt.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` — the real
 * module is exercised so the strict-vs-spoofable distinction is genuine.
 * Relies on `TRUSTED_PROXY_IPS` being unset in the test environment.
 *
 * Also covers C16 (2026-09-16 fix plan): this route buffered the whole body
 * via a bare `request.json()` before its 128/1024-char length checks ran —
 * the `adminExists` 409 is only evaluated inside the service, i.e. after the
 * full parse. Unlike `native/login`, this gap is PERMANENT: the route stays
 * reachable pre-auth forever (its own guard is `adminExists`, not a
 * time-boxed setup window), not just once per fresh deployment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/api-responses.js', () => ({
    ApiResponses: {
        rateLimited: (resetTime?: number) =>
            new Response(JSON.stringify({ error: 'Rate limited', resetTime }), { status: 429 }),
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
        error: (msg: string, _details: unknown, status: number) =>
            new Response(JSON.stringify({ error: msg }), { status }),
        aiDatabaseUnavailable: () =>
            new Response(JSON.stringify({ error: 'db unavailable' }), { status: 503 }),
        // C16: the shared 413 response the bounded-body-reader gate returns.
        payloadTooLarge: (message = 'Request body is too large') =>
            new Response(JSON.stringify({ error: message }), { status: 413 }),
    },
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));

// Every setup attempt fails fast (setup already completed) — the ip-gate check
// happens BEFORE this is reached, so it doesn't affect the rate-limit
// assertions.
const mockCompleteNativeSetup = vi.fn(async (..._args: unknown[]) => ({
    ok: false as const,
    status: 409,
    message: 'Setup has already been completed.',
}));
vi.mock('$lib/server/services/native-auth.service.js', () => ({
    completeNativeSetup: (...args: unknown[]) => mockCompleteNativeSetup(...args),
    completeForwardAuthSetup: vi.fn(),
}));

vi.mock('$lib/server/middleware/forward-auth.js', () => ({
    readTrustedForwardAuthIdentity: vi.fn(() => null),
}));

vi.mock('$lib/server/auth/native-session.js', () => ({
    setSessionCookie: vi.fn(),
    sessionMaxAgeSeconds: () => 3600,
}));

// Fixed-window counter keyed on whatever string checkRateLimit is called
// with — lets the tests assert bucket IDENTITY (the same key hit N+1 times)
// without depending on Valkey/memory-store internals.
const rateLimitCounts = new Map<string, number>();
const mockCheckRateLimit = vi.fn(async (key: string, limit: number, _windowSize?: number) => {
    const count = (rateLimitCounts.get(key) ?? 0) + 1;
    rateLimitCounts.set(key, count);
    return { allowed: count <= limit, resetAt: 9999999999 };
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: [string, number, number]) => mockCheckRateLimit(...args),
}));

// NOTE: $lib/server/utils/client-ip.js is intentionally NOT mocked — see the
// file doc comment above.

import { POST } from './+server.js';

function makeSetupEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('http://localhost/api/auth/native/setup');
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            method: 'native',
            username: 'admin',
            password: 'irrelevant-password',
        }),
    });

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

/**
 * Marks `reachedEnd` true only once the LAST byte of the real body has been
 * pulled out of the source — i.e. only if the stream was drained to
 * completion. A cancelled reader (the bounded reader aborting once the cap
 * is crossed) can never reach this, regardless of exactly how many
 * (implementation-specific, e.g. undici's own read-ahead) `pull()` calls
 * happened before the cancel — a strict pull COUNT would be flaky, this
 * boolean is not. Uses a real (unmocked) per-chunk delay — like
 * bounded-body-reader.test.ts's own `makeSlowStream` — so the consumer's
 * cancel() has a chance to run BETWEEN chunks; a synchronous pull() lets
 * undici's Request implementation drain the whole source eagerly before our
 * reader ever gets a turn.
 */
function makeStreamedEvent(opts: {
    peer: string;
    bodyBytes: number;
    declaredContentLength: string | undefined;
    drainTracker?: { reachedEnd: boolean };
}): RequestEvent {
    const url = new URL('http://localhost/api/auth/native/setup');
    const encoder = new TextEncoder();
    const realBodyText = JSON.stringify({
        method: 'native',
        username: 'firstadmin',
        password: 'x'.repeat(opts.bodyBytes),
    });
    const chunkSize = 4096;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            await new Promise((r) => setTimeout(r, 1));
            if (offset >= realBodyText.length) {
                if (opts.drainTracker) opts.drainTracker.reachedEnd = true;
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(realBodyText.slice(offset, offset + chunkSize)));
            offset += chunkSize;
        },
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.declaredContentLength !== undefined) {
        headers['content-length'] = opts.declaredContentLength;
    }
    const request = new Request(url, {
        method: 'POST',
        headers,
        body: stream,
        duplex: 'half',
    } as RequestInit & { duplex: 'half' });

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
    mockCompleteNativeSetup.mockResolvedValue({
        ok: false,
        status: 409,
        message: 'Setup has already been completed.',
    });
    rateLimitCounts.clear();
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('POST /api/auth/native/setup — IP rate-limit bucket keys on the strict (non-spoofable) IP', () => {
    it('N+1 setup attempts, each with a DIFFERENT X-Forwarded-For, from the SAME peer collapse into ONE bucket and the (N+1)th is limited', async () => {
        const PEER = '203.0.113.20';
        const LIMIT = 20; // matches the route's checkRateLimit(..., 20, 15 * 60)

        const responses: Response[] = [];
        for (let i = 0; i < LIMIT + 1; i++) {
            const event = makeSetupEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const response = await POST(event as Parameters<typeof POST>[0]);
            responses.push(response);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(responses[i].status).not.toBe(429);
        }
        expect(responses[LIMIT].status).toBe(429);

        // All LIMIT+1 attempts, despite LIMIT+1 distinct XFF values, land in ONE
        // ip-keyed bucket (keyed on the peer, not the attacker-spoofed XFF).
        expect(rateLimitCounts.get(`setup:ip:${PEER}`)).toBe(LIMIT + 1);
        const ipKeys = [...rateLimitCounts.keys()].filter((k) => k.startsWith('setup:ip:'));
        expect(ipKeys).toEqual([`setup:ip:${PEER}`]);
    });
});

describe('C16 — POST /api/auth/native/setup body-size cap uses the shared streamed reader', () => {
    it('rejects a genuinely streamed oversized body (413) even when Content-Length LIES (understates it), before the body is fully read', async () => {
        const drainTracker = { reachedEnd: false };
        const event = makeStreamedEvent({
            peer: '203.0.113.30',
            bodyBytes: 20_000, // over the 16 KiB cap
            declaredContentLength: '10', // lies — claims a tiny body
            drainTracker,
        });
        const response = await POST(event as Parameters<typeof POST>[0]);
        expect(response.status).toBe(413);
        // The finding is specifically that the body must never be FULLY
        // buffered — assert the reader was never drained to completion, not
        // merely that the status is 413.
        expect(drainTracker.reachedEnd).toBe(false);
        expect(mockCompleteNativeSetup).not.toHaveBeenCalled();
    });

    it('a normal small setup body is NOT rejected as too large', async () => {
        const event = makeStreamedEvent({
            peer: '203.0.113.31',
            bodyBytes: 12,
            declaredContentLength: undefined,
        });
        const response = await POST(event as Parameters<typeof POST>[0]);
        expect(response.status).not.toBe(413);
    });

    it('an honest declared Content-Length over the cap is rejected before any byte is read', async () => {
        const drainTracker = { reachedEnd: false };
        const event = makeStreamedEvent({
            peer: '203.0.113.32',
            bodyBytes: 20_000,
            declaredContentLength: String(20_000),
            drainTracker,
        });
        const response = await POST(event as Parameters<typeof POST>[0]);
        expect(response.status).toBe(413);
        expect(drainTracker.reachedEnd).toBe(false);
    });
});
