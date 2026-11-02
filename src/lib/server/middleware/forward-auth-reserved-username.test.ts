// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for the reserved-username guard on the forward-auth
 * cold-start provisioning path (`resolveOrProvisionUserId` in
 * forward-auth.ts).
 *
 * Task 8 (C8): `watch-together.service.ts#endSession` used to trust a literal
 * `userId === 'system'` as an in-band escape from its host-only check. A real
 * account named `system` — mintable via ANY provisioning path, including a
 * trusted reverse-proxy header asserting `X-Authentik-Username: system` —
 * could therefore end any watch-together party. This test pins the
 * forward-auth half of the fix: a header identity resolving to a NEW
 * (not-yet-provisioned) username reserved for an internal actor must be
 * refused rather than provisioned.
 *
 * Modeled on forward-auth-display-name.test.ts's mocking, but with
 * `getUserByUsername` returning null (no existing row) so `resolveDbAuth`
 * yields `userId: null` and the request falls into the synchronous
 * cold-start provisioning branch under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    AUTH_NATIVE_LOGIN_ENABLED: false,
    AUTH_OIDC_LOGIN_AVAILABLE: false,
    AUTH_OIDC_ENABLED: false,
    AUTH_OIDC_ISSUER: '',
    AUTH_OIDC_CLIENT_ID: '',
    FORWARD_AUTH_ENABLED: true,
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
    DEFAULT_USER: 'default',
    ADMIN_GROUPS: ['admin'],
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
    buildUserContextFromSession: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

// Matches upsertUser()'s real UpsertUserResult shape (security review
// 2026-09-16, fix round 1 review) -- neither flag true, since this file
// never asserts on admin-credential narrowing/restoring.
const mockUpsertUser = vi.hoisted(() =>
    vi.fn(async () => ({
        id: '00000000-0000-0000-0000-000000000000',
        isAdmin: false,
        demoted: false,
        promoted: false,
    })),
);
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    // An admin exists → the first-run /setup redirect passes, so the guard
    // under test (not the first-run guard) is what refuses provisioning.
    adminExists: vi.fn(async () => true),
    // No existing row for ANY username — forces resolveDbAuth to return
    // userId: null and the request into the cold-start provisioning branch.
    getUserByUsername: vi.fn(async () => null),
    upsertUser: mockUpsertUser,
}));

vi.mock('$lib/server/database/queries/oauth-admin.queries.js', () => ({
    upsertUserGroups: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: vi.fn(async (_sql: unknown, _userId: string, groups: string[]) => ({
        inAppGroupNames: [],
        effectiveGroups: groups,
        capabilities: {},
    })),
}));

vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: (groups: string[] = []) => groups.includes('admin'),
    buildUserPermissions: (
        groups: string[],
        opts?: { isAdminOverride?: boolean; extraCapabilities?: { isAdmin?: boolean } },
    ) => {
        const isAdmin = opts?.isAdminOverride ?? groups.includes('admin');
        return {
            hasWatchPermission: isAdmin,
            hasLiveTvPermission: isAdmin,
            hasRequestPermission: isAdmin,
            isAdmin,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: isAdmin,
            liveTvPriority: isAdmin ? 'high' : 'low',
        };
    },
}));

// Caches always cold so every request re-runs the DB resolution path.
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedUserId: () => null,
    setCachedUserId: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    getCachedMaxAge: () => Symbol.for('MAX_AGE_MISS'),
    setCachedMaxAge: () => {},
    invalidateUserMaxAgeCache: () => {},
    MAX_AGE_MISS: Symbol.for('MAX_AGE_MISS'),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: vi.fn(() => false),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    getValkeyClient: vi.fn(() => null),
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

function makeEvent(headers: Record<string, string>, peer = '127.0.0.1'): RequestEvent {
    // Internal `/api/*` mount (forward-auth header cold-start provisioning
    // flow) — NOT `/api/v1/*`, which is the separate bearer-token-only public
    // API surface and never reaches resolveOrProvisionUserId.
    const url = new URL('http://localhost/api/watch-together/ABCD');
    const request = new Request(url, {
        headers: new Headers({ accept: 'application/json', ...headers }),
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
        getClientAddress: () => peer,
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

describe('forward auth — reserved-username guard on cold-start provisioning', () => {
    it('refuses to provision a NEW user named "system" and never calls upsertUser', async () => {
        const event = makeEvent({
            'x-authentik-username': 'system',
            'x-authentik-groups': 'users',
        });

        const result = await resolveAuth(event, noopMigration, true);

        // Fails closed: no locals.user attached, upsertUser never reached.
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(event.locals.user).toBeUndefined();
        // resolveAuth returns a Response rather than falling through to
        // `true`/`false` continuation when it fails closed here — same
        // "Account not provisioned" branch as first-run-pre-admin / DB-down.
        expect(result).toBeInstanceOf(Response);
        if (result instanceof Response) {
            expect(result.status).toBe(503);
        }
    });

    it('still provisions an ordinary NEW username via the same path', async () => {
        const event = makeEvent({
            'x-authentik-username': 'brandnewuser',
            'x-authentik-groups': 'users',
        });

        await resolveAuth(event, noopMigration, true);

        expect(mockUpsertUser).toHaveBeenCalledTimes(1);
        const calls = mockUpsertUser.mock.calls as unknown as [unknown, Record<string, unknown>][];
        expect(calls[0][1]).toMatchObject({ username: 'brandnewuser' });
    });
});
