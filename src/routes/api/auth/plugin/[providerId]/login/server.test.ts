// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security tests for POST /api/auth/plugin/<providerId>/login.
 *
 * This is the one route in the plugin system that is reachable BEFORE
 * authentication, so the properties pinned here are the ones an attacker would
 * probe first:
 *
 *   - a provider the operator has not allowlisted is invisible (404) and its
 *     `verifyCredentials` is never reached, so installing an auth plugin can
 *     never open a login path on its own;
 *   - a provider that throws, hangs or answers nonsense is a FAILED login, not
 *     a successful one — the opposite of the playback veto's fail-open;
 *   - an outage does not burn the per-account lockout budget, or a flapping
 *     directory would lock every user out of the fallback login too.
 *
 * `$lib/server/utils/client-ip.js` is deliberately NOT mocked, so the
 * strict-vs-spoofable IP distinction under test is the real one.
 *
 * Also covers C16 (2026-09-16 fix plan): this route buffered the whole body
 * via `event.request.json().catch(() => ({}))` before its 128/1024-char
 * length checks ran — same class as native/login's C15 fix and
 * native/setup's C16 sibling fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

let enabledProviders: string[] = [];
vi.mock('$lib/server/config.js', () => ({
    config: {
        get AUTH_PLUGIN_PROVIDERS() {
            return enabledProviders;
        },
        AUTH_PLUGIN_PROVISION: [],
        AUTH_PLUGIN_ADMIN_ASSERT: [],
        ADMIN_GROUPS: ['admins'],
    },
}));

const mockVerify = vi.fn();
let registeredProvider: unknown = null;
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAuthProvider: (id: string) => (id === 'acme-ldap' ? registeredProvider : null),
    },
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: () => ({}),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

const mockResolveUserId = vi.fn(async () => 'user-1');
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    resolveUserIdByIdentity: (...a: unknown[]) => mockResolveUserId(...(a as [])),
    provisionUserWithIdentity: vi.fn(),
}));

let userRow: { id: string; disabled_at: Date | null } | null = {
    id: 'user-1',
    disabled_at: null,
};
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserById: vi.fn(async () => userRow),
}));

const mockCreateSession = vi.fn(async () => ({
    token: 'sess-token',
    expiresAt: new Date(Date.now() + 3600_000),
}));
vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ create: mockCreateSession }),
}));

const mockSetSessionCookie = vi.fn();
vi.mock('$lib/server/auth/native-session.js', () => ({
    setSessionCookie: (...a: unknown[]) => mockSetSessionCookie(...(a as [])),
    sessionMaxAgeSeconds: () => 3600,
}));

// Fixed-window counter keyed on the literal bucket string, so the tests can
// assert bucket IDENTITY and consumption without a real Valkey.
const counts = new Map<string, number>();
const mockCheck = vi.fn(async (key: string, limit: number, _window?: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit, resetAt: 9999999999 };
});
const mockPeek = vi.fn(async (key: string, limit: number, _window?: number) => ({
    allowed: (counts.get(key) ?? 0) < limit,
    resetAt: 9999999999,
}));
const mockReset = vi.fn(async (key: string, _window?: number) => {
    counts.delete(key);
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: [string, number, number]) => mockCheck(...a),
    peekRateLimit: (...a: [string, number, number]) => mockPeek(...a),
    resetRateLimit: (...a: [string, number]) => mockReset(...a),
}));

import { POST } from './+server.js';

function makeEvent(opts: {
    providerId?: string;
    peer?: string;
    xff?: string;
    username?: string;
}): RequestEvent {
    const providerId = opts.providerId ?? 'acme-ldap';
    const url = new URL(`http://localhost/api/auth/plugin/${providerId}/login`);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ username: opts.username ?? 'alice', password: 'pw' }),
        }),
        params: { providerId },
        route: { id: null },
        locals: {},
        cookies: { get: () => undefined, getAll: () => [], set: vi.fn(), delete: vi.fn() },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer ?? '203.0.113.9',
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
 * boolean is not. Uses a real (unmocked) per-chunk delay so the consumer's
 * cancel() has a chance to run BETWEEN chunks.
 */
