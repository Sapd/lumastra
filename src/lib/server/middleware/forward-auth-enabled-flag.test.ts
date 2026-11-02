// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FORWARD_AUTH_ENABLED: forward auth is opt-in.
 *
 * Found by the reverse-proxy guide e2e (2026-10-06): identity headers were
 * honoured from every TRUSTED_PROXY_IPS peer whatever sign-in method the admin
 * chose. TRUSTED_PROXY_IPS is also set just to get real client IPs, and no proxy
 * strips client-sent identity headers by default, so an anonymous
 * `X-Forwarded-User: <admin>` through such a proxy was signed in as that admin.
 *
 * Off (default): a trusted peer's identity headers are ignored on every reader
 * (`resolveAuth`, `readTrustedForwardAuthIdentity` — the setup wizard and the
 * forward-auth setup completion — and the session-vs-header arbitration), logged
 * once per window without values. On: unchanged behaviour.
 *
 * Harness: `forward-auth-groups-without-username.test.ts`'s, driving the REAL
 * `resolveAuth()` from a TRUSTED peer (127.0.0.1 in TRUSTED_PROXY_IPS).
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

const session = vi.hoisted(() => ({
    token: null as string | null,
    row: null as Record<string, unknown> | null,
    clear: vi.fn(),
}));
vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => session.token,
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
    readDisabledForwardAuthHeaders,
    readRejectedForwardAuthPeer,
    identityHeaderVerdict,
    isForwardAuthEnabled,
} from './forward-auth.js';
import {
    getIgnoredForwardAuthSighting,
    resetIgnoredForwardAuthSighting,
} from '$lib/server/utils/forward-auth-disabled-observer.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
    headers: Record<string, string>,
    opts: { path?: string; accept?: string; peer?: string } = {},
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
        getClientAddress: () => opts.peer ?? '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

