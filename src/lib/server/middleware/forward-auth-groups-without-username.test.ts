// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A groups header WITHOUT a usable username header is not an identity.
 *
 * `handleForwardAuth` used to let such a request past the missing-auth gate
 * (`hasAuthHeaders = rawUserHeader || rawGroupHeader`) and then authenticate
 * it as `config.DEFAULT_USER` (`'admin'` by default) — outside dev too, since
 * `isDev` was false the moment a groups header was present. Only a TRUSTED
 * peer can send one (untrusted peers are stripped first), e.g. an nginx
 * server-level `proxy_set_header X-authentik-groups …` inherited by a location
 * without `auth_request`, or a `map` that turns an empty groups value into
 * `|` without checking the username. With a pinned-admin `admin` row, that
 * request was admin.
 *
 * Outside dev it now takes the no-headers path; dev keeps its DEFAULT_USER
 * fallback. `readTrustedForwardAuthIdentity` already returned null here.
 *
 * Harness: `forward-auth-groups-always-sent.test.ts`'s, driving the REAL
 * `resolveAuth()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    FORWARD_AUTH_GROUPS_ALWAYS_SENT: false,
    DEFAULT_USER: 'admin',
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
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: { deviceAuth: false },
}));

const mockEnv = vi.hoisted(() => ({ dev: false }));
vi.mock('$app/environment', () => ({
    get dev() {
        return mockEnv.dev;
    },
}));

const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
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

const mockUpsertUser = vi.hoisted(() =>
    vi.fn(async () => ({
        id: '00000000-0000-0000-0000-00000000ad01',
        isAdmin: true,
        demoted: false,
        promoted: false,
    })),
);

const mockAdminExists = vi.hoisted(() => vi.fn(async () => true));

/** The row the fallback would land on: a PINNED admin named DEFAULT_USER. */
const PINNED_ADMIN_ROW = {
    id: '00000000-0000-0000-0000-00000000ad01',
    username: 'admin',
    is_admin: true,
    admin_pinned: true,
    groups: [],
    max_age_rating: null,
    age_rating_pinned: false,
    disabled_at: null,
    deleted_at: null,
};

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: mockAdminExists,
    getUserByUsername: vi.fn(async () => PINNED_ADMIN_ROW),
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

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: vi.fn(async () => ({
        inAppGroupNames: [],
        effectiveGroups: [],
        capabilities: {},
    })),
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

vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: () => false,
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

import {
    resolveAuth,
    invalidateAdminExistsCache,
    readTrustedForwardAuthIdentity,
} from './forward-auth.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
    headers: Record<string, string>,
    opts: { path?: string; accept?: string } = {},
): RequestEvent {
    const url = new URL(`http://localhost${opts.path ?? '/api/user'}`);
    const request = new Request(url, {
        headers: new Headers({ accept: opts.accept ?? 'application/json', ...headers }),
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

/** A trusted proxy's groups header with no username header — the `|` map case. */
const GROUPS_ONLY = { 'x-authentik-groups': '|' };

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function groupsWithoutUsernameWarn(): unknown[] | undefined {
    return mockWarn.mock.calls.find(([msg]) =>
        String(msg).includes('groups header without a username header'),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.dev = false;
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
    mockAdminExists.mockImplementation(async () => true);
    invalidateAdminExistsCache();
});

describe('non-dev: groups header without a username header', () => {
    it('API request → unauthenticated Response, no identity, no writes', async () => {
        const event = makeEvent(GROUPS_ONLY);

        const res = await resolveAuth(event, noopMigration, true);
        expect(res).toBeInstanceOf(Response);
        expect(res?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.idpGroups).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('an admin-group value does not authenticate either', async () => {
        const event = makeEvent({ 'x-authentik-groups': 'admins' });

        expect(await resolveAuth(event, noopMigration, true)).toBeInstanceOf(Response);
        expect(event.locals.user).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('logs a warn naming the peer', async () => {
        await resolveAuth(makeEvent(GROUPS_ONLY), noopMigration, true);

        const call = groupsWithoutUsernameWarn();
        expect(call).toBeDefined();
        expect(call?.[1]).toMatchObject({
            peer: '127.0.0.1',
            path: '/api/user',
            header: 'x-authentik-groups',
        });
    });

    it('HTML page with native login → login redirect, same as no headers', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        const event = makeEvent(GROUPS_ONLY, { path: '/library', accept: 'text/html' });

        const res = await resolveAuth(event, noopMigration, true);
        expect(res?.status).toBe(303);
        expect(res?.headers.get('location')).toBe('/login?redirect=%2Flibrary');
        expect(event.locals.user).toBeUndefined();
    });

    it('readTrustedForwardAuthIdentity agrees: no identity', () => {
        expect(readTrustedForwardAuthIdentity(makeEvent(GROUPS_ONLY))).toBeNull();
    });

    it('control: username + groups from the same peer still authenticates', async () => {
        // Keep the upsert IIFE from racing the sync's dynamic import.
        mockAdminExists.mockImplementation(async () => false);
        const event = makeEvent({ 'x-authentik-username': 'admin', ...GROUPS_ONLY });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('admin');
        expect(groupsWithoutUsernameWarn()).toBeUndefined();
    });
});

describe('dev: DEFAULT_USER fallback unchanged', () => {
    it('a groups-only header still authenticates as DEFAULT_USER', async () => {
        mockEnv.dev = true;
        mockAdminExists.mockImplementation(async () => false);
        const event = makeEvent(GROUPS_ONLY);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('admin');
        expect(groupsWithoutUsernameWarn()).toBeUndefined();
    });
});

// LUMASTRA_DEV_NO_DEFAULT_USER: Playwright runs against `vite dev`, where the
// fallback above made every header-less "unauthenticated" spec admin.
describe('dev with LUMASTRA_DEV_NO_DEFAULT_USER=true: no DEFAULT_USER fallback', () => {
    beforeEach(() => {
        mockEnv.dev = true;
        vi.stubEnv('LUMASTRA_DEV_NO_DEFAULT_USER', 'true');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('control: without the opt-out a header-less dev request is DEFAULT_USER', async () => {
        vi.stubEnv('LUMASTRA_DEV_NO_DEFAULT_USER', '');
        mockAdminExists.mockImplementation(async () => false);
        const event = makeEvent({});

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('admin');
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
    });

    it('header-less API request → 401, no identity, no writes', async () => {
        const event = makeEvent({});

        const res = await resolveAuth(event, noopMigration, true);
        expect(res?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('a groups-only header does not authenticate either', async () => {
        const event = makeEvent({ 'x-authentik-groups': 'admins' });

        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        expect(groupsWithoutUsernameWarn()).toBeDefined();
    });

    it('value is case/whitespace tolerant ("  TRUE ")', async () => {
        vi.stubEnv('LUMASTRA_DEV_NO_DEFAULT_USER', '  TRUE ');
        const event = makeEvent({});

        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
    });

    it('an unrouted path gets no identity, as in a production build', async () => {
        const event = makeEvent(
            { 'x-authentik-username': 'testuser', ...GROUPS_ONLY },
            { path: '/api/no-such-route' },
        );
        (event as { route: { id: string | null } }).route = { id: null };

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('a real identity header still authenticates', async () => {
        mockAdminExists.mockImplementation(async () => false);
        const event = makeEvent({ 'x-authentik-username': 'testuser', ...GROUPS_ONLY });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('testuser');
    });
});

describe('non-dev: LUMASTRA_DEV_NO_DEFAULT_USER changes nothing', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each(['', 'true', 'false'])('header-less API request → 401 with the value %j', async (v) => {
        vi.stubEnv('LUMASTRA_DEV_NO_DEFAULT_USER', v);
        const event = makeEvent({});

        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
    });
});
