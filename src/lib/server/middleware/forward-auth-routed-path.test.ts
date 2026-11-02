// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolveAuth must classify a request by the path SvelteKit ROUTES it to, not
 * by the raw `event.url.pathname`.
 *
 * `/api/v1` is header-blind: the edge runs no forward auth there, so identity
 * headers on it are attacker-controlled and only a Bearer credential counts.
 * SvelteKit routes `/api/%76%31/…` (percent-encoded) and `/de/api/v1/…`
 * (Paraglide's locale prefix, stripped by the `reroute` hook) to the same
 * /api/v1 handlers — and a common edge matches the encoded form against its
 * /api/v1 bypass location too, after normalising it. Classified on the raw
 * pathname, those requests took the forward-auth branch and a trusted-proxy
 * header made the caller whoever the header named. Found in the 2026-10-07
 * entry-point review.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Environment (must be set before client-ip.ts is imported) ────────────────
// TRUSTED_PROXIES is captured at module load in utils/client-ip.ts, so the
// allowlist has to exist before the import graph is pulled in. vi.hoisted runs
// ahead of every import.
vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_SUBSONIC_COMPAT: false,
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

// No native session cookie → falls through to the forward-auth header path.
vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => null,
    clearSessionCookie: vi.fn(),
    buildUserContextFromSession: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

const EXISTING_USER_ID = '00000000-0000-0000-0000-0000000000aa';

const mockUpsertUser = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    // An admin exists → the first-run /setup redirect and the provisioning guard
    // both pass, so the steady-state upsert path under test runs.
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => ({
        id: EXISTING_USER_ID,
        username: 'alice',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        disabled_at: null,
    })),
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

// In-app access layer: pass the synced groups straight through, no extra caps.
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: vi.fn(async (_sql: unknown, _userId: string, groups: string[]) => ({
        inAppGroupNames: [],
        effectiveGroups: groups,
        capabilities: {},
    })),
}));

// Deterministic stand-ins: admin-ness is driven by a sentinel group rather than
// the real ADMIN_GROUPS list (both have their own coverage elsewhere).
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

// Valkey not ready → syncUserGroupsIfNeeded returns before any DB work, leaving
// the upsert branch as the only writer under test.
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

function makeEvent(
    path: string,
    routeId: string | null,
    headers: Record<string, string>,
): RequestEvent {
    const url = new URL('http://localhost' + path);
    const request = new Request(url, {
        headers: new Headers({ accept: 'application/json', ...headers }),
    });
    return {
        url,
        request,
        params: {},
        route: { id: routeId },
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

/** A trusted proxy peer naming an admin — what a header-forging client sends. */
const FORGED_ADMIN = {
    'x-authentik-username': 'mallory',
    'x-authentik-groups': 'admin',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockFeatures.deviceAuth = false;
});

describe('resolveAuth classifies by the routed path', () => {
    // features.deviceAuth is off in this harness, so the /api/v1 branch answers
    // its 503 kill switch before any identity is read — the observable proof
    // that a request took the header-blind branch.
    it.each([
        ['/api/v1/me', '/api/v1/[...path]'],
        ['/api/%76%31/me', '/api/v1/[...path]'],
        ['/api/v%31/me', '/api/v1/[...path]'],
        ['/de/api/v1/me', '/api/v1/[...path]'],
        ['/en/api/v1/me', '/api/v1/[...path]'],
    ])(
        '%s takes the header-blind /api/v1 branch and never trusts identity headers',
        async (path, routeId) => {
            const event = makeEvent(path, routeId, FORGED_ADMIN);
            const res = await resolveAuth(event, noopMigration, true);
            expect(res?.status).toBe(503);
            expect(event.locals.user).toBeUndefined();
        },
    );

    it.each(['/api/v1/me', '/api/%76%31/me', '/de/api/v1/me'])(
        'with the public API on, %s ignores forged identity headers and asks for a bearer',
        async (path) => {
            mockFeatures.deviceAuth = true;
            const event = makeEvent(path, '/api/v1/[...path]', FORGED_ADMIN);
            const res = await resolveAuth(event, noopMigration, true);
            expect(res?.status).toBe(401);
            expect(event.locals.user).toBeUndefined();
        },
    );

    it('an ordinary page still authenticates from a trusted forward-auth header', async () => {
        const event = makeEvent('/browse', '/browse', FORGED_ADMIN);
        const res = await resolveAuth(event, noopMigration, true);
        expect(res).toBeUndefined();
        expect(event.locals.user?.username).toBe('mallory');
    });
});
