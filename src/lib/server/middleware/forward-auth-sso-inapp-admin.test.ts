// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-23, C6 (SSO half, Option A per the fix-plan-5
 * task-1 ruling): the SSO/cookie forward-auth session used to rebuild its
 * final permissions with `isAdminOverride: dbIsAdmin` — `dbIsAdmin` is
 * ALWAYS a defined boolean (resolveDbAuth's every branch returns one), so
 * `buildUserPermissions`'s `isAdminOverride ?? (groups || inApp)` never fell
 * through to the OR term. An unpinned account whose only admin grant was the
 * in-app `admin` capability was therefore denied admin in the browser while
 * every token-based admin surface already granted it (the "relative
 * over-grant" review names). Fix: `resolveDbAuth` now also returns
 * `adminPinned`, and the merge point uses
 * `computeOwnerIsAdminOverride(dbIsAdmin, adminPinned)` — the SAME tri-state
 * `resolve-token-user-access.ts` and the service-token impersonation branch
 * already use — so the pin still wins unconditionally, but an UNPINNED
 * account's in-app admin capability now counts on the SSO session too,
 * exactly as it already does everywhere else.
 *
 * Drives the REAL `resolveAuth()` header/cookie session path (not `/api/v1`,
 * not a Bearer token) with a MOCKED `getUserByUsername` row (controlled per
 * test via `mockUserRow`) and a mocked `resolveEffectiveAccess` (the in-app
 * layer) — the seam this policy change actually lives on. Does NOT mock
 * `$lib/server/auth.js`: the real `buildUserPermissions` composition IS the
 * thing under test.
 *
 * Fix round 1 (fix-plan-5 task-1 review) adds: IMPORTANT 1's DB-error-branch
 * cases (the catch branch must keep a DEFINED override, not `adminPinned:
 * false`, since the pin is genuinely unknown there); MINOR 3's isolated
 * guard (non-admin header groups, so the pin — not the header — is what's
 * being proven to suppress the in-app term); and MINOR 7's warm-path case
 * (all cache keys warm except `adminPinned` still takes the DB path).
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
    vi.fn(async () => ({
        id: '00000000-0000-0000-0000-000000000000',
        isAdmin: false,
        demoted: false,
        promoted: false,
    })),
);

// The row this test controls per-case: an unpinned or pinned-demoted owner.
// `throwOnFirstCall` (fix round 1, IMPORTANT 1) lets a test simulate a DB
// read error inside resolveDbAuth's OWN try/catch specifically, while still
// letting resolveOrProvisionUserId's later getUserByUsername call (used to
// re-fetch the row after upsertUser()) succeed — otherwise the whole request
// fails closed at "Account not provisioned" before ever reaching the merge
// point this fix round is about.
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
    throwOnFirstCall: false,
}));

const mockGetUserByUsername = vi.hoisted(() =>
    vi.fn(async () => {
        if (mockUserRow.throwOnFirstCall) {
            mockUserRow.throwOnFirstCall = false;
            throw new Error('DB read failed (simulated, fix round 1)');
        }
        return mockUserRow.row;
    }),
);

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: mockGetUserByUsername,
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

// The in-app group -> capability layer. Configured per test.
const mockResolveEffectiveAccess = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) => mockResolveEffectiveAccess(...args),
}));

// Caches default cold (every getter returns null / MISS) so a request
// re-runs the DB resolution path by default — the seam the fix changes.
// Turned into vi.fn()s (fix round 1, MINOR 7) rather than fixed arrow
// functions so a single test can make four of the five keys warm and leave
// `adminPinned` cold, proving resolveDbAuth's warm-path condition requires
// ALL FIVE keys (not just the pre-C6 four) before skipping the DB.
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
    mockUserRow.row = null;
    mockUserRow.throwOnFirstCall = false;
    mockResolveEffectiveAccess.mockReset();
    // Explicit re-arm to cold-cache defaults: clearAllMocks clears call
    // history but a prior test's mockReturnValueOnce/mockImplementationOnce
    // queue could otherwise leak into the next test.
    mockCacheGetters.isAdmin.mockImplementation(() => null);
    mockCacheGetters.adminPinned.mockImplementation(() => null);
    mockCacheGetters.disabled.mockImplementation(() => null);
    mockCacheGetters.userId.mockImplementation(() => null);
    mockGetCachedMaxAge.mockImplementation(() => MAX_AGE_MISS_SENTINEL);
});

