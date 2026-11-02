// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the shared `resolveBearerAdminPrincipal()` helper
 * (`$lib/server/auth/resolve-bearer-principal.ts`) — the ONE Bearer-only
 * admin-Principal resolver `mount.ts`'s `enforce()` {kind:'admin'} TERTIARY
 * fallback, `middleware/auth.ts`'s `requireAdmin()`, and `token-minting.ts`'s
 * `callerIsAdmin()` all consume.
 *
 * FIX (security review 5, fix-plan-5 Task 3): this helper now delegates its
 * credential validation and identity resolution to the shared
 * `$lib/server/auth/token-identity.ts` producer, the SAME one
 * `forward-auth.ts` (`/api/v1` PRIMARY) and `tasks/api-auth.ts`'s
 * `authenticate()` ({kind:'scope'} fallback) use. Per Global Constraint 2
 * ("test at the seam, not the nearest function"), this suite does NOT mock
 * `resolveOwnerAdminStatus`, `resolveTokenUserAccess`, or
 * `resolveOwnerIsAdminFailClosed` — those resolvers run for REAL. Only the
 * DB/cache LEAVES underneath them are mocked (`getUserByUsername`, a raw
 * `Database.getSql()` tagged-template for the impersonation-target row,
 * `resolveEffectiveAccess`, the L1 admin/max-age caches, and Valkey), plus
 * the two credential-validation entry points (`pat.service.js` /
 * `service-token.service.js`) and `client-ip.js`'s `getClientIpStrict`.
 *
 * New cases (a)/(b)/(c) below are the task-3 brief's §9 RED-before-GREEN
 * evidence for C1 (impersonation judged by creator, not target), C2 (the
 * path/method envelope was never enforced on this fallback), and the
 * regression guard for Task 1's C6 fix (in-app admin capability / pinned-
 * demoted), all exercised through this real (unmocked-resolver) chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Credential validation boundary ──────────────────────────────────────────

const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: (...args: unknown[]) => mockPatValidate(...args) }),
}));

const mockSvcValidate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: (...args: unknown[]) => mockSvcValidate(...args) }),
}));

// fix-plan-5 Task 3: RBP now calls getClientIpStrict (IP-outage fix) —
// export it from the mock factory, not just getClientIp, or RBP throws
// inside its own try/catch and fails closed to null for the WRONG reason
// (research-shape-a.md §Q1's mock-factory trap).
vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIp: () => '127.0.0.1',
    getClientIpStrict: () => '127.0.0.1',
}));

const logError = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: logError, info: vi.fn(), debug: vi.fn() }) },
}));

// Mutable so a couple of tests can flip `deviceAuth` (fix-plan-5 Task 4 review,
// fix round 1, Important 2: resolveBearerAdminPrincipal() now short-circuits
// to null when this is false) without a second vi.mock factory. Defaults to
// `true` — every OTHER test in this file predates that gate and asserts on
// the underlying resolution logic, not this flag; an incomplete mock here
// (missing `features` altogether, as this file had before this fix) makes
// EVERY one of those tests fail for the WRONG reason (research-shape-a.md's
// mock-factory trap, called out explicitly in the review).
const mockFeatures = vi.hoisted(() => ({ deviceAuth: true }));

vi.mock('$lib/server/config.js', () => ({
    config: {
        ADMIN_GROUPS: ['admin-group'],
        AGE_RATING_GROUP_PREFIX: 'age-',
        WATCH_PERMISSION_GROUPS: [],
        LIVETV_GROUPS: [],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
        ARR_MANAGER_GROUPS: [],
    },
    features: mockFeatures,
}));

// ── DB/cache leaves — real resolveOwnerAdminStatus / resolveTokenUserAccess /
// resolveOwnerIsAdminFailClosed run on top of these ─────────────────────────

interface UserRow {
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

const userRows = new Map<string, UserRow>();
function setUserRow(row: UserRow): void {
    userRows.set(row.username.toLowerCase(), row);
}

const mockGetUserByUsername = vi.fn(async (_sql: unknown, username: string) => {
    return userRows.get(username.toLowerCase()) ?? null;
});
const mockGetUserById = vi.fn(async (_sql: unknown, id: string) => {
    return [...userRows.values()].find((r) => r.id === id) ?? null;
});
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: [unknown, string]) => mockGetUserByUsername(...args),
    getUserById: (...args: [unknown, string]) => mockGetUserById(...args),
}));

