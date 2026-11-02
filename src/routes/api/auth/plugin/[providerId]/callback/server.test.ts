// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/auth/plugin/<id>/callback — where a redirect-kind login lands.
 *
 * This is the request an attacker actually gets to forge, so almost everything
 * here is about refusing one. The three defences are independent and none
 * substitutes for another: the state↔cookie binding proves the SAME browser
 * started the flow, the single-use transaction proves it has not been replayed,
 * and the provider id stored inside it proves the state was not minted by a
 * different provider.
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

const mockComplete = vi.fn();
let registered: unknown = null;
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAuthProvider: (id: string) => (id === 'discord-login' ? registered : null),
    },
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: () => ({}),
}));

let tx: unknown = { pluginId: 'discord-login', returnTo: '/music', txData: 'opaque' };
const mockConsume = vi.fn(async () => tx);
vi.mock('$lib/server/services/plugin-auth-tx-store.js', () => ({
    consumePluginAuthTx: (...a: unknown[]) => mockConsume(...(a as [])),
}));

type SessionResult = { kind: string; userId?: string };
const mockEstablish = vi.fn(async (): Promise<SessionResult> => ({ kind: 'ok', userId: 'user-1' }));
vi.mock('$lib/server/auth/plugin-auth-session.js', () => ({
    establishPluginSession: (...a: unknown[]) => mockEstablish(...(a as [])),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 9999999999 })),
}));

import { GET } from './+server.js';

const STATE = 'state-abc';

function makeEvent(
    opts: {
        providerId?: string;
        cookieState?: string | null;
        query?: Record<string, string>;
    } = {},
): RequestEvent {
    const providerId = opts.providerId ?? 'discord-login';
    const query = opts.query ?? { code: 'abc123', state: STATE };
    const url = new URL(
        `https://media.example/api/auth/plugin/${providerId}/callback?` +
            new URLSearchParams(query).toString(),
    );
    const cookieState = opts.cookieState === undefined ? STATE : opts.cookieState;
    return {
        url,
        request: new Request(url),
        params: { providerId },
        cookies: {
            get: () => cookieState ?? undefined,
            set: vi.fn(),
            delete: vi.fn(),
        },
        getClientAddress: () => '203.0.113.9',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const call = (e: RequestEvent) => GET(e as Parameters<typeof GET>[0]);
const location = (r: Response) => r.headers.get('location') ?? '';

beforeEach(() => {
    vi.clearAllMocks();
    enabled = ['discord-login'];
    registered = { beginLogin: vi.fn(), completeLogin: mockComplete };
    tx = { pluginId: 'discord-login', returnTo: '/music', txData: 'opaque' };
    mockConsume.mockImplementation(async () => tx);
    mockComplete.mockResolvedValue({
        ok: true,
        identity: { subject: 'discord:42', username: 'alice' },
    });
    mockEstablish.mockResolvedValue({ kind: 'ok', userId: 'user-1' });
    delete process.env.TRUSTED_PROXY_IPS;
});

describe('the operator gate', () => {
    it('404s and never reaches the plugin when not allowlisted', async () => {
        enabled = [];
        const res = await call(makeEvent());
        expect(res.status).toBe(404);
        expect(mockComplete).not.toHaveBeenCalled();
    });
});

describe('login-CSRF: the state must match this browser', () => {
    it('refuses when the binding cookie is absent', async () => {
        const res = await call(makeEvent({ cookieState: null }));
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it('refuses when the cookie names a DIFFERENT state', async () => {
        const res = await call(makeEvent({ cookieState: 'someone-elses-state' }));
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it('refuses when the query carries no state at all', async () => {
        const res = await call(makeEvent({ query: { code: 'abc' } }));
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it('deletes the binding cookie whatever the outcome, so it is single-use too', async () => {
        const event = makeEvent({ cookieState: 'mismatch' });
        await call(event);
        expect(event.cookies.delete).toHaveBeenCalled();
    });
});

describe('replay and cross-provider', () => {
    it('refuses when the transaction is gone — consumed, expired or never issued', async () => {
        tx = null;
        const res = await call(makeEvent());
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it('asks the store to verify the provider, not just the state', async () => {
        await call(makeEvent());
        expect(mockConsume).toHaveBeenCalledWith(STATE, 'discord-login');
    });
});

describe('what the plugin is handed', () => {
    it('gets the query params, the state and its own txData', async () => {
        await call(makeEvent());
        expect(mockComplete).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                params: expect.objectContaining({ code: 'abc123' }),
                state: STATE,
                txData: 'opaque',
            }),
        );
    });

    it('does not reach the plugin at all when the provider signalled an error', async () => {
        const res = await call(makeEvent({ query: { error: 'access_denied', state: STATE } }));
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockComplete).not.toHaveBeenCalled();
    });
});

describe('fails closed', () => {
    it('a throwing completeLogin is a failed login', async () => {
        mockComplete.mockRejectedValue(new Error('boom'));
        const res = await call(makeEvent());
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockEstablish).not.toHaveBeenCalled();
    });

    it('a success with no subject is refused', async () => {
        mockComplete.mockResolvedValue({ ok: true, identity: { username: 'alice' } });
        const res = await call(makeEvent());
        expect(location(res)).toMatch(/^\/login\?/);
        expect(mockEstablish).not.toHaveBeenCalled();
    });

    it('an explicit rejection is refused', async () => {
        mockComplete.mockResolvedValue({ ok: false, reason: 'invalid_credentials' });
        const res = await call(makeEvent());
        expect(location(res)).toMatch(/^\/login\?/);
    });
});

describe('success', () => {
    it('lands the user on the returnTo captured at start', async () => {
        const res = await call(makeEvent());
        expect(res.status).toBe(303);
        expect(location(res)).toBe('/music');
    });

    it('RE-SANITIZES returnTo — a stored value is not trusted a second time', async () => {
        tx = { pluginId: 'discord-login', returnTo: 'https://evil.example/steal' };
        const res = await call(makeEvent());
        expect(location(res)).toBe('/');
    });

    it('sets no-referrer, so the provider code in this URL cannot leak via Referer', async () => {
        const res = await call(makeEvent());
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
});

describe('account outcomes', () => {
    it('tells an unlinked user something they can act on', async () => {
        mockEstablish.mockResolvedValue({ kind: 'not-linked' });
        const res = await call(makeEvent());
        expect(decodeURIComponent(location(res))).toMatch(/not linked/i);
    });

    it('reports a suspended account as disabled', async () => {
        mockEstablish.mockResolvedValue({ kind: 'account-refused' });
        const res = await call(makeEvent());
        expect(decodeURIComponent(location(res))).toMatch(/disabled/i);
    });
});
