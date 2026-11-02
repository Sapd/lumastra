// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for H8 on POST /api/auth/native/login: the per-IP rate-limit
 * bucket (`login:ip:${ip}`) must key on the STRICT (non-spoofable) client IP
 * (`getClientIpStrict`), not the implicit-trust `getClientIp`. When
 * `TRUSTED_PROXY_IPS` is unset, `getClientIp` honors an attacker-supplied
 * `X-Forwarded-For` by implicit proxy trust, so keying the bucket on it would
 * let an attacker rotate `X-Forwarded-For` per request to dodge the limit.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` — the real
 * module is exercised so the strict-vs-spoofable distinction is genuine.
 * Relies on `TRUSTED_PROXY_IPS` being unset in the test environment (not set
 * by any project vitest config/.env).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/api-responses.js', () => ({
    ApiResponses: {
        rateLimited: (resetTime?: number) =>
            new Response(JSON.stringify({ error: 'Rate limited', resetTime }), { status: 429 }),
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
        unauthorized: (msg: string) =>
            new Response(JSON.stringify({ error: msg }), { status: 401 }),
        aiDatabaseUnavailable: () =>
            new Response(JSON.stringify({ error: 'db unavailable' }), { status: 503 }),
    },
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));

// Every login attempt fails (invalid credentials) — the ip-gate check happens
// BEFORE this is reached, so it doesn't affect the rate-limit assertions.
const mockAttemptLogin = vi.fn(async (..._args: unknown[]) => null);
vi.mock('$lib/server/services/native-auth.service.js', () => ({
    attemptLogin: (...args: unknown[]) => mockAttemptLogin(...args),
}));

vi.mock('$lib/server/auth/native-session.js', () => ({
    setSessionCookie: vi.fn(),
    sessionMaxAgeSeconds: () => 3600,
}));

vi.mock('$lib/server/utils/safe-redirect.js', () => ({
    sanitizeRedirect: () => '/',
}));

// Fixed-window counter keyed on whatever string checkRateLimit/peekRateLimit
// is called with — lets the tests assert bucket IDENTITY (the same key hit
// N+1 times) without depending on Valkey/memory-store internals.
const rateLimitCounts = new Map<string, number>();
const mockCheckRateLimit = vi.fn(async (key: string, limit: number, _windowSize?: number) => {
    const count = (rateLimitCounts.get(key) ?? 0) + 1;
    rateLimitCounts.set(key, count);
    return { allowed: count <= limit, resetAt: 9999999999 };
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: [string, number, number]) => mockCheckRateLimit(...args),
    peekRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 9999999999 })),
    resetRateLimit: vi.fn(async () => undefined),
}));

// NOTE: $lib/server/utils/client-ip.js is intentionally NOT mocked — see the
// file doc comment above.

// ── Import after mocks ──────────────────────────────────────────────────────

import { POST } from './+server.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeLoginEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('http://localhost/api/auth/native/login');
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'alice', password: 'wrong-password' }),
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

beforeEach(() => {
    vi.clearAllMocks();
    mockAttemptLogin.mockResolvedValue(null);
    rateLimitCounts.clear();
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('H8 — POST /api/auth/native/login IP rate-limit bucket keys on the strict (non-spoofable) IP', () => {
    it('N+1 login attempts, each with a DIFFERENT X-Forwarded-For, from the SAME peer collapse into ONE bucket and the (N+1)th is limited', async () => {
        const PEER = '203.0.113.9';
        const LIMIT = 30; // IP_ATTEMPT_LIMIT

        const responses: Response[] = [];
        for (let i = 0; i < LIMIT + 1; i++) {
            const event = makeLoginEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const response = await POST(event as Parameters<typeof POST>[0]);
            responses.push(response);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(responses[i].status).not.toBe(429);
        }
        expect(responses[LIMIT].status).toBe(429);

        // All LIMIT+1 attempts, despite LIMIT+1 distinct XFF values, land in
        // ONE ip-keyed bucket (keyed on the peer, not the spoofed XFF). A
        // second key (`login:user:*`, the per-username failure counter) is
        // also present from the post-attemptLogin lockout tracking — that's
        // unrelated to this assertion.
        expect(rateLimitCounts.get(`login:ip:${PEER}`)).toBe(LIMIT + 1);
        const ipKeys = [...rateLimitCounts.keys()].filter((k) => k.startsWith('login:ip:'));
        expect(ipKeys).toEqual([`login:ip:${PEER}`]);
    });
});

// ── Deferred item 6 (2026-09-13 security review) ────────────────────────────
//
// The old guard only ever checked the DECLARED Content-Length header — a
// client that lies about it (or omits it) could still stream an oversized
// body straight through to `request.json()`, never buffered-but-bounded.
// Drives a genuinely STREAMED body (not a pre-buffered string) whose
// Content-Length header UNDERSTATES the real size, so only the byte-counting
// streamed reader (bounded-body-reader.ts) — not the cheap declared-length
// pre-check — can catch it. Also pins that the cheap per-IP rate-limit gate
// still runs BEFORE this streaming read (an unauthenticated flood must be
// refused at the gate, not handed a streaming read).
describe('C15 — POST /api/auth/native/login body-size cap uses the shared streamed reader', () => {
    function makeStreamedEvent(opts: {
        peer: string;
        bodyBytes: number;
        declaredContentLength: string | undefined;
    }): RequestEvent {
        const url = new URL('http://localhost/api/auth/native/login');
        const encoder = new TextEncoder();
        // A genuinely oversized JSON body (a long password field), streamed
        // in chunks rather than passed as a pre-buffered string.
        const realBodyText = JSON.stringify({
            username: 'alice',
            password: 'x'.repeat(opts.bodyBytes),
        });
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const chunkSize = 4096;
                for (let i = 0; i < realBodyText.length; i += chunkSize) {
                    controller.enqueue(encoder.encode(realBodyText.slice(i, i + chunkSize)));
                }
                controller.close();
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

    it('rejects a genuinely streamed oversized body (413) even when Content-Length LIES (understates it)', async () => {
        const event = makeStreamedEvent({
            peer: '203.0.113.20',
            bodyBytes: 20_000, // over MAX_LOGIN_BODY_BYTES (16 * 1024)
            declaredContentLength: '10', // lies — claims a tiny body
        });
        const response = await POST(event as Parameters<typeof POST>[0]);
        expect(response.status).toBe(413);
        expect(mockAttemptLogin).not.toHaveBeenCalled();
    });

    it('a normal small login body is NOT rejected as too large', async () => {
        const event = makeStreamedEvent({
            peer: '203.0.113.21',
            bodyBytes: 12,
            declaredContentLength: undefined,
        });
        const response = await POST(event as Parameters<typeof POST>[0]);
        expect(response.status).not.toBe(413);
    });

    it('the per-IP rate-limit gate still runs BEFORE the streaming body read — an already-limited IP never reaches it', async () => {
        const PEER = '203.0.113.22';
        // Exhaust the IP gate first with small, ordinary requests.
        for (let i = 0; i < 30; i++) {
            await POST(
                makeStreamedEvent({
                    peer: PEER,
                    bodyBytes: 12,
                    declaredContentLength: undefined,
                }) as Parameters<typeof POST>[0],
            );
        }
        mockAttemptLogin.mockClear();

        // The (LIMIT+1)th request, oversized, must be refused by the IP gate
        // (429) — not by (or after) the streaming body read.
        const response = await POST(
            makeStreamedEvent({
                peer: PEER,
                bodyBytes: 20_000,
                declaredContentLength: '10',
            }) as Parameters<typeof POST>[0],
        );
        expect(response.status).toBe(429);
        expect(mockAttemptLogin).not.toHaveBeenCalled();
    });
});
