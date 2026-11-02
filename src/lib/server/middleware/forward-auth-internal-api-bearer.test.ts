// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test pinning a security invariant on the internal `/api/*`
 * surface (everything EXCEPT `/api/v1/*`): it is forward-auth/cookie-only by
 * construction. A PAT/service-token `Authorization: Bearer` header must NOT
 * authenticate a request there.
 *
 * In production mode (`dev === false`) with no forward-auth identity headers,
 * such a request must be rejected (401, via `handleMissingAuthHeaders`) and
 * must NEVER reach the route handler — `patService.validate()` (the only
 * call site is inside `handleApiV1Auth`, the `/api/v1/*` path) must never be
 * invoked for it.
 *
 * The ONE intentional exception is `/api/admin/*` (see forward-auth.ts, the
 * "Bearer exception (P0 fix)" block): a Bearer header there passes through
 * undecoded to the route's own `requireAdmin`, which is the actual authority
 * — but only when `features.deviceAuth` is on (fix-plan-5 Task 4, security
 * review 5 §7 item 1); otherwise the request falls through to the normal
 * missing-auth 401, exactly like a headerless request to any other internal
 * route. This test pins that the bypass is scoped to `/api/admin/*` only —
 * it must not leak onto a sibling internal write route such as
 * `PUT /api/livetv/favorites` (src/routes/api/livetv/favorites/+server.ts)
 * — AND that it is itself gated on `features.deviceAuth`.
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

// Mutable so individual tests can flip `deviceAuth` (fix-plan-5 Task 4: the
// /api/admin Bearer exception is now gated on it) without re-mocking the
// module. Defaults to false — the pre-Task-4 case ("no admin-scoped token
// can even exist yet") is the safer default for a test that forgets to set it.
const mockFeatures = vi.hoisted(() => ({ deviceAuth: false }));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: mockFeatures,
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
    mockFeatures.deviceAuth = false;
});

describe('resolveAuth — internal /api/* surface is forward-auth/cookie-only, not Bearer-authenticated', () => {
    it('PUT /api/livetv/favorites with a PAT Bearer header and no forward-auth headers is rejected (401) in prod mode, and patService.validate is never called', async () => {
        const event = makeInternalApiEvent({
            path: '/api/livetv/favorites',
            authHeader: 'Bearer pat_abc123doesnotmatter',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
        // Never reaches the route handler: no identity is materialized.
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
        // The ONLY patService.validate() call site is inside handleApiV1Auth
        // (/api/v1/*) — it must not be reached from the generic /api/* path.
        expect(mockPatValidate).not.toHaveBeenCalled();
    });

    it('the SAME Bearer header on /api/admin/* passes through undecoded (the intentional P0 exception) instead of 401ing, when features.deviceAuth is on', async () => {
        mockFeatures.deviceAuth = true;
        const event = makeInternalApiEvent({
            path: '/api/admin/some-endpoint',
            authHeader: 'Bearer pat_abc123doesnotmatter',
        });

        const result = await resolveAuth(event, noopMigration, true);

        // Passes through to the route's own requireAdmin — resolveAuth does not
        // short-circuit with a Response, and does not materialize any identity
        // here (the route gate is the primary authority for this bypass).
        expect(result).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
        // Still never touches patService — this bypass is a raw path+header
        // check in forward-auth.ts, not bearer-token validation.
        expect(mockPatValidate).not.toHaveBeenCalled();
    });

    it('the SAME Bearer header on /api/admin/* is rejected (401) when features.deviceAuth is off (fix-plan-5 Task 4)', async () => {
        // features.deviceAuth defaults to false in beforeEach — asserting the
        // gate explicitly rather than relying on the default.
        mockFeatures.deviceAuth = false;
        const event = makeInternalApiEvent({
            path: '/api/admin/some-endpoint',
            authHeader: 'Bearer pat_abc123doesnotmatter',
        });

        const result = await resolveAuth(event, noopMigration, true);

        // No exception is taken: falls through exactly like a headerless
        // request to any other internal route (handleMissingAuthHeaders 401).
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
        expect(mockPatValidate).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// NOTE on the "valid forward-auth admin headers succeed" assertion requested
// alongside this pair: it was dropped. Once forward-auth headers ARE present,
// resolveAuth falls into resolveDbAuth() / resolveOrProvisionUserId() /
// resolveInAppAccess() (forward-auth.ts ~line 1904-1948), none of which any
// sibling test file mocks — they pull in $lib/server/cache/user-max-age-cache.js,
// $lib/server/database/queries/oauth-admin.queries.js,
// $lib/server/database/queries/user-ratings.queries.js and
// $lib/server/services/access-control.service.js, none of which have an
// established mock in forward-auth.test.ts / forward-auth-login-redirect.test.ts
// / forward-auth-apiv1-auth.test.ts. It would also require driving
// isForwardAuthPeerTrusted() to `true` (LUMASTRA_TRUST_ANY_PROXY or
// TRUSTED_PROXY_IPS, both read from process.env at $lib/server/utils/client-ip.js
// MODULE-LOAD time — i.e. before this file's `dev`/`config` mocks even apply),
// which none of the reviewed sibling tests attempt either. Per instructions,
// that's invented mocking rather than reuse of an established pattern, so the
// assertion was dropped in favor of (a) and (b) above, which fully pin the
// stated invariant and its one intentional exception.
// ---------------------------------------------------------------------------
