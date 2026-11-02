// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /oauth/links/{provider}/callback gets the BROWSER identity; the rest of
 * /oauth/ (device flow) stays public and token-only.
 *
 * Bug (since the callback was added in 6db3eae819, 2026-06-25): resolveAuth
 * sent every /oauth/ path through the public device-flow branch, which never
 * loads a user, so the MAL callback always saw `locals.user` undefined and
 * redirected to `?mal_link=error`.
 *
 * Seam: the REAL resolveAuth() populates `event.locals`, then the REAL callback
 * handler runs on that same event. Harness from forward-auth-enabled-flag.test.ts
 * (trusted peer 127.0.0.1 in TRUSTED_PROXY_IPS).
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
    MAL_CLIENT_ID: 'mal-client',
    MAL_CLIENT_SECRET: 'mal-secret',
}));

const mockFeatures = vi.hoisted(() => ({ deviceAuth: true }));
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    features: mockFeatures,
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

const session = vi.hoisted(() => ({
    token: null as string | null,
    row: null as Record<string, unknown> | null,
    clear: vi.fn(),
}));
vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => {
        if (session.token === 'THROW') throw new Error('cookie store unavailable');
        return session.token;
    },
    clearSessionCookie: session.clear,
    buildUserContextFromSession: (row: { user_id: string; username: string }) => ({
        userId: row.user_id,
        username: row.username,
        userGroups: [],
        isAdmin: false,
    }),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => session.row) }),
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
const mockGetUserByUsername = vi.hoisted(() =>
    vi.fn<(username: string) => Promise<Record<string, unknown> | null>>(),
);

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
    getUserByUsername: (_sql: unknown, username: string) => mockGetUserByUsername(username),
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

/** Valkey: the `state` the authorize step stored for the user who started the link. */
const oauthState = vi.hoisted(() => ({ stored: new Map<string, string>() }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: () => false,
    cacheGet: vi.fn(async (key: string) => oauthState.stored.get(key) ?? null),
    cacheDel: vi.fn(async (key: string) => {
        oauthState.stored.delete(key);
    }),
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

const mockUpsertMalCredential = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/server/database/queries/mal-credentials.queries.js', () => ({
    upsertMalCredential: mockUpsertMalCredential,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}) as unknown,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth, invalidateAdminExistsCache } from './forward-auth.js';
import { GET as malCallback } from '../../../routes/oauth/links/[provider]/callback/+server.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const CALLBACK_ROUTE = '/oauth/links/[provider]/callback';
const SESSION_USER_ID = '00000000-0000-0000-0000-0000000000b1';

function makeEvent(
    path: string,
    opts: { headers?: Record<string, string>; routeId?: string | null; peer?: string } = {},
): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    const request = new Request(url, {
        headers: new Headers({ accept: 'text/html', ...opts.headers }),
    });
    return {
        url,
        request,
        params: { provider: 'mal' },
        route: { id: opts.routeId === undefined ? CALLBACK_ROUTE : opts.routeId },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer ?? '127.0.0.1',
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

/** Run the request through resolveAuth, then (if it passed) the callback handler. */
async function runCallback(event: RequestEvent): Promise<{ status: number; location: string }> {
    const early = await resolveAuth(event, noopMigration, true);
    if (early) return { status: early.status, location: early.headers.get('location') ?? '' };
    try {
        await malCallback(event as Parameters<typeof malCallback>[0]);
    } catch (thrown) {
        const r = thrown as { status?: number; location?: string };
        if (typeof r.status === 'number' && typeof r.location === 'string') {
            return { status: r.status, location: r.location };
        }
        throw thrown;
    }
    throw new Error('callback returned without redirecting');
}

function startLink(username: string): string {
    const state = `state-${username}`;
    oauthState.stored.set(
        `mal:oauth:${state}`,
        JSON.stringify({ codeVerifier: 'verifier', username }),
    );
    return `/oauth/links/mal/callback?code=the-code&state=${state}`;
}

function signInNative(username: string): void {
    session.token = 'session-token';
    session.row = { user_id: SESSION_USER_ID, username, session_id: 'sess-1', groups: [] };
}

const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) {
        return new Response(
            JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }),
            {
                status: 200,
            },
        );
    }
    if (u.includes('/users/@me')) {
        return new Response(JSON.stringify({ name: 'mal-alice' }), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockEnv.dev = false;
    mockFeatures.deviceAuth = true;
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
    mockConfig.FORWARD_AUTH_ENABLED = true;
    session.token = null;
    session.row = null;
    oauthState.stored.clear();
    mockGetUserByUsername.mockImplementation(async () => PINNED_ADMIN_ROW);
    mockAdminExists.mockImplementation(async () => true);
    invalidateAdminExistsCache();
});