function makeStreamedEvent(opts: {
    peer: string;
    bodyBytes: number;
    declaredContentLength: string | undefined;
    drainTracker?: { reachedEnd: boolean };
}): RequestEvent {
    const url = new URL('http://localhost/api/auth/plugin/acme-ldap/login');
    const encoder = new TextEncoder();
    const realBodyText = JSON.stringify({
        username: 'alice',
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
        params: { providerId: 'acme-ldap' },
        route: { id: null },
        locals: {},
        cookies: { get: () => undefined, getAll: () => [], set: vi.fn(), delete: vi.fn() },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const call = (e: RequestEvent) => POST(e as Parameters<typeof POST>[0]);

beforeEach(() => {
    vi.clearAllMocks();
    counts.clear();
    enabledProviders = ['acme-ldap'];
    registeredProvider = { verifyCredentials: mockVerify };
    mockVerify.mockResolvedValue({
        ok: true,
        identity: { subject: 'uid=alice', username: 'alice' },
    });
    mockResolveUserId.mockResolvedValue('user-1');
    userRow = { id: 'user-1', disabled_at: null };
    delete process.env.TRUSTED_PROXY_IPS;
});

describe('operator allowlist', () => {
    it('404s and never reaches the plugin when the provider is not allowlisted', async () => {
        enabledProviders = [];
        const res = await call(makeEvent({}));
        expect(res.status).toBe(404);
        expect(mockVerify).not.toHaveBeenCalled();
    });

    it('404s — not 401 — for an unknown provider id, so the installed set stays unenumerable', async () => {
        enabledProviders = ['other'];
        const res = await call(makeEvent({ providerId: 'other' }));
        expect(res.status).toBe(404);
    });

    it('logs in when the operator allowlisted the provider', async () => {
        const res = await call(makeEvent({}));
        expect(res.status).toBe(200);
        // Same shape as native login, and deliberately no userId: the response
        // to a pre-auth endpoint should not carry an internal identifier.
        expect(await res.json()).toEqual({ redirect: '/' });
    });
});

describe('fails closed', () => {
    it('a throwing provider is a failed login, not a session', async () => {
        mockVerify.mockRejectedValue(new Error('ldap exploded'));
        const res = await call(makeEvent({}));
        expect(res.status).toBe(401);
    });

    it('a success with no subject is refused — a username is not an identity key', async () => {
        mockVerify.mockResolvedValue({ ok: true, identity: { username: 'alice' } });
        const res = await call(makeEvent({}));
        expect(res.status).toBe(401);
    });

    it('a non-object verdict is refused', async () => {
        mockVerify.mockResolvedValue('yes, let them in');
        const res = await call(makeEvent({}));
        expect(res.status).toBe(401);
    });
});

describe('lockout accounting', () => {
    const userKey = 'plugin-auth:user:acme-ldap:alice';

    it('a wrong password consumes the per-account budget', async () => {
        mockVerify.mockResolvedValue({ ok: false, reason: 'invalid_credentials' });
        await call(makeEvent({}));
        expect(counts.get(userKey)).toBe(1);
    });

    it('a provider OUTAGE does not consume it', async () => {
        mockVerify.mockRejectedValue(new Error('down'));
        await call(makeEvent({}));
        expect(counts.get(userKey) ?? 0).toBe(0);
    });

    it('a successful login clears earlier failures', async () => {
        mockVerify.mockResolvedValue({ ok: false, reason: 'invalid_credentials' });
        await call(makeEvent({}));
        expect(counts.get(userKey)).toBe(1);

        mockVerify.mockResolvedValue({
            ok: true,
            identity: { subject: 'uid=alice', username: 'alice' },
        });
        await call(makeEvent({}));
        expect(counts.get(userKey) ?? 0).toBe(0);
    });

    it('locks the account out after the 10th failure without calling the provider again', async () => {
        mockVerify.mockResolvedValue({ ok: false, reason: 'invalid_credentials' });
        for (let i = 0; i < 10; i++) await call(makeEvent({}));
        mockVerify.mockClear();

        const res = await call(makeEvent({}));
        expect(res.status).toBe(429);
        expect(mockVerify).not.toHaveBeenCalled();
    });
});

describe('IP bucket', () => {
    it('keys on the strict peer, so rotating X-Forwarded-For cannot dodge the limit', async () => {
        mockVerify.mockResolvedValue({ ok: false, reason: 'invalid_credentials' });
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) {
            // A distinct username each time, so ONLY the IP bucket can trip.
            const res = await call(makeEvent({ xff: `198.51.100.${i}`, username: `user${i}` }));
            statuses.push(res.status);
        }
        expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
        expect(statuses[30]).toBe(429);
        expect(counts.get('plugin-auth:ip:203.0.113.9')).toBe(31);
    });
});

describe('unlinked accounts', () => {
    it('says so explicitly rather than pretending the password was wrong', async () => {
        mockResolveUserId.mockResolvedValue(null as unknown as string);
        const res = await call(makeEvent({}));
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'account_not_linked' });
    });
});

describe('session mint', () => {
    it('sets the session cookie on success — a userId in the body is not a login', async () => {
        await call(makeEvent({}));
        expect(mockCreateSession).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-1' }),
        );
        expect(mockSetSessionCookie).toHaveBeenCalled();
    });

    it('refuses a SUSPENDED account and mints nothing, however valid the claims', async () => {
        userRow = { id: 'user-1', disabled_at: new Date() };
        const res = await call(makeEvent({}));
        expect(res.status).toBe(401);
        expect(mockCreateSession).not.toHaveBeenCalled();
        expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });

    it('refuses when the resolved user no longer exists', async () => {
        userRow = null;
        const res = await call(makeEvent({}));
        expect(res.status).toBe(401);
        expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });
});

describe('C16 — POST /api/auth/plugin/{providerId}/login body-size cap uses the shared streamed reader', () => {
    it('rejects a genuinely streamed oversized body (413) even when Content-Length LIES (understates it), before the body is fully read', async () => {
        const drainTracker = { reachedEnd: false };
        const event = makeStreamedEvent({
            peer: '203.0.113.40',
            bodyBytes: 20_000, // over the 16 KiB cap
            declaredContentLength: '10', // lies — claims a tiny body
            drainTracker,
        });
        const response = await call(event);
        expect(response.status).toBe(413);
        // The finding is specifically that the body must never be FULLY
        // buffered — assert the reader was never drained to completion, not
        // merely that the status is 413.
        expect(drainTracker.reachedEnd).toBe(false);
        expect(mockVerify).not.toHaveBeenCalled();
    });

    it('a normal small login body is NOT rejected as too large', async () => {
        const event = makeStreamedEvent({
            peer: '203.0.113.41',
            bodyBytes: 12,
            declaredContentLength: undefined,
        });
        const response = await call(event);
        expect(response.status).not.toBe(413);
    });

    it('an honest declared Content-Length over the cap is rejected before any byte is read', async () => {
        const drainTracker = { reachedEnd: false };
        const event = makeStreamedEvent({
            peer: '203.0.113.42',
            bodyBytes: 20_000,
            declaredContentLength: String(20_000),
            drainTracker,
        });
        const response = await call(event);
        expect(response.status).toBe(413);
        expect(drainTracker.reachedEnd).toBe(false);
    });
});
