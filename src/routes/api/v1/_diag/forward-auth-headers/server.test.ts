// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/v1/_diag/forward-auth-headers
 *
 * Tests:
 *  (a) Unauthenticated request (no locals.user) → 401
 *  (b) Authenticated + forged x-authentik-username header present → name listed in received
 *  (c) Authenticated + header present → value is NEVER returned, only the name
 *  (d) Authenticated + no forward-auth headers → received is empty
 *  (e) Authenticated + USERHEADER / GROUPHEADER present → names listed
 *
 * The middleware (handlePublicApiAuth) is tested separately. Here we test only the
 * route handler logic itself — auth is exercised by injecting `locals.user`.
 *
 * Pure helper functions (buildForwardAuthAllowlist, collectForwardAuthHeaderNames)
 * are also tested directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectForwardAuthHeaderNames, buildForwardAuthAllowlist } from './headers-util.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: {
        USERHEADER: 'X-Forwarded-User',
        GROUPHEADER: 'X-Forwarded-Groups',
    },
}));

vi.mock('$lib/server/utils/api-responses.js', () => ({
    ApiResponses: {
        unauthorized: (msg?: string) =>
            new Response(JSON.stringify({ error: msg ?? 'unauthorized' }), { status: 401 }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Headers-like object backed by a plain string map.
 * The Headers platform API lowercases all header names.
 */
function makeHeaders(raw: Record<string, string>): {
    has: (name: string) => boolean;
    keys: () => Iterable<string>;
    get: (name: string) => string | null;
} {
    const map = new Map<string, string>(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        has: (name: string) => map.has(name.toLowerCase()),
        keys: () => map.keys(),
        get: (name: string) => map.get(name.toLowerCase()) ?? null,
    };
}

/** Build a minimal RequestEvent-like object for the route handler. */
function makeEvent(opts: {
    user?: { username: string };
    headerRecord?: Record<string, string>;
}): Parameters<typeof import('./+server.js').GET>[0] {
    return {
        locals: {
            user: opts.user as App.Locals['user'],
        },
        request: {
            headers: makeHeaders(opts.headerRecord ?? {}),
        },
    } as unknown as Parameters<typeof import('./+server.js').GET>[0];
}

// ── Pure helper: collectForwardAuthHeaderNames ────────────────────────────────

describe('collectForwardAuthHeaderNames', () => {
    const allowlist = ['x-forwarded-user', 'x-forwarded-groups'];

    it('returns empty array when no forward-auth headers are present', () => {
        const headers = makeHeaders({ 'content-type': 'application/json' });
        expect(collectForwardAuthHeaderNames(headers, allowlist)).toEqual([]);
    });

    it('returns the name of an x-authentik-* header when present', () => {
        const headers = makeHeaders({ 'x-authentik-username': 'admin' });
        expect(collectForwardAuthHeaderNames(headers, allowlist)).toContain('x-authentik-username');
    });

    it('returns multiple x-authentik-* names when multiple are present', () => {
        const headers = makeHeaders({
            'x-authentik-username': 'alice',
            'x-authentik-groups': 'admins',
        });
        const result = collectForwardAuthHeaderNames(headers, allowlist);
        expect(result).toContain('x-authentik-username');
        expect(result).toContain('x-authentik-groups');
    });

    it('returns USERHEADER name when it is present', () => {
        const headers = makeHeaders({ 'x-forwarded-user': 'alice' });
        const result = collectForwardAuthHeaderNames(headers, allowlist);
        expect(result).toContain('x-forwarded-user');
    });

    it('returns GROUPHEADER name when it is present', () => {
        const headers = makeHeaders({ 'x-forwarded-groups': 'admins,users' });
        const result = collectForwardAuthHeaderNames(headers, allowlist);
        expect(result).toContain('x-forwarded-groups');
    });

    it('does NOT include non-forward-auth headers', () => {
        const headers = makeHeaders({
            authorization: 'Bearer svc_abc123',
            'content-type': 'application/json',
            'accept-encoding': 'gzip',
        });
        const result = collectForwardAuthHeaderNames(headers, allowlist);
        expect(result).not.toContain('authorization');
        expect(result).not.toContain('content-type');
        expect(result).not.toContain('accept-encoding');
    });

    it('does not duplicate a name already in the allowlist that also matches x-authentik-*', () => {
        // Contrived: allowlist includes an x-authentik-* name — should not appear twice.
        const mixedAllowlist = ['x-authentik-username', 'x-forwarded-groups'];
        const headers = makeHeaders({ 'x-authentik-username': 'alice' });
        const result = collectForwardAuthHeaderNames(headers, mixedAllowlist);
        const count = result.filter((n) => n === 'x-authentik-username').length;
        expect(count).toBe(1);
    });
});

// ── Pure helper: buildForwardAuthAllowlist ────────────────────────────────────

describe('buildForwardAuthAllowlist', () => {
    it('returns lowercased USERHEADER and GROUPHEADER from config', () => {
        const list = buildForwardAuthAllowlist();
        // config mock returns 'X-Forwarded-User' and 'X-Forwarded-Groups'
        expect(list).toContain('x-forwarded-user');
        expect(list).toContain('x-forwarded-groups');
    });

    it('returns exactly two entries for the default config', () => {
        const list = buildForwardAuthAllowlist();
        expect(list).toHaveLength(2);
    });
});

// ── Route handler: GET ────────────────────────────────────────────────────────

describe('GET /api/v1/_diag/forward-auth-headers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // (a) Unauthenticated → 401
    it('(a) returns 401 when locals.user is not set (unauthenticated)', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ user: undefined });
        const response = await GET(event);
        expect(response.status).toBe(401);
    });

    it('(a) returns 401 when locals.user has no username', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ user: { username: '' } });
        const response = await GET(event);
        expect(response.status).toBe(401);
    });

    // (b) Authenticated + forged x-authentik-username → name in received
    it('(b) lists x-authentik-username in received when header is present and user is authed', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({
            user: { username: 'alice' },
            headerRecord: { 'x-authentik-username': 'admin' },
        });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { received: string[] };
        expect(body.received).toContain('x-authentik-username');
    });

    // (c) Values are NEVER returned, only names
    it('(c) does NOT return header values — only names in received', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({
            user: { username: 'alice' },
            headerRecord: { 'x-authentik-username': 'SUPER_SECRET_ADMIN_VALUE' },
        });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { received: string[] };
        // received must be an array of strings (header names)
        for (const entry of body.received) {
            expect(typeof entry).toBe('string');
            // No entry should equal the forged value
            expect(entry).not.toBe('SUPER_SECRET_ADMIN_VALUE');
        }
        // The response JSON should not contain the secret value at all
        const raw = JSON.stringify(body);
        expect(raw).not.toContain('SUPER_SECRET_ADMIN_VALUE');
    });

    // (d) Authenticated + no forward-auth headers → received is empty
    it('(d) returns empty received array when no forward-auth headers are present', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({
            user: { username: 'alice' },
            headerRecord: {
                authorization: 'Bearer svc_ephem_abc',
                'accept-encoding': 'gzip',
            },
        });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { received: string[] };
        expect(body.received).toEqual([]);
    });

    // (e) Authenticated + USERHEADER present → name listed
    it('(e) lists the configured USERHEADER name when that header is present', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({
            user: { username: 'alice' },
            // config mock: USERHEADER='X-Forwarded-User'
            headerRecord: { 'x-forwarded-user': 'bob' },
        });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { received: string[] };
        expect(body.received).toContain('x-forwarded-user');
        // Value must not appear
        const raw = JSON.stringify(body);
        expect(raw).not.toContain('bob');
    });

    it('response has a "received" key that is an array', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ user: { username: 'alice' } });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = (await response.json()) as unknown;
        expect(body).toHaveProperty('received');
        expect(Array.isArray((body as { received: unknown }).received)).toBe(true);
    });
});
