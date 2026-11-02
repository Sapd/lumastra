// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/auth/plugin/<id>/start — the redirect kind's front door.
 *
 * The host owns this transaction, not the plugin. The plugin is asked one
 * question — "where should I send the browser?" — and the answer is treated as
 * untrusted input, because a redirect target returned by third-party code is
 * exactly the shape of an open redirect and of a `javascript:` payload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

let enabled: string[] = [];
vi.mock('$lib/server/config.js', () => ({
    config: {
        get AUTH_PLUGIN_PROVIDERS() {
            return enabled;
        },
    },
}));

const mockBegin = vi.fn();
let registered: unknown = null;
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAuthProvider: (id: string) => (id === 'discord-login' ? registered : null),
    },
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: () => ({}),
}));

let storeOk = true;
const mockStore = vi.fn(async () => storeOk);
vi.mock('$lib/server/services/plugin-auth-tx-store.js', () => ({
    storePluginAuthTx: (...a: unknown[]) => mockStore(...(a as [])),
}));

const counts = new Map<string, number>();
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async (key: string, limit: number) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { allowed: n <= limit, resetAt: 9999999999 };
    }),
}));

import { GET } from './+server.js';

function makeEvent(opts: { providerId?: string; returnTo?: string } = {}): RequestEvent {
    const providerId = opts.providerId ?? 'discord-login';
    const url = new URL(
        `https://media.example/api/auth/plugin/${providerId}/start` +
            (opts.returnTo ? `?returnTo=${encodeURIComponent(opts.returnTo)}` : ''),
    );
    return {
        url,
        request: new Request(url),
        params: { providerId },
        cookies: { set: vi.fn(), get: () => undefined, delete: vi.fn() },
        getClientAddress: () => '203.0.113.9',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const call = (e: RequestEvent) => GET(e as Parameters<typeof GET>[0]);

beforeEach(() => {
    vi.clearAllMocks();
    counts.clear();
    enabled = ['discord-login'];
    storeOk = true;
    registered = { beginLogin: mockBegin, completeLogin: vi.fn() };
    mockBegin.mockResolvedValue({ redirectUrl: 'https://discord.com/oauth2/authorize?x=1' });
    delete process.env.TRUSTED_PROXY_IPS;
});

describe('the operator gate', () => {
    it('404s and never reaches the plugin when not allowlisted', async () => {
        enabled = [];
        const res = await call(makeEvent());
        expect(res.status).toBe(404);
        expect(mockBegin).not.toHaveBeenCalled();
    });

    it('404s for a credentials-kind provider — this is not its door', async () => {
        registered = { verifyCredentials: vi.fn() };
        const res = await call(makeEvent());
        expect(res.status).toBe(404);
    });
});

describe('the plugin-supplied redirect target', () => {
    it('follows an absolute https URL', async () => {
        const res = await call(makeEvent());
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://discord.com/oauth2/authorize?x=1');
    });

    it('REFUSES a javascript: URL', async () => {
        mockBegin.mockResolvedValue({ redirectUrl: 'javascript:alert(1)' });
        const res = await call(makeEvent());
        expect(res.headers.get('location')).toMatch(/^\/login\?/);
    });

    it('REFUSES a data: URL', async () => {
        mockBegin.mockResolvedValue({ redirectUrl: 'data:text/html,<script>x</script>' });
        const res = await call(makeEvent());
        expect(res.headers.get('location')).toMatch(/^\/login\?/);
    });

    it('REFUSES plaintext http to a public host — the flow carries an auth code back', async () => {
        mockBegin.mockResolvedValue({ redirectUrl: 'http://discord.com/oauth2/authorize' });
        const res = await call(makeEvent());
        expect(res.headers.get('location')).toMatch(/^\/login\?/);
    });

    it('ALLOWS http to loopback, so a locally-run IdP still works', async () => {
        mockBegin.mockResolvedValue({ redirectUrl: 'http://127.0.0.1:8080/authorize' });
        const res = await call(makeEvent());
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://127.0.0.1:8080/authorize');
    });

    it('REFUSES a relative URL rather than redirecting inside our own origin', async () => {
        mockBegin.mockResolvedValue({ redirectUrl: '/admin/settings' });
        const res = await call(makeEvent());
        expect(res.headers.get('location')).toMatch(/^\/login\?/);
    });

    it('REFUSES a missing or non-string redirectUrl', async () => {
        mockBegin.mockResolvedValue({});
        expect((await call(makeEvent())).headers.get('location')).toMatch(/^\/login\?/);
    });
});

describe('the transaction', () => {
    it('binds the flow to this browser with an HttpOnly, SameSite=Lax cookie', async () => {
        const event = makeEvent();
        await call(event);
        const set = (event.cookies.set as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(set[2]).toMatchObject({ httpOnly: true, sameSite: 'lax' });
        // Lax, not Strict: the cookie has to survive the top-level redirect back
        // from the provider, which Strict would drop.
        expect(set[1]).toEqual(expect.any(String));
        expect(String(set[1]).length).toBeGreaterThan(20);
    });

    it('gives every start a DIFFERENT state', async () => {
        const a = makeEvent();
        const b = makeEvent();
        await call(a);
        await call(b);
        const sa = (a.cookies.set as ReturnType<typeof vi.fn>).mock.calls[0][1];
        const sb = (b.cookies.set as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(sa).not.toEqual(sb);
    });

    it('stores the provider id, so a state cannot be presented at another provider', async () => {
        await call(makeEvent());
        expect(mockStore).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ pluginId: 'discord-login' }),
        );
    });

    it('SANITIZES returnTo before storing it', async () => {
        await call(makeEvent({ returnTo: 'https://evil.example/steal' }));
        expect(mockStore).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ returnTo: '/' }),
        );
    });

    it('refuses to start at all when the transaction cannot be stored', async () => {
        // Redirecting into a flow whose callback can never succeed just strands
        // the user at the provider.
        storeOk = false;
        const res = await call(makeEvent());
        expect(res.headers.get('location')).toMatch(/^\/login\?/);
    });

    it('hands the plugin a callback URL on our own origin', async () => {
        await call(makeEvent());
        expect(mockBegin).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                callbackUrl: 'https://media.example/api/auth/plugin/discord-login/callback',
            }),
        );
    });
});

describe('failure and headers', () => {
    it('bounces to /login rather than 500-ing when the plugin throws', async () => {
        mockBegin.mockRejectedValue(new Error('boom'));
        const res = await call(makeEvent());
        expect(res.headers.get('location')).toMatch(/^\/login\?/);
    });

    it('sets no-referrer and no-store on the redirect', async () => {
        const res = await call(makeEvent());
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('rate-limits per IP so the transaction store cannot be flooded', async () => {
        const results: number[] = [];
        for (let i = 0; i < 31; i++) results.push((await call(makeEvent())).status);
        expect(results[30]).not.toBe(302);
        expect(results.slice(0, 30).every((s) => s === 302)).toBe(true);
    });
});