/** What an attacker sends through a proxy that does not strip identity headers. */
const FORGED_ADMIN = { 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' };

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function disabledWarns(): unknown[][] {
    return mockWarn.mock.calls.filter(([msg]) =>
        String(msg).includes('FORWARD_AUTH_ENABLED is off'),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockEnv.dev = false;
    mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
    mockConfig.FORWARD_AUTH_ENABLED = true;
    session.token = null;
    session.row = null;
    mockAdminExists.mockImplementation(async () => true);
    invalidateAdminExistsCache();
    resetIgnoredForwardAuthSighting();
});

describe('forward auth OFF: forged identity headers from a TRUSTED peer', () => {
    beforeEach(() => {
        mockConfig.FORWARD_AUTH_ENABLED = false;
    });

    it('API request → 401, anonymous, no provisioning, no group sync', async () => {
        const event = makeEvent(FORGED_ADMIN);

        const res = await resolveAuth(event, noopMigration, true);
        expect(res?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        expect(event.locals.principal).toBeUndefined();
        expect(event.locals.idpGroups).toBeUndefined();

        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('HTML page with built-in login → /login redirect, as with no headers', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        const event = makeEvent(FORGED_ADMIN, { path: '/admin', accept: 'text/html' });

        const res = await resolveAuth(event, noopMigration, true);
        expect(res?.status).toBe(303);
        expect(res?.headers.get('location')).toBe('/login?redirect=%2Fadmin');
        expect(event.locals.user).toBeUndefined();
    });

    it('logs once per window, naming headers and peer but never the values', async () => {
        await resolveAuth(makeEvent(FORGED_ADMIN), noopMigration, true);
        await resolveAuth(makeEvent(FORGED_ADMIN), noopMigration, true);
        await resolveAuth(makeEvent(FORGED_ADMIN), noopMigration, true);

        const warns = disabledWarns();
        expect(warns).toHaveLength(1);
        expect(warns[0][1]).toMatchObject({
            peer: '127.0.0.1',
            headers: ['x-authentik-username', 'x-authentik-groups'],
        });
        const logged = JSON.stringify(warns[0]);
        expect(logged).not.toContain('admins');
        expect(logged).not.toMatch(/"admin"/);
        expect(getIgnoredForwardAuthSighting()).toMatchObject({ count: 3, lastPeer: '127.0.0.1' });
    });

    it('readTrustedForwardAuthIdentity (setup wizard, setup completion) returns null', () => {
        expect(readTrustedForwardAuthIdentity(makeEvent(FORGED_ADMIN))).toBeNull();
    });

    it('the wizard learns "headers arrived, forward auth is off" — not "untrusted peer"', () => {
        const event = makeEvent(FORGED_ADMIN);
        expect(identityHeaderVerdict(event)).toBe('disabled');
        expect(readDisabledForwardAuthHeaders(event)).toBe(true);
        expect(readRejectedForwardAuthPeer(event)).toBeNull();
    });

    it('a native session survives a forged header naming someone else (no clear-and-defer)', async () => {
        session.token = 'tok';
        session.row = {
            session_id: 's1',
            user_id: '00000000-0000-0000-0000-0000000000b0',
            username: 'bob',
            groups: [],
        };
        const event = makeEvent(FORGED_ADMIN);

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('bob');
        expect(event.locals.authMethod).toBe('session');
        expect(session.clear).not.toHaveBeenCalled();
    });

    it('an untrusted peer is still reported as untrusted, not as a disabled sighting', () => {
        const event = makeEvent(FORGED_ADMIN, { peer: '203.0.113.9' });
        expect(identityHeaderVerdict(event)).toBe('untrusted-peer');
        expect(readTrustedForwardAuthIdentity(event)).toBeNull();
        expect(readDisabledForwardAuthHeaders(event)).toBe(false);
        expect(getIgnoredForwardAuthSighting()).toBeNull();
    });

    it('a settings source that omits the key fails closed', () => {
        (mockConfig as Record<string, unknown>).FORWARD_AUTH_ENABLED = undefined;
        expect(isForwardAuthEnabled()).toBe(false);
        expect(readTrustedForwardAuthIdentity(makeEvent(FORGED_ADMIN))).toBeNull();
    });

    it('a lone display-name header is dropped silently and is not a sighting', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        await resolveAuth(makeEvent({ 'x-authentik-name': 'Eve' }), noopMigration, true);
        expect(getIgnoredForwardAuthSighting()).toBeNull();
        expect(disabledWarns()).toHaveLength(0);
    });

    it('an untrusted peer flooding forged headers logs at most once per window', async () => {
        for (let i = 0; i < 5; i++) {
            await resolveAuth(
                makeEvent(FORGED_ADMIN, { peer: '203.0.113.9' }),
                noopMigration,
                true,
            );
        }
        const untrusted = mockWarn.mock.calls.filter(([msg]) =>
            String(msg).includes('untrusted TCP peer'),
        );
        expect(untrusted).toHaveLength(1);
        expect(JSON.stringify(untrusted[0])).toContain('FORWARD_AUTH_ENABLED');
    });

    it('dev: the forged username is ignored; the DEFAULT_USER fallback applies as with no header', async () => {
        mockEnv.dev = true;
        mockAdminExists.mockImplementation(async () => false);
        const event = makeEvent({
            'x-authentik-username': 'alice',
            'x-authentik-groups': 'family',
        });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('admin');
        // Dev's fallback groups, never the forged header's.
        expect(event.locals.idpGroups ?? []).not.toContain('family');
    });

    it('a request without identity headers records nothing', async () => {
        await resolveAuth(makeEvent({}), noopMigration, true);
        expect(getIgnoredForwardAuthSighting()).toBeNull();
        expect(disabledWarns()).toHaveLength(0);
    });
});

describe('forward auth ON: the same headers from the trusted peer sign in', () => {
    it('API request → signed in as the header user', async () => {
        // Keep the upsert IIFE from racing the sync's dynamic import.
        mockAdminExists.mockImplementation(async () => false);
        const event = makeEvent({
            'x-authentik-username': 'alice',
            'x-authentik-groups': 'family',
        });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.username).toBe('alice');
        expect(event.locals.authMethod).toBe('forward_auth');
        expect(disabledWarns()).toHaveLength(0);
        expect(getIgnoredForwardAuthSighting()).toBeNull();
    });

    it('readTrustedForwardAuthIdentity returns the identity', () => {
        expect(readTrustedForwardAuthIdentity(makeEvent(FORGED_ADMIN))).toEqual({
            username: 'admin',
            groups: ['admins'],
            isAdmin: true,
        });
        expect(readDisabledForwardAuthHeaders(makeEvent(FORGED_ADMIN))).toBe(false);
    });

    it('a different-user session cookie is cleared and the proxy wins (unchanged)', async () => {
        mockAdminExists.mockImplementation(async () => false);
        session.token = 'tok';
        session.row = {
            session_id: 's1',
            user_id: '00000000-0000-0000-0000-0000000000b0',
            username: 'bob',
            groups: [],
        };
        const event = makeEvent({ 'x-authentik-username': 'alice' });

        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(session.clear).toHaveBeenCalled();
        expect(event.locals.user?.username).toBe('alice');
    });

    it('an untrusted peer is still rejected with the flag on, warned on every request', async () => {
        const event = makeEvent(FORGED_ADMIN, { peer: '203.0.113.9' });
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        await resolveAuth(makeEvent(FORGED_ADMIN, { peer: '203.0.113.9' }), noopMigration, true);
        const untrusted = mockWarn.mock.calls.filter(([msg]) =>
            String(msg).includes('untrusted TCP peer'),
        );
        expect(untrusted).toHaveLength(2);
    });
});

describe('forward-auth identity trust uses the socket, not ADDRESS_HEADER', () => {
    it('rejects forged trusted proxy address without provisioning or replacing a session', async () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-forwarded-for');
        vi.stubEnv('XFF_DEPTH', '1');
        const event = makeEvent({ ...FORGED_ADMIN, 'x-forwarded-for': '127.0.0.1' });
        event.platform = { req: { socket: { remoteAddress: '203.0.113.9' } } };
        // adapter-node resolves the forged XFF here, not the TCP peer.
        expect(event.getClientAddress()).toBe('127.0.0.1');
        expect(identityHeaderVerdict(event)).toBe('untrusted-peer');
        expect(readTrustedForwardAuthIdentity(event)).toBeNull();
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
        await settle();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();

        session.token = 'tok';
        session.row = { session_id: 's1', user_id: 'bob-id', username: 'bob', groups: [] };
        const sessionEvent = makeEvent(FORGED_ADMIN);
        sessionEvent.platform = event.platform;
        expect(await resolveAuth(sessionEvent, noopMigration, true)).toBeUndefined();
        expect(sessionEvent.locals.user?.username).toBe('bob');
        expect(session.clear).not.toHaveBeenCalled();
    });

    it('accepts the trusted socket even when ADDRESS_HEADER resolves a public client', () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-forwarded-for');
        const event = makeEvent(FORGED_ADMIN, { peer: '203.0.113.9' });
        event.platform = { req: { socket: { remoteAddress: '127.0.0.1' } } };
        expect(readTrustedForwardAuthIdentity(event)).toEqual({
            username: 'admin',
            groups: ['admins'],
            isAdmin: true,
        });
    });

    it('fails closed if ADDRESS_HEADER is enabled and the socket peer is unavailable', () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-real-ip');
        const event = makeEvent(FORGED_ADMIN);
        expect(identityHeaderVerdict(event)).toBe('untrusted-peer');
        expect(readTrustedForwardAuthIdentity(event)).toBeNull();
        event.platform = { req: { socket: {} } };
        expect(readTrustedForwardAuthIdentity(event)).toBeNull();
    });
});