describe('forward auth SSO session — in-app admin capability under the pin (C6)', () => {
    // RED at HEAD (security review 2026-09-23, C6): resolveDbAuth's dbIsAdmin
    // is ALWAYS defined, so `isAdminOverride: dbIsAdmin` at the merge point
    // never falls through to the in-app OR-term even when unpinned. GREEN
    // once resolveDbAuth also returns adminPinned and the merge uses
    // computeOwnerIsAdminOverride(dbIsAdmin, adminPinned).
    it('[C6] unpinned account becomes admin in the SSO session via an in-app admin capability alone', async () => {
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000a1',
            username: 'inapp-admin',
            is_admin: false,
            admin_pinned: false,
            groups: ['users'], // not an admin group
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: { ownerIsAdmin: true },
        });

        const event = makeEvent({
            'x-authentik-username': 'inapp-admin',
            'x-authentik-groups': 'users',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined(); // continues the request, does not fail closed
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
    });

    // GUARD: a pin that explicitly DEMOTES an admin must stay non-admin in
    // the SSO session even with an in-app admin capability — same ordering
    // as resolve-owner-admin-status.test.ts's guard. Must be GREEN both
    // before and after the C6 fix (dbIsAdmin is already false here at HEAD,
    // since admin_pinned=true routes it straight to the false is_admin
    // column, independent of the in-app layer).
    it('pinned-demoted account stays non-admin in the SSO session even with an in-app admin capability (GUARD)', async () => {
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000a2',
            username: 'pinned-demoted',
            is_admin: false,
            admin_pinned: true,
            groups: ['admins'], // stale IdP admin group
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['in-app-admins'],
            effectiveGroups: ['admins', 'in-app-admins'],
            capabilities: { ownerIsAdmin: true },
        });

        const event = makeEvent({
            'x-authentik-username': 'pinned-demoted',
            'x-authentik-groups': 'admins',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
    });

    // MINOR 3 (fix-plan-5 task-1 review): the GUARD above carries the admin
    // group in the HEADER too, so it does not, on its own, isolate the pin
    // as the thing suppressing the in-app term — a hypothetical bug that
    // read the header instead of the pin would pass it just as well. This
    // variant uses NON-admin header groups so only the pin (admin_pinned:true,
    // is_admin:false) can be responsible for the denial. Discrimination proof
    // (scratch edit -> RED -> revert by hand) is recorded in the task-1
    // report's "Fix round 1" section.
    it('pinned-demoted account with NON-admin header groups stays non-admin — isolates the pin, not the header, as the suppressor (GUARD)', async () => {
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000a3',
            username: 'pinned-demoted-plain-header',
            is_admin: false,
            admin_pinned: true,
            groups: ['admins'], // the ROW's synced groups — irrelevant once pinned
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['in-app-admins'],
            effectiveGroups: ['users', 'in-app-admins'],
            capabilities: { ownerIsAdmin: true },
        });

        const event = makeEvent({
            'x-authentik-username': 'pinned-demoted-plain-header',
            // NON-admin header groups — isolates the pin as the suppressor.
            'x-authentik-groups': 'users',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
    });

    // IMPORTANT 1 (fix-plan-5 task-1 review, controller ruling): unlike the
    // no-sql/no-row fallbacks, resolveDbAuth's DB-ERROR (catch) branch must
    // NOT return adminPinned:false — the pin is genuinely UNKNOWN when the
    // row can't be read, and `false` would let the in-app admin term through
    // for what might be a pinned-demoted user. RED before this fix round's
    // catch-branch change (adminPinned:true, forcing a DEFINED override
    // equal to oidcIsAdmin so the in-app term cannot add admin).
    it('[Fix round 1] a DB read error inside resolveDbAuth keeps a DEFINED override so in-app admin cannot elevate an unverifiable pin', async () => {
        mockUserRow.throwOnFirstCall = true;
        // This legacy pin-fallback case has a known enabled account. An unknown
        // disabled state now returns 503 before any fallback can authenticate.
        mockCacheGetters.disabled.mockReturnValue(false);
        // The row resolveOrProvisionUserId's SECOND getUserByUsername call
        // (after upsertUser) succeeds with, once throwOnFirstCall is spent.
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000b1',
            username: 'db-error-inapp-admin',
            is_admin: false,
            admin_pinned: false,
            groups: ['users'],
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: { ownerIsAdmin: true },
        });

        const event = makeEvent({
            'x-authentik-username': 'db-error-inapp-admin',
            'x-authentik-groups': 'users', // non-admin header
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
    });

    // Sibling of the case above: a header-admin must still get admin on the
    // DB-error branch (unchanged behaviour) — the fix only stops the in-app
    // term from ADDING admin on an unverifiable pin, it does not touch the
    // group-derived path.
    it('[Fix round 1] a DB read error inside resolveDbAuth still grants admin when header groups say admin (unchanged)', async () => {
        mockUserRow.throwOnFirstCall = true;
        // This legacy pin-fallback case has a known enabled account. An unknown
        // disabled state now returns 503 before any fallback can authenticate.
        mockCacheGetters.disabled.mockReturnValue(false);
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000b2',
            username: 'db-error-header-admin',
            is_admin: false,
            admin_pinned: false,
            groups: ['admins'],
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['admins'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'db-error-header-admin',
            'x-authentik-groups': 'admins',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
    });

    // MINOR 7 (fix-plan-5 task-1 review): resolveDbAuth's warm-path fast
    // return requires ALL FIVE cache keys warm (isAdmin, adminPinned, maxAge,
    // disabled, userId) since the C6 fix added adminPinned as a fifth key —
    // four-warm-one-cold must still take the DB path, not silently reuse a
    // stale/absent adminPinned.
    it('[Fix round 1] all cache keys warm except adminPinned still takes the DB path', async () => {
        mockCacheGetters.isAdmin.mockImplementation(() => true);
        mockCacheGetters.disabled.mockImplementation(() => false);
        mockCacheGetters.userId.mockImplementation(() => '00000000-0000-0000-0000-0000000000c1');
        mockGetCachedMaxAge.mockImplementation(() => null);
        // adminPinned intentionally left cold (mockCacheGetters.adminPinned
        // keeps its beforeEach default of `() => null`).

        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000c1',
            username: 'warm-except-pinned',
            is_admin: false,
            admin_pinned: false,
            groups: ['users'],
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'warm-except-pinned',
            'x-authentik-groups': 'users',
        });

        await resolveAuth(event, noopMigration, true);

        // If the warm path incorrectly short-circuited on the pre-C6 four
        // keys, getUserByUsername would never be called at all (userId was
        // already warm, so resolveOrProvisionUserId is also skipped) — the
        // DB path being taken is the only way this fires.
        expect(mockGetUserByUsername).toHaveBeenCalledWith(expect.anything(), 'warm-except-pinned');
    });
});

