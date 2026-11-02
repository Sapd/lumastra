// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for resolveAuth()'s /api/v1/* bearer-token identity paths in
 * forward-auth.ts (PAT / service token / stream token). Drives the full
 * handlePublicApiAuth flow with heavy mocking of the token-validation
 * services and the DB/cache layers underneath them, then asserts on the
 * resulting `event.locals.user` / `event.locals.principal`.
 *
 * Covers:
 *   M11 — buildPrincipal wiring: PAT ownerIsAdmin = isUserAdmin(groups);
 *         service_token forceNonAdmin forwarded to deriveIsAdmin.
 *   M13 — stream token yields a tightly-scoped, never-admin principal.
 *   M15 — service-token impersonation: forceNonAdmin strips elevated traits
 *         even when the impersonated user is admin; without forceNonAdmin an
 *         admin-scope token retains admin for an admin-group target.
 *   L5  — allowed_path_prefixes boundary matching (exact / child / sibling).
 *
 * L3 ("stream_token principal loop") was investigated per the task brief and
 * found NOT reproducible — see the skip note at the bottom of this file. No
 * test was added for it (per instructions, an unreproducible report is not
 * invented into a test).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_JELLYFIN_COMPAT: false,
        buildInfo: { version: '1.0.0' },
        FEATURE_DEVICE_AUTH: true,
        AUTH_NATIVE_LOGIN_ENABLED: true,
    },
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// isUserAdmin / buildUserPermissions: simplified, deterministic stand-ins so
// tests control admin-ness directly via a sentinel group ('admin-group')
// instead of depending on the real config.ADMIN_GROUPS list. isUserAdmin() and
// buildUserPermissions() each have their own dedicated unit-test coverage
// elsewhere; here we only need a stable, controllable shape.
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: (groups: string[] = []) => groups.includes('admin-group'),
    buildUserPermissions: (
        groups: string[],
        opts?: { isAdminOverride?: boolean; extraCapabilities?: { ownerIsAdmin?: boolean } },
    ) => {
        const isAdmin =
            opts?.isAdminOverride ??
            (groups.includes('admin-group') || opts?.extraCapabilities?.ownerIsAdmin === true);
        return {
            hasWatchPermission: isAdmin,
            hasLiveTvPermission: isAdmin,
            hasRequestPermission: isAdmin,
            ownerIsAdmin: isAdmin,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: isAdmin,
            liveTvPriority: isAdmin ? 'high' : 'low',
        };
    },
}));

// Every username resolves to the same fixed, valid users.id UUID via the L1
// cache hit path — keeps PAT/service-token/stream-token identity resolution
// off the real database entirely (resolveUserIdByUsername short-circuits on
// a cache hit before ever touching the DB).
const mockGetCachedDisabled = vi.fn<(username: string) => boolean | null>(() => null);
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    // Always a cold miss, same as getCachedIsAdmin — keeps this file's
    // resolveTokenUserAccess-driven tests on the DB path (fix round 1,
    // Important 4: resolveRow() now also reads/writes this cache entry).
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: (username: string) => mockGetCachedDisabled(username),
    setCachedDisabled: () => {},
    // `deleted_at`'s parallel cache entry (security review 2026-09-16, task 6
    // follow-up) — always a cold miss too, same rationale as getCachedDisabled
    // above: this file's resolveTokenUserAccess-driven tests stay on the DB
    // path via mockGetUserByUsername.
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: () => '00000000-0000-0000-0000-0000000000aa',
    setCachedUserId: () => {},
    // Always a cold miss here, same as getCachedIsAdmin above — keeps this
    // file's stream-token tests (which drive behaviour entirely via
    // mockGetUserByUsername) on the DB path in resolveTokenUserAccess's
    // resolveRow(); its own cache-hit-skips-DB behaviour has dedicated
    // coverage in resolve-token-user-access.test.ts.
    getCachedGroups: () => null,
    setCachedGroups: () => {},
    invalidateUserAdminCache: () => {},
}));

// DB unavailable -> resolveInAppAccess() fails open (effectiveGroups = synced
// groups, no extra capabilities). Keeps PAT/JWT/service-token in-app-access
// resolution off the real database.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

const mockValkeyCacheGet = vi.fn<(key: string) => Promise<null>>(async () => null);
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: (key: string) => mockValkeyCacheGet(key),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

// Service-token impersonation (act_as_user) reads the target's username +
// groups via a direct `new Database().getSql()` query — mock it to return a
// controllable row so M15 doesn't need a live database.
const mockImpersonationRow = {
    username: 'targetuser',
    groups: [] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
    // C2 (security review 2026-09-15): the impersonation-target SELECT now
    // also reads is_admin/admin_pinned so forward-auth.ts can apply the
    // pin-aware formula. Default false/false reproduces the OLD groups-only
    // behaviour for every pre-existing fixture in this file that never sets
    // these two fields.
    is_admin: false,
    admin_pinned: false,
    // C10 (security review 2026-09-15/16): the same SELECT now also reads
    // max_age_rating/age_rating_pinned so forward-auth.ts can apply
    // computeOwnerMaxAge()'s pin-aware formula. Default null/false reproduces
    // the OLD "no age pin at all" behaviour for every pre-existing fixture.
    max_age_rating: null as number | null,
    age_rating_pinned: false,
};
const mockSqlQuery = vi.fn(async () => [mockImpersonationRow]);
vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): typeof mockSqlQuery {
            return mockSqlQuery;
        }
    }
    return { Database: MockDatabase };
});

const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: (...args: unknown[]) => mockPatValidate(...args),
        hasScope: () => true,
    }),
}));

const mockSvcValidate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        validate: (...args: unknown[]) => mockSvcValidate(...args),
    }),
}));

// Stream-token path (handleStreamToken) resolves live DB permissions via
// resolve-token-user-access.ts -> getUserByUsername + resolveEffectiveAccess
// (C4). Default row is an ordinary, unrestricted, non-admin, enabled account;
// individual tests override via mockResolvedValue.
const mockLiveTvAllowed = vi.hoisted(() => vi.fn().mockResolvedValue(true));
interface MockUserRow {
    id: string;
    username: string;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
    groups: string[];
    disabled_at: Date | null;
    deleted_at: Date | null;
}

