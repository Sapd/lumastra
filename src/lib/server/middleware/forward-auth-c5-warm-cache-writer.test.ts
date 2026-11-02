// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix plan 6, C5: the per-request fire-and-forget admin-credential upsert
 * (`forward-auth.ts` ~`:2451-2458`) used to write the CACHED `dbIsAdmin` —
 * the header verdict of an EARLIER request (or up to 10 minutes stale on a
 * Valkey-less install) — into `users.is_admin`, instead of THIS request's
 * own live header-groups projection (`groupPermissions.isAdmin`). On a warm
 * L1 cache, an IdP promotion or demotion landed one request late (R1 writes
 * the stale cached verdict; R2, now cold because the group-sync invalidated
 * the cache, writes the correct one).
 *
 * This is a clone of `forward-auth-sso-inapp-admin.test.ts`'s harness (same
 * seam: the REAL `resolveAuth()` header/cookie session path), but with
 * `adminExists` as a CONTROLLABLE mock (that harness fixes it to always
 * `true`, which can't exercise the pre-admin first-run ordering test below)
 * and cache getters that can be warmed to non-null/non-MISS on all five
 * keys — the exact condition `resolveDbAuth`'s warm path requires to skip
 * the DB entirely and serve a stale cached verdict.
 *
 * Two seams, per the fix-plan-6 task-3 brief:
 * - (c') the ORDERING invariant that makes the new setup-gate term safe:
 *   first-run (no admin yet) must still fail closed / redirect to /setup
 *   BEFORE any group or admin write, even on a request carrying admin-group
 *   headers.
 * - (d) the WARM-CACHE writer: R1 (not R2) must write the CURRENT request's
 *   header-groups admin verdict, not the stale cached one.
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

const mockUpsertUser = vi.hoisted(() =>
    vi.fn(
        async (
            _sql: unknown,
            _params: {
                username: string;
                isAdmin: boolean;
                maxAgeRating?: number | null;
                displayName?: string | null;
            },
        ) => ({
            id: '00000000-0000-0000-0000-000000000000',
            isAdmin: false,
            demoted: false,
            promoted: false,
        }),
    ),
);

// Controllable, unlike forward-auth-sso-inapp-admin.test.ts's fixed `true` —
// (c') needs `false` to exercise the pre-admin first-run ordering guard.
const mockAdminExists = vi.hoisted(() => vi.fn(async () => true));

const mockUserRow = vi.hoisted(() => ({
    row: null as null | {
        id: string;
        username: string;
        is_admin: boolean;
        admin_pinned: boolean;
        groups: string[];
        max_age_rating: number | null;
        age_rating_pinned: boolean;
        disabled_at: Date | null;
        deleted_at: Date | null;
    },
}));

const mockGetUserByUsername = vi.hoisted(() => vi.fn(async () => mockUserRow.row));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: mockAdminExists,
    getUserByUsername: mockGetUserByUsername,
    upsertUser: mockUpsertUser,
}));

const mockUpsertUserGroups = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/server/database/queries/oauth-admin.queries.js', () => ({
    upsertUserGroups: mockUpsertUserGroups,
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

// Controllable per test — unlike the sso-inapp-admin harness's always-cold
// defaults, (d) needs ALL FIVE warmed at once.
const mockCacheGetters = vi.hoisted(() => ({
    isAdmin: vi.fn((_username: string): boolean | null => null),
    adminPinned: vi.fn((_username: string): boolean | null => null),
    disabled: vi.fn((_username: string): boolean | null => null),
    userId: vi.fn((_username: string): string | null => null),
}));
const MAX_AGE_MISS_SENTINEL = vi.hoisted(() => Symbol.for('MAX_AGE_MISS'));
const mockGetCachedMaxAge = vi.hoisted(() =>
    vi.fn(
        (_username: string): number | null | typeof MAX_AGE_MISS_SENTINEL => MAX_AGE_MISS_SENTINEL,
    ),
);

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: (username: string) => mockCacheGetters.isAdmin(username),
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: (username: string) => mockCacheGetters.adminPinned(username),
    setCachedAdminPinned: () => {},
    getCachedDisabled: (username: string) => mockCacheGetters.disabled(username),
    setCachedDisabled: () => {},
    getCachedUserId: (username: string) => mockCacheGetters.userId(username),
    setCachedUserId: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    getCachedMaxAge: (username: string) => mockGetCachedMaxAge(username),
    setCachedMaxAge: () => {},
    invalidateUserMaxAgeCache: () => {},
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
}));

// The throttled group sync's L2 hash cache, per key. Empty unless a test
// seeds it — see `skipThrottledGroupSync` below.
const mockL2Hashes = vi.hoisted(() => new Map<string, string>());
const mockIsValkeyReady = vi.hoisted(() => vi.fn(() => false));

vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: () => mockIsValkeyReady(),
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

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth, invalidateAdminExistsCache } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(
    headers: Record<string, string>,
    peer = '127.0.0.1',
    pathname = '/api/watch-together/ABCD',
): RequestEvent {
    const url = new URL(`http://localhost${pathname}`);
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

/**
 * Make forward-auth's throttled `users.groups` sync skip for `username` by
 * answering its L2 check with this header's hash (the format of
 * `forward-auth.ts`'s `hashGroups`). The sync runs with or without Valkey, and
 * its `import('database.service')` would overlap the upsert IIFE's. Vitest
 * resolves the overlapping import of a factory mock to the REAL module, which
 * this file's config mock cannot load, so the IIFE under test would throw
 * before `upsertUser`. If the hash format ever drifts, the sync runs again
 * and the tests below fail loudly — never falsely green.
 */
function skipThrottledGroupSync(username: string, groups: string[]): void {
    mockIsValkeyReady.mockReturnValue(true);
    mockL2Hashes.set(
        `user:groups:hash:${username.toLowerCase()}`,
        JSON.stringify([...groups].map((g) => g.toLowerCase()).sort()),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockIsValkeyReady.mockReturnValue(false);
    mockL2Hashes.clear();
    mockUserRow.row = null;
    mockResolveEffectiveAccess.mockReset();
    mockAdminExists.mockImplementation(async () => true);
    mockCacheGetters.isAdmin.mockImplementation(() => null);
    mockCacheGetters.adminPinned.mockImplementation(() => null);
    mockCacheGetters.disabled.mockImplementation(() => null);
    mockCacheGetters.userId.mockImplementation(() => null);
    mockGetCachedMaxAge.mockImplementation(() => MAX_AGE_MISS_SENTINEL);
    // anAdminExists() caches `true` PERMANENTLY per module instance
    // (forward-auth.ts ~:1645) — a prior test's `true` would mask (c')'s
    // `false` case if this module instance is reused across tests in this
    // file (it is: vitest keeps one module graph per test FILE).
    invalidateAdminExistsCache();
});

describe('forward-auth first-run ordering invariant (C5, (c) unit half)', () => {
    // GUARD: must be GREEN both before and after the C5 writer fix — the new
    // setup-gate `users.groups` term (S-C5b) is only safe because NOTHING
    // writes `users.groups`/`users.is_admin` before the first admin exists on
    // a fresh install. This test pins that ordering directly at the seam the
    // writer change lives on: even with admin-group headers present, a
    // pre-admin request must fail closed / bounce to /setup BEFORE any
    // upsert.
    it('non-HTML request: 503, upsertUserGroups and upsertUser NOT called, when no admin exists yet (GUARD)', async () => {
        mockAdminExists.mockImplementation(async () => false);
        mockUserRow.row = null; // no row yet either

        const event = makeEvent({
            'x-authentik-username': 'first-admin',
            'x-authentik-groups': 'admins',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(503);
        expect(event.locals.user).toBeUndefined();
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockUpsertUserGroups).not.toHaveBeenCalled();
    });

    it('HTML request: redirects to /setup, upsertUserGroups and upsertUser NOT called, when no admin exists yet (GUARD)', async () => {
        mockAdminExists.mockImplementation(async () => false);
        mockUserRow.row = null;

        const event = makeEvent(
            {
                'x-authentik-username': 'first-admin',
                'x-authentik-groups': 'admins',
                accept: 'text/html',
            },
            '127.0.0.1',
            '/library', // NOT an /api/ path — isHtmlPageRequest() excludes those unconditionally
        );

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(303);
        expect((result as Response).headers.get('location')).toBe('/setup');
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockUpsertUserGroups).not.toHaveBeenCalled();
    });
});

describe('forward-auth warm-cache per-request admin writer (C5, (d))', () => {
    function warmAllFiveCacheKeys(opts: {
        isAdmin: boolean;
        userId?: string;
        maxAge?: number | null;
    }): void {
        mockCacheGetters.isAdmin.mockImplementation(() => opts.isAdmin);
        mockCacheGetters.adminPinned.mockImplementation(() => false);
        mockCacheGetters.disabled.mockImplementation(() => false);
        mockCacheGetters.userId.mockImplementation(
            () => opts.userId ?? '00000000-0000-0000-0000-0000000000aa',
        );
        // null (unrestricted), not the MISS sentinel, unless a test warms a cap.
        mockGetCachedMaxAge.mockImplementation(() => opts.maxAge ?? null);
    }

    // RED at HEAD (C5 primary case): a warm L1 cache says `isAdmin: false`
    // (an earlier request's verdict), but THIS request's header carries the
    // admin group — an IdP promotion that hasn't been seen by this cache
    // entry yet. HEAD's writer persists the STALE cached `dbIsAdmin` (false);
    // the fix persists THIS request's live `groupPermissions.isAdmin` (true)
    // instead, so the promotion lands on R1, not R2.
    it('[C5 RED] warm cache says non-admin, header carries the admin group → upsertUser is called with isAdmin: true on R1', async () => {
        warmAllFiveCacheKeys({ isAdmin: false });
        skipThrottledGroupSync('promoted-user', ['admins']);
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['admins'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'promoted-user',
            'x-authentik-groups': 'admins',
        });

        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined(); // continues the request

        // GUARD (unaffected by the writer fix — Formula A is computed
        // independently of the cached/written column value): the SYNCHRONOUS
        // response already reflects the correct verdict on R1, both before
        // and after the fix.
        expect(event.locals.user?.ownerIsAdmin).toBe(true);

        // The fire-and-forget IIFE runs after resolveAuth returns.
        await vi.waitFor(() => expect(mockUpsertUser).toHaveBeenCalled());
        expect(mockUpsertUser.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true });
    });

    // Mirror case, also RED at HEAD: warm cache says `isAdmin: true` (stale),
    // header no longer carries the admin group (an IdP demotion). HEAD's
    // writer persists the stale cached `true`; the fix persists `false`.
    it('[C5 RED] warm cache says admin, header carries no admin group → upsertUser is called with isAdmin: false on R1', async () => {
        warmAllFiveCacheKeys({ isAdmin: true });
        skipThrottledGroupSync('demoted-user', ['users']);
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'demoted-user',
            'x-authentik-groups': 'users',
        });

        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();

        // GUARD, same reasoning as the mirror test above.
        expect(event.locals.user?.ownerIsAdmin).toBe(false);

        await vi.waitFor(() => expect(mockUpsertUser).toHaveBeenCalled());
        expect(mockUpsertUser.mock.calls[0]?.[1]).toMatchObject({ isAdmin: false });
    });

    // Security review 7 A1 (the age axis of the same writer): the upsert used
    // to persist `dbMaxAge`, which on a warm L1 cache is an EARLIER request's
    // cap. It now persists THIS request's header cap
    // (`groupPermissions.maxAgeRating`), the way S-C5a fixed `isAdmin`; a
    // pinned row is still protected by `upsertUser`'s own
    // `CASE WHEN users.age_rating_pinned` guard, which ignores the parameter.
    it('[A1] warm cache holds age 12, header carries age-6 → upsertUser is called with maxAgeRating: 6', async () => {
        warmAllFiveCacheKeys({ isAdmin: false, maxAge: 12 });
        skipThrottledGroupSync('kid', ['users', 'age-6']);
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'kid',
            'x-authentik-groups': 'users,age-6',
        });

        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();

        await vi.waitFor(() => expect(mockUpsertUser).toHaveBeenCalled());
        expect(mockUpsertUser.mock.calls[0]?.[1]).toMatchObject({ maxAgeRating: 6 });
    });

    it('[A1] warm cache holds age 6, header carries no age group → upsertUser is called with maxAgeRating: null', async () => {
        warmAllFiveCacheKeys({ isAdmin: false, maxAge: 6 });
        skipThrottledGroupSync('grown-up', ['users']);
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'grown-up',
            'x-authentik-groups': 'users',
        });

        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();

        await vi.waitFor(() => expect(mockUpsertUser).toHaveBeenCalled());
        expect(mockUpsertUser.mock.calls[0]?.[1]).toMatchObject({ maxAgeRating: null });
    });
});