// Security review 6, P2 fix round 1, Important 2: the device-authorize route
// test built `locals.idpGroups` BY HAND, so no test at the actual seam
// (`handleForwardAuth`) proved forward-auth ever sets it, or sets it to the
// RAW header list rather than the in-app-merged `userContext.userGroups`.
// Both `idpGroups = effectiveGroups` and deleting the assignment entirely
// survived the full 185-test forward-auth* suite. This reuses the C6
// harness above (real `resolveAuth`/`handleForwardAuth`, mocked
// `resolveEffectiveAccess` for the in-app layer, `isValkeyReady` false).
describe('forward auth — locals.idpGroups is the raw header projection, not the in-app-merged set (security review 6, P2)', () => {
    it('locals.idpGroups equals the parsed header list and excludes an in-app-only group name', async () => {
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000e1',
            username: 'idp-groups-user',
            is_admin: false,
            admin_pinned: false,
            groups: ['users'],
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        // The in-app layer adds a group NAME that is not in the header —
        // this is exactly what `userContext.userGroups` (effectiveGroups)
        // must NOT leak into `locals.idpGroups`.
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['in-app-only-group'],
            effectiveGroups: ['users', 'in-app-only-group'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'idp-groups-user',
            'x-authentik-groups': 'users',
        });

        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.authMethod).toBe('forward_auth');
        // The merged set DID reach userContext.userGroups (sanity check that
        // the in-app mock is actually wired and doing something) —
        expect(event.locals.user?.userGroups).toContain('in-app-only-group');
        // — but locals.idpGroups is the raw header projection only.
        expect(event.locals.idpGroups).toEqual(['users']);
        expect(event.locals.idpGroups).not.toContain('in-app-only-group');
    });

    // Fix round 1 (coordinator update): renamed from "...is set whenever
    // authMethod is forward_auth..." — that overclaimed. The empty-IdP-header
    // follow-up makes `idpGroups` `undefined` when the groups header is
    // ABSENT (even though `authMethod` is still `forward_auth`), so this test
    // covers the PRESENT-header case only, with no in-app membership as the
    // varying factor.
    it('locals.idpGroups equals the parsed header list with a PRESENT header, even with no in-app membership', async () => {
        mockUserRow.row = {
            id: '00000000-0000-0000-0000-0000000000e2',
            username: 'idp-groups-user-2',
            is_admin: false,
            admin_pinned: false,
            groups: ['users', 'editors'],
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        };
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users', 'editors'],
            capabilities: {},
        });

        const event = makeEvent({
            'x-authentik-username': 'idp-groups-user-2',
            'x-authentik-groups': 'users,editors',
        });

        await resolveAuth(event, noopMigration, true);

        expect(event.locals.authMethod).toBe('forward_auth');
        expect(event.locals.idpGroups).toEqual(['users', 'editors']);
    });
});
