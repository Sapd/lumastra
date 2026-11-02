// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the "no forward-auth headers, no session" HTML-page fallback in
 * forward-auth.ts: does an unauthenticated visitor get sent to /login, or served
 * the self-documenting "authentication isn't set up" page?
 *
 * Regression: an operator who enabled OIDC SSO only (AUTH_OIDC_ENABLED +
 * ISSUER + CLIENT_ID, no native login, no reverse proxy) got the
 * "not configured" page in a cookie-less browser, because the redirect gate
 * checked AUTH_NATIVE_LOGIN_ENABLED alone. /login renders the
 * "Sign in with …" button for an OIDC-only deployment, so it must be reachable.
 *
 * The mirror case matters too: AUTH_OIDC_ENABLED=true with an empty issuer /
 * client id cannot render any sign-in control, and /login bounces such visitors
 * straight back — redirecting there would be an infinite loop, so those
 * deployments must keep getting the guidance page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

// Mutable config so each test can flip the auth-method flags. Only the keys the
// unauthenticated-HTML path reads are here — proxy trust is deliberately absent
// (TRUSTED_PROXY_IPS / LUMASTRA_TRUST_ANY_PROXY are read from process.env by
// utils/client-ip.ts, not off `config`), and these tests never send identity
// headers, so the trusted-peer check is never reached.
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
    // Mirrors the real derived getter in config.ts so tests keep driving the
    // three underlying flags. The real derivation is pinned separately by
    // config.oidc-login-available.test.ts.
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

// No native session cookie → falls through to the forward-auth path.
vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => null,
    clearSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

// An admin exists → first-run /setup redirect does NOT fire, so we exercise the
// steady-state branch under test.
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => null),
    upsertUser: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

// Import-time-heavy modules the middleware pulls in transitively but that this
// path never exercises (they read config keys absent from the mock above).
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

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePageEvent(path = '/', extraHeaders?: Record<string, string>): RequestEvent {
    const url = new URL('http://localhost' + path);
    const request = new Request(url, {
        headers: new Headers({ accept: 'text/html', ...extraHeaders }),
    });

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
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
    mockConfig.AUTH_OIDC_ENABLED = false;
    mockConfig.AUTH_OIDC_ISSUER = '';
    mockConfig.AUTH_OIDC_CLIENT_ID = '';
});

describe('resolveAuth — unauthenticated HTML page, no forward-auth headers', () => {
    it('OIDC-only deployment (enabled + issuer + client id) redirects to /login', async () => {
        mockConfig.AUTH_OIDC_ENABLED = true;
        mockConfig.AUTH_OIDC_ISSUER = 'https://idp.example.com/application/o/lumastra/';
        mockConfig.AUTH_OIDC_CLIENT_ID = 'lumastra';

        const event = makePageEvent('/browse');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(303);
        expect(result?.headers.get('location')).toBe('/login?redirect=%2Fbrowse');
    });

    it('native login enabled redirects to /login (unchanged behavior)', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;

        const event = makePageEvent('/browse');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(303);
        expect(result?.headers.get('location')).toBe('/login?redirect=%2Fbrowse');
    });

    it('OIDC enabled but issuer/client id missing serves the guidance page, not a /login loop', async () => {
        mockConfig.AUTH_OIDC_ENABLED = true;

        const event = makePageEvent('/');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(200);
        const html = await result?.text();
        expect(html).toContain("authentication isn't set up");
        // Names the specific keys still missing rather than repeating the generic
        // "enable one of three methods" list.
        expect(html).toContain('the OIDC provider is incomplete');
        expect(html).toContain('AUTH_OIDC_ISSUER');
        expect(html).toContain('AUTH_OIDC_CLIENT_ID');
    });

    it('OIDC guidance names only the key that is actually missing', async () => {
        mockConfig.AUTH_OIDC_ENABLED = true;
        mockConfig.AUTH_OIDC_ISSUER = 'https://idp.example.com/application/o/lumastra/';

        const event = makePageEvent('/');
        const result = await resolveAuth(event, noopMigration, true);

        const html = (await result?.text()) ?? '';
        const missingLine = html.slice(html.indexOf('Still missing:'));
        expect(missingLine).toContain('AUTH_OIDC_CLIENT_ID');
        expect(missingLine.slice(0, missingLine.indexOf('</p>'))).not.toContain('AUTH_OIDC_ISSUER');
    });

    it('no sign-in method at all serves the guidance page', async () => {
        const event = makePageEvent('/');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(200);
        expect(await result?.text()).toContain("authentication isn't set up");
    });
});

// ── Precedence: rejected-untrusted-peer vs an available sign-in method ───────
//
// A proxy IS sending identity headers but they're discarded as forgeable (peer
// not in TRUSTED_PROXY_IPS). The redirect gate deliberately does NOT consult
// that: if a working sign-in method exists, users keep getting in through it,
// and the proxy misconfiguration surfaces to the OPERATOR via the authLogger
// warning plus the `proxy.unpinned` / `proxy.trust-any` security self-check
// findings. Gating the redirect on !rejectedUntrustedPeer instead would lock
// every user out of a working OIDC login over a single mistyped proxy IP, and
// would show the config-hint page to anyone who sends a stray identity header.
describe('resolveAuth — identity headers rejected as untrusted', () => {
    const UNTRUSTED = { 'x-authentik-username': 'mallory' };

    beforeEach(() => {
        // Force the fail-closed posture (no peer is trusted) deterministically —
        // both are read from process.env by utils/client-ip.ts, not off `config`.
        delete process.env.TRUSTED_PROXY_IPS;
        delete process.env.LUMASTRA_TRUST_ANY_PROXY;
    });

    it('still reaches /login when OIDC is available (sign-in must not depend on proxy trust)', async () => {
        mockConfig.AUTH_OIDC_ENABLED = true;
        mockConfig.AUTH_OIDC_ISSUER = 'https://idp.example.com/application/o/lumastra/';
        mockConfig.AUTH_OIDC_CLIENT_ID = 'lumastra';

        const event = makePageEvent('/browse', UNTRUSTED);
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(303);
        expect(result?.headers.get('location')).toBe('/login?redirect=%2Fbrowse');
        // Never trusts the forged header: no identity is materialized.
        expect(event.locals.user).toBeUndefined();
    });

    it('gets the peer-trust guidance — not the generic one — when no sign-in method exists', async () => {
        const event = makePageEvent('/', UNTRUSTED);
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(200);
        const html = await result?.text();
        expect(html).toContain("network peer isn't trusted");
        expect(html).toContain('TRUSTED_PROXY_IPS');
        expect(event.locals.user).toBeUndefined();
    });
});