describe('B-3: partial auth caches during a database outage', () => {
    function warmPartial(): void {
        mockCacheGetters.isAdmin.mockReturnValue(false);
        mockCacheGetters.adminPinned.mockReturnValue(true);
        mockCacheGetters.userId.mockReturnValue('00000000-0000-4000-8000-000000000001');
        mockGetUserByUsername.mockRejectedValueOnce(
            Object.assign(new Error('down'), { code: 'ECONNREFUSED' }),
        );
    }
    it('returns retryable 503 when the age pin is unknown even with a warm user id', async () => {
        warmPartial();
        mockCacheGetters.disabled.mockReturnValue(false);
        const event = makeEvent({
            'x-authentik-username': 'partial',
            'x-authentik-groups': 'users',
        });
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(503);
        expect(event.locals.user).toBeUndefined();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });
    it('retains a cached disable when another field is cold and a non-dependency read fails', async () => {
        warmPartial();
        mockGetUserByUsername.mockReset().mockRejectedValueOnce(new TypeError('bad row'));
        mockCacheGetters.disabled.mockReturnValue(true);
        const event = makeEvent({
            'x-authentik-username': 'disabled-partial',
            'x-authentik-groups': 'users',
        });
        expect((await resolveAuth(event, noopMigration, true))?.status).toBe(403);
        expect(event.locals.user).toBeUndefined();
    });
});

it.each(['57014', 'XX000'])(
    'B-3 follow-up: unknown disabled state and DB error %s returns retryable 503',
    async (code) => {
        mockCacheGetters.isAdmin.mockReturnValue(false);
        mockCacheGetters.adminPinned.mockReturnValue(true);
        mockCacheGetters.userId.mockReturnValue('00000000-0000-4000-8000-000000000001');
        mockGetCachedMaxAge.mockReturnValue(null);
        mockGetUserByUsername
            .mockReset()
            .mockRejectedValueOnce(Object.assign(new Error('query failed'), { code }));
        const event = makeEvent({ 'x-authentik-username': 'unknown-disabled' });
        const response = await resolveAuth(event, noopMigration, true);
        expect(response?.status).toBe(503);
        expect(response?.headers.get('X-Lumastra-Auth-Retry')).toBe('true');
        expect(event.locals.user).toBeUndefined();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    },
);