const mockGetUserByUsername = vi.fn<(username: string) => Promise<MockUserRow | null>>(
    async (_username: string) => ({
        id: '00000000-0000-0000-0000-0000000000aa',
        username: 'carol',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: [],
        disabled_at: null,
        deleted_at: null,
    }),
);
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserLiveTvAllowed: (...args: unknown[]) => mockLiveTvAllowed(...args),
    getUserByUsername: (username: string) => mockGetUserByUsername(username),
    // A service token's owner is resolved by id (API package 15); the same
    // queue of rows serves both lookups.
    getUserById: (id: string) => mockGetUserByUsername(id),
}));

// In-app access layer: simple passthrough (effective groups = synced DB
// groups, no extra capabilities) by default — resolveEffectiveAccess has its
// own dedicated coverage in access-control.service.test.ts. A test that needs
// to grant the in-app `admin` capability (Important 1, security review
// 2026-09-16 fix round 1) overrides via mockResolveEffectiveAccess.mockResolvedValueOnce.
const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, syncedGroups: readonly string[]) => ({
        inAppGroupNames: [] as string[],
        effectiveGroups: [...syncedGroups],
        capabilities: {} as Record<string, unknown>,
    }),
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) =>
        mockResolveEffectiveAccess(...(args as [unknown, string, readonly string[]])),
}));

const mockStreamValidate = vi.fn();
const mockStreamGetStatus = vi.fn();
vi.mock('$lib/server/services/playback-grant.js', async () => {
    const { resolvePlaybackGrantRoute } = await import('../services/playback-grant-routes.js');
    return {
        resolvePlaybackGrantRoute,
        validatePlaybackGrant: (
            token: string,
            opts: { clientIp: string; route: { mediaId?: string } },
        ) => mockStreamValidate(token, opts.route.mediaId, opts.clientIp),
    };
});
vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({
        validate: (...args: unknown[]) => mockStreamValidate(...args),
        getStatus: (...args: unknown[]) => mockStreamGetStatus(...args),
    }),
}));

// JWT bearer path (device-flow access tokens — the `else` branch when the
// token has neither the pat_ nor svc_ prefix).
const mockVerifyAccessToken = vi.fn();
vi.mock('$lib/server/oauth/jwt.js', () => ({
    verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
}));

// Device-session liveness (revoked device => its access JWT is rejected).
// Live by default; individual tests flip it.
const mockCheckLiveness = vi.fn(
    async (_id: string): Promise<'live' | 'revoked' | 'unknown'> => 'live',
);
vi.mock('$lib/server/oauth/device-session-liveness.js', () => ({
    checkDeviceSessionLiveness: (id: string) => mockCheckLiveness(id),
}));

