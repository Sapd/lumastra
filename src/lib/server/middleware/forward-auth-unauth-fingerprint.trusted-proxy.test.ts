// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C7: `isOperatorProximate` must not treat a peer in `TRUSTED_PROXY_IPS` as
 * the operator, even when that proxy adds no forwarded-client-ip header.
 *
 * `forward-auth-unauth-fingerprint.test.ts` covers the unpinned-trust default
 * (no `TRUSTED_PROXY_IPS`), where the immediate TCP peer is implicitly the
 * proxy. Once an operator explicitly pins `TRUSTED_PROXY_IPS`, a peer on that
 * list is a KNOWN reverse proxy, not the operator on the LAN — but the
 * pre-fix `isOperatorProximate` only asked "is there a forwarded-for header?"
 * and "is the peer a private address?", so a pinned proxy that (mis)forwards
 * without annotating `X-Forwarded-For` / `X-Real-IP` (e.g. the `.env.example`
 * "OPTION 1" nginx snippet before this fix plan added the `proxy_set_header`
 * lines) still got the full setup-guidance page — a fingerprinting oracle for
 * anyone who can reach the proxy's own address space.
 *
 * `TRUSTED_PROXY_IPS` is parsed ONCE at `client-ip.ts` module load, so this
 * lives in its own file (separate from `forward-auth-unauth-fingerprint.test.ts`,
 * which relies on the module-load default of no allowlist) with the env var
 * set inside `vi.hoisted` before any import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '172.18.0.4';
});

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    AUTH_NATIVE_LOGIN_ENABLED: false,
    AUTH_OIDC_ENABLED: false,
    AUTH_OIDC_ISSUER: '',
    AUTH_OIDC_CLIENT_ID: '',
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
    get AUTH_OIDC_LOGIN_AVAILABLE(): boolean {
        return (
            this.AUTH_OIDC_ENABLED &&
            this.AUTH_OIDC_ISSUER.length > 0 &&
            this.AUTH_OIDC_CLIENT_ID.length > 0
        );
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: { deviceAuth: false },
}));

vi.mock('$app/environment', () => ({ dev: false }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => null,
    clearSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => null),
    upsertUser: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// NOTE: client-ip.js is deliberately NOT mocked — TRUSTED_PROXY_IPS (set
// above, before any import) and the real isConfiguredTrustedProxy /
// isPrivateClientIp / hasForwardedClientIpHeader logic are what's under test.

import { resolveAuth } from './forward-auth.js';

interface EventOpts {
    path?: string;
    peer?: string;
    accept?: string;
    headers?: Record<string, string>;
}

function makeEvent(opts: EventOpts = {}): RequestEvent {
    const path = opts.path ?? '/api/image/catalog/abc/poster';
    const url = new URL('http://localhost' + path);
    const headers = new Headers({ accept: opts.accept ?? 'application/json', ...opts.headers });
    const request = new Request(url, { headers });

    return {
        url,
        request,
        params: {},
        route: { id: url.pathname },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer ?? '203.0.113.7',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

async function bodyOf(opts: EventOpts = {}): Promise<{ status: number; text: string }> {
    const result = await resolveAuth(makeEvent(opts), noopMigration, true);
    if (!result) throw new Error('expected resolveAuth to short-circuit');
    return { status: result.status, text: await result.text() };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
    mockConfig.AUTH_OIDC_ENABLED = false;
    mockConfig.AUTH_OIDC_ISSUER = '';
    mockConfig.AUTH_OIDC_CLIENT_ID = '';
});

describe('unauthenticated rejection — a TRUSTED_PROXY_IPS peer with no forwarded header', () => {
    it('gets the generic public body, not operator setup guidance', async () => {
        // 172.18.0.4 is in TRUSTED_PROXY_IPS but sends no X-Forwarded-For /
        // X-Real-IP — a known-proxy misconfiguration, not an operator on the LAN.
        const trustedProxyPeer = await bodyOf({ peer: '172.18.0.4' });
        const genericPublic = await bodyOf({ peer: '203.0.113.7' });
        expect(trustedProxyPeer.status).toBe(401);
        expect(trustedProxyPeer.text).toBe(genericPublic.text);
        expect(trustedProxyPeer.text).not.toMatch(/forward-auth reverse proxy/i);
    });

    it('control: loopback (not in TRUSTED_PROXY_IPS) still gets the setup guidance', async () => {
        const { text } = await bodyOf({ peer: '127.0.0.1' });
        expect(text).toMatch(/forward-auth reverse proxy/i);
    });

    it('control: the HTML variant shows no TRUSTED_PROXY_IPS or product name for the trusted-proxy peer', async () => {
        const { text } = await bodyOf({
            peer: '172.18.0.4',
            path: '/library',
            accept: 'text/html',
        });
        expect(text).not.toMatch(/TRUSTED_PROXY_IPS/);
        expect(text).not.toMatch(/Lumastra/i);
    });
});
