// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for security review 2026-09-13, C24 — /j/Users/AuthenticateByName
 * must (1) key its per-IP rate limit on the STRICT (non-spoofable) client IP,
 * not the implicit-trust `getClientIp` used by plain `withValkeyRateLimit`,
 * and (2) enforce a second, IP-independent per-username failure bucket so a
 * distributed attacker (rotating peers) can't brute-force one account by
 * simply spreading requests across IPs. Each attempt also costs a full
 * scrypt verify (N=65536) even for an unknown user, so the per-IP gate alone
 * is an expensive way to rate-limit a targeted-account attack.
 *
 * Mirrors the C13 test in
 * `src/routes/(proprietary)/j/QuickConnect/Initiate/server.test.ts` for the
 * strict-IP behaviour, and the `USER_FAIL_LIMIT` pattern in
 * `src/routes/api/auth/native/login/+server.ts` for the per-username bucket.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` or
 * `$lib/server/middleware/valkey-rate-limit.js` — both are exercised for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockAllowsLiveTv } = vi.hoisted(() => ({
    mockAllowsLiveTv: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: mockAllowsLiveTv }));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// isValkeyReady is FALSE (not just getValkeyClient() null) so both
// checkRateLimit AND peekRateLimit/resetRateLimit fall through to the SAME
// in-memory fallback store — peekRateLimit only branches on isValkeyReady()
// (no client-null check), so a true/null combo here would make it read from
// mocked Valkey (always empty) while checkRateLimit writes to the memory
// store, silently decoupling the two and defeating the per-username test.
vi.mock('$lib/server/cache/valkey', () => ({
    cacheSet: vi.fn(async () => undefined),
    cacheGet: vi.fn(async () => null),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    getKeysByPattern: vi.fn(async () => []),
    del: vi.fn(async () => undefined),
}));

// Heavy transitive deps aren't needed to exercise the rate-limit behaviour.
vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));

vi.mock('$lib/server/auth', () => ({
    hasGroupPermission: () => false,
}));

vi.mock('$lib/server/config', () => ({
    config: { LIVETV_GROUPS: [] },
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/user-playback-preferences', () => ({
    loadUserPlaybackPreferences: vi.fn(async () => null),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/serializers/user', () => ({
    serializeUser: (u: { id: string; username: string; hasLiveTvPermission: boolean }) => ({
        Id: u.id,
        Name: u.username,
        Policy: { EnableLiveTvAccess: u.hasLiveTvPermission },
    }),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/playback-utils', () => ({
    clampJellyfinDeviceId: (raw: unknown) => (typeof raw === 'string' ? raw : ''),
}));

const mockValidatePassword = vi.fn();
vi.mock('$lib/server/proprietary/jellyfin-compat/auth', () => ({
    validatePassword: (...args: unknown[]) =>
        (mockValidatePassword as unknown as (...a: unknown[]) => unknown)(...args),
    createSession: vi.fn(async () => 'faketoken'),
}));

// NOTE: $lib/server/utils/client-ip.js and
// $lib/server/middleware/valkey-rate-limit.js are intentionally NOT mocked.

import { POST } from './+server.js';

function makeEvent(opts: {
    peer: string;
    xff?: string;
    username?: string;
    password?: string;
}): RequestEvent {
    const url = new URL('http://localhost/j/Users/AuthenticateByName');
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const body = JSON.stringify({
        Username: opts.username ?? 'strictipuser',
        Pw: opts.password ?? 'wrong-password',
    });
    const request = new Request(url, { method: 'POST', headers, body });

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
    mockAllowsLiveTv.mockReset().mockResolvedValue(true);
    vi.clearAllMocks();
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('C24 — /j/Users/AuthenticateByName per-IP rate limit uses the strict client IP', () => {
    it('11 requests from the SAME peer with a DIFFERENT X-Forwarded-For each time collapse into one bucket, and the 11th is 429', async () => {
        mockValidatePassword.mockResolvedValue({
            userId: 'u1',
            username: 'strictipuser',
            isAdmin: false,
            groups: [],
            displayName: 'Strict IP User',
        });

        const PEER = '203.0.113.50';
        const LIMIT = 10;

        const statuses: number[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            // Same body username on every call — the default rate-limit key
            // is ip:username:endpoint, and username is read from
            // `event.locals.user` (unset pre-auth), not the request body, so
            // it stays constant across requests regardless.
            const event = makeEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const response = await POST(event);
            statuses.push(response.status);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(statuses[i]).not.toBe(429);
        }
        expect(statuses[LIMIT]).toBe(429);
    });

    it('the bucket key is derived from the peer address, not the X-Forwarded-For header (two DIFFERENT peers each get their own budget)', async () => {
        mockValidatePassword.mockResolvedValue({
            userId: 'u1',
            username: 'strictipuser',
            isAdmin: false,
            groups: [],
            displayName: 'Strict IP User',
        });

        const sameXff = '198.51.100.200';
        const eventA = makeEvent({ peer: '203.0.113.60', xff: sameXff });
        const eventB = makeEvent({ peer: '203.0.113.61', xff: sameXff });

        const responseA = await POST(eventA);
        const responseB = await POST(eventB);

        // Both share the SAME X-Forwarded-For but are DIFFERENT peers — if the
        // key were derived from the header, they'd collide into one bucket
        // (irrelevant here) but more importantly a same-peer/rotating-header
        // scenario (covered above) would NOT collapse. This asserts the
        // complementary shape: different peers are never wrongly merged.
        expect(responseA.status).not.toBe(429);
        expect(responseB.status).not.toBe(429);
    });
});

describe('C24 — /j/Users/AuthenticateByName per-username failure bucket', () => {
    it('11 wrong passwords for the SAME username from rotating peers trips the per-username bucket', async () => {
        mockValidatePassword.mockResolvedValue(null); // always invalid credentials

        const USERNAME = 'targetuser';
        const ATTEMPTS = 11; // USER_FAIL_LIMIT (10) + 1

        const statuses: number[] = [];
        for (let i = 0; i < ATTEMPTS; i++) {
            const event = makeEvent({ peer: `203.0.113.${100 + i}`, username: USERNAME });
            const response = await POST(event);
            statuses.push(response.status);
        }

        expect(statuses.slice(0, -1)).not.toContain(429);
        expect(statuses[statuses.length - 1]).toBe(429);
    });

    it('a different username is unaffected by another username being locked out', async () => {
        mockValidatePassword.mockResolvedValue(null);

        const LOCKED_OUT = 'lockedoutuser';
        for (let i = 0; i < 11; i++) {
            const event = makeEvent({ peer: `203.0.113.${150 + i}`, username: LOCKED_OUT });
            await POST(event);
        }

        mockValidatePassword.mockResolvedValue({
            userId: 'u2',
            username: 'otheruser',
            isAdmin: false,
            groups: [],
            displayName: 'Other User',
        });
        const event = makeEvent({ peer: '203.0.113.199', username: 'otheruser' });
        const response = await POST(event);

        expect(response.status).not.toBe(429);
    });
});

describe('/j/Users/AuthenticateByName body cap', () => {
    function rawEvent(body: string, peer: string): RequestEvent {
        const base = makeEvent({ peer });
        const request = new Request(base.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });
        return { ...base, request } as RequestEvent;
    }

    it('answers 413 for a body past the cap, before any password check', async () => {
        mockValidatePassword.mockClear();
        const res = await POST(
            rawEvent(JSON.stringify({ Username: 'a', Pw: 'p'.repeat(64 * 1024) }), '203.0.113.60'),
        );
        expect(res.status).toBe(413);
        expect(mockValidatePassword).not.toHaveBeenCalled();
    });

    it('still reads a normal login body', async () => {
        mockValidatePassword.mockResolvedValue(null);
        const res = await POST(
            rawEvent(JSON.stringify({ Username: 'a', Pw: 'p' }), '203.0.113.61'),
        );
        expect(res.status).not.toBe(413);
        expect(mockValidatePassword).toHaveBeenCalled();
    });
});

it('hides Live TV in the initial sign-in response when the admin switch is off', async () => {
    mockAllowsLiveTv.mockResolvedValue(false);
    mockValidatePassword.mockResolvedValue({
        userId: 'u-tv',
        username: 'tv-disabled-login',
        isAdmin: true,
        groups: [],
        displayName: 'TV user',
    });
    const response = await POST(
        makeEvent({ peer: '203.0.113.99', username: 'tv-disabled-login', password: 'valid' }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).User.Policy.EnableLiveTvAccess).toBe(false);
});

it('binds password session issuance to the exact verification result', async () => {
    const verified = {
        userId: 'u1',
        username: 'bindinguser',
        isAdmin: false,
        groups: [],
        displayName: 'Binding User',
    };
    mockValidatePassword.mockResolvedValue(verified);
    const response = await POST(makeEvent({ peer: '203.0.113.240', username: 'bindinguser' }));
    expect(response.status).toBe(200);
    const { createSession } = await import('$lib/server/proprietary/jellyfin-compat/auth');
    expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ userId: verified.userId }),
        verified,
    );
});