describe('/oauth/links/mal/callback reaches the handler with the browser user', () => {
    it('native session cookie: locals.user is the session user and the link is stored', async () => {
        signInNative('alice');
        const event = makeEvent(startLink('alice'));

        const res = await runCallback(event);

        expect(event.locals.user?.username).toBe('alice');
        expect(event.locals.user?.userId).toBe(SESSION_USER_ID);
        expect(res).toEqual({ status: 302, location: '/settings/connections?mal_link=success' });
        expect(mockUpsertMalCredential).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: SESSION_USER_ID, providerUsername: 'mal-alice' }),
        );
    });

    it('linking does not depend on the device flow being enabled', async () => {
        mockFeatures.deviceAuth = false;
        signInNative('alice');

        const res = await runCallback(makeEvent(startLink('alice')));

        expect(res.location).toBe('/settings/connections?mal_link=success');
    });

    it('trusted forward-auth headers (FORWARD_AUTH_ENABLED): an existing proxy user links', async () => {
        const event = makeEvent(startLink('admin'), {
            headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
        });

        const res = await runCallback(event);

        expect(mockGetUserByUsername).toHaveBeenCalledWith('admin');
        expect(event.locals.user?.username).toBe('admin');
        expect(event.locals.user?.userId).toBe(PINNED_ADMIN_ROW.id);
        expect(res.location).toBe('/settings/connections?mal_link=success');
        expect(mockUpsertMalCredential).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: PINNED_ADMIN_ROW.id }),
        );
    });

    it('the header identity is link-only: no admin, no principal, no write', async () => {
        const event = makeEvent(startLink('admin'), {
            headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
        });

        await runCallback(event);
        await settle();

        expect(event.locals.user?.ownerIsAdmin).toBe(false);
        expect(event.locals.user?.userGroups).toEqual([]);
        expect(event.locals.principal).toBeUndefined();
        // /oauth/ bypasses the IdP on most proxies: a header that slips
        // through such a bypass must not create users or rewrite groups.
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('headers naming a user that does not exist: no provisioning, error page', async () => {
        mockGetUserByUsername.mockImplementation(async () => null);
        const event = makeEvent(startLink('newbie'), {
            headers: { 'x-authentik-username': 'newbie', 'x-authentik-groups': 'admins' },
        });

        const res = await runCallback(event);

        expect(event.locals.user).toBeUndefined();
        expect(res.location).toBe('/settings/connections?mal_link=error');
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('headers naming a disabled user: error page', async () => {
        mockGetUserByUsername.mockImplementation(async () => ({
            ...PINNED_ADMIN_ROW,
            disabled_at: new Date(),
        }));
        const event = makeEvent(startLink('admin'), {
            headers: { 'x-authentik-username': 'admin' },
        });

        const res = await runCallback(event);

        expect(event.locals.user).toBeUndefined();
        expect(res.location).toBe('/settings/connections?mal_link=error');
    });

    it('forward-auth headers with FORWARD_AUTH_ENABLED off: no user, error page', async () => {
        mockConfig.FORWARD_AUTH_ENABLED = false;
        const event = makeEvent(startLink('admin'), {
            headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
        });

        const res = await runCallback(event);

        expect(event.locals.user).toBeUndefined();
        expect(res).toEqual({ status: 302, location: '/settings/connections?mal_link=error' });
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forward-auth headers from an UNTRUSTED peer: no user, error page', async () => {
        const event = makeEvent(startLink('admin'), {
            headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
            peer: '203.0.113.9',
        });

        const res = await runCallback(event);

        expect(event.locals.user).toBeUndefined();
        expect(res.location).toBe('/settings/connections?mal_link=error');
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('no session at all: the handler redirects to the error page (not a 401 JSON)', async () => {
        const event = makeEvent(startLink('alice'));

        const res = await runCallback(event);

        expect(event.locals.user).toBeUndefined();
        expect(res).toEqual({ status: 302, location: '/settings/connections?mal_link=error' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no session on a fresh install (no admin yet): still the error page, never /setup', async () => {
        mockAdminExists.mockImplementation(async () => false);
        invalidateAdminExistsCache();

        const res = await runCallback(makeEvent(startLink('alice')));

        expect(res.location).toBe('/settings/connections?mal_link=error');
    });

    it('a provider failure after consent still lands on the error page', async () => {
        signInNative('alice');
        fetchMock.mockImplementationOnce(async () => {
            throw new Error('MAL unreachable');
        });

        const res = await runCallback(makeEvent(startLink('alice')));

        expect(res).toEqual({ status: 302, location: '/settings/connections?mal_link=error' });
        expect(mockUpsertMalCredential).not.toHaveBeenCalled();
    });

    it('the state check still binds the link to the user who started it', async () => {
        signInNative('mallory');
        const event = makeEvent(startLink('alice'));

        const res = await runCallback(event);

        expect(event.locals.user?.username).toBe('mallory');
        expect(res.location).toBe('/settings/connections?mal_link=error');
        expect(mockUpsertMalCredential).not.toHaveBeenCalled();
    });

    it('an /oauth/links/ path served by the /oauth/[...path] catch-all gets no identity', async () => {
        const event = makeEvent('/oauth/links/mal/nope', {
            headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
            routeId: '/oauth/[...path]',
        });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it('a failing identity lookup still ends on the error page', async () => {
        session.token = 'THROW';
        const event = makeEvent(startLink('alice'));

        const res = await runCallback(event);

        expect(event.locals.user).toBeUndefined();
        expect(res.location).toBe('/settings/connections?mal_link=error');
    });

    it('an unrouted /oauth/links/ path gets no identity and no provisioning write', async () => {
        const event = makeEvent('/oauth/links/mal/nope', {
            headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
            routeId: null,
        });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });
});

describe('the device-flow endpoints under /oauth/ stay public and token-only', () => {
    for (const [path, routeId] of [
        ['/oauth/device', '/oauth/device'],
        ['/oauth/token', '/oauth/token'],
        ['/oauth/anything', '/oauth/[...path]'],
    ] as const) {
        it(`${path}: passes with no identity, even with a session cookie and proxy headers`, async () => {
            signInNative('alice');
            const event = makeEvent(path, {
                routeId,
                headers: { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' },
            });

            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.user).toBeUndefined();
            expect(event.locals.principal).toBeUndefined();
            expect(mockUpsertUser).not.toHaveBeenCalled();
        });

        it(`${path}: device auth off answers 400 as before`, async () => {
            mockFeatures.deviceAuth = false;
            const res = await resolveAuth(makeEvent(path, { routeId }), noopMigration, true);
            expect(res?.status).toBe(400);
        });
    }
});
