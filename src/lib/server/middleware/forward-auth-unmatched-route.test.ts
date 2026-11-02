// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Defence-in-depth (security runtime pass 2026-09-26): a forward-auth request
 * whose path matches NO SvelteKit route must not provision, write, or
 * authenticate. It gets a 404 either way; the only effect of running the
 * forward-auth header path on it is the fire-and-forget `upsertUser` /
 * `syncUserGroups` write, which turns any edge location that leaks
 * `x-authentik-*` headers on an unrouted path (a stale `location /ws` /
 * `location /public-api/` with no `auth_request` and no header strip) into a
 * DB write: an unauthenticated client forges `x-authentik-username` +
 * `x-authentik-groups: <admin group>` and the app creates/updates that user
 * as an admin before returning 404. Measured on preprod through the real edge.
 *
 * The edge is the primary fix (blank the headers / delete the stale
 * locations); this guard closes the app side so an unrouted path can never be
 * a write primitive even if an edge location leaks. `event.route.id` is null
 * exactly when no route matched (populated in `handle` for every routed
 * request; the metrics hook already relies on it). The guard is fail-closed:
 * a manipulated route.id can only DROP identity on a real route, never grant
 * it on an unrouted one.
 *
 * Harness mirrors forward-auth-groups-always-sent.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

vi.mock('$lib/server/config.js', () => ({
    config: {
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
        FORWARD_AUTH_GROUPS_ALWAYS_SENT: false,
        DEFAULT_USER: 'default',
        ADMIN_GROUPS: ['admins'],
        WATCH_PERMISSION_GROUPS: [],
        LIVETV_GROUPS: [],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
        AGE_RATING_GROUP_PREFIX: 'age-',
        ARR_MANAGER_GROUPS: [],
    },
    features: { deviceAuth: false },
}));

vi.mock('$app/environment', () => ({ dev: false }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
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

const mockUpsertUser = vi.hoisted(() =>
    vi.fn(async () => ({
        id: '00000000-0000-0000-0000-0000000000e1',
        isAdmin: true,
        demoted: false,
        promoted: false,
    })),
);

const EXISTING_ADMIN_ROW = {
    id: '00000000-0000-0000-0000-0000000000e1',
    username: 'forged-admin',
    is_admin: true,
    admin_pinned: false,
    groups: ['admins'],
    max_age_rating: null,
    age_rating_pinned: false,
    disabled_at: null,
    deleted_at: null,
};

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => EXISTING_ADMIN_ROW),
    upsertUser: mockUpsertUser,
}));

const mockSyncUserGroups = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/server/services/user-groups.service.js', () => ({
    syncUserGroups: mockSyncUserGroups,
    invalidateGroupDerivedCaches: vi.fn(),
}));

vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: vi.fn(async () => undefined),
    PROVIDER_FORWARD_AUTH: 'forward_auth',
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

const mockResolveEffectiveAccess = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) => mockResolveEffectiveAccess(...args),
}));

const MAX_AGE_MISS_SENTINEL = vi.hoisted(() => Symbol.for('MAX_AGE_MISS'));

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
    getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: () => {},
    invalidateUserMaxAgeCache: () => {},
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
}));

const mockL2Hashes = vi.hoisted(() => new Map<string, string>());
vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: () => false,
    cacheGet: vi.fn(async (key: string) => mockL2Hashes.get(key) ?? null),
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

import { resolveAuth, invalidateAdminExistsCache } from './forward-auth.js';

/** `routeId: null` = an unrouted path (what SvelteKit passes for a 404). */
function makeEvent(pathname: string, routeId: string | null): RequestEvent {
    const url = new URL(`http://localhost${pathname}`);
    const request = new Request(url, {
        headers: new Headers({
            accept: 'application/json',
            'x-authentik-username': 'forged-admin',
            'x-authentik-groups': 'admins',
        }),
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

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockL2Hashes.clear();
    mockResolveEffectiveAccess.mockResolvedValue({
        inAppGroupNames: [],
        effectiveGroups: ['admins'],
        capabilities: {},
    });
    invalidateAdminExistsCache();
});

describe('forward-auth: an unrouted path is never provisioned or authenticated', () => {
    it('route.id null + forged trusted admin headers → no identity, no write, falls through to 404', async () => {
        const event = makeEvent('/ws', null);

        const res = await resolveAuth(event, noopMigration, true);

        // Falls through: SvelteKit renders its own 404 for the unrouted path.
        expect(res).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.authMethod).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('/public-api/x is treated the same', async () => {
        const event = makeEvent('/public-api/x', null);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('CONTROL: a matched route (route.id set) still authenticates', async () => {
        // Same headers, same peer — only route.id differs. The guard did NOT
        // skip: identity is established synchronously (the provisioning WRITE
        // itself is covered by forward-auth-groups-always-sent / c5, which
        // isolate the concurrent database.service dynamic import; asserting it
        // here too would hit that race, not the guard).
        const event = makeEvent('/library', '/library');

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.authMethod).toBe('forward_auth');
        expect(event.locals.user?.username).toBe('forged-admin');
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
    });
});

it.each(['/api/v1', '/oauth', '/subsonic'])(
    'B-2: bare %s ignores trusted identity headers without provisioning',
    async (path) => {
        const event = makeEvent(path, `${path}/[...path]`);
        await resolveAuth(event, noopMigration, true);
        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.authMethod).not.toBe('forward_auth');
    },
);