vi.mock('$lib/server/config/server-id.js', () => ({
    getServerId: async () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('$lib/server/server-branding.js', () => ({
    getServerBranding: async () => ({ appName: 'Lumastra', appDescription: 'Media Dashboard' }),
}));
vi.mock('$lib/server/api/defs/server/capabilities.js', () => ({
    buildServerCapabilities: async () => ({ liveTv: { available: false } }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';
import { aiDbService } from '$lib/server/services/database.service.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeApiV1Event(opts: {
    path: string;
    authHeader?: string;
    streamToken?: string;
    method?: string;
}): RequestEvent {
    const url = new URL('http://localhost' + opts.path);
    if (opts.streamToken) url.searchParams.set('grant', opts.streamToken);
    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);
    const request = new Request(url, { headers, method: opts.method });

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
    mockLiveTvAllowed.mockResolvedValue(true);
    // Reset EVERY test to "DB unavailable" for the pin-aware admin lookup
    // (resolveOwnerIsAdminOverride) — a test that needs it truthy sets its
    // own mockResolvedValue and must not leak that into a later test, since
    // vi.clearAllMocks() clears call history but NOT a configured resolved
    // value or a queued mockResolvedValueOnce().
    vi.mocked(aiDbService.getSql).mockResolvedValue(null);
    mockValkeyCacheGet.mockResolvedValue(null);
    mockSqlQuery.mockResolvedValue([mockImpersonationRow]);
    mockGetCachedDisabled.mockReturnValue(null);
    mockImpersonationRow.username = 'targetuser';
    mockImpersonationRow.groups = [];
    mockImpersonationRow.disabled_at = null;
    // Review round 1, Minor 6: this global reset omitted `deleted_at`, so a
    // test that set it to a Date (the C17 "soft-deleted impersonation
    // target" block below) would leak that state into whichever test runs
    // next in file order.
    mockImpersonationRow.deleted_at = null;
    mockImpersonationRow.is_admin = false;
    mockImpersonationRow.admin_pinned = false;
    mockImpersonationRow.max_age_rating = null;
    mockImpersonationRow.age_rating_pinned = false;
    mockGetUserByUsername.mockResolvedValue({
        id: '00000000-0000-0000-0000-0000000000aa',
        username: 'carol',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: [],
        disabled_at: null,
        deleted_at: null,
    });
});

// ── M11: buildPrincipal wiring — PAT ownerIsAdmin = isUserAdmin(groups) ──────

describe('resolveAuth /api/v1 — PAT: ownerIsAdmin = isUserAdmin(groups) (M11)', () => {
    it('admin-scope PAT owned by an admin-group user -> principal.isAdmin true', async () => {
        // Fix round 1 (Important #1): the DB is now consulted to decide
        // whether an isAdminOverride applies at all (native-session.ts
        // shape). This owner is UNPINNED, so resolveOwnerIsAdminOverride
        // resolves `undefined` (no override) and buildUserPermissions' own
        // group check decides — supply an unpinned DB row so this test still
        // exercises the groups-derived path its name claims, rather than
        // silently hitting the fail-closed "DB unavailable" branch.
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: '11111111-1111-1111-1111-111111111111',
            username: 'alice',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admin-group'],
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            id: 1,
            userId: '11111111-1111-1111-1111-111111111111',
            username: 'alice',
            name: 'alice-pat',
            scopes: ['admin'],
            groups: ['admin-group'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_abc',
            allowedIps: null,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer pat_abc123' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(event.locals.principal?.isAdmin).toBe(true);
    });

    it('admin-scope PAT owned by a NON-admin user -> principal.isAdmin false', async () => {
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: '11111111-1111-1111-1111-111111111112',
            username: 'bob',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['regular-user'],
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            id: 2,
            userId: '11111111-1111-1111-1111-111111111112',
            username: 'bob',
            name: 'bob-pat',
            scopes: ['admin'],
            groups: ['regular-user'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_def',
            allowedIps: null,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer pat_def456' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(event.locals.principal?.isAdmin).toBe(false);
    });
});

// ── C10 (security review 2026-09-15/16): handlePatAuth never applied the
// admin's per-user age-rating pin (`age_rating_pinned`/`max_age_rating`) at
// all — only resolveInAppAccess + resolveOwnerIsAdminOverride ran, neither of
// which reads the age columns. It now ALSO consults resolveTokenUserAccess()
// for the age axis (kept separate from the admin axis on purpose — see
// forward-auth.ts's comment on that call for why the admin verdict still
// comes from resolveOwnerIsAdminOverride, not resolveTokenUserAccess's own).

describe('resolveAuth /api/v1 — PAT: the age-rating pin now applies (C10)', () => {
    it('a pinned owner (age_rating_pinned=true, max_age_rating=6, no age group) yields isAgeRestricted:true, maxAgeRating:6', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000c2',
            username: 'kid-pat-owner',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: 6,
            age_rating_pinned: true,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            id: 8,
            userId: '00000000-0000-0000-0000-0000000000c2',
            username: 'kid-pat-owner',
            name: 'kid-pat',
            scopes: ['read'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'pat_kid',
            allowedIps: null,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer pat_kidxyz' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.isAgeRestricted).toBe(true);
        expect(event.locals.user?.maxAgeRating).toBe(6);
    });

    it('an unresolvable owner row denies the request (fails closed, never skips the pin silently)', async () => {
        mockGetUserByUsername.mockResolvedValue(null);
        mockPatValidate.mockResolvedValue({
            id: 9,
            userId: '00000000-0000-0000-0000-0000000000c3',
            username: 'ghost-pat-owner',
            name: 'ghost-pat',
            scopes: ['read'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'pat_ghost',
            allowedIps: null,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer pat_ghostxyz' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result!.status).toBe(401);
    });
});

// ── C2 (security review 2026-09-15): the pin-aware admin verdict never
// reached forward-auth.ts. Before this fix, handlePatAuth /
// handleServiceTokenAuth built `Principal` from a raw, group-only
// `ownerIsAdmin` — so a PAT/service-token session minted while its owner was
// still an admin kept granting admin forever after an `admin_pinned=true`
// demotion (`setIsAdmin(false)` revokes neither `users.groups` nor
// outstanding tokens). There was previously NO `admin_pinned: true` fixture
// anywhere in this file (M11/M15 above are all `admin_pinned: false`) — that
// absence is the gap that let C2/C3 ship. These tests drive the REAL
// resolveAuth() seam (not a hand-built buildPrincipal()) with a pin-demoted
// owner/creator whose STALE users.groups still lists an admin group. ──────

describe('resolveAuth /api/v1 — pin-demoted owner: ownerIsAdmin must NOT come from stale groups (C2)', () => {
    it('PAT: owner has admin_pinned:true, is_admin:false + a stale admin group -> principal.isAdmin false', async () => {
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: '11111111-1111-1111-1111-111111111113',
            username: 'demoted-admin',
            is_admin: false,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admin-group'], // stale IdP group — pin must override it
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            id: 3,
            userId: '11111111-1111-1111-1111-111111111113',
            username: 'demoted-admin',
            name: 'demoted-admin-pat',
            scopes: ['admin'],
            groups: ['admin-group'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_demoted',
            allowedIps: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer pat_demoted123',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(event.locals.principal?.isAdmin).toBe(false);
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
    });

    // FIX ROUND 1 (Important #4, security review 2026-09-16): the JWT bearer
    // branch fully delegates to resolveTokenUserAccess() (since the original
    // C9/C10 fix), which — after this fix round — carries the SAME
    // `adminPinned ? isAdmin : undefined` tri-state the PAT test above
    // relies on. Confirms the pinned-attack-state invariant holds on this
    // producer too, not just PAT/impersonation.
    it('JWT bearer: owner has admin_pinned:true, is_admin:false + a stale admin group -> locals.user.isAdmin false', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'demoted-jwt-owner',
            clientId: 'tv-client',
            groups: ['admin-group'],
            deviceSessionId: 'dev-demoted',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '11111111-1111-1111-1111-111111111114',
            username: 'demoted-jwt-owner',
            is_admin: false,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admin-group'], // stale IdP group — pin must override it
            disabled_at: null,
            deleted_at: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
        expect(event.locals.principal?.isAdmin).toBe(false);
    });

    // FIX ROUND 3 (security review 2026-09-16): this test already drove the
    // impersonation branch's REAL admin computation before this round — the
    // gap round 3 closed was that the branch computed it via its OWN inline
    // ternary rather than the shared computeOwnerIsAdminOverride()
    // (resolve-owner-admin-status.ts), so no test anywhere would have
    // FAILED if the two copies diverged. Now that the branch calls the
    // shared function directly, this test is what proves the pinned-attack-
    // state invariant holds on the impersonation path specifically — not a
    // guard on two functions the branch never calls.
    it('service token IMPERSONATING a pin-demoted user with a stale admin group -> principal.isAdmin false', async () => {
        // This permission test needs a healthy dependency, not an outage fallback.
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockImpersonationRow.username = 'demoted-target';
        mockImpersonationRow.groups = ['admin-group']; // stale IdP group
        mockImpersonationRow.disabled_at = null;
        mockImpersonationRow.is_admin = false;
        mockImpersonationRow.admin_pinned = true;

        mockSvcValidate.mockResolvedValue({
            id: 14,
            name: 'grafana-demoted-target',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: '55555555-5555-5555-5555-555555555555',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin'],
            tokenPrefix: 'svc_imp_demoted',
            isAdmin: true,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_imp_demotedxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('service_token');
        expect(event.locals.principal?.isAdmin).toBe(false);
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
    });

    it('service token NOT impersonating, whose CREATOR is pin-demoted with a stale admin group -> principal.isAdmin false', async () => {
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: '66666666-6666-6666-6666-666666666666',
            username: 'demoted-creator',
            is_admin: false,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admin-group'], // stale IdP group — pin must override it
            disabled_at: null,
            deleted_at: null,
        });

        mockSvcValidate.mockResolvedValue({
            id: 15,
            name: 'ops-console-demoted-creator',
            createdBy: 'demoted-creator',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: null,
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin'],
            tokenPrefix: 'svc_creator_demoted',
            isAdmin: true,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_creator_demotedxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('service_token');
        expect(event.locals.principal?.isAdmin).toBe(false);
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
    });
});

// ── Important 1 (fix round 1, security review 2026-09-16 reviewer finding):
// an UNPINNED user whose only admin grant is the in-app `admin` capability
// (access-control.service.ts's mergeCapabilityRows, a first-class grant for
// standalone-multiuser installs — see countEffectiveAdmins guards at
// access-groups.queries.ts) must stay admin via their PAT, matching the
// native-session.ts behaviour EXACTLY: `row.admin_pinned ? { isAdminOverride:
// row.is_admin } : {}` — unpinned means NO override at all, so
// buildUserPermissions' own group-OR-extraCapabilities check decides. The
// naive fix (always supplying a groups-only isAdminOverride) would silently
// suppress this grant for every unpinned in-app-only admin's PAT while they
// remain admin in the browser — a hard lockout on every {kind:'admin'}
// /api/v1 def. ──────────────────────────────────────────────────────────

describe('resolveAuth /api/v1 — PAT owner unpinned, admin ONLY via in-app capability (Important 1)', () => {
    it('admin-scope PAT owned by an UNPINNED user whose only admin grant is the in-app capability -> principal.isAdmin true', async () => {
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: '77777777-7777-7777-7777-777777777777',
            username: 'in-app-admin',
            is_admin: false, // never pinned true — this column is meaningless while unpinned
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['regular-user'], // NOT an admin group
            disabled_at: null,
            deleted_at: null,
        });
        // The in-app access layer is the ONLY source of this user's admin-ness.
        mockResolveEffectiveAccess.mockResolvedValueOnce({
            inAppGroupNames: ['in-app-admins'],
            effectiveGroups: ['regular-user', 'in-app-admins'],
            capabilities: { ownerIsAdmin: true },
        });
        mockPatValidate.mockResolvedValue({
            id: 16,
            userId: '77777777-7777-7777-7777-777777777777',
            username: 'in-app-admin',
            name: 'in-app-admin-pat',
            scopes: ['admin'],
            groups: ['regular-user'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_inappadmin',
            allowedIps: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer pat_inappadmin123',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(event.locals.principal?.isAdmin).toBe(true);
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
    });
});

// ── M11: service_token forceNonAdmin forwarded to deriveIsAdmin ─────────────

describe('resolveAuth /api/v1 — service token: forceNonAdmin forwarded (M11)', () => {
    it('forceNonAdmin=true with admin scope -> principal.isAdmin false (kill-switch forwarded)', async () => {
        mockSvcValidate.mockResolvedValue({
            id: 1,
            name: 'monitor',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: null,
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: true,
            scopes: ['admin'],
            tokenPrefix: 'svc_abc',
            isAdmin: true,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer svc_abc123' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('service_token');
        expect(event.locals.principal?.isAdmin).toBe(false);
        // C2: the kill-switch also strips the admin-class SCOPES, otherwise every
        // `{kind:'scope', anyOf:['users:admin']}` def still opens via the alias.
        // X2 (security review 2026-09-23 final wave): the raw ['admin'] scope
        // is now stripped BEFORE expansion, so nothing survives — the old
        // "read/write survive" behaviour came from expanding 'admin' FIRST,
        // which also let tasks:run/webhooks:write/users:read/metrics:read
        // survive the narrower area-scope strip. See principal.test.ts.
        const scopes = event.locals.principal?.scopes ?? [];
        expect(scopes).not.toContain('admin');
        expect(scopes.filter((s) => s.endsWith(':admin'))).toEqual([]);
        expect(scopes).toEqual([]);
    });

    it('forceNonAdmin=false with admin scope, creator CURRENTLY pin-aware admin -> principal.isAdmin true', async () => {
        // C3 (security review 2026-09-15): a non-impersonating admin-scoped
        // token now also requires the creator to be CURRENTLY (pin-aware)
        // admin, not just scope+forceNonAdmin — see resolveOwnerIsAdminOverride.
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: '00000000-0000-0000-0000-0000000000ad',
            username: 'admin-owner',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockSvcValidate.mockResolvedValue({
            id: 2,
            name: 'ci-bot',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: null,
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin'],
            tokenPrefix: 'svc_def',
            isAdmin: true,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer svc_def456' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('service_token');
        expect(event.locals.principal?.isAdmin).toBe(true);
    });
});

// ── M13: stream token — tightly scoped at the principal layer, real DB perms at the user-context layer (C4) ──

describe('resolveAuth /api/v1 — stream token: tightly scoped, never admin at the principal layer (M13)', () => {
    it('yields real DB-derived groups, principal.kind=stream_token, principal never admin', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000aa',
            username: 'carol',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['family'],
            disabled_at: null,
            deleted_at: null,
        });
        mockStreamValidate.mockResolvedValue({
            id: 'sess-1',
            username: 'carol',
            userId: 'jellyfin-user-uuid',
            deviceSessionId: null,
            mediaItemId: 'item123',
            isWildcard: false,
            clientIp: '127.0.0.1',
            createdAt: new Date(),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        });

        const event = makeApiV1Event({
            path: '/api/v1/playback/item123/hls.m3u8',
            streamToken: 'stream_abc123',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
        expect(event.locals.user?.maxAgeRating).toBeNull();
        // Real DB-derived groups (was hardcoded [] before the C4 fix).
        expect(event.locals.user?.userGroups).toEqual(['family']);
        expect(event.locals.principal?.kind).toBe('stream_token');
        // The principal (route-authorization) layer is independently never
        // admin regardless of the UserContext — see principal.test.ts's
        // "stream_token is never admin" coverage — so even a real admin's own
        // stream token can't authorize an /api/v1 admin-scoped call.
        expect(event.locals.principal?.isAdmin).toBe(false);
    });

    // C4: a wildcard stream session (the music surface's radio/library token)
    // for a user whose age cap is pinned in the DB must carry the real
    // maxAgeRating/isAgeRestricted, not the old hardcoded
    // isAgeRestricted:false — otherwise media-access.ts's age gate
    // (`if (!user.isAgeRestricted) return true;`) never runs and an
    // age-13-capped account can stream 18-rated content via its wildcard
    // token for as long as heartbeats keep renewing the session.
    it('an item-bound music grant for a user with max_age_rating=13 yields isAgeRestricted:true, maxAgeRating:13', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000ab',
            username: 'kid-account',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: 13,
            age_rating_pinned: true,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockStreamValidate.mockResolvedValue({
            id: 'sess-2',
            username: 'kid-account',
            userId: 'jellyfin-user-uuid-2',
            deviceSessionId: null,
            mediaItemId: 'track123',
            isWildcard: false,
            clientIp: '127.0.0.1',
            createdAt: new Date(),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        });

        const event = makeApiV1Event({
            path: '/api/v1/music/tracks/track123/stream',
            streamToken: 'stream_track123',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.isAgeRestricted).toBe(true);
        expect(event.locals.user?.maxAgeRating).toBe(13);
    });

    it('a disabled account with a still-valid stream token is rejected (401), consistent with the JWT/PAT disabled-account gate', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000ac',
            username: 'carol',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: new Date(),
            deleted_at: null,
        });
        mockStreamValidate.mockResolvedValue({
            id: 'sess-3',
            username: 'carol',
            userId: 'jellyfin-user-uuid',
            deviceSessionId: null,
            mediaItemId: 'item123',
            isWildcard: false,
            clientIp: '127.0.0.1',
            createdAt: new Date(),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        });

        const event = makeApiV1Event({
            path: '/api/v1/playback/item123/hls.m3u8',
            streamToken: 'stream_abc123',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect(result?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
    });

    // Security review 2026-09-16, task 6 fix round 1, Important 2: this
    // producer tested `.disabled` but not `.deleted`, even though
    // resolveTokenUserAccess() (called just above) has resolved both through
    // the same seam since an earlier commit this round — a soft-deleted
    // account's music/HLS stream token stayed valid for as long as heartbeats
    // kept renewing the session. RED before the `|| streamAccess.deleted`
    // fix: this test got a 200 instead of a 401.
    it('a soft-deleted account with a still-valid stream token is rejected (401)', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000ad',
            username: 'carol',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: new Date(),
        });
        mockStreamValidate.mockResolvedValue({
            id: 'sess-4',
            username: 'carol',
            userId: 'jellyfin-user-uuid',
            deviceSessionId: null,
            mediaItemId: 'item123',
            isWildcard: false,
            clientIp: '127.0.0.1',
            createdAt: new Date(),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        });

        const event = makeApiV1Event({
            path: '/api/v1/playback/item123/hls.m3u8',
            streamToken: 'stream_abc123',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect(result?.status).toBe(401);
        expect(event.locals.user).toBeUndefined();
    });
});

// ── M15: service-token impersonation + forceNonAdmin ────────────────────────

describe('resolveAuth /api/v1 — service token impersonation + forceNonAdmin (M15)', () => {
    it('forceNonAdmin=true impersonating an admin-group user strips elevated traits', async () => {
        // This permission test needs a healthy dependency, not an outage fallback.
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockImpersonationRow.username = 'targetadmin';
        mockImpersonationRow.groups = ['admin-group'];

        mockSvcValidate.mockResolvedValue({
            id: 3,
            name: 'grafana',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: '22222222-2222-2222-2222-222222222222',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: true,
            scopes: ['admin'],
            tokenPrefix: 'svc_imp1',
            isAdmin: true,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer svc_imp1xyz' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
        expect(event.locals.user?.isModerator).toBe(false);
        expect(event.locals.user?.hasRequestPermission).toBe(false);
        expect(event.locals.user?.liveTvPriority).toBe('low');
        expect(event.locals.principal?.isAdmin).toBe(false);
    });

    it('forceNonAdmin=false with admin scope impersonating an admin-group user retains admin', async () => {
        // This permission test needs a healthy dependency, not an outage fallback.
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockImpersonationRow.username = 'targetadmin2';
        mockImpersonationRow.groups = ['admin-group'];

        mockSvcValidate.mockResolvedValue({
            id: 4,
            name: 'ops-console',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: '33333333-3333-3333-3333-333333333333',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin'],
            tokenPrefix: 'svc_imp2',
            isAdmin: true,
        });

        const event = makeApiV1Event({ path: '/api/v1/media', authHeader: 'Bearer svc_imp2xyz' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
        expect(event.locals.principal?.isAdmin).toBe(true);
    });
});

// ── C10 (security review 2026-09-15/16): the impersonation TARGET's
// age-rating pin was never applied at all — the branch built `userContext`
// from `buildUserPermissions(svcAccess.effectiveGroups, {...})` alone, with
// no max_age_rating/age_rating_pinned input. It now applies
// computeOwnerMaxAge() directly on the SAME row this branch already fetches
// by id (never resolveTokenUserAccess() itself, which is username-keyed and
// cached — this branch has an explicit always-fresh-no-cache contract).

describe('resolveAuth /api/v1 — service token impersonation: the age-rating pin now applies (C10)', () => {
    it('a pinned impersonation target (age_rating_pinned=true, max_age_rating=6, no age group) yields isAgeRestricted:true, maxAgeRating:6', async () => {
        // This permission test needs a healthy dependency, not an outage fallback.
        vi.mocked(aiDbService.getSql).mockResolvedValue({} as never);
        mockImpersonationRow.username = 'kid-target';
        mockImpersonationRow.groups = [];
        mockImpersonationRow.max_age_rating = 6;
        mockImpersonationRow.age_rating_pinned = true;

        mockSvcValidate.mockResolvedValue({
            id: 10,
            name: 'grafana',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: '66666666-6666-6666-6666-666666666666',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['read'],
            tokenPrefix: 'svc_imp_kid',
            isAdmin: false,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_imp_kidxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.isAgeRestricted).toBe(true);
        expect(event.locals.user?.maxAgeRating).toBe(6);
    });
});

// ── C2: disabled_at must be honoured by every token→user resolution path ───
//
// SECURITY (C9/C10, security review 2026-09-15/16): the JWT branch now
// delegates to resolveTokenUserAccess() (which reads `users.disabled_at` via
// getUserByUsername, cache-first) instead of the bare isUsernameDisabled()
// helper (getCachedDisabled + a standalone raw SQL query) it used before —
// see forward-auth.ts's handlePublicApiAuth JWT branch. The disabled
// signal now comes from `mockGetUserByUsername`'s `disabled_at` field, not
// `mockGetCachedDisabled`/`mockSqlQuery` (this file's cache mocks keep
// getCachedIsAdmin/getCachedGroups permanently cold, so resolveTokenUserAccess
// always re-reads the row fresh regardless of getCachedDisabled).
describe('resolveAuth /api/v1 — JWT bearer: disabled account rejected (C2)', () => {
    it('rejects a valid, unexpired JWT for a disabled account', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'eve',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-1',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000ee',
            username: 'eve',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: new Date(),
            deleted_at: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result!.status).toBe(401);
        const body = await result!.json();
        expect(body.code).toBe('invalid_token');
    });

    // Security review 2026-09-16, task 6 fix round 1, Important 2: the OAuth
    // device-flow JWT path (the TV client surface) tested `.disabled` but
    // not `.deleted`, even though resolveTokenUserAccess() (called just
    // above in forward-auth.ts) resolves both through the same seam. RED
    // before the `|| tokenAccess.deleted` fix: a soft-deleted account's TV
    // client kept a valid session.
    it('rejects a valid, unexpired JWT for a soft-deleted account', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'frank',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-5',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000ff',
            username: 'frank',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: new Date(),
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result!.status).toBe(401);
        const body = await result!.json();
        expect(body.code).toBe('invalid_token');
    });

    it('allows a valid JWT for an active account (not disabled in the DB)', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'alice',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-2',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000a1',
            username: 'alice',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.username).toBe('alice');
    });

    it('rejects a valid JWT whose device session was revoked (logout / device revoke)', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'alice',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-revoked',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockCheckLiveness.mockResolvedValueOnce('revoked');

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(mockCheckLiveness).toHaveBeenCalledWith('dev-revoked');
        expect(result).toBeDefined();
        expect(result!.status).toBe(401);
        const body = await result!.json();
        expect(body.code).toBe('invalid_token');
        expect(event.locals.user).toBeUndefined();
    });

    it('answers 503 + Retry-After (not 401, not rate-limited) when liveness is unknown', async () => {
        const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit.js');
        vi.mocked(checkRateLimit).mockClear();
        mockVerifyAccessToken.mockResolvedValue({
            username: 'alice',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-unknown',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockCheckLiveness.mockResolvedValueOnce('unknown');

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result!.status).toBe(503);
        expect(result!.headers.get('Retry-After')).toBe('5');
        expect(((await result!.json()) as { code: string }).code).toBe('dependency_unavailable');
        expect(checkRateLimit).not.toHaveBeenCalled();
        expect(event.locals.user).toBeUndefined();
    });

    it('a revoked session counts as a failed auth attempt (rate limiter consulted)', async () => {
        const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit.js');
        vi.mocked(checkRateLimit).mockClear();
        mockVerifyAccessToken.mockResolvedValue({
            username: 'alice',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-revoked-2',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockCheckLiveness.mockResolvedValueOnce('revoked');

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result!.status).toBe(401);
        expect(checkRateLimit).toHaveBeenCalled();
    });

    it('does not consult device-session liveness for a JWT without a device_session_id claim', async () => {
        mockCheckLiveness.mockClear();
        mockVerifyAccessToken.mockResolvedValue({
            username: 'alice',
            clientId: 'tv-client',
            groups: [],
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000a1',
            username: 'alice',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(mockCheckLiveness).not.toHaveBeenCalled();
    });

    it('denies a disabled account resolved fresh from the DB (no users.id cache hit)', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'coldcache',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-3',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000cc',
            username: 'coldcache',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: new Date(),
            deleted_at: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result!.status).toBe(401);
    });

    // C9/C10: the JWT branch never applied the admin's per-user age-rating pin
    // at all before this fix — it built the UserContext from a bare
    // `buildUserPermissions(jwtAccess.effectiveGroups, {...})` with no DB pin
    // input. Now it delegates to resolveTokenUserAccess(), the same resolver
    // the /j and stream-token paths use for the age axis.
    it('a pinned user (age_rating_pinned=true, max_age_rating=6, no age group) yields isAgeRestricted:true, maxAgeRating:6', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            username: 'kid-jwt',
            clientId: 'tv-client',
            groups: [],
            deviceSessionId: 'dev-4',
            issuedAt: 0,
            expiresAt: 0,
        });
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000c1',
            username: 'kid-jwt',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: 6,
            age_rating_pinned: true,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer some.jwt.value',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user?.isAgeRestricted).toBe(true);
        expect(event.locals.user?.maxAgeRating).toBe(6);
    });
});

describe('resolveAuth /api/v1 — service token actAsUser: disabled impersonation target rejected (C2)', () => {
    it('denies impersonation when the target account is disabled', async () => {
        mockImpersonationRow.username = 'targetuser';
        mockImpersonationRow.groups = ['some-group'];
        mockImpersonationRow.disabled_at = new Date();

        mockSvcValidate.mockResolvedValue({
            id: 6,
            name: 'grafana',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: '44444444-4444-4444-4444-444444444444',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin'],
            tokenPrefix: 'svc_disabled',
            isAdmin: true,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_disabledxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result!.status).toBe(403);
        const body = await result!.json();
        expect(body.code).toBe('forbidden');
        expect(body.reason).toBe('invalid_impersonation');
    });
});

describe('resolveAuth /api/v1 — service token actAsUser: soft-deleted impersonation target rejected (C17)', () => {
    it('denies impersonation when the target account is soft-deleted (deleted_at set, disabled_at NULL)', async () => {
        mockImpersonationRow.username = 'targetuser';
        mockImpersonationRow.groups = ['some-group'];
        mockImpersonationRow.disabled_at = null;
        mockImpersonationRow.deleted_at = new Date();

        mockSvcValidate.mockResolvedValue({
            id: 17,
            name: 'grafana',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: '88888888-8888-8888-8888-888888888888',
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin'],
            tokenPrefix: 'svc_deleted',
            isAdmin: true,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_deletedxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeDefined();
        expect(result!.status).toBe(403);
        const body = await result!.json();
        expect(body.code).toBe('forbidden');
        expect(body.reason).toBe('invalid_impersonation');
    });
});

// API package 15: a disabled or deleted OWNER is rejected inside
// ServiceTokenService.validate(), by `owner_user_id` and fail closed
// (service-token.service.test.ts). The producer no longer consults the
// username-keyed disabled cache for the `created_by` label, so a disabled
// account that merely carries that username does not touch the token.
describe('resolveAuth /api/v1 — service token owner: matched by id, not the created_by username', () => {
    it('a disabled account holding the created_by username does not disable the token', async () => {
        mockGetCachedDisabled.mockReturnValue(true);

        mockSvcValidate.mockResolvedValue({
            id: 7,
            name: 'ops-console',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: null,
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['read'],
            tokenPrefix: 'svc_creatordisabled',
            isAdmin: false,
        });

        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_creatordisabledxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.principal?.userId).toBe('00000000-0000-0000-0000-0000000000ad');
        expect(mockGetCachedDisabled).not.toHaveBeenCalledWith('admin-owner');
    });

    it('a token that validate() rejected (owner disabled) is 401', async () => {
        mockSvcValidate.mockResolvedValue(null);
        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_ownerdisabledxyz',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result!.status).toBe(401);
    });
});

// ── L5: allowed_path_prefixes boundary matching ─────────────────────────────

describe('resolveAuth /api/v1 — service token allowed_path_prefixes boundary (L5)', () => {
    function svcTokenWithPrefixes(prefixes: string[] | null) {
        return {
            id: 5,
            name: 'scoped',
            createdBy: 'admin-owner',
            ownerUserId: '00000000-0000-0000-0000-0000000000ad',
            actAsUser: null,
            allowedIps: null,
            allowedPathPrefixes: prefixes,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['read'],
            tokenPrefix: 'svc_scoped',
            isAdmin: false,
        };
    }

    it('allows an EXACT match of the prefix', async () => {
        mockSvcValidate.mockResolvedValue(svcTokenWithPrefixes(['/api/v1/admin']));
        const event = makeApiV1Event({ path: '/api/v1/admin', authHeader: 'Bearer svc_exact' });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();
    });

    it('allows a CHILD path under prefix + "/"', async () => {
        mockSvcValidate.mockResolvedValue(svcTokenWithPrefixes(['/api/v1/admin']));
        const event = makeApiV1Event({
            path: '/api/v1/admin/users',
            authHeader: 'Bearer svc_child',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();
    });

    it('rejects a SIBLING path that merely string-prefix-matches (not a path-component boundary)', async () => {
        mockSvcValidate.mockResolvedValue(svcTokenWithPrefixes(['/api/v1/ad']));
        const event = makeApiV1Event({
            path: '/api/v1/admin/users',
            authHeader: 'Bearer svc_sibling',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).not.toBeUndefined();
        expect(result!.status).toBe(403);
    });
});

// ── Push rich-notification pair: the ?sig= HMAC is the only credential ──────
//
// Regression: both endpoints shipped `auth: 'public'`, which only makes
// mount()'s enforce() a no-op — the bearer check in handlePublicApiAuth still
// answered `401 Bearer token required`, so an iOS Notification Service
// Extension (which holds no usable token, the entire reason the URL is signed)
// could never reach the route and its verifySignedUrl never ran. Live prod
// returned the same 401 for a deliberately WRONG signature, proving the check
// was dead code.
//
// These cases assert the MIDDLEWARE decision only — that resolveAuth stops
// gating and hands off. That it hands off to a route which then rejects an
// unsigned caller is pinned in forward-auth-push-rich-signed.test.ts, which
// drives both layers together.

const PUSH_UUID = '8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';

describe('resolveAuth /api/v1 — push rich-notification pair falls through to in-route ?sig=', () => {
    it('lets an UNSIGNED push-image request through (the route is the gate, not this)', async () => {
        const event = makeApiV1Event({
            path: `/api/v1/notifications/${PUSH_UUID}/push-image`,
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();
        // No identity was invented on the way through.
        expect(event.locals.user).toBeUndefined();
    });

    it('lets an UNSIGNED push-content request through, for every mintable locale', async () => {
        for (const locale of ['en', 'de']) {
            const event = makeApiV1Event({
                path: `/api/v1/notifications/${PUSH_UUID}/push-content/${locale}`,
            });
            const result = await resolveAuth(event, noopMigration, true);
            expect(result).toBeUndefined();
            expect(event.locals.user).toBeUndefined();
        }
    });

    it('lets a request carrying a signature through without validating it here', async () => {
        // The middleware must not become a second signature authority — it only
        // steps aside. Verification (and the 403) belongs to the route.
        const event = makeApiV1Event({
            path: `/api/v1/notifications/${PUSH_UUID}/push-image?expires=9999999999&purpose=push-image&sig=deadbeef`,
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();
    });
});

describe('resolveAuth /api/v1 — push exemption is exact; near misses still need a bearer', () => {
    async function expectBearerRequired(path: string): Promise<void> {
        const event = makeApiV1Event({ path });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result, `${path} must not be exempted`).not.toBeUndefined();
        expect(result!.status).toBe(401);
        const body = (await result!.json()) as { error: string };
        expect(body.error).toBe('Bearer token required');
    }

    it('still gates the rest of /api/v1/notifications/ (no bare-prefix exemption)', async () => {
        await expectBearerRequired('/api/v1/notifications');
        await expectBearerRequired(`/api/v1/notifications/${PUSH_UUID}`);
        await expectBearerRequired(`/api/v1/notifications/${PUSH_UUID}/read`);
        await expectBearerRequired('/api/v1/notifications/preferences');
    });

    it('still gates a path that merely CONTAINS an exempt segment', async () => {
        await expectBearerRequired('/api/v1/notifications/push-image');
        await expectBearerRequired('/api/v1/notifications/push-image/settings');
        await expectBearerRequired(`/api/v1/notifications/${PUSH_UUID}/push-image/raw`);
    });

    it('still gates a non-UUID id and an unknown locale', async () => {
        await expectBearerRequired('/api/v1/notifications/me/push-image');
        await expectBearerRequired(`/api/v1/notifications/${PUSH_UUID}/push-content/fr`);
        await expectBearerRequired(`/api/v1/notifications/${PUSH_UUID}/push-content`);
    });

    it('leaves an unrelated /api/v1 path unchanged — still 401 without a bearer', async () => {
        await expectBearerRequired('/api/v1/music/albums');
        await expectBearerRequired('/api/v1/media');
    });
});

// ---------------------------------------------------------------------------
// L3 — investigated, not reproducible: skipped, no test added.
//
// The reported "stream_token principal loop" was not reproducible on recon of
// the stream-token path (handleStreamToken -> buildPrincipal, a single
// straight-line call with no recursion/retry). M13 above exercises that exact
// path and observes a single, terminating buildPrincipal() call. Marking as
// skipped per instructions rather than inventing a regression test for an
// unreproduced report.
// ---------------------------------------------------------------------------

describe('admin-owned stream token media capability', () => {
    it('restores a scoped stream token underlying age pin while preserving owner identity', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000aa',
            username: 'admin-stream-owner',
            groups: ['admin-group'],
            is_admin: true,
            admin_pinned: true,
            max_age_rating: 8,
            age_rating_pinned: true,
            disabled_at: null,
            deleted_at: null,
        });
        mockStreamValidate.mockResolvedValue({
            id: 'admin-stream',
            username: 'admin-stream-owner',
            userId: 'jellyfin-user',
            deviceSessionId: null,
            mediaItemId: 'item123',
            isWildcard: false,
            clientIp: '127.0.0.1',
            createdAt: new Date(),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + 60000),
        });
        const event = makeApiV1Event({
            path: '/api/v1/playback/item123/hls.m3u8',
            streamToken: 'stream_admin',
        });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(true);
        expect(event.locals.principal?.isAdmin).toBe(false);
        expect(event.locals.user?.mediaAccessIsAdmin).toBe(false);
        expect(event.locals.user?.maxAgeRating).toBe(8);
        expect(event.locals.user?.isAgeRestricted).toBe(true);
    });
});

describe('resolveAuth server bootstrap through real public API auth', () => {
    function validPat(): void {
        mockPatValidate.mockResolvedValue({
            id: 1,
            userId: '00000000-0000-0000-0000-0000000000aa',
            username: 'carol',
            name: 'test',
            scopes: ['read'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'pat_valid',
            allowedIps: null,
        });
    }
    it.each([undefined, 'Basic ignored', 'Bearer garbage'])(
        '%s resolves anonymously without a 401',
        async (authHeader) => {
            mockVerifyAccessToken.mockResolvedValue(null);
            const event = makeApiV1Event({ path: '/api/v1/server', authHeader });
            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.principal).toBeUndefined();
            expect(event.locals.user).toBeUndefined();
        },
    );
    it.each(['GET', 'HEAD'])('valid mixed-case PAT bearer authenticates %s', async (method) => {
        validPat();
        const event = makeApiV1Event({ path: '/api/v1/server', authHeader: 'bEaReR pat_valid' });
        event.request = new Request(event.url, { method, headers: event.request.headers });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(event.locals.principal?.userId).toBe('00000000-0000-0000-0000-0000000000aa');
        const { buildServerInfo } = await import('$lib/server/api/defs/server/index.js');
        expect((await buildServerInfo(event, 'v1')).caller?.id).toBe(
            event.locals.principal?.userId,
        );
    });
    it.each(['api_key', 'stream_token', 'grant'])(
        'ignores valid query %s without changing the event',
        async (key) => {
            validPat();
            mockStreamValidate.mockResolvedValue({
                username: 'carol',
                userId: 'user',
                id: 'stream-id',
            });
            const event = makeApiV1Event({ path: '/api/v1/server' });
            event.url.searchParams.set(key, key === 'api_key' ? 'pat_valid' : 'stream_valid');
            event.request = new Request(event.url);
            const originalUrl = event.url.href;
            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.principal).toBeUndefined();
            expect(mockPatValidate).not.toHaveBeenCalled();
            expect(mockStreamValidate).not.toHaveBeenCalled();
            expect(event.url.href).toBe(originalUrl);
            expect(event.request.url).toBe(originalUrl);
        },
    );
    it('valid bearer wins over a valid stream query credential', async () => {
        validPat();
        const event = makeApiV1Event({
            path: '/api/v1/server',
            authHeader: 'Bearer pat_valid',
            streamToken: 'stream_valid',
        });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('pat');
        expect(mockStreamValidate).not.toHaveBeenCalled();
        expect(event.url.searchParams.get('grant')).toBe('stream_valid');
    });
});

describe('preview grant HTTP scope on both surfaces', () => {
    it.each(['/api', '/api/v1'])(
        'uses the existing wrong-scope problem for full-item delivery on %s',
        async (prefix) => {
            mockStreamValidate.mockResolvedValue({
                reason: 'wrong_scope',
                grantId: 'preview-grant',
            });
            for (const path of [
                '/playback/item/file',
                '/playback/item/stream',
                '/Videos/item/stream',
                '/media/item/download',
            ]) {
                const event = makeApiV1Event({
                    path: `${prefix}${path}?PlaySessionId=preview-bound`,
                    streamToken: 'stream_preview',
                });
                const result = await resolveAuth(event, noopMigration, true);
                expect(result).toBeInstanceOf(Response);
                expect(result!.status).toBe(403);
                expect(result!.headers.get('X-Playback-Grant-Reason')).toBe('wrong_scope');
                expect(await result!.json()).toMatchObject({ code: 'forbidden' });
            }
        },
    );
    it.each(['/api', '/api/v1'])(
        'accepts only the declared preview lifecycle methods on %s',
        async (prefix) => {
            // A revoked grant proves the method reached validation (wrong methods fail before it).
            mockStreamValidate.mockResolvedValue({ reason: 'revoked' });
            for (const [suffix, allowed] of [
                ['', 'DELETE'],
                ['/keepalive', 'POST'],
            ]) {
                for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
                    const event = makeApiV1Event({
                        path: `${prefix}/playback/previews/preview-bound${suffix}`,
                        method,
                        streamToken: 'stream_preview',
                    });
                    const result = await resolveAuth(event, noopMigration, true);
                    expect(result!.status).toBe(method === allowed ? 401 : 403);
                    expect(result!.headers.get('X-Playback-Grant-Reason')).toBe(
                        method === allowed ? 'revoked' : 'wrong_scope',
                    );
                }
            }
        },
    );
});

it('preserves Live TV on an authenticated synthetic service identity without looking up a fake account', async () => {
    mockLiveTvAllowed.mockResolvedValue(false);
    mockSvcValidate.mockResolvedValue({
        id: 1,
        name: 'monitor',
        createdBy: 'admin-owner',
        ownerUserId: '00000000-0000-0000-0000-0000000000ad',
        actAsUser: null,
        allowedIps: null,
        allowedPathPrefixes: null,
        allowedMethods: null,
        forceNonAdmin: false,
        scopes: ['read'],
        tokenPrefix: 'svc_live',
        isAdmin: false,
    });
    const request = makeApiV1Event({
        path: '/api/v1/livetv/stations',
        authHeader: 'Bearer svc_live123',
    });
    expect(await resolveAuth(request, noopMigration, true)).toBeUndefined();
    expect(request.locals.principal?.kind).toBe('service_token');
    expect(request.locals.user?.username).toBe('service:monitor');
    expect(request.locals.user?.hasLiveTvPermission).toBe(true);
    expect(mockLiveTvAllowed).not.toHaveBeenCalled();
});