// L1 admin/max-age caches: real per-username maps (cleared each test) so
// resolveTokenUserAccess's resolveRow() genuinely exercises its cold-cache DB
// path every time, matching resolve-token-user-access.test.ts's convention.
// NOTE: `MAX_AGE_MISS` is a Symbol created INLINE inside the vi.mock factory
// below (not hoisted to a top-level const) — vi.mock calls are hoisted above
// every other top-level statement in this file, including `import`, so a
// module-scope `const` referenced from inside the factory would throw
// "Cannot access before initialization" the moment anything (transitively,
// via resolve-bearer-principal.js -> token-identity.js ->
// resolve-token-user-access.js) imports this mocked module.
const adminCache = new Map<string, boolean>();
const adminPinnedCache = new Map<string, boolean>();
const maxAgeCache = new Map<string, number | null>();
const disabledCache = new Map<string, boolean>();
const deletedCache = new Map<string, boolean>();
const userIdCache = new Map<string, string>();
const groupsCache = new Map<string, string[]>();
function clearAllCaches(): void {
    adminCache.clear();
    adminPinnedCache.clear();
    maxAgeCache.clear();
    disabledCache.clear();
    deletedCache.clear();
    userIdCache.clear();
    groupsCache.clear();
}
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: (u: string) => (adminCache.has(u) ? (adminCache.get(u) ?? false) : null),
    setCachedIsAdmin: (u: string, v: boolean) => {
        adminCache.set(u, v);
    },
    getCachedAdminPinned: (u: string) =>
        adminPinnedCache.has(u) ? (adminPinnedCache.get(u) ?? false) : null,
    setCachedAdminPinned: (u: string, v: boolean) => {
        adminPinnedCache.set(u, v);
    },
    getCachedDisabled: (u: string) =>
        disabledCache.has(u) ? (disabledCache.get(u) ?? false) : null,
    setCachedDisabled: (u: string, v: boolean) => {
        disabledCache.set(u, v);
    },
    getCachedDeleted: (u: string) => (deletedCache.has(u) ? (deletedCache.get(u) ?? false) : null),
    setCachedDeleted: (u: string, v: boolean) => {
        deletedCache.set(u, v);
    },
    getCachedUserId: (u: string) => userIdCache.get(u) ?? null,
    setCachedUserId: (u: string, v: string) => {
        userIdCache.set(u, v);
    },
    getCachedGroups: (u: string) => groupsCache.get(u) ?? null,
    setCachedGroups: (u: string, v: string[]) => {
        groupsCache.set(u, v);
    },
    invalidateUserAdminCache: (u: string) => {
        adminCache.delete(u);
        adminPinnedCache.delete(u);
        disabledCache.delete(u);
        deletedCache.delete(u);
        userIdCache.delete(u);
        groupsCache.delete(u);
    },
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => {
    const MAX_AGE_MISS_SENTINEL = Symbol('max-age-miss');
    return {
        MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
        getCachedMaxAge: (u: string) =>
            maxAgeCache.has(u) ? maxAgeCache.get(u) : MAX_AGE_MISS_SENTINEL,
        setCachedMaxAge: (u: string, v: number | null) => {
            maxAgeCache.set(u, v);
        },
        invalidateUserMaxAgeCache: (u: string) => {
            maxAgeCache.delete(u);
        },
    };
});

// In-app access layer: passthrough by default (no in-app groups/capabilities)
// — case (c) below overrides this to exercise the C6 in-app-admin path.
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

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));

// Service-token impersonation reads the target row via a direct
// `new Database().getSql()` raw query (research §Q1: kept FA's id-keyed
// fresh query) — a tagged-template function, not `getUserByUsername`.
interface ImpersonationRow {
    username: string;
    groups: string[] | null;
    disabled_at: Date | null;
    deleted_at: Date | null;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
}
let impersonationRows: ImpersonationRow[] = [];
const mockSqlQuery = vi.fn(async () => impersonationRows);
vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): typeof mockSqlQuery {
            return mockSqlQuery;
        }
    }
    return { Database: MockDatabase, getAdminDb: () => ({}) };
});

vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    isCoordinationValkeyReady: vi.fn(() => false),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
}));

const mockResolveUserIdByUsername = vi.fn(async (username: string) => {
    const row = userRows.get(username.toLowerCase());
    return row ? toUserId(row.id) : null;
});
vi.mock('$lib/server/auth/resolve-user-id.js', () => ({
    resolveUserIdByUsername: (...args: [string]) => mockResolveUserIdByUsername(...args),
}));

const reportBuilder = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/debug-report/build.js', () => ({ buildDebugReport: reportBuilder }));

import { resolveBearerAdminPrincipal } from './resolve-bearer-principal.js';

function makeEvent(opts: {
    authHeader?: string;
    method?: string;
    pathname?: string;
}): RequestEvent {
    const pathname = opts.pathname ?? '/api/admin/test';
    const url = new URL(`http://localhost${pathname}`);
    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);
    return {
        request: new Request(url, { method: opts.method ?? 'GET', headers }),
        url,
        getClientAddress: () => '127.0.0.1',
    } as unknown as RequestEvent;
}

/** `true` iff the resolved Principal (if any) is an admin. */
async function isAdmin(event: RequestEvent): Promise<boolean> {
    return (await resolveBearerAdminPrincipal(event))?.isAdmin === true;
}

