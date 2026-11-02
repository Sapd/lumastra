// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security test pinning the `/api/plugin-webhooks/*` forward-auth bypass.
 *
 * That endpoint MUST be reachable without forward-auth headers — its callers
 * are external systems (an *arr app, a chat platform) that hold no session.
 * Authentication is the per-integration shared secret checked inside
 * `dispatchIntegrationWebhook`, not this middleware.
 *
 * The risk a bypass always carries is over-reach: these tests pin that it is
 * scoped to exactly that prefix and leaks onto no sibling internal route. The
 * harness mirrors forward-auth-internal-api-bearer.test.ts, which drives
 * resolveAuth() to the same "no headers, no session" fork.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Mirrors the mocking style of forward-auth-login-redirect.test.ts: this test
// only needs to drive resolveAuth() up to the "no forward-auth headers, no
// session" fork (line ~1785 in forward-auth.ts) — it never reaches
// resolveDbAuth/resolveInAppAccess (those only run once forward-auth headers
// ARE present), so the DB/cache mocks below are the same minimal set used
// there, not the fuller battery from forward-auth.test.ts.

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
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

// No native session cookie -> falls through to the forward-auth path.
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

// The single call site under test: patService.validate() must be reachable
// only from handleApiV1Auth (the /api/v1/* path). Spied so we can assert it
// is never invoked when a Bearer header hits the internal /api/* surface.
const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: (...args: unknown[]) => mockPatValidate(...args),
        hasScope: () => true,
    }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeInternalApiEvent(opts: { path: string; authHeader?: string }): RequestEvent {
    const url = new URL('http://localhost' + opts.path);
    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);
    const request = new Request(url, { method: 'PUT', headers });

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
});

describe('resolveAuth — /api/plugin-webhooks/* bypasses forward-auth', () => {
    it('POST /api/plugin-webhooks/<id> without forward-auth headers passes through instead of 401ing', async () => {
        const event = makeInternalApiEvent({ path: '/api/plugin-webhooks/sonarr-relay' });

        const result = await resolveAuth(event, noopMigration, true);

        // Passes through to the route, which applies the shared-secret gate.
        expect(result).toBeUndefined();
        // No identity is materialized: an inbound webhook is not a user.
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
    });

    it('does not extend the bypass to a sibling internal route', async () => {
        const event = makeInternalApiEvent({ path: '/api/livetv/favorites' });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });

    it('does not extend the bypass to a prefix-lookalike path', async () => {
        // `startsWith('/api/plugin-webhooks')` without the trailing slash would
        // also open `/api/plugin-webhooks-admin`.
        const event = makeInternalApiEvent({ path: '/api/plugin-webhooks-admin/secrets' });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });

    it('does not open the bare /api/plugin-webhooks collection path', async () => {
        const event = makeInternalApiEvent({ path: '/api/plugin-webhooks' });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });
});
