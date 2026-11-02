// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security test pinning the `/api/health/ready` forward-auth bypass.
 *
 * The readiness probe MUST be reachable without forward-auth headers: a kubelet
 * (or a load balancer, or the Docker healthcheck) sends no cookie and no
 * identity headers. Without the bypass it falls through to
 * handleMissingAuthHeaders() and gets a 401 — which a readinessProbe reads as
 * "not ready", taking every web pod out of the Service and 503ing the whole
 * deployment. That is the exact outage the probe exists to prevent, so it is
 * worth a test rather than a comment.
 *
 * The risk a bypass always carries is over-reach. `/api/health` has three
 * admin-only siblings — `/migration`, `/config`, `/components` — so these tests
 * pin that the bypass is exactly two literal paths and does not become a
 * prefix. The harness mirrors forward-auth-plugin-webhook-bypass.test.ts, which
 * drives resolveAuth() to the same "no headers, no session" fork.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

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

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn(), hasScope: () => true }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeProbeEvent(path: string): RequestEvent {
    const url = new URL('http://localhost' + path);
    // GET with no headers at all — exactly what a kubelet httpGet probe sends.
    const request = new Request(url, { method: 'GET', headers: new Headers() });

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
        getClientAddress: () => '10.42.0.1',
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

describe('resolveAuth — /api/health/ready bypasses forward-auth', () => {
    it('an anonymous probe passes through instead of 401ing', async () => {
        const event = makeProbeEvent('/api/health/ready');

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        // No identity is materialized on the event that was actually processed:
        // the route's own admin check is what decides whether the per-component
        // `checks` object is included, and it must find nobody here.
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
    });

    it('tolerates the trailing-slash form the same way /api/health does', async () => {
        const result = await resolveAuth(makeProbeEvent('/api/health/ready/'), noopMigration, true);

        expect(result).toBeUndefined();
    });

    it('still bypasses the plain liveness path', async () => {
        const result = await resolveAuth(makeProbeEvent('/api/health'), noopMigration, true);

        expect(result).toBeUndefined();
    });
});

describe('resolveAuth — the health bypass does not become a prefix', () => {
    // These three are admin-only routes sitting under the same /api/health
    // parent. A `startsWith('/api/health')` bypass would hand all of them to
    // unauthenticated callers, so each is pinned separately.
    it.each(['/api/health/migration', '/api/health/config', '/api/health/components'])(
        '%s still requires identity',
        async (path) => {
            const result = await resolveAuth(makeProbeEvent(path), noopMigration, true);

            expect(result).toBeInstanceOf(Response);
            expect((result as Response).status).toBe(401);
        },
    );

    it('does not open a prefix-lookalike sibling of /ready', async () => {
        // `startsWith('/api/health/ready')` would also open this one.
        const result = await resolveAuth(
            makeProbeEvent('/api/health/ready-debug'),
            noopMigration,
            true,
        );

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });

    it('does not open a deeper path under /ready', async () => {
        const result = await resolveAuth(
            makeProbeEvent('/api/health/ready/detail'),
            noopMigration,
            true,
        );

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });
});