beforeEach(() => {
    mockFeatures.deviceAuth = true;
    mockPatValidate.mockReset();
    mockSvcValidate.mockReset();
    userRows.clear();
    clearAllCaches();
    impersonationRows = [];
    mockResolveEffectiveAccess
        .mockReset()
        .mockImplementation(
            async (_sql: unknown, _userId: string, syncedGroups: readonly string[]) => ({
                inAppGroupNames: [] as string[],
                effectiveGroups: [...syncedGroups],
                capabilities: {} as Record<string, unknown>,
            }),
        );
});

describe('resolveBearerAdminPrincipal', () => {
    it('returns null with no Authorization header', async () => {
        expect(await resolveBearerAdminPrincipal(makeEvent({}))).toBeNull();
    });

    it('returns null for a malformed Bearer header', async () => {
        expect(
            await resolveBearerAdminPrincipal(makeEvent({ authHeader: 'NotBearer xyz' })),
        ).toBeNull();
    });

    // Fix-plan-5 Task 4 review, fix round 1, Important 2: this is the ONE
    // shared function every caller (mount.ts TERTIARY, requireAdmin(),
    // callerIsAdmin()) consumes, so gating it here closes the gap for all
    // three regardless of how each individual call site is wired.
    describe('features.deviceAuth gate', () => {
        it('returns null immediately when the flag is off, even for a would-be-admin token — never reaches validate()', async () => {
            mockFeatures.deviceAuth = false;
            setUserRow({
                id: '22222222-2222-4222-8222-222222222222',
                username: 'admin-user',
                is_admin: true,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: ['admin-group'],
                disabled_at: null,
                deleted_at: null,
            });
            mockPatValidate.mockResolvedValue({
                scopes: ['admin'],
                username: 'admin-user',
                userId: '22222222-2222-4222-8222-222222222222',
            });

            expect(
                await resolveBearerAdminPrincipal(makeEvent({ authHeader: 'Bearer pat_x' })),
            ).toBeNull();
            // Short-circuits BEFORE any credential validation — same fail-fast
            // shape as the no-header / malformed-header cases above.
            expect(mockPatValidate).not.toHaveBeenCalled();
        });

        it('resolves normally when the flag is on (unchanged behaviour)', async () => {
            mockFeatures.deviceAuth = true;
            setUserRow({
                id: '33333333-3333-4333-8333-333333333333',
                username: 'admin-user-2',
                is_admin: true,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: ['admin-group'],
                disabled_at: null,
                deleted_at: null,
            });
            mockPatValidate.mockResolvedValue({
                scopes: ['admin'],
                username: 'admin-user-2',
                userId: '33333333-3333-4333-8333-333333333333',
            });

            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_x' }))).toBe(true);
        });
    });

    describe('pat_ branch', () => {
        it('resolves no Principal when the token does not validate', async () => {
            mockPatValidate.mockResolvedValue(null);
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_x' }))).toBe(false);
        });

        it('is not admin without admin-class scope, even if owner is admin', async () => {
            setUserRow({
                id: '00000000-0000-4000-8000-00000000a001',
                username: 'alice',
                is_admin: true,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: [],
                disabled_at: null,
                deleted_at: null,
            });
            mockPatValidate.mockResolvedValue({ scopes: ['read'], username: 'alice' });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_x' }))).toBe(false);
            // Item 15 short-circuit: no admin-class scope at all skips the
            // identity DB round trip entirely.
            expect(mockGetUserByUsername).not.toHaveBeenCalled();
        });

        it('is admin for a PINNED admin whose live groups are NOT an admin group', async () => {
            setUserRow({
                id: '11111111-1111-4111-8111-111111111111',
                username: 'pinned-admin',
                is_admin: true,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: ['regular-user'],
                disabled_at: null,
                deleted_at: null,
            });
            mockPatValidate.mockResolvedValue({
                scopes: ['admin'],
                username: 'pinned-admin',
                userId: '11111111-1111-4111-8111-111111111111',
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_pinned' }))).toBe(true);
        });

        it('is not admin when the owner is not currently admin', async () => {
            setUserRow({
                id: '22222222-2222-4222-8222-222222222222',
                username: 'demoted',
                is_admin: false,
                admin_pinned: false,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: [],
                disabled_at: null,
                deleted_at: null,
            });
            mockPatValidate.mockResolvedValue({
                scopes: ['admin'],
                username: 'demoted',
                userId: '22222222-2222-4222-8222-222222222222',
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_demoted' }))).toBe(false);
        });
    });

    describe('svc_ branch', () => {
        it('resolves no Principal when the token does not validate (e.g. disabled creator)', async () => {
            mockSvcValidate.mockResolvedValue(null);
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer svc_x' }))).toBe(false);
        });

        // Task 3 review, Important 4: this test was vacuous — 'someone' had
        // NO resolvable row, so `resolveUserIdByUsername('someone')` (called
        // UNCONDITIONALLY, before the admin check, in the non-impersonating
        // creator branch) already denied via "Token owner not provisioned"
        // before ever reaching `resolveOwnerIsAdminFailClosed`/
        // `getUserByUsername` — the assertion passed whether or not RBP's
        // OWN `forceNonAdmin` short-circuit existed. Give the creator a REAL,
        // resolvable row so the ONLY reason neither call fires is the
        // short-circuit itself, and assert `resolveUserIdByUsername`
        // (via `mockResolveUserIdByUsername`) never runs either — that IS the
        // proof the short-circuit fires in RBP, before `token-identity.ts`'s
        // resolveTokenIdentity (and thus its whole creator-resolution
        // sequence) is ever entered.
        it('forceNonAdmin short-circuits before the ownerIsAdmin lookup', async () => {
            setUserRow({
                id: '55555555-5555-4555-8555-555555555555',
                username: 'someone',
                is_admin: true,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: [],
                disabled_at: null,
                deleted_at: null,
            });
            mockSvcValidate.mockResolvedValue({
                forceNonAdmin: true,
                scopes: ['admin'],
                createdBy: 'someone',
                ownerUserId: '55555555-5555-4555-8555-555555555555',
                actAsUser: null,
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer svc_x' }))).toBe(false);
            expect(mockResolveUserIdByUsername).not.toHaveBeenCalled();
            expect(mockGetUserByUsername).not.toHaveBeenCalled();
            expect(mockGetUserById).not.toHaveBeenCalled();
        });

        it('is admin when the creator is currently admin', async () => {
            setUserRow({
                id: '33333333-3333-4333-8333-333333333333',
                username: 'current-admin',
                is_admin: true,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: [],
                disabled_at: null,
                deleted_at: null,
            });
            mockSvcValidate.mockResolvedValue({
                forceNonAdmin: false,
                scopes: ['admin'],
                createdBy: 'current-admin',
                ownerUserId: '33333333-3333-4333-8333-333333333333',
                actAsUser: null,
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer svc_x' }))).toBe(true);
        });

        it('is not admin when the creator has since been demoted', async () => {
            setUserRow({
                id: '44444444-4444-4444-8444-444444444444',
                username: 'demoted-admin',
                is_admin: false,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: ['regular-user'],
                disabled_at: null,
                deleted_at: null,
            });
            mockSvcValidate.mockResolvedValue({
                forceNonAdmin: false,
                scopes: ['admin'],
                createdBy: 'demoted-admin',
                ownerUserId: '44444444-4444-4444-8444-444444444444',
                actAsUser: null,
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer svc_x' }))).toBe(false);
        });
    });
});

// Item 2 (2026-09-13 deferred fix): its own admin-class-scope predicate
// (`'admin'` OR `'tasks:admin'`, matching principal.ts's `deriveIsAdmin()`)
// is the ONE canonical formula everywhere, consolidating a pre-existing
// drift: mount.ts's TERTIARY path already granted admin to a `tasks:admin`
// -scoped (no literal `'admin'`) token via `buildPrincipal()`, while the old
// `deriveIsAdminFromBearer()`'s hand-rolled `scopes.includes('admin')` check
// did not — the same credential got two different admin verdicts depending
// on which fallback a request happened to take.
describe('resolveBearerAdminPrincipal: consolidated formula (item 2)', () => {
    it("a PAT scoped only 'tasks:admin' (no literal 'admin') is admin, matching mount.ts's TERTIARY path", async () => {
        setUserRow({
            id: '88888888-8888-4888-8888-888888888888',
            username: 'ops-admin',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            scopes: ['tasks:admin'],
            username: 'ops-admin',
            userId: '88888888-8888-4888-8888-888888888888',
        });
        expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_opsadmin' }))).toBe(true);
    });

    it('a PAT with no admin-class scope at all resolves null without an owner lookup', async () => {
        mockPatValidate.mockResolvedValue({ scopes: ['read'], username: 'bob' });
        expect(
            await resolveBearerAdminPrincipal(makeEvent({ authHeader: 'Bearer pat_bob' })),
        ).toBeNull();
        expect(mockGetUserByUsername).not.toHaveBeenCalled();
    });

    // isAdminClassScope() (the item 15 short-circuit predicate) is BROADER
    // than deriveIsAdmin()'s own hasAdminScope check — it treats every
    // '<area>:admin' scope as "admin-class" (so the short-circuit can't
    // false-negative), not just 'admin'/'tasks:admin'. So a 'users:admin'
    // -only token does NOT skip the DB round trip (the short-circuit can't
    // prove it's non-admin), but still resolves to non-admin — the DB
    // verdict doesn't matter because deriveIsAdmin() never treats
    // 'users:admin' as admin-equivalent.
    it("a PAT scoped only 'users:admin' consults the owner (isAdminClassScope is broader) but is still not admin", async () => {
        setUserRow({
            id: '99999999-9999-4999-8999-999999999999',
            username: 'bob',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue({
            scopes: ['users:admin'],
            username: 'bob',
            userId: '99999999-9999-4999-8999-999999999999',
        });
        expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_bob' }))).toBe(false);
        expect(mockGetUserByUsername).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// fix-plan-5 Task 3 new cases (review §9 (a)/(b)/(c)) — RED before this
// task's fix, run with resolveOwnerAdminStatus / resolveTokenUserAccess
// UNMOCKED (see the module-level mocks above: only the DB/cache LEAVES are
// stubbed).
// ─────────────────────────────────────────────────────────────────────────
describe('fix-plan-5 Task 3: C1, C2, IP outage (unmocked resolvers)', () => {
    // (a) C1: an impersonating, admin-scoped service token whose TARGET is
    // NOT admin (creator still is) must be judged by the TARGET, not the
    // creator — null/non-admin here, and the Principal (built regardless of
    // isAdmin, since the token IS admin-class-scoped) carries the TARGET's
    // userId, never the creator's.
    it('(a) C1 — impersonating admin-scoped token: non-admin target, still-admin creator -> non-admin, Principal.userId is the TARGET', async () => {
        const targetId = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
        setUserRow({
            id: 'cccccccc-1111-4ccc-8ccc-cccccccccccc',
            username: 'still-admin',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        impersonationRows = [
            {
                username: 'target-user',
                groups: ['users'],
                disabled_at: null,
                deleted_at: null,
                is_admin: false,
                admin_pinned: false,
                max_age_rating: null,
                age_rating_pinned: false,
            },
        ];
        mockSvcValidate.mockResolvedValue({
            forceNonAdmin: false,
            scopes: ['admin'],
            createdBy: 'still-admin',
            ownerUserId: 'cccccccc-1111-4ccc-8ccc-cccccccccccc',
            actAsUser: targetId,
        });
        const principal = await resolveBearerAdminPrincipal(
            makeEvent({ authHeader: 'Bearer svc_impersonate' }),
        );
        expect(principal).not.toBeNull();
        expect(principal?.isAdmin).toBe(false);
        expect(principal?.userId).toBe(targetId);
        // The CREATOR's row must never even be consulted for THIS axis
        // (target-judged, not creator-judged) — the C1 bug's signature was
        // reading service_tokens.created_by instead of act_as_user.
        expect(mockGetUserByUsername).not.toHaveBeenCalledWith(expect.anything(), 'still-admin');
    });

    // (b) C2: a path/method-restricted service token must be denied on
    // /api/admin/* — every documented prefix is /api/v1/-only
    // (schemas/admin.ts), so ANY envelope on this plane denies.
    it('(b) C2 — path/method-restricted token on POST /api/admin/secrets/rotate -> null', async () => {
        setUserRow({
            id: '55555555-5555-4555-8555-555555555555',
            username: 'still-admin-2',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockSvcValidate.mockResolvedValue({
            forceNonAdmin: false,
            scopes: ['admin'],
            createdBy: 'still-admin-2',
            ownerUserId: '55555555-5555-4555-8555-555555555555',
            actAsUser: null,
            allowedPathPrefixes: ['/api/v1/metrics'],
            allowedMethods: ['GET'],
        });
        const principal = await resolveBearerAdminPrincipal(
            makeEvent({
                authHeader: 'Bearer svc_restricted',
                method: 'POST',
                pathname: '/api/admin/secrets/rotate',
            }),
        );
        expect(principal).toBeNull();
    });

    // (c) Task 1's C6 fix, re-verified through THIS fallback specifically:
    // an unpinned, non-admin-group PAT owner whose in-app group carries the
    // `admin` capability IS admin here; the SAME owner pinned-demoted is
    // NOT, even with the SAME in-app capability (the pin beats the OR).
    describe('(c) C6 guard — in-app admin capability, pin precedence', () => {
        it('unpinned, non-admin-group + in-app admin capability -> admin', async () => {
            setUserRow({
                id: '66666666-6666-4666-8666-666666666666',
                username: 'in-app-admin',
                is_admin: false,
                admin_pinned: false,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: ['users'],
                disabled_at: null,
                deleted_at: null,
            });
            mockResolveEffectiveAccess.mockResolvedValue({
                inAppGroupNames: ['ops'],
                effectiveGroups: ['users', 'ops'],
                capabilities: { ownerIsAdmin: true },
            });
            mockPatValidate.mockResolvedValue({
                scopes: ['admin'],
                username: 'in-app-admin',
                userId: '66666666-6666-4666-8666-666666666666',
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_inapp' }))).toBe(true);
        });

        it('pinned-demoted + the SAME in-app admin capability -> NOT admin (pin beats the OR)', async () => {
            setUserRow({
                id: '77777777-7777-4777-8777-777777777777',
                username: 'pinned-demoted',
                is_admin: false,
                admin_pinned: true,
                max_age_rating: null,
                age_rating_pinned: false,
                groups: ['users'],
                disabled_at: null,
                deleted_at: null,
            });
            mockResolveEffectiveAccess.mockResolvedValue({
                inAppGroupNames: ['ops'],
                effectiveGroups: ['users', 'ops'],
                capabilities: { ownerIsAdmin: true },
            });
            mockPatValidate.mockResolvedValue({
                scopes: ['admin'],
                username: 'pinned-demoted',
                userId: '77777777-7777-4777-8777-777777777777',
            });
            expect(await isAdmin(makeEvent({ authHeader: 'Bearer pat_pinneddemoted' }))).toBe(
                false,
            );
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// API package 15: the `integrations:read` grant and the owner by id, through
// the SAME shared producer (token-identity.ts) every plane uses.
// ─────────────────────────────────────────────────────────────────────────
describe('API package 15: integrations:read grant and owner by id', () => {
    const OWNER_ID = 'dddddddd-1111-4ddd-8ddd-dddddddddddd';
    const IMPOSTOR_ID = 'eeeeeeee-1111-4eee-8eee-eeeeeeeeeeee';
    const WATCH_HISTORY = '/api/v1/integrations/watch-history';

    function ownerRow(username: string, isAdmin: boolean, id = OWNER_ID): UserRow {
        return {
            id,
            username,
            is_admin: isAdmin,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        };
    }

    async function produce(validated: Record<string, unknown>, pathname: string) {
        const { validateBearerCredential, resolveTokenIdentity } =
            await import('./token-identity.js');
        mockSvcValidate.mockResolvedValue({
            id: 7,
            name: 'bot',
            tokenPrefix: 'svc_bot',
            forceNonAdmin: false,
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            ...validated,
        });
        const step1 = await validateBearerCredential('svc_bot', {
            clientIp: '127.0.0.1',
            method: 'GET',
            pathname,
        });
        if (!step1.ok) return { denial: step1.denial };
        const step2 = await resolveTokenIdentity(step1.credential, { resolveJellyfinId: false });
        return step2.ok ? { identity: step2.identity } : { denial: step2.denial };
    }

    it('an integrations:read token of a still-admin owner passes the integration gate', async () => {
        const { integrationTokenDenial } = await import('./integration-token.js');
        setUserRow(ownerRow('bot-admin', true));
        const out = await produce(
            { scopes: ['integrations:read'], createdBy: 'bot-admin', ownerUserId: OWNER_ID },
            WATCH_HISTORY,
        );
        expect(out.identity?.principal.tokenOwnerIsAdmin).toBe(true);
        expect(out.identity?.principal.isAdmin).toBe(false);
        expect(out.identity?.principal.scopes).toEqual(['integrations:read']);
        expect(integrationTokenDenial(out.identity?.principal)).toBeNull();
    });

    it('a demoted owner makes the integrations:read token fail the integration gate', async () => {
        const { integrationTokenDenial } = await import('./integration-token.js');
        setUserRow(ownerRow('bot-admin', false));
        const out = await produce(
            { scopes: ['integrations:read'], createdBy: 'bot-admin', ownerUserId: OWNER_ID },
            WATCH_HISTORY,
        );
        expect(out.identity?.principal.tokenOwnerIsAdmin).toBe(false);
        expect(integrationTokenDenial(out.identity?.principal)?.status).toBe(403);
    });

    it.each([
        '/api/v1/me/stats',
        '/api/admin/x',
        '/api/v1/integrationsx',
        '/api/v1/',
        '/api/v1/integrations',
        '/api/v1/integrations/keys/1',
        '/api/v1/integrations/watch-history/x',
        '/api/v1/integrations/watch-history//',
    ])('denies an integrations:read token on %s before any identity work', async (pathname) => {
        setUserRow(ownerRow('bot-admin', true));
        const out = await produce(
            { scopes: ['integrations:read'], createdBy: 'bot-admin', ownerUserId: OWNER_ID },
            pathname,
        );
        expect(out.denial).toEqual({
            status: 403,
            error: 'Token not permitted on this endpoint',
        });
        expect(mockGetUserById).not.toHaveBeenCalled();
    });

    it.each([
        '/api/v1/integrations/watch-history',
        '/api/v1/integrations/upcoming/',
        '/api/v1/integrations/homepage',
    ])('lets an integrations:read token through on %s', async (pathname) => {
        setUserRow(ownerRow('bot-admin', true));
        const out = await produce(
            { scopes: ['integrations:read'], createdBy: 'bot-admin', ownerUserId: OWNER_ID },
            pathname,
        );
        expect(out.denial).toBeUndefined();
        expect(out.identity?.principal.scopes).toEqual(['integrations:read']);
    });

    // Every plane passes the ROUTED path (as forward-auth does): an encoded
    // spelling is judged by the route it reaches, against the stored prefixes.
    it('judges an encoded /api/admin path by the route it reaches', async () => {
        setUserRow(ownerRow('bot-admin', true));
        mockSvcValidate.mockResolvedValue({
            scopes: ['admin'],
            createdBy: 'bot-admin',
            ownerUserId: OWNER_ID,
            forceNonAdmin: false,
            actAsUser: null,
            allowedPathPrefixes: ['/api/admin/metrics'],
            allowedMethods: null,
        });
        const at = (pathname: string) =>
            resolveBearerAdminPrincipal(makeEvent({ authHeader: 'Bearer svc_bot', pathname }));
        expect((await at('/api/admin/%6detrics'))?.isAdmin).toBe(true);
        expect(await at('/api/%61dmin/x')).toBeNull();
    });

    it('denies an integrations:read token on /api/admin through resolveBearerAdminPrincipal', async () => {
        setUserRow(ownerRow('bot-admin', true));
        mockSvcValidate.mockResolvedValue({
            scopes: ['integrations:read'],
            createdBy: 'bot-admin',
            ownerUserId: OWNER_ID,
            forceNonAdmin: false,
            actAsUser: null,
        });
        expect(
            await resolveBearerAdminPrincipal(
                makeEvent({ authHeader: 'Bearer svc_bot', pathname: '/api/admin/x' }),
            ),
        ).toBeNull();
    });

    it('a renamed owner keeps the token, and the user who took the old name lends nothing', async () => {
        // The owner (by id) was renamed and is still admin; a NEW, non-admin
        // account now carries the old username the token's created_by label shows.
        setUserRow(ownerRow('renamed-admin', true));
        setUserRow(ownerRow('bot-admin', false, IMPOSTOR_ID));
        const out = await produce(
            { scopes: ['admin'], createdBy: 'bot-admin', ownerUserId: OWNER_ID },
            '/api/v1/libraries',
        );
        expect(out.identity?.principal.isAdmin).toBe(true);
        expect(out.identity?.principal.userId).toBe(OWNER_ID);
        expect(mockGetUserByUsername).not.toHaveBeenCalledWith(expect.anything(), 'bot-admin');

        // And the reverse: the owner was demoted; an admin who took the old
        // name does not make the token admin.
        userRows.clear();
        setUserRow(ownerRow('renamed-admin', false));
        setUserRow(ownerRow('bot-admin', true, IMPOSTOR_ID));
        const demoted = await produce(
            { scopes: ['admin'], createdBy: 'bot-admin', ownerUserId: OWNER_ID },
            '/api/v1/libraries',
        );
        expect(demoted.identity?.principal.isAdmin).toBe(false);
        expect(demoted.identity?.principal.userId).toBe(OWNER_ID);
    });

    it('a token without owner_user_id is rejected', async () => {
        setUserRow(ownerRow('bot-admin', true));
        const out = await produce(
            { scopes: ['admin'], createdBy: 'bot-admin', ownerUserId: null },
            '/api/v1/libraries',
        );
        expect(out.denial?.status).toBe(403);
        expect(out.identity).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Debug report (spec 2026-10-21 §6): the `diagnostics:read` grant gets the
// same owner verdict as `integrations:read`, plus its own built-in envelope
// (GET/HEAD on the report routes only), through the shared producer.
// ─────────────────────────────────────────────────────────────────────────
describe('debug report: diagnostics:read grant and owner by id', () => {
    const OWNER_ID = 'dddddddd-2222-4ddd-8ddd-dddddddddddd';
    const REPORT = '/api/v1/admin/debug-report';

    function ownerRow(username: string, isAdmin: boolean): UserRow {
        return {
            id: OWNER_ID,
            username,
            is_admin: isAdmin,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        };
    }

    async function produce(validated: Record<string, unknown>, pathname: string, method = 'GET') {
        const { validateBearerCredential, resolveTokenIdentity } =
            await import('./token-identity.js');
        mockSvcValidate.mockResolvedValue({
            id: 9,
            name: 'debug-bot',
            tokenPrefix: 'svc_dbg',
            forceNonAdmin: false,
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            createdBy: 'root',
            ownerUserId: OWNER_ID,
            ...validated,
        });
        const step1 = await validateBearerCredential('svc_dbg', {
            clientIp: '127.0.0.1',
            method,
            pathname,
        });
        if (!step1.ok) return { denial: step1.denial, identity: undefined };
        const step2 = await resolveTokenIdentity(step1.credential, { resolveJellyfinId: false });
        return step2.ok
            ? { denial: undefined, identity: step2.identity }
            : { denial: step2.denial, identity: undefined };
    }

    it('a diagnostics:read token of a still-admin owner gets the owner verdict and passes diagnosticsAccessDenial', async () => {
        const { diagnosticsAccessDenial } = await import('./diagnostics-grant.js');
        setUserRow(ownerRow('root', true));
        const out = await produce({ scopes: ['diagnostics:read'] }, REPORT);
        expect(out.identity?.principal.tokenOwnerIsAdmin).toBe(true);
        expect(out.identity?.principal.isAdmin).toBe(false);
        expect(out.identity?.principal.scopes).toEqual(['diagnostics:read']);
        expect(diagnosticsAccessDenial(out.identity?.principal)).toBeNull();
    });

    it('forceNonAdmin suppresses the diagnostics owner verdict even for an admin owner', async () => {
        const { diagnosticsAccessDenial } = await import('./diagnostics-grant.js');
        setUserRow(ownerRow('root', true));
        const out = await produce({ scopes: ['diagnostics:read'], forceNonAdmin: true }, REPORT);
        expect(out.denial).toBeUndefined();
        expect(out.identity?.principal.isAdmin).toBe(false);
        expect(out.identity?.principal.tokenOwnerIsAdmin).toBe(false);
        expect(diagnosticsAccessDenial(out.identity?.principal)?.status).toBe(403);
    });

    it('an admin-scope token of a demoted owner resolves non-admin and is refused by the report handler', async () => {
        setUserRow(ownerRow('root', false));
        const out = await produce({ scopes: ['admin'] }, REPORT);
        expect(out.denial).toBeUndefined();
        expect(out.identity?.principal.isAdmin).toBe(false);
        const { def } = await import('$lib/server/api/defs/admin/debug-report/index.js');
        const event = {
            ...makeEvent({ pathname: REPORT }),
            locals: { principal: out.identity?.principal },
        } as RequestEvent;
        reportBuilder.mockClear();
        const response = await def.handlers.GET!(event, { surface: 'v1' });
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(reportBuilder).not.toHaveBeenCalled();
    });

    it('a demoted owner makes the diagnostics:read token fail diagnosticsAccessDenial', async () => {
        const { diagnosticsAccessDenial } = await import('./diagnostics-grant.js');
        setUserRow(ownerRow('root', false));
        const out = await produce({ scopes: ['diagnostics:read'] }, REPORT);
        expect(out.identity?.principal.tokenOwnerIsAdmin).toBe(false);
        expect(diagnosticsAccessDenial(out.identity?.principal)?.status).toBe(403);
    });

    it.each([
        `${REPORT}`,
        `${REPORT}/`,
        `${REPORT}/health`,
        `${REPORT}/runs/abc`,
        `${REPORT}/client-diagnostics/fp1`,
        `${REPORT}/cluster/nodes/n1`,
    ])('lets a diagnostics:read token GET %s', async (pathname) => {
        setUserRow(ownerRow('root', true));
        const out = await produce({ scopes: ['diagnostics:read'] }, pathname, 'GET');
        expect(out.denial).toBeUndefined();
        expect(out.identity?.principal.scopes).toEqual(['diagnostics:read']);
    });

    it.each([
        ['POST', REPORT],
        ['DELETE', `${REPORT}/runs/abc`],
        ['OPTIONS', REPORT],
        ['GET', '/api/v1/stats/me'],
        ['GET', '/api/v1/admin/users'],
        ['GET', '/api/admin/debug-report'],
        ['GET', '/de/api/v1/admin/debug-report'],
        ['GET', `${REPORT}/runs/a/b`],
        ['GET', `${REPORT}/..`],
        ['GET', `${REPORT}-x`],
    ])(
        'denies a diagnostics:read token on %s %s before any identity work',
        async (method, pathname) => {
            setUserRow(ownerRow('root', true));
            const out = await produce({ scopes: ['diagnostics:read'] }, pathname, method);
            expect(out.denial?.status).toBe(403);
            expect(out.identity).toBeUndefined();
        },
    );

    it('denies a diagnostics:read token on /api/admin through resolveBearerAdminPrincipal', async () => {
        setUserRow(ownerRow('root', true));
        mockSvcValidate.mockResolvedValue({
            scopes: ['diagnostics:read'],
            createdBy: 'root',
            ownerUserId: OWNER_ID,
            forceNonAdmin: false,
            actAsUser: null,
        });
        expect(
            await resolveBearerAdminPrincipal(
                makeEvent({ authHeader: 'Bearer svc_dbg', pathname: '/api/admin/debug-report' }),
            ),
        ).toBeNull();
    });
});

it('logs non-dependency service-token impersonation failures while preserving their denial', async () => {
    const { validateBearerCredential, resolveTokenIdentity } = await import('./token-identity.js');
    mockSvcValidate.mockResolvedValue({
        scopes: ['admin'],
        createdBy: 'admin',
        ownerUserId: 'cccccccc-1111-4ccc-8ccc-cccccccccccc',
        actAsUser: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const failure = new TypeError('malformed target row');
    mockSqlQuery.mockRejectedValueOnce(failure);
    const credential = await validateBearerCredential('svc_test', {
        clientIp: '127.0.0.1',
        method: 'GET',
        pathname: '/api/v1/media',
    });
    if (!credential.ok) throw new Error('fixture credential must validate');
    const result = await resolveTokenIdentity(credential.credential, { resolveJellyfinId: false });
    expect(result).toMatchObject({
        ok: false,
        denial: { status: 500, error: 'impersonation_failed' },
    });
    expect(logError).toHaveBeenCalledWith('Service token impersonation failed', failure);
});
