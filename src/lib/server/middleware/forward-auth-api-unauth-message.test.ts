// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the "no forward-auth headers, no session" JSON 401 on /api/*
 * routes in forward-auth.ts.
 *
 * Regression: an unauthenticated /api/* request on a native-login (or
 * fully-configured OIDC) deployment got a message telling the operator to set
 * up a forward-auth reverse proxy — actively wrong advice when forward-auth
 * isn't even the configured method, and confusing on a fresh install (found
 * during an OSS-readiness cold-start pass: `curl /api/health/config` before
 * ever visiting /setup returns this 401). Mirrors the HTML-page redirect gate
 * in forward-auth-login-redirect.test.ts, which already got this right for
 * browser navigations — this pins the API-route message text too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (mirrors forward-auth-login-redirect.test.ts) ────────────────

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

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeApiEvent(path: string): RequestEvent {
    const url = new URL('http://localhost' + path);
    const request = new Request(url, { headers: new Headers({ accept: 'application/json' }) });

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

describe('resolveAuth — unauthenticated /api/* request, no forward-auth headers', () => {
    it('native login enabled: points at /login, not a forward-auth proxy', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;

        const event = makeApiEvent('/api/health/config');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(401);
        const body = (await result?.json()) as { error: string; message: string };
        expect(body.message).toBe('No active session. Sign in at /login.');
        expect(body.message).not.toMatch(/forward-auth reverse proxy/i);
    });

    it('fully-configured OIDC: points at /login, not a forward-auth proxy', async () => {
        mockConfig.AUTH_OIDC_ENABLED = true;
        mockConfig.AUTH_OIDC_ISSUER = 'https://idp.example.com/application/o/lumastra/';
        mockConfig.AUTH_OIDC_CLIENT_ID = 'lumastra';

        const event = makeApiEvent('/api/health/config');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(401);
        const body = (await result?.json()) as { error: string; message: string };
        expect(body.message).toBe('No active session. Sign in at /login.');
    });

    it('no sign-in method configured: keeps the original forward-auth guidance', async () => {
        const event = makeApiEvent('/api/health/config');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(401);
        const body = (await result?.json()) as { error: string; message: string };
        expect(body.message).toMatch(/forward-auth reverse proxy/i);
    });

    it('half-configured OIDC (issuer set, client id missing): still forward-auth guidance, not the /login message', async () => {
        mockConfig.AUTH_OIDC_ENABLED = true;
        mockConfig.AUTH_OIDC_ISSUER = 'https://idp.example.com/application/o/lumastra/';
        // AUTH_OIDC_CLIENT_ID left empty — AUTH_OIDC_LOGIN_AVAILABLE must stay false.

        const event = makeApiEvent('/api/health/config');
        const result = await resolveAuth(event, noopMigration, true);

        expect(result?.status).toBe(401);
        const body = (await result?.json()) as { error: string; message: string };
        expect(body.message).toMatch(/forward-auth reverse proxy/i);
    });
});
