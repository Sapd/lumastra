// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The unauthenticated 401 / setup page must not fingerprint the deployment to
 * the public internet.
 *
 * `hooks.server.ts` already carries an anti-fingerprint guard for the
 * unauthenticated path prefixes ("lets external probes fingerprint the
 * deployment as a Lumastra"), but `resolveAuth`'s 401 returns ABOVE it, so the
 * guard never sees it. An anonymous `curl https://host/api/image/...` therefore
 * received the product name, the auth architecture and a docs URL. The
 * untrusted-peer branch went further and confirmed that a guessed identity
 * header had been received, which enumerates the configured USERHEADER name
 * for anyone who can reach the app directly. (Naming which built-in sign-in
 * methods are enabled is not itself a new leak — `/login` already shows that
 * to anyone — but the rejection page shouldn't become a second place to
 * confirm it without visiting `/login`.)
 *
 * The verbose guidance exists for a real reason (a `docker run` operator must
 * not be stranded), so it is gated rather than deleted: it survives for a
 * caller on loopback / RFC1918 / link-local with no forwarded-for annotation
 * — and holds only that far: a peer explicitly pinned in TRUSTED_PROXY_IPS is
 * a known reverse proxy, never the operator, even if it forwards without
 * annotating X-Forwarded-For / X-Real-IP (see the sibling
 * `.trusted-proxy.test.ts` file) — and collapses to one fixed envelope for
 * everyone else.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

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

// NOTE: client-ip.js is deliberately NOT mocked — the peer-proximity gate and
// the fail-closed identity-header trust check are the behaviour under test.

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

/** Everything an anonymous prober must not learn from a rejection. */
const FINGERPRINTS = [
    /lumastra/i,
    /authentik/i,
    /forward-auth/i,
    /USERHEADER/,
    /GROUPHEADER/,
    /TRUSTED_PROXY_IPS/,
    /LUMASTRA_TRUST_ANY_PROXY/,
    /AUTH_OIDC/,
    /ADMIN_GROUPS/,
    /lumastra\.org/i,
];

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
    mockConfig.AUTH_OIDC_ENABLED = false;
    mockConfig.AUTH_OIDC_ISSUER = '';
    mockConfig.AUTH_OIDC_CLIENT_ID = '';
});

describe('unauthenticated /api/* rejection — public caller', () => {
    it('discloses nothing about the product, the auth architecture or the config', async () => {
        const { status, text } = await bodyOf();
        expect(status).toBe(401);
        for (const pattern of FINGERPRINTS) {
            expect(text).not.toMatch(pattern);
        }
    });

    it('is byte-identical whether or not native login is enabled (no config oracle)', async () => {
        const off = await bodyOf();
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        const on = await bodyOf();
        expect(on.text).toBe(off.text);
    });

    it('is byte-identical whether or not OIDC is fully configured (no config oracle)', async () => {
        const off = await bodyOf();
        mockConfig.AUTH_OIDC_ENABLED = true;
        mockConfig.AUTH_OIDC_ISSUER = 'https://idp.example.com/application/o/lumastra/';
        mockConfig.AUTH_OIDC_CLIENT_ID = 'lumastra';
        const on = await bodyOf();
        expect(on.text).toBe(off.text);
    });

    it('does not confirm that a guessed identity header was received (no header-name oracle)', async () => {
        const plain = await bodyOf();
        const probed = await bodyOf({ headers: { 'x-authentik-username': 'admin' } });
        expect(probed.text).toBe(plain.text);
        for (const pattern of FINGERPRINTS) {
            expect(probed.text).not.toMatch(pattern);
        }
    });

    it('does not confirm a guessed group header either', async () => {
        const plain = await bodyOf();
        const probed = await bodyOf({ headers: { 'x-authentik-groups': 'admins' } });
        expect(probed.text).toBe(plain.text);
    });

    it('does not diagnose an unexpanded proxy placeholder for a public caller', async () => {
        const plain = await bodyOf();
        const probed = await bodyOf({ headers: { 'x-authentik-username': '{http.whatever}' } });
        expect(probed.text).toBe(plain.text);
    });

    it('still answers 401 with X-Auth-Required so clients keep working', async () => {
        const result = await resolveAuth(makeEvent(), noopMigration, true);
        expect(result?.status).toBe(401);
        expect(result?.headers.get('X-Auth-Required')).toBe('true');
        expect(result?.headers.get('Content-Type')).toBe('application/json');
    });

    it('a proxied visitor is public even though the TCP peer is private', async () => {
        const proxied = await bodyOf({
            peer: '172.18.0.4',
            headers: { 'x-forwarded-for': '203.0.113.7' },
        });
        const direct = await bodyOf();
        expect(proxied.text).toBe(direct.text);
    });

    it('an unknowable peer (0.0.0.0 sentinel) is treated as public', async () => {
        const unknown = await bodyOf({ peer: '0.0.0.0' });
        const direct = await bodyOf();
        expect(unknown.text).toBe(direct.text);
    });
});

describe('unauthenticated /api/* rejection — operator-proximate caller', () => {
    it('loopback still gets the forward-auth setup guidance', async () => {
        const { status, text } = await bodyOf({ peer: '127.0.0.1' });
        expect(status).toBe(401);
        expect(text).toMatch(/forward-auth reverse proxy/i);
    });

    it('a LAN caller still gets the forward-auth setup guidance', async () => {
        const { text } = await bodyOf({ peer: '192.168.1.50' });
        expect(text).toMatch(/forward-auth reverse proxy/i);
    });

    it('loopback with native login enabled still gets the /login hint', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        const { text } = await bodyOf({ peer: '127.0.0.1' });
        expect(text).toMatch(/Sign in at \/login/);
    });

    it('loopback still gets the untrusted-peer remediation', async () => {
        const { text } = await bodyOf({
            peer: '127.0.0.1',
            headers: { 'x-authentik-username': 'admin' },
        });
        expect(text).toMatch(/TRUSTED_PROXY_IPS/);
    });
});

describe('unauthenticated HTML page — public caller', () => {
    const htmlOpts: EventOpts = { path: '/library', accept: 'text/html' };

    it('serves no setup guidance and no product identity', async () => {
        const { text } = await bodyOf(htmlOpts);
        for (const pattern of FINGERPRINTS) {
            expect(text).not.toMatch(pattern);
        }
    });

    it('keeps the reload-once recovery script for an expired IdP session', async () => {
        const { text } = await bodyOf(htmlOpts);
        expect(text).toMatch(/sessionStorage/);
    });

    it('operator on loopback still gets the full setup page', async () => {
        const { text } = await bodyOf({ ...htmlOpts, peer: '127.0.0.1' });
        expect(text).toMatch(/TRUSTED_PROXY_IPS/);
        expect(text).toMatch(/Lumastra/);
    });
});
