// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for enforce() and mount() in $lib/server/api/mount.ts.
 *
 * authenticate() and scopeGranted() are mocked — this suite tests the
 * enforce() decision logic only, not the underlying auth primitives
 * (those have their own tests in tasks/api-auth.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import postgres from 'postgres';
import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from './principal.js';

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockAuthenticate = vi.fn();
const mockRequireScope = vi.fn();
const mockScopeGranted = vi.fn();

vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return {
        ...actual,
        authenticate: (...args: unknown[]) => mockAuthenticate(...args),
        requireScope: (...args: unknown[]) => mockRequireScope(...args),
        scopeGranted: (...args: unknown[]) => mockScopeGranted(...args),
    };
});

// Mutable so the deviceAuth-gate describe block below can flip it without a
// second vi.mock factory. Defaults to `true`: this was `features: {}` before
// fix-plan-5 Task 4 review, fix round 1, Important 2 added a
// `features.deviceAuth` read inside `resolveBearerAdminPrincipal()` —
// EVERY test in the "resolveBearerAdminPrincipal" describe blocks below
// exercises that function for real (only its DB/service leaves are mocked),
// so an empty `features` object made `!features.deviceAuth` throw / resolve
// every one of those tests to `null` for the WRONG reason the moment that
// gate landed (the exact "incomplete factory" trap the review named).
const mockFeatures = vi.hoisted(() => ({ deviceAuth: true }));

// config is only used by isFeatureEnabled; mock it cleanly
vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_DEVICE_AUTH: true,
        FEATURE_MY_FEATURE: true,
    },
    features: mockFeatures,
}));

const dbWarn = vi.hoisted(() => vi.fn());

// Logger: suppress output in tests
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: dbWarn,
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// Dynamic imports inside resolveBearerAdminPrincipal — mock to fail-closed by default
const mockPatValidate = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: (...args: unknown[]) => mockPatValidate(...args) }),
}));
const mockSvcValidate = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: (...args: unknown[]) => mockSvcValidate(...args) }),
}));
const mockIsUserAdmin = vi.fn().mockReturnValue(false);
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: (...args: unknown[]) => mockIsUserAdmin(...args),
}));
// H5: the svc_ branch of resolveBearerAdminPrincipal now re-checks the token
// creator's live groups (mirroring the pat_ branch) before granting admin.
const mockGetUserByUsername = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
}));
const mockGetSql = vi.fn().mockResolvedValue({});
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
// resolveBearerAdminPrincipal's pin-aware ownerIsAdmin lookup (both pat_ and
// svc_ branches now share this one helper — see resolve-owner-admin-status.ts).
const mockResolveOwnerAdminStatus = vi.fn().mockResolvedValue(null);
// fix-plan-5 Task 3: resolveOwnerIsAdminFailClosed() is the non-impersonating
// service-token CREATOR axis's entry point in the shared token-identity.ts
// producer (resolve-bearer-principal.ts no longer calls resolveOwnerAdminStatus
// directly for that axis). Delegates to the SAME mockResolveOwnerAdminStatus
// fixture every existing test already configures, so per-test bodies below
// don't need editing — this is a mock-plumbing update, not a behaviour change
// to what this suite asserts (mount.test.ts's own docstring: authenticate()
// and the underlying auth primitives are mocked; enforce()'s decision logic
// is what's under test here, not resolveOwnerAdminStatus's own formula —
// that has its own unmocked-resolver coverage in
// resolve-owner-admin-status.test.ts / resolve-bearer-principal.test.ts).
const mockResolveOwnerIsAdminFailClosed = vi.fn(async (username: string) => {
    const owner = await mockResolveOwnerAdminStatus({}, username);
    return owner?.isAdmin === true;
});
// Task 3 review, Minor 5: computeOwnerIsAdminOverride() is a pure, two-line
// formula (`adminPinned ? isAdminColumn : undefined`) — importOriginal() it
// instead of re-implementing it a third time in a mock factory, so this file
// can never silently drift from the real formula's own tri-state semantics.
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/auth/resolve-owner-admin-status.js')>();
    return {
        resolveOwnerAdminStatus: (...args: unknown[]) => mockResolveOwnerAdminStatus(...args),
        resolveOwnerIsAdminFailClosed: (...args: [string]) =>
            mockResolveOwnerIsAdminFailClosed(...args),
        // API package 15: a service token's owner verdict is resolved by its
        // owner_user_id. Same fixture; the id stands in for the owner here.
        resolveOwnerIsAdminFailClosedById: (...args: [string]) =>
            mockResolveOwnerIsAdminFailClosed(...args),
        computeOwnerIsAdminOverride: actual.computeOwnerIsAdminOverride,
    };
});

// fix-plan-5 Task 3: the PAT owner axis in the shared token-identity.ts
// producer resolves identity via resolveTokenUserAccess() (Formula A,
// effective/in-app-merged groups), not resolveOwnerAdminStatus() directly —
// see token-identity.ts's doc comment. Same delegation pattern as
// resolveOwnerIsAdminFailClosed above: derives its answer from the SAME
// mockResolveOwnerAdminStatus fixture so existing test bodies (which only
// ever configure that one mock) keep working unmodified.
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async (username: string) => {
        const owner = await mockResolveOwnerAdminStatus({}, username);
        if (!owner) return null;
        return {
            userGroups: owner.groups,
            disabled: false,
            deleted: false,
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                hasReviewPermission: false,
                hasMediaAnnotationPermission: false,
                ownerIsAdmin: owner.isAdmin === true,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        };
    },
    computeOwnerMaxAge: () => null,
    mergeMaxAge: (a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : Math.min(a, b),
    MOST_RESTRICTIVE_AGE_RATING: 0,
}));

// fix-plan-5 Task 3: the non-impersonating service-token creator axis also
// resolves creatorUserId via resolveUserIdByUsername() before the
// ownerIsAdmin check runs. This suite doesn't assert on the resolved UUID
// itself, so a fixed resolvable id keeps every existing "creator IS/ISN'T
// admin" fixture working without needing its own users.queries.js row.
vi.mock('$lib/server/auth/resolve-user-id.js', () => ({
    resolveUserIdByUsername: async () => toUserId('00000000-0000-4000-8000-000000000000'),
}));

// The real (unmocked) `$lib/server/utils/audit-log.js` — imported below for the
// R5 seam tests — pulls in `$lib/server/database/connection.js` for its
// best-effort DB sink. That module is enormous (CatalogService,
// UserRatingsService, embedding services, …) and drags in unrelated config
// flags this suite doesn't mock; stub it to a no-op DB (auditLog()'s sink is
// already fire-and-forget and swallows a null/failing getDb()).
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => null,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { enforce } from './mount.js';
import type { AuthSpec } from './define.js';
import { ApiAuthError } from '$lib/server/tasks/api-auth.js';
// Real (unmocked) auditActor() — used by the R5 seam tests below to prove the
// Principal enforce() materialises on event.locals is what an audited action
// would actually attribute the request to.
import { auditActor } from '$lib/server/utils/audit-log.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

type _DeepPartial<T> = T extends object ? { [K in keyof T]?: _DeepPartial<T[K]> } : T;

function makeEvent(
    opts: {
        username?: string;
        isAdmin?: boolean;
        params?: Record<string, string>;
        authHeader?: string;
        /**
         * Attach `locals.principal` (H4). Any field left unset defaults to a
         * value consistent with the `user` object built from the other opts,
         * so tests only need to specify the field(s) they care about.
         */
        principal?: Partial<Principal>;
    } = {},
): RequestEvent {
    const user = {
        userId: toUserId('00000000-0000-0000-0000-000000000001'),
        username: opts.username ?? '',
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: opts.isAdmin ?? false,
        isModerator: false,
        maxAgeRating: null as null | number,
        isAgeRestricted: false,
        liveTvPriority: 'low' as const,
    };

    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);

    const principal: Principal | undefined = opts.principal
        ? {
              kind: opts.principal.kind ?? 'session',
              userId: opts.principal.userId ?? user.userId,
              username: opts.principal.username ?? user.username,
              userGroups: opts.principal.userGroups ?? user.userGroups,
              scopes: opts.principal.scopes ?? [],
              isAdmin: opts.principal.isAdmin ?? false,
          }
        : undefined;

    return {
        url: new URL('http://localhost/api/v1/test'),
        request: new Request('http://localhost/api/v1/test', { headers }),
        params: opts.params ?? {},
        route: { id: '/api/v1/test' as const },
        locals: {
            user,
            principal,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function bodyCode(res: Response): Promise<string> {
    const body = (await res.clone().json()) as { code: string };
    return body.code;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('enforce(): public', () => {
    const spec: AuthSpec = { kind: 'public' };

    it('returns null for any request', async () => {
        const result = await enforce(spec, makeEvent());
        expect(result).toBeNull();
    });

    it('returns null even when no user is authenticated', async () => {
        const result = await enforce(spec, makeEvent({ username: '' }));
        expect(result).toBeNull();
    });
});

describe('enforce(): user', () => {
    const spec: AuthSpec = { kind: 'user' };

    it('passes when user has a username', async () => {
        const result = await enforce(spec, makeEvent({ username: 'alice' }));
        expect(result).toBeNull();
    });

    it('returns 401 unauthorized when username is empty', async () => {
        const res = await enforce(spec, makeEvent({ username: '' }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401);
        expect(await bodyCode(res!)).toBe('unauthorized');
    });
});

describe('enforce(): admin', () => {
    const spec: AuthSpec = { kind: 'admin' };

    it('passes when the principal is admin', async () => {
        const result = await enforce(
            spec,
            makeEvent({ username: 'admin', isAdmin: true, principal: { isAdmin: true } }),
        );
        expect(result).toBeNull();
    });

    it('returns 403 forbidden for non-admin authenticated user', async () => {
        const res = await enforce(spec, makeEvent({ username: 'alice', isAdmin: false }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(await bodyCode(res!)).toBe('forbidden');
    });

    it('returns 403 for unauthenticated request with no Bearer token', async () => {
        const res = await enforce(spec, makeEvent({ username: '' }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// H5 (SECURITY REGRESSION): the svc_ branch of resolveBearerAdminPrincipal
// must require ownerIsAdmin (the token creator's CURRENT pin-aware admin
// status), not just an 'admin' scope. Before the fix, a scope='admin'
// service token whose creator was later demoted from admin kept granting
// admin through this fallback path.
//
// Final fix wave (2026-09-13): both the pat_ and svc_ branches now resolve
// ownerIsAdmin through the ONE shared resolveOwnerAdminStatus() helper
// instead of each re-deriving it — see resolve-owner-admin-status.ts.
// ---------------------------------------------------------------------------
describe('enforce(): admin — resolveBearerAdminPrincipal svc_ ownerIsAdmin (H5)', () => {
    const spec: AuthSpec = { kind: 'admin' };

    beforeEach(() => {
        mockSvcValidate.mockReset().mockResolvedValue(null);
        mockResolveOwnerAdminStatus.mockReset().mockResolvedValue(null);
        mockGetSql.mockReset().mockResolvedValue({});
    });

    it('svc_ token with admin scope owned by a NON-admin creator does NOT grant admin', async () => {
        mockSvcValidate.mockResolvedValue({
            forceNonAdmin: false,
            scopes: ['admin'],
            createdBy: 'demoted-admin',
            ownerUserId: '00000000-0000-4000-8000-000000000001',
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('00000000-0000-0000-0000-0000000000bb'),
            groups: ['regular-user'],
            isAdmin: false,
        });

        const res = await enforce(
            spec,
            makeEvent({ username: '', authHeader: 'Bearer svc_deadbeef' }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        // By owner id (API package 15), never the created_by label.
        expect(mockResolveOwnerAdminStatus).toHaveBeenCalledWith(
            expect.anything(),
            '00000000-0000-4000-8000-000000000001',
        );
    });

    it('svc_ token with admin scope owned by an ADMIN creator grants admin', async () => {
        mockSvcValidate.mockResolvedValue({
            id: 42,
            name: 'ci-svc-token',
            forceNonAdmin: false,
            scopes: ['admin'],
            createdBy: 'current-admin',
            ownerUserId: '00000000-0000-4000-8000-000000000002',
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('00000000-0000-0000-0000-0000000000aa'),
            groups: ['admin-group'],
            isAdmin: true,
        });

        const event = makeEvent({ username: '', authHeader: 'Bearer svc_deadbeef' });
        const result = await enforce(spec, event);
        expect(result).toBeNull();
        // R5: the tertiary bearer-admin fallback must materialise a Principal
        // (not just return a boolean) so an audited action downstream is
        // attributable to this specific service token.
        expect(event.locals.principal).toMatchObject({
            kind: 'service_token',
            isAdmin: true,
            credentialId: '42',
        });
    });

    it('forceNonAdmin short-circuits before the ownerIsAdmin lookup', async () => {
        mockSvcValidate.mockResolvedValue({
            forceNonAdmin: true,
            scopes: ['admin'],
            createdBy: 'current-admin',
            ownerUserId: '00000000-0000-4000-8000-000000000003',
        });

        const res = await enforce(
            spec,
            makeEvent({ username: '', authHeader: 'Bearer svc_deadbeef' }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(mockResolveOwnerAdminStatus).not.toHaveBeenCalled();
    });

    // Final fix wave: svc.validate() itself now denies a token whose creator
    // is disabled/deleted (ServiceTokenService.validate()'s own creator gate
    // — unit-tested at that seam in service-token.service.test.ts). At the
    // mount seam this surfaces simply as validate() returning null, same as
    // any other invalid token.
    it('svc_ token with a disabled creator (validate() denies it) → 403', async () => {
        mockSvcValidate.mockResolvedValue(null);

        const res = await enforce(
            spec,
            makeEvent({ username: '', authHeader: 'Bearer svc_disabledcreator' }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(mockResolveOwnerAdminStatus).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Fix-plan-5 Task 4 review, fix round 1, Important 2: the {kind:'admin'}
// TERTIARY fallback resolves a Bearer admin identity via the SAME
// `resolveBearerAdminPrincipal()` helper the mount seam above already
// exercises for real — it is now gated on `features.deviceAuth` too (not
// only forward-auth.ts's separate /api/admin Bearer exception). An admin
// Bearer token that would otherwise pass must be denied when the flag is
// off, and unaffected when it's on.
// ---------------------------------------------------------------------------
describe('enforce(): admin TERTIARY — gated on features.deviceAuth', () => {
    const spec: AuthSpec = { kind: 'admin' };

    beforeEach(() => {
        mockFeatures.deviceAuth = true;
        mockPatValidate.mockReset().mockResolvedValue(null);
        mockResolveOwnerAdminStatus.mockReset().mockResolvedValue(null);
        mockGetSql.mockReset().mockResolvedValue({});
    });

    it('denies an otherwise-valid admin Bearer PAT when features.deviceAuth is off, even with a non-admin session present', async () => {
        mockFeatures.deviceAuth = false;
        mockPatValidate.mockResolvedValue({
            scopes: ['admin'],
            username: 'admin-user',
            userId: '44444444-4444-4444-8444-444444444444',
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('44444444-4444-4444-8444-444444444444'),
            groups: ['admin-group'],
            isAdmin: true,
        });

        // A non-admin SESSION is present (makeEvent always sets locals.user;
        // isAdmin defaults to false) — the PRIMARY/SECONDARY paths already
        // deny, so this exercises the TERTIARY fallback exactly as a real
        // non-admin-session-plus-admin-Bearer request would.
        const event = makeEvent({ username: 'session-user', authHeader: 'Bearer pat_x' });

        const res = await enforce(spec, event);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(event.locals.principal).toBeUndefined();
        // Short-circuits before touching validate() at all.
        expect(mockPatValidate).not.toHaveBeenCalled();
    });

    it('grants admin for the SAME Bearer PAT when features.deviceAuth is on (unchanged)', async () => {
        mockFeatures.deviceAuth = true;
        mockPatValidate.mockResolvedValue({
            scopes: ['admin'],
            username: 'admin-user',
            userId: '44444444-4444-4444-8444-444444444444',
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('44444444-4444-4444-8444-444444444444'),
            groups: ['admin-group'],
            isAdmin: true,
        });

        const event = makeEvent({ username: 'session-user', authHeader: 'Bearer pat_x' });

        const res = await enforce(spec, event);
        expect(res).toBeNull();
        expect(event.locals.principal?.isAdmin).toBe(true);
    });
});

// Final fix wave (2026-09-13): a pinned native admin (admin_pinned=true,
// is_admin=true) whose live IdP groups do NOT include the configured admin
// group used to be 403'd on every kind:'admin' def, because the pat_ branch
// computed ownerIsAdmin as isUserAdmin(token.groups) alone (group-only,
// ignoring the pin). resolveOwnerAdminStatus() is pin-aware, so the SAME
// PAT now passes.
describe('enforce(): admin — pinned-admin PAT is pin-aware, not group-only', () => {
    const spec: AuthSpec = { kind: 'admin' };

    beforeEach(() => {
        mockPatValidate.mockReset().mockResolvedValue(null);
        mockResolveOwnerAdminStatus.mockReset().mockResolvedValue(null);
        mockGetSql.mockReset().mockResolvedValue({});
    });

    it('a pinned admin PAT grants admin even though live groups are not an admin group', async () => {
        mockPatValidate.mockResolvedValue({
            id: 900,
            userId: toUserId('66666666-6666-4666-8666-666666666666'),
            username: 'pinned-admin',
            scopes: ['admin'],
            groups: ['regular-user'], // NOT the configured admin group
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('66666666-6666-4666-8666-666666666666'),
            groups: ['regular-user'],
            isAdmin: true, // admin_pinned=true, is_admin=true overrides the groups
        });

        const event = makeEvent({ username: '', authHeader: 'Bearer pat_pinnedadmin' });
        const result = await enforce(spec, event);

        expect(result).toBeNull();
        expect(event.locals.principal).toMatchObject({ kind: 'pat', isAdmin: true });
    });
});

// R5 fix round 1 (Critical finding #1): the {kind:'admin'} TERTIARY fallback
// (no locals.principal, no locals.user.isAdmin — a Bearer PAT/service-token
// caller on one of the ~132 kind:'admin' defs, where forward-auth's "Bearer
// exception" deliberately never materialises a Principal) used to return a
// bare boolean and leave event.locals.principal/user both unset for the
// whole request. Any auditLog() call downstream then fell through
// auditActor()'s `principalBeforeDelegation(event) ?? locals.principal ??
// locals.user` all the way to `{username: null}` → actor:'system',
// principal_kind/credential_id both NULL — unattributable, the exact
// scenario R5 exists to close. These go through enforce() with a RAW Bearer
// header and no pre-built Principal (the report's original "mount-seam
// test" constructed the Principal directly and only ever hit the PRIMARY
// branch above, never this one), then call the REAL auditActor() on the
// event enforce() mutated — the actual seam an audited handler uses.
describe('enforce(): admin — TERTIARY bearer fallback materialises a Principal (R5)', () => {
    const spec: AuthSpec = { kind: 'admin' };

    beforeEach(() => {
        mockPatValidate.mockReset().mockResolvedValue(null);
        mockSvcValidate.mockReset().mockResolvedValue(null);
        mockResolveOwnerAdminStatus.mockReset().mockResolvedValue(null);
        mockGetSql.mockReset().mockResolvedValue({});
    });

    it('a raw Bearer PAT admin request materialises principal_kind=pat + credential_id=<pat id>', async () => {
        mockPatValidate.mockResolvedValue({
            id: 777,
            userId: toUserId('33333333-3333-4333-8333-333333333333'),
            username: 'ci-token',
            scopes: ['admin'],
            groups: ['admins'],
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('33333333-3333-4333-8333-333333333333'),
            groups: ['admins'],
            isAdmin: true,
        });

        const event = makeEvent({ username: '', authHeader: 'Bearer pat_abc123' });
        const result = await enforce(spec, event);

        expect(result).toBeNull();
        expect(event.locals.principal).toMatchObject({
            kind: 'pat',
            isAdmin: true,
            credentialId: '777',
        });
        // The actual seam: what would an auditLog() call inside the handler
        // this request reaches record as the actor?
        expect(auditActor(event)).toEqual({
            username: 'ci-token',
            kind: 'pat',
            credentialId: '777',
        });
    });

    it('a raw Bearer service token admin request materialises principal_kind=service_token + credential_id=<token id>', async () => {
        mockSvcValidate.mockResolvedValue({
            id: 55,
            name: 'ci-svc',
            forceNonAdmin: false,
            scopes: ['admin'],
            createdBy: 'the-admin',
            ownerUserId: '00000000-0000-4000-8000-000000000004',
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('44444444-4444-4444-8444-444444444444'),
            groups: ['admins'],
            isAdmin: true,
        });

        const event = makeEvent({ username: '', authHeader: 'Bearer svc_xyz789' });
        const result = await enforce(spec, event);

        expect(result).toBeNull();
        expect(event.locals.principal).toMatchObject({
            kind: 'service_token',
            isAdmin: true,
            credentialId: '55',
        });
        expect(auditActor(event)).toEqual({
            username: 'service:ci-svc',
            kind: 'service_token',
            credentialId: '55',
        });
    });

    it('a non-admin Bearer PAT still gets NO principal-less {username:null} fallback: forbidden, and no principal leaks through as admin', async () => {
        mockPatValidate.mockResolvedValue({
            id: 1,
            userId: toUserId('55555555-5555-4555-8555-555555555555'),
            username: 'low-scope-user',
            scopes: ['read'],
            groups: [],
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: toUserId('55555555-5555-4555-8555-555555555555'),
            groups: [],
            isAdmin: false,
        });

        const event = makeEvent({ username: '', authHeader: 'Bearer pat_lowscope' });
        const result = await enforce(spec, event);

        expect(result).not.toBeNull();
        expect(result!.status).toBe(403);
    });
});

describe('enforce(): scope', () => {
    beforeEach(() => {
        mockAuthenticate.mockReset();
        mockRequireScope.mockReset();
    });

    const spec: AuthSpec = { kind: 'scope', anyOf: ['tasks:read'] };

    it('passes when authenticate + requireScope succeed', async () => {
        mockAuthenticate.mockResolvedValue({ tokenKind: 'pat', scopes: ['read'] });
        mockRequireScope.mockReturnValue(undefined); // no throw = success
        const result = await enforce(spec, makeEvent());
        expect(result).toBeNull();
    });

    it('returns 401 when authenticate throws ApiAuthError(401)', async () => {
        mockAuthenticate.mockRejectedValue(new ApiAuthError(401, 'Bearer token required'));
        const res = await enforce(spec, makeEvent());
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401);
        expect(await bodyCode(res!)).toBe('unauthorized');
    });

    // Final fix wave: a svc_ token whose creator has been disabled is denied
    // by ServiceTokenService.validate() itself (unit-tested at that seam),
    // which authenticate() surfaces as "Invalid or expired service token" —
    // same shape as any other invalid Bearer credential on a kind:'scope' def
    // (e.g. /api/admin/* task/run/queue routes).
    it('returns 401 for a svc_ token whose creator is disabled (kind:scope on /api/admin/*)', async () => {
        mockAuthenticate.mockRejectedValue(
            new ApiAuthError(401, 'Invalid or expired service token'),
        );
        const res = await enforce(spec, makeEvent({ authHeader: 'Bearer svc_disabledcreator' }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401);
        expect(await bodyCode(res!)).toBe('unauthorized');
    });

    it('returns 403 scope_required when requireScope throws ApiAuthError(403)', async () => {
        mockAuthenticate.mockResolvedValue({ tokenKind: 'pat', scopes: [] });
        mockRequireScope.mockImplementation(() => {
            throw new ApiAuthError(403, 'Insufficient scope');
        });
        const res = await enforce(spec, makeEvent());
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(await bodyCode(res!)).toBe('scope_required');
    });

    it('re-throws non-ApiAuthError errors', async () => {
        mockAuthenticate.mockRejectedValue(new Error('DB connection error'));
        await expect(enforce(spec, makeEvent())).rejects.toThrow('DB connection error');
    });
});

// C20: the {kind:'scope'} fallback now materialises `locals.principal` from
// authenticate()'s resolved `identity` (when present) so surfaces that skip
// Principal construction upstream — Bearer PAT/svc callers on /api/admin/*,
// see hooks.server.ts's "Bearer exception" — still let handlers read a real
// caller identity instead of falling back to ad hoc sentinels.
describe('enforce(): scope — Principal materialisation from authenticate() identity (C20)', () => {
    beforeEach(() => {
        mockAuthenticate.mockReset();
        mockRequireScope.mockReset();
        // Fix round 2: this describe's tests set identity.ownerIsAdmin
        // directly and assert mount.ts CONSUMES it rather than re-deriving
        // via isUserAdmin(userGroups) — mount.ts no longer calls
        // isUserAdmin() on this path at all, so this mock's return value
        // must not coincidentally agree with the correct answer, or a test
        // asserting "consumed, not re-derived" would pass even against code
        // that still re-derives. Stubbing `true` here means: if mount.ts
        // regressed back to isUserAdmin(auth.identity.userGroups), the
        // PIN-DEMOTED test below (identity.ownerIsAdmin:false, userGroups
        // that a group-only check would read as admin) would flip to
        // isAdmin:true and fail RED, instead of passing either way.
        mockIsUserAdmin.mockReset().mockReturnValue(true);
    });

    const spec: AuthSpec = { kind: 'scope', anyOf: ['library:admin'] };
    // Fix round 1 (Critical): ownerIsAdmin is now CARRIED on auth.identity —
    // resolved pin-aware by authenticate() — rather than re-derived at this
    // call site via isUserAdmin(auth.identity.userGroups). Tests below set
    // it directly instead of mocking isUserAdmin's return value.
    const IDENTITY = {
        userId: toUserId('22222222-2222-4222-8222-222222222222'),
        username: 'alice',
        userGroups: ['users'],
        ownerIsAdmin: false,
    };

    it('builds locals.principal from a PAT identity when none exists yet', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'pat',
            scopes: ['library:admin'],
            identity: IDENTITY,
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent(); // no `principal` opt → locals.principal starts undefined
        const result = await enforce(spec, event);
        expect(result).toBeNull();
        expect(event.locals.principal?.username).toBe('alice');
        expect(event.locals.principal?.userId).toBe(IDENTITY.userId);
        expect(event.locals.principal?.kind).toBe('pat');
    });

    // R5 fix round 1 (Important finding #2): credentialId was omitted here even
    // though `auth: ApiAuth` has `tokenId` in scope, so credential_id stayed
    // NULL on every scope-gated admin/task/queue/run route reached via Bearer.
    it('carries credentialId (auth.tokenId) onto the materialised Principal, and auditActor() reflects it', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'pat',
            tokenId: 'pat-row-999',
            scopes: ['library:admin'],
            identity: IDENTITY,
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent();
        const result = await enforce(spec, event);
        expect(result).toBeNull();
        expect(event.locals.principal?.credentialId).toBe('pat-row-999');
        // The real seam an audited action goes through — not a hand-built
        // Principal, the one enforce() actually left on the event.
        expect(auditActor(event)).toEqual({
            username: 'alice',
            kind: 'pat',
            credentialId: 'pat-row-999',
        });
    });

    it('a users:admin/scope-only PAT identity does NOT become isAdmin:true, even when the owner is in an admin group', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'pat',
            scopes: ['users:admin'], // not 'admin' / 'tasks:admin'
            identity: { ...IDENTITY, ownerIsAdmin: true }, // owner IS a pin-aware admin
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent();
        await enforce(spec, event);
        expect(event.locals.principal?.isAdmin).toBe(false);
    });

    it('does not overwrite an existing locals.principal', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'pat',
            scopes: ['library:admin'],
            identity: IDENTITY,
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent({ principal: { username: 'bob' } });
        await enforce(spec, event);
        expect(event.locals.principal?.username).toBe('bob');
    });

    it('leaves locals.principal unset when authenticate() resolved no identity (service token)', async () => {
        mockAuthenticate.mockResolvedValue({ tokenKind: 'svc', scopes: ['library:admin'] });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent();
        const result = await enforce(spec, event);
        expect(result).toBeNull();
        expect(event.locals.principal).toBeUndefined();
    });

    // Item 1 (2026-09-13 deferred fix): authenticate() now resolves a service
    // token's identity too, with a SYNTHETIC admin-class userGroups that on
    // its own would make ownerIsAdmin true — auth.forceNonAdmin must reach
    // buildPrincipal() or a sandboxed (forceNonAdmin) admin-scoped service
    // token becomes isAdmin:true through this fallback.
    it('plumbs auth.forceNonAdmin through to buildPrincipal(), so a forceNonAdmin service token identity does NOT become isAdmin:true', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'svc',
            tokenId: 'svc-row-1',
            scopes: ['admin'],
            identity: {
                userId: toUserId('33333333-3333-4333-8333-333333333333'),
                username: 'service:sandboxed',
                userGroups: ['admin'],
                // Synthetic identity's own ownerIsAdmin verdict (see
                // ApiAuth.identity's doc comment) — true from the token's
                // admin scope, matching what forceNonAdmin must still veto.
                ownerIsAdmin: true,
            },
            forceNonAdmin: true,
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent();
        const result = await enforce(spec, event);
        expect(result).toBeNull();
        expect(event.locals.principal?.isAdmin).toBe(false);
    });

    it('a non-forceNonAdmin service token identity with admin scope+group DOES become isAdmin:true', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'svc',
            tokenId: 'svc-row-2',
            scopes: ['admin'],
            identity: {
                userId: toUserId('44444444-4444-4444-8444-444444444444'),
                username: 'service:ci',
                userGroups: ['admin'],
                ownerIsAdmin: true,
            },
            forceNonAdmin: false,
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent();
        const result = await enforce(spec, event);
        expect(result).toBeNull();
        expect(event.locals.principal?.isAdmin).toBe(true);
    });

    // Fix round 1 (CRITICAL, seam test): a service token IMPERSONATING a
    // real, PIN-DEMOTED admin (admin_pinned:true, is_admin:false) whose live
    // IdP groups still include the admin group. authenticate() (mocked here,
    // real behaviour covered by api-auth.test.ts) resolves
    // identity.ownerIsAdmin via the pin-aware formula = false. enforce()
    // MUST consume that verdict as-is — not re-derive isUserAdmin(userGroups)
    // — or this Principal would incorrectly become isAdmin:true, and
    // callerIsAdmin()/denyUnlessMayMint() would then let the token mint an
    // admin-scoped PAT for anyone.
    it('a PIN-DEMOTED admin impersonation target does NOT produce principal.isAdmin === true, even though userGroups includes the admin group', async () => {
        mockAuthenticate.mockResolvedValue({
            tokenKind: 'svc',
            tokenId: 'svc-row-3',
            scopes: ['admin'],
            identity: {
                userId: toUserId('55555555-5555-4555-8555-555555555555'),
                username: 'carol',
                userGroups: ['admins'], // stale IdP membership
                ownerIsAdmin: false, // pin-aware verdict: demoted
            },
            forceNonAdmin: false,
        });
        mockRequireScope.mockReturnValue(undefined);
        const event = makeEvent();
        const result = await enforce(spec, event);
        expect(result).toBeNull(); // scope check itself still passes
        expect(event.locals.principal?.isAdmin).toBe(false);
        expect(event.locals.principal?.userGroups).toEqual(['admins']);
    });
});

describe('enforce(): selfOrAdmin', () => {
    const spec: AuthSpec = { kind: 'selfOrAdmin', param: 'id' };

    it('passes when path param matches logged-in user', async () => {
        const result = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: {}, params: { id: 'alice' } }),
        );
        expect(result).toBeNull();
    });

    it('passes when path param is the "me" alias', async () => {
        const result = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: {}, params: { id: 'me' } }),
        );
        expect(result).toBeNull();
    });

    it('passes when path param is the "user" alias', async () => {
        const result = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: {}, params: { id: 'user' } }),
        );
        expect(result).toBeNull();
    });

    it('passes when accessing another user but isAdmin is true', async () => {
        const result = await enforce(
            spec,
            makeEvent({ username: 'admin', principal: { isAdmin: true }, params: { id: 'alice' } }),
        );
        expect(result).toBeNull();
    });

    it('returns 403 when accessing another user as non-admin', async () => {
        const res = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: {}, params: { id: 'bob' } }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
    });

    it.each(['alice', 'me', 'user', 'bob'])(
        'returns 401 without a principal even when an admin user exists (target %s)',
        async (target) => {
            const res = await enforce(
                spec,
                makeEvent({ username: 'alice', isAdmin: true, params: { id: target } }),
            );
            expect(res?.status).toBe(401);
        },
    );

    it('passes a case-insensitive self match using the principal identity', async () => {
        const res = await enforce(
            spec,
            makeEvent({ principal: { username: 'alice' }, params: { id: 'ALICE' } }),
        );
        expect(res).toBeNull();
    });

    it.each(['alice', 'bob'])(
        'uses principal identity when the owner username conflicts (target %s)',
        async (target) => {
            const res = await enforce(
                spec,
                makeEvent({
                    username: 'bob',
                    principal: { username: 'alice', isAdmin: false },
                    params: { id: target },
                }),
            );
            if (target === 'alice') expect(res).toBeNull();
            else expect(res?.status).toBe(403);
        },
    );

    it('does not use an admin owner flag for a scoped PAT accessing another user', async () => {
        const res = await enforce(
            spec,
            makeEvent({
                username: 'alice',
                isAdmin: true,
                principal: { kind: 'pat', isAdmin: false },
                params: { id: 'bob' },
            }),
        );
        expect(res?.status).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
        const res = await enforce(spec, makeEvent({ username: '', params: { id: 'alice' } }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401);
    });

    it('returns 404 when path param is missing', async () => {
        const res = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: {}, params: {} }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// H4: enforce() reads `locals.principal` FIRST, falling back to `locals.user`
// only when no Principal is attached (mount.ts:66/78/99-109/136/146).
// ---------------------------------------------------------------------------
describe('enforce(): locals.principal precedence (H4)', () => {
    beforeEach(() => {
        mockAuthenticate.mockReset();
        mockRequireScope.mockReset();
        mockScopeGranted.mockReset();
    });

    it('principal.isAdmin passes {kind:"admin"} even when locals.user is not admin', async () => {
        const spec: AuthSpec = { kind: 'admin' };
        const result = await enforce(
            spec,
            makeEvent({
                username: 'alice',
                isAdmin: false,
                principal: { isAdmin: true },
            }),
        );
        expect(result).toBeNull();
    });

    // ── Principal is AUTHORITATIVE for {kind:'admin'} ────────────────────────
    //
    // locals.user.isAdmin is derived from the user's live GROUPS alone
    // (buildUserPermissions), so for token credentials it ignores the token's
    // scopes. enforce() must therefore NOT fall through to it once a Principal
    // exists, or a non-admin-scoped token owned by an admin regains admin.

    it('device-flow JWT held by an ADMIN is NOT admin (tvOS: a shared-room device carries no admin capability)', async () => {
        // Mirrors forward-auth.ts's bearer path exactly: tokenScopes: [] →
        // deriveIsAdmin() false, while locals.user.isAdmin is true from groups.
        const res = await enforce(
            { kind: 'admin' },
            makeEvent({
                username: 'denis',
                isAdmin: true, // locals.user — group-derived, would have granted
                principal: { kind: 'bearer', isAdmin: false, scopes: ['read', 'write'] },
            }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(await bodyCode(res!)).toBe('forbidden');
    });

    it('low-scope PAT owned by an ADMIN is NOT admin', async () => {
        const res = await enforce(
            { kind: 'admin' },
            makeEvent({
                username: 'denis',
                isAdmin: true,
                principal: { kind: 'pat', isAdmin: false, scopes: ['read'] },
            }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
    });

    it('does NOT consult the bearer fallback once a Principal exists', async () => {
        // resolveBearerAdminPrincipal would validate the pat_ token; a
        // Principal that already said "not admin" must short-circuit before that.
        mockPatValidate.mockResolvedValue({ scopes: ['admin'], groups: ['admins'] });
        mockIsUserAdmin.mockReturnValue(true);
        const res = await enforce(
            { kind: 'admin' },
            makeEvent({
                username: 'denis',
                isAdmin: true,
                authHeader: 'Bearer pat_something',
                principal: { kind: 'bearer', isAdmin: false },
            }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(mockPatValidate).not.toHaveBeenCalled();
    });

    it('an admin SESSION principal still passes {kind:"admin"}', async () => {
        const res = await enforce(
            { kind: 'admin' },
            makeEvent({
                username: 'denis',
                isAdmin: true,
                principal: { kind: 'session', isAdmin: true },
            }),
        );
        expect(res).toBeNull();
    });

    // 2026-10-13: no principal means not admin; locals.user.isAdmin is no longer a fallback.
    it('routes with NO principal do NOT fall back to locals.user.isAdmin', async () => {
        const res = await enforce(
            { kind: 'admin' },
            makeEvent({ username: 'denis', isAdmin: true }),
        );
        expect(res?.status).toBe(403);
    });

    it('principal.scopes (already expanded) drives {kind:"scope"} WITHOUT calling authenticate()', async () => {
        mockScopeGranted.mockReturnValue(true);
        const spec: AuthSpec = { kind: 'scope', anyOf: ['tasks:read'] };
        const result = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: { scopes: ['read', 'tasks:read'] } }),
        );
        expect(result).toBeNull();
        expect(mockScopeGranted).toHaveBeenCalledWith(['read', 'tasks:read'], 'tasks:read');
        expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('{kind:"scope"} rejects via scope_required when the principal lacks the required scope, still without calling authenticate()', async () => {
        mockScopeGranted.mockReturnValue(false);
        const spec: AuthSpec = { kind: 'scope', anyOf: ['tasks:admin'] };
        const res = await enforce(
            spec,
            makeEvent({ username: 'alice', principal: { scopes: ['read'] } }),
        );
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
        expect(await bodyCode(res!)).toBe('scope_required');
        expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('principal.username satisfies {kind:"user"}', async () => {
        const spec: AuthSpec = { kind: 'user' };
        const result = await enforce(
            spec,
            makeEvent({ username: '', principal: { username: 'alice' } }),
        );
        expect(result).toBeNull();
    });

    it('principal.username satisfies {kind:"selfOrAdmin"}', async () => {
        const spec: AuthSpec = { kind: 'selfOrAdmin', param: 'id' };
        const result = await enforce(
            spec,
            makeEvent({
                username: '',
                params: { id: 'alice' },
                principal: { username: 'alice' },
            }),
        );
        expect(result).toBeNull();
    });

    it('when principal and locals.user disagree on username, principal wins ({kind:"selfOrAdmin"})', async () => {
        // locals.user is 'bob' (would NOT match the 'alice' path param on its
        // own), but the attached principal says 'alice' — enforce() must use
        // the principal's identity, not locals.user's.
        const spec: AuthSpec = { kind: 'selfOrAdmin', param: 'id' };
        const result = await enforce(
            spec,
            makeEvent({
                username: 'bob',
                isAdmin: false,
                params: { id: 'alice' },
                principal: { username: 'alice', isAdmin: false },
            }),
        );
        expect(result).toBeNull();
    });

    it('when principal and locals.user disagree on username, principal wins ({kind:"user"} identity)', async () => {
        // Both users are "authenticated" so {kind:'user'} passes either way —
        // the precedence is proven via {kind:'selfOrAdmin'} above, which is
        // sensitive to WHICH username is used, not just whether one exists.
        const spec: AuthSpec = { kind: 'user' };
        const result = await enforce(
            spec,
            makeEvent({ username: 'bob', principal: { username: 'alice' } }),
        );
        expect(result).toBeNull();
    });
});

describe('enforce(): feature', () => {
    it('returns 404 when feature flag is falsy for the given key', async () => {
        const spec: AuthSpec = {
            kind: 'feature',
            flag: 'FEATURE_DISABLED_FLAG',
            then: { kind: 'public' },
        };
        const res = await enforce(spec, makeEvent());
        // FEATURE_DISABLED_FLAG is not in the mocked config → treated as false
        expect(res).not.toBeNull();
        expect(res!.status).toBe(404);
    });

    it('delegates to then-spec when feature is enabled', async () => {
        // FEATURE_DEVICE_AUTH is true in the mock config
        const spec: AuthSpec = {
            kind: 'feature',
            flag: 'FEATURE_DEVICE_AUTH',
            then: { kind: 'public' },
        };
        const result = await enforce(spec, makeEvent());
        expect(result).toBeNull();
    });

    it('evaluates then-spec when feature is enabled — user spec passes for authed user', async () => {
        const spec: AuthSpec = {
            kind: 'feature',
            flag: 'FEATURE_DEVICE_AUTH',
            then: { kind: 'user' },
        };
        const result = await enforce(spec, makeEvent({ username: 'alice' }));
        expect(result).toBeNull();
    });

    it('evaluates then-spec when feature is enabled — user spec fails for anon', async () => {
        const spec: AuthSpec = {
            kind: 'feature',
            flag: 'FEATURE_DEVICE_AUTH',
            then: { kind: 'user' },
        };
        const res = await enforce(spec, makeEvent({ username: '' }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401);
    });
});

describe('enforce(): all', () => {
    it('returns null when all sub-specs pass', async () => {
        const spec: AuthSpec = {
            kind: 'all',
            specs: [{ kind: 'public' }, { kind: 'public' }],
        };
        const result = await enforce(spec, makeEvent());
        expect(result).toBeNull();
    });

    it('short-circuits on first failing spec', async () => {
        const spec: AuthSpec = {
            kind: 'all',
            specs: [{ kind: 'user' }, { kind: 'admin' }],
        };
        // user is empty → first spec fails → stops before second
        const res = await enforce(spec, makeEvent({ username: '' }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401); // 'user' spec failure, not 'admin'
    });

    it('passes all specs for an admin user', async () => {
        const spec: AuthSpec = {
            kind: 'all',
            specs: [{ kind: 'user' }, { kind: 'admin' }],
        };
        const result = await enforce(
            spec,
            makeEvent({ username: 'admin', isAdmin: true, principal: { isAdmin: true } }),
        );
        expect(result).toBeNull();
    });
});

describe('enforce(): any', () => {
    it('returns null when first sub-spec passes', async () => {
        const spec: AuthSpec = {
            kind: 'any',
            specs: [{ kind: 'public' }, { kind: 'admin' }],
        };
        const result = await enforce(spec, makeEvent());
        expect(result).toBeNull();
    });

    it('returns null when second sub-spec passes even if first fails', async () => {
        const spec: AuthSpec = {
            kind: 'any',
            specs: [{ kind: 'admin' }, { kind: 'user' }],
        };
        // not admin, but is authenticated user
        const result = await enforce(spec, makeEvent({ username: 'alice', isAdmin: false }));
        expect(result).toBeNull();
    });

    it('returns the last failure when all sub-specs fail', async () => {
        const spec: AuthSpec = {
            kind: 'any',
            specs: [{ kind: 'admin' }, { kind: 'user' }],
        };
        // unauthenticated → both fail
        const res = await enforce(spec, makeEvent({ username: '' }));
        expect(res).not.toBeNull();
        // last sub-spec was 'user' which returns 401
        expect(res!.status).toBe(401);
    });

    // Fix round 1 (Important #3, documented not fixed — see the invariant
    // comment at mount.ts's TERTIARY `case 'admin'` branch and
    // resolve-bearer-principal.ts's CAVEAT): {kind:'admin'}'s TERTIARY
    // fallback materialises event.locals.principal as a side effect even
    // when it DENIES (isAdmin:false) — a later `any` arm like {kind:'user'}
    // can still see that identity. The item-15 short-circuit means whether
    // this side effect fires at all depends on the token's scope, not just
    // on whether it's admin — pinning both outcomes here so a future change
    // to the short-circuit predicate is caught by this test either way.
    describe('interaction with the item-15 short-circuit (Important #3, latent, not currently reachable)', () => {
        beforeEach(() => {
            mockPatValidate.mockReset();
            mockResolveOwnerAdminStatus.mockReset().mockResolvedValue(null);
        });

        it("a ['users:admin']-scoped (non-admin, but admin-CLASS) Bearer token passes the {kind:'user'} fallback arm — the TERTIARY admin arm's side effect fired", async () => {
            mockPatValidate.mockResolvedValue({
                id: 601,
                userId: toUserId('11111111-1111-4111-8111-111111111111'),
                username: 'ops',
                scopes: ['users:admin'],
                groups: [],
            });
            mockResolveOwnerAdminStatus.mockResolvedValue({
                userId: toUserId('11111111-1111-4111-8111-111111111111'),
                groups: [],
                isAdmin: false,
            });
            const spec: AuthSpec = { kind: 'any', specs: [{ kind: 'admin' }, { kind: 'user' }] };
            const event = makeEvent({ username: '', authHeader: 'Bearer pat_ops' });
            const result = await enforce(spec, event);
            expect(result).toBeNull();
            expect(event.locals.principal?.username).toBe('ops');
        });

        it("a ['read']-scoped Bearer token FAILS the same {kind:'user'} fallback arm — short-circuited, no side effect", async () => {
            mockPatValidate.mockResolvedValue({
                id: 602,
                userId: toUserId('22222222-2222-4222-8222-222222222222'),
                username: 'reader',
                scopes: ['read'],
                groups: [],
            });
            const spec: AuthSpec = { kind: 'any', specs: [{ kind: 'admin' }, { kind: 'user' }] };
            const event = makeEvent({ username: '', authHeader: 'Bearer pat_reader' });
            const result = await enforce(spec, event);
            expect(result).not.toBeNull();
            expect(result!.status).toBe(401);
            expect(event.locals.principal).toBeUndefined();
            expect(mockResolveOwnerAdminStatus).not.toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
// mount() — structural tests
// ---------------------------------------------------------------------------

import { mount } from './mount.js';
import { defineEndpoint } from './define.js';

describe('mount(): exports', () => {
    const ctx = { surface: 'v1' as const };

    it('exports only the methods defined in handlers', () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => new Response('ok'),
                POST: async () => new Response('created', { status: 201 }),
            },
        });
        const handlers = mount(def, ctx);
        expect(typeof handlers.GET).toBe('function');
        expect(typeof handlers.POST).toBe('function');
        expect(handlers.PUT).toBeUndefined();
        expect(handlers.DELETE).toBeUndefined();
    });

    it('public endpoint returns handler response directly', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => new Response('hello', { status: 200 }),
            },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('hello');
    });

    it('adds Deprecation, Sunset and the successor Link to a deprecated operation', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            docs: {
                GET: {
                    tags: ['Test'],
                    summary: 'Old read',
                    stability: 'deprecated',
                    deprecation: {
                        since: '2026-11-01',
                        sunset: '2027-02-01',
                        replacement: '/new-read',
                    },
                    responses: { 200: 'ok' },
                },
            },
            handlers: { GET: async () => new Response('old', { status: 200 }) },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent());
        expect(res.headers.get('deprecation')).toBe('@1793491200');
        expect(res.headers.get('sunset')).toBe('Mon, 01 Feb 2027 00:00:00 GMT');
        expect(res.headers.get('link')).toBe(
            '</api/v1/new-read>; rel="successor-version", <https://lumastra.org/developers/api/#stability-labels-and-deprecation>; rel="deprecation"',
        );
    });

    it('marks error responses of a deprecated operation too (early 401)', async () => {
        const def = defineEndpoint({
            auth: { kind: 'user' },
            docs: {
                GET: {
                    tags: ['Test'],
                    summary: 'Old read',
                    stability: 'deprecated',
                    deprecation: { since: '2026-11-01', replacement: '/new-read' },
                    responses: { 200: 'ok' },
                },
            },
            handlers: { GET: async () => new Response('old', { status: 200 }) },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent({ username: '' }));
        expect(res.status).toBe(401);
        expect(res.headers.get('deprecation')).toBe('@1793491200');
    });

    it('ignores a deprecation block without stability deprecated', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            docs: {
                GET: {
                    tags: ['Test'],
                    summary: 'Read',
                    stability: 'stable',
                    deprecation: { since: '2026-11-01', replacement: '/new-read' },
                    responses: { 200: 'ok' },
                },
            },
            handlers: { GET: async () => new Response('ok', { status: 200 }) },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent());
        expect(res.headers.get('deprecation')).toBeNull();
    });

    it('sends no deprecation headers for a current operation', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            docs: {
                GET: {
                    tags: ['Test'],
                    summary: 'Read',
                    stability: 'stable',
                    responses: { 200: 'ok' },
                },
            },
            handlers: { GET: async () => new Response('ok', { status: 200 }) },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent());
        expect(res.headers.get('deprecation')).toBeNull();
    });

    it('user endpoint returns 401 for unauthenticated request', async () => {
        const def = defineEndpoint({
            auth: { kind: 'user' },
            handlers: {
                GET: async () => new Response('secret', { status: 200 }),
            },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent({ username: '' }));
        expect(res.status).toBe(401);
        expect(await bodyCode(res)).toBe('unauthorized');
    });

    it('user endpoint passes through for authenticated user', async () => {
        const def = defineEndpoint({
            auth: { kind: 'user' },
            handlers: {
                GET: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
            },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent({ username: 'alice' }));
        expect(res.status).toBe(200);
    });

    it('passes ApiContext to handler', async () => {
        let receivedCtx: unknown;
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async (_event, handlerCtx) => {
                    receivedCtx = handlerCtx;
                    return new Response('ok');
                },
            },
        });
        const { GET } = mount(def, ctx);
        await GET!(makeEvent());
        // mount() builds a per-request ctx: the surface fields are passed
        // through, plus the additive input/idempotencyKey slots.
        expect(receivedCtx).toMatchObject(ctx);
    });

    it('per-method auth: GET is public, POST requires user', async () => {
        const def = defineEndpoint({
            auth: {
                GET: { kind: 'public' },
                POST: { kind: 'user' },
            },
            handlers: {
                GET: async () => new Response('list'),
                POST: async () => new Response('created', { status: 201 }),
            },
        });
        const { GET, POST } = mount(def, ctx);

        // GET passes for anon
        const getRes = await GET!(makeEvent({ username: '' }));
        expect(getRes.status).toBe(200);

        // POST fails for anon
        const postRes = await POST!(makeEvent({ username: '' }));
        expect(postRes.status).toBe(401);

        // POST passes for user
        const postResAuth = await POST!(makeEvent({ username: 'alice' }));
        expect(postResAuth.status).toBe(201);
    });

    describe.each(['internal', 'v1'] as const)('%s surface redirects', (surface) => {
        it.each([301, 302, 303, 307, 308] as const)(
            'preserves a real framework %i redirect from a public raw GET',
            async (status) => {
                const location = 'https://requests.example.test/tv/60625';
                const def = defineEndpoint({
                    auth: { kind: 'public' },
                    raw: true,
                    handlers: {
                        GET: async () => redirect(status, location),
                    },
                });
                const { GET } = mount(def, { surface });
                const thrown = await Promise.resolve(GET!(makeEvent({ username: '' }))).then(
                    () => null,
                    (err: unknown) => err,
                );

                expect(isRedirect(thrown)).toBe(true);
                expect(thrown).toMatchObject({ status, location });
            },
        );

        it('preserves a non-raw authenticated POST redirect and rejects anonymous access', async () => {
            const location = '/completed';
            const handler = vi.fn(async () => redirect(303, location));
            const def = defineEndpoint({
                auth: { kind: 'user' },
                docs: {
                    POST: {
                        tags: ['Test'],
                        summary: 'Redirect after submission',
                        responses: {
                            200: { schema: z.object({ ok: z.boolean() }), description: 'ok' },
                        },
                    },
                },
                handlers: { POST: handler },
            });
            const { POST } = mount(def, { surface });
            const event = makeEvent({ username: 'alice' });
            event.request = new Request(event.url, { method: 'POST' });
            const thrown = await Promise.resolve(POST!(event)).catch((err: unknown) => err);
            expect(isRedirect(thrown)).toBe(true);
            expect(thrown).toMatchObject({ status: 303, location });
            expect(handler).toHaveBeenCalledTimes(1);

            const anonymous = makeEvent({ username: '' });
            anonymous.request = new Request(anonymous.url, { method: 'POST' });
            const response = await POST!(anonymous);
            expect(response.status).toBe(401);
            expect(await bodyCode(response)).toBe('unauthorized');
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('converts a redirect lookalike into an internal error', async () => {
            const def = defineEndpoint({
                auth: { kind: 'public' },
                raw: true,
                handlers: {
                    GET: async () => {
                        throw { status: 302, location: 'https://requests.example.test/tv/60625' };
                    },
                },
            });
            const { GET } = mount(def, { surface });
            const res = await GET!(makeEvent({ username: '' }));

            expect(res.status).toBe(500);
            expect(await bodyCode(res)).toBe('internal_error');
        });
    });

    it('catches unhandled errors and returns 500 problem+json', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => {
                    throw new Error('unexpected boom');
                },
            },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(500);
        expect(await bodyCode(res)).toBe('internal_error');
    });

    it("maps adapter-node's body-limit error (SvelteKitError, `status` 413) to 413, not 500", async () => {
        // What `request.formData()` rejects with once a multipart upload passes
        // BODY_SIZE_LIMIT: an Error carrying `status`, not `statusCode`.
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => {
                    throw Object.assign(
                        new Error('Content-length of 1048576 exceeds limit of 524288 bytes.'),
                        { status: 413, text: 'Payload Too Large' },
                    );
                },
            },
        });
        const { GET } = mount(def, ctx);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(413);
        expect(await bodyCode(res)).toBe('payload_too_large');
    });
});

// ---------------------------------------------------------------------------
// mount() — REQUEST / INPUT contract validation
// ---------------------------------------------------------------------------

import { z } from 'zod';

/**
 * Event factory for request-validation tests — supports method, JSON/form body,
 * query string, route params, and Content-Type. (The shared makeEvent() above
 * only covers auth fields.)
 */
function makeReqEvent(
    opts: {
        method?: string;
        path?: string;
        query?: Record<string, string | string[]>;
        params?: Record<string, string>;
        json?: unknown;
        form?: Record<string, string>;
        rawBody?: string;
        contentType?: string;
        idempotencyKey?: string;
    } = {},
): RequestEvent {
    const method = opts.method ?? 'GET';
    const base = 'http://localhost' + (opts.path ?? '/api/v1/test');
    const url = new URL(base);
    if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
            if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, vv));
            else url.searchParams.set(k, v);
        }
    }

    const headers = new Headers();
    if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey);

    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers.set('content-type', opts.contentType ?? 'application/json');
    } else if (opts.form) {
        body = new URLSearchParams(opts.form).toString();
        headers.set('content-type', opts.contentType ?? 'application/x-www-form-urlencoded');
    } else if (opts.rawBody !== undefined) {
        body = opts.rawBody;
        if (opts.contentType) headers.set('content-type', opts.contentType);
    }

    const request = new Request(url, { method, headers, body });

    return {
        url,
        request,
        params: opts.params ?? {},
        route: { id: '/api/v1/test' as const },
        locals: {
            user: { username: 'alice', ownerIsAdmin: false },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('mount(): request body validation', () => {
    const ctx = { surface: 'v1' as const };

    const bodyDef = defineEndpoint({
        auth: { kind: 'public' },
        request: {
            body: z.object({ rating: z.number().min(0).max(10) }),
        },
        handlers: {
            POST: async (_event, c) =>
                new Response(JSON.stringify({ got: c.input?.body }), { status: 200 }),
        },
    });

    it('passes a valid body through and exposes typed ctx.input.body', async () => {
        const { POST } = mount(bodyDef, ctx);
        const res = await POST!(makeReqEvent({ method: 'POST', json: { rating: 7 } }));
        expect(res.status).toBe(200);
        const out = (await res.json()) as { got: { rating: number } };
        expect(out.got).toEqual({ rating: 7 });
    });

    it('rejects an invalid body with validation_failed + field details', async () => {
        const { POST } = mount(bodyDef, ctx);
        const res = await POST!(makeReqEvent({ method: 'POST', json: { rating: 99 } }));
        expect(res.status).toBe(422);
        const out = (await res.json()) as {
            code: string;
            details: Array<{ field: string; message: string }>;
        };
        expect(out.code).toBe('validation_failed');
        expect(out.details[0].field).toBe('body.rating');
        expect(typeof out.details[0].message).toBe('string');
    });

    it('rejects a missing required field with a field-level issue', async () => {
        const { POST } = mount(bodyDef, ctx);
        const res = await POST!(makeReqEvent({ method: 'POST', json: {} }));
        expect(res.status).toBe(422);
        const out = (await res.json()) as { details: Array<{ field: string }> };
        expect(out.details[0].field).toBe('body.rating');
    });

    it('rejects malformed JSON with a body issue', async () => {
        const { POST } = mount(bodyDef, ctx);
        const res = await POST!(
            makeReqEvent({ method: 'POST', rawBody: '{not json', contentType: 'application/json' }),
        );
        expect(res.status).toBe(422);
        const out = (await res.json()) as {
            code: string;
            details: Array<{ field: string }>;
        };
        expect(out.code).toBe('validation_failed');
        expect(out.details[0].field).toBe('body');
    });

    it('STRIPS unknown fields instead of rejecting them (leniency)', async () => {
        const { POST } = mount(bodyDef, ctx);
        const res = await POST!(
            makeReqEvent({
                method: 'POST',
                json: { rating: 5, extra: 'ignored', nested: { a: 1 } },
            }),
        );
        expect(res.status).toBe(200);
        const out = (await res.json()) as { got: Record<string, unknown> };
        expect(out.got).toEqual({ rating: 5 }); // unknown keys dropped, not 422
    });
});

describe('mount(): request.maxBodyBytes cap (C15)', () => {
    const ctx = { surface: 'v1' as const };

    // A lenient schema so a large-but-well-formed body parses fine once it's
    // under the cap — these tests are about SIZE, not shape.
    const permissiveBodyDef = defineEndpoint({
        auth: { kind: 'public' },
        request: {
            body: z.record(z.string(), z.unknown()),
        },
        handlers: {
            POST: vi.fn(async (_event, c) => new Response(JSON.stringify({ got: c.input?.body }))),
        },
    });

    const bigBodyDefWithOverride = defineEndpoint({
        auth: { kind: 'public' },
        request: {
            body: z.record(z.string(), z.unknown()),
            maxBodyBytes: 2_000_000,
        },
        handlers: {
            POST: async (_event, c) => new Response(JSON.stringify({ got: c.input?.body })),
        },
    });

    it('rejects a >256KB JSON body with 413 payload_too_large and never calls the handler', async () => {
        const handler = permissiveBodyDef.handlers.POST as ReturnType<typeof vi.fn>;
        handler.mockClear();
        const { POST } = mount(permissiveBodyDef, ctx);

        const res = await POST!(
            makeReqEvent({ method: 'POST', json: { blob: 'x'.repeat(300_000) } }),
        );

        expect(res.status).toBe(413);
        const out = (await res.json()) as { code: string };
        expect(out.code).toBe('payload_too_large');
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects a Content-Length over the cap BEFORE reading the body stream at all', async () => {
        const { POST } = mount(permissiveBodyDef, ctx);

        // NOTE: a ReadableStream's `pull()` callback fires automatically right
        // after construction to fill its internal queue (per the Streams spec),
        // independent of whether anything ever calls `.getReader()` — so `pull`
        // cannot be used as the "was this stream ever read BY OUR CODE" signal.
        // `getReader()` is what mount.ts's readBoundedBodyText() calls, so spy on
        // that instead.
        const bodyStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ rating: 5 })));
                controller.close();
            },
        });
        const getReaderSpy = vi.spyOn(bodyStream, 'getReader');

        const url = new URL('http://localhost/api/v1/test');
        const headers = new Headers({
            'content-type': 'application/json',
            // Declared far larger than the actual (tiny) body, and far over the cap.
            'content-length': '5000000',
        });
        const request = new Request(url, {
            method: 'POST',
            headers,
            body: bodyStream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        const event = {
            url,
            request,
            params: {},
            route: { id: '/api/v1/test' as const },
            locals: { user: { username: 'alice', ownerIsAdmin: false } },
            cookies: {} as RequestEvent['cookies'],
            fetch: vi.fn(),
            getClientAddress: () => '127.0.0.1',
            platform: undefined,
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: vi.fn(),
        } as unknown as RequestEvent;

        const res = await POST!(event);

        expect(res.status).toBe(413);
        expect(getReaderSpy).not.toHaveBeenCalled();
    });

    it('accepts a ~1MB body when the def declares maxBodyBytes: 2_000_000', async () => {
        const { POST } = mount(bigBodyDefWithOverride, ctx);

        const res = await POST!(
            makeReqEvent({ method: 'POST', json: { blob: 'x'.repeat(1_000_000) } }),
        );

        expect(res.status).toBe(200);
        const out = (await res.json()) as { got: { blob: string } };
        expect(out.got.blob.length).toBe(1_000_000);
    });
});

describe('mount(): request query + params validation', () => {
    const ctx = { surface: 'v1' as const };

    const queryDef = defineEndpoint({
        auth: { kind: 'public' },
        request: {
            query: z.object({
                limit: z.coerce.number().min(1).max(100).optional(),
                include: z.string().optional(),
            }),
            params: z.object({ id: z.string().min(1) }),
        },
        handlers: {
            GET: async (_event, c) =>
                new Response(JSON.stringify({ query: c.input?.query, params: c.input?.params }), {
                    status: 200,
                }),
        },
    });

    it('coerces query strings to typed values and passes params through', async () => {
        const { GET } = mount(queryDef, ctx);
        const res = await GET!(
            makeReqEvent({ query: { limit: '25', include: 'user' }, params: { id: 'abc' } }),
        );
        expect(res.status).toBe(200);
        const out = (await res.json()) as {
            query: { limit: number; include: string };
            params: { id: string };
        };
        expect(out.query.limit).toBe(25); // coerced number, not "25"
        expect(out.query.include).toBe('user');
        expect(out.params.id).toBe('abc');
    });

    it('rejects an out-of-bounds query value with query.<field> detail', async () => {
        const { GET } = mount(queryDef, ctx);
        const res = await GET!(makeReqEvent({ query: { limit: '999' }, params: { id: 'abc' } }));
        expect(res.status).toBe(422);
        const out = (await res.json()) as {
            code: string;
            details: Array<{ field: string }>;
        };
        expect(out.code).toBe('validation_failed');
        expect(out.details.some((d) => d.field === 'query.limit')).toBe(true);
    });

    it('rejects a missing required param with params.<field> detail', async () => {
        const { GET } = mount(queryDef, ctx);
        const res = await GET!(makeReqEvent({ query: {}, params: {} }));
        expect(res.status).toBe(422);
        const out = (await res.json()) as { details: Array<{ field: string }> };
        expect(out.details.some((d) => d.field === 'params.id')).toBe(true);
    });
});

describe('mount(): OAuth form-urlencoded body', () => {
    const ctx = { surface: 'internal' as const };

    // OAuth keeps snake_case + form-urlencoded (documented exception).
    const oauthDef = defineEndpoint({
        auth: { kind: 'public' },
        request: {
            body: z.object({
                grant_type: z.string(),
                device_code: z.string(),
                client_id: z.string().optional(),
            }),
        },
        handlers: {
            POST: async (_event, c) =>
                new Response(JSON.stringify({ got: c.input?.body }), { status: 200 }),
        },
    });

    it('parses application/x-www-form-urlencoded into the typed body', async () => {
        const { POST } = mount(oauthDef, ctx);
        const res = await POST!(
            makeReqEvent({
                method: 'POST',
                form: {
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: 'DC-123',
                    client_id: 'tvos',
                },
            }),
        );
        expect(res.status).toBe(200);
        const out = (await res.json()) as { got: Record<string, string> };
        expect(out.got.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
        expect(out.got.device_code).toBe('DC-123');
        expect(out.got.client_id).toBe('tvos');
    });

    it('rejects a form body missing a required snake_case field', async () => {
        const { POST } = mount(oauthDef, ctx);
        const res = await POST!(makeReqEvent({ method: 'POST', form: { grant_type: 'x' } }));
        expect(res.status).toBe(422);
        const out = (await res.json()) as { details: Array<{ field: string }> };
        expect(out.details.some((d) => d.field === 'body.device_code')).toBe(true);
    });
});

describe('mount(): body double-read is transparent to handlers', () => {
    // REGRESSION: the input contract makes mount() read the body to validate a
    // declared request.body schema. Many handlers ALSO re-read the body via
    // event.request.json()/.text()/.formData(). Before the foundation fix the
    // second read threw "Body already read" and the route returned 422 for a
    // VALID request when hit through the real mount() path. These tests exercise
    // mount() (not the handler directly) so they actually catch that regression.
    const ctx = { surface: 'v1' as const };

    it('handler can call event.request.json() after body-schema validation (JSON)', async () => {
        let handlerError: unknown;
        const def = defineEndpoint({
            auth: { kind: 'public' },
            request: {
                body: z.object({ role: z.enum(['editor', 'readonly']) }),
            },
            handlers: {
                // Mirrors playlists/[id]/members/[memberId].ts: declares a body
                // schema AND re-reads event.request.json() inside the handler.
                PUT: async (event, c) => {
                    let reread: unknown;
                    try {
                        reread = await event.request.json();
                    } catch (err) {
                        handlerError = err;
                        throw err;
                    }
                    return new Response(JSON.stringify({ reread, viaCtx: c.input?.body }), {
                        status: 200,
                    });
                },
            },
        });
        const { PUT } = mount(def, ctx);
        const res = await PUT!(makeReqEvent({ method: 'PUT', json: { role: 'editor' } }));

        expect(handlerError).toBeUndefined(); // no "Body already read"
        expect(res.status).toBe(200); // NOT 422
        const out = (await res.json()) as {
            reread: { role: string };
            viaCtx: { role: string };
        };
        // The handler's own re-read sees the original body…
        expect(out.reread).toEqual({ role: 'editor' });
        // …and ctx.input.body is still populated by mount().
        expect(out.viaCtx).toEqual({ role: 'editor' });
    });

    it('handler can call event.request.text() after body-schema validation', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            request: { body: z.object({ a: z.number() }) },
            handlers: {
                POST: async (event) => {
                    const raw = await event.request.text();
                    return new Response(JSON.stringify({ raw }), { status: 200 });
                },
            },
        });
        const { POST } = mount(def, ctx);
        const res = await POST!(makeReqEvent({ method: 'POST', json: { a: 1 } }));
        expect(res.status).toBe(200);
        const out = (await res.json()) as { raw: string };
        expect(JSON.parse(out.raw)).toEqual({ a: 1 });
    });

    it('handler can call event.request.formData() after form body-schema validation', async () => {
        let handlerError: unknown;
        const def = defineEndpoint({
            auth: { kind: 'public' },
            request: {
                body: z.object({ grant_type: z.string(), device_code: z.string() }),
            },
            handlers: {
                POST: async (event, c) => {
                    let grant: string | undefined;
                    try {
                        const form = await event.request.formData();
                        grant = form.get('grant_type') as string;
                    } catch (err) {
                        handlerError = err;
                        throw err;
                    }
                    return new Response(JSON.stringify({ grant, viaCtx: c.input?.body }), {
                        status: 200,
                    });
                },
            },
        });
        const { POST } = mount(def, ctx);
        const res = await POST!(
            makeReqEvent({
                method: 'POST',
                form: { grant_type: 'device_code', device_code: 'DC-1' },
            }),
        );

        expect(handlerError).toBeUndefined();
        expect(res.status).toBe(200);
        const out = (await res.json()) as {
            grant: string;
            viaCtx: { grant_type: string; device_code: string };
        };
        expect(out.grant).toBe('device_code');
        expect(out.viaCtx).toEqual({ grant_type: 'device_code', device_code: 'DC-1' });
    });

    it('handler re-read still works when the valid body is rejected? (invalid body never reaches handler)', async () => {
        // Guard: an INVALID body must still short-circuit with 422 and never call
        // the handler — the fix must not change that.
        let handlerCalled = false;
        const def = defineEndpoint({
            auth: { kind: 'public' },
            request: { body: z.object({ role: z.enum(['editor', 'readonly']) }) },
            handlers: {
                PUT: async (event) => {
                    handlerCalled = true;
                    await event.request.json();
                    return new Response('ok');
                },
            },
        });
        const { PUT } = mount(def, ctx);
        const res = await PUT!(makeReqEvent({ method: 'PUT', json: { role: 'bogus' } }));
        expect(res.status).toBe(422);
        expect(handlerCalled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// L4: restoreRequestBody() catch-fallback path (mount.ts:432-463) — when
// reassigning `event.request` throws (e.g. a frozen/readonly RequestEvent),
// the function falls back to overriding the body-reading methods in place so
// the handler's own event.request.json()/.text()/.formData() still resolve
// to the buffered body instead of throwing "Body already read".
// ---------------------------------------------------------------------------
describe('mount(): restoreRequestBody catch-fallback (L4)', () => {
    const ctx = { surface: 'v1' as const };

    it('falls back to method overrides when request reassignment throws, keeping json/text/formData readable', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            request: { body: z.object({ role: z.enum(['editor', 'readonly']) }) },
            handlers: {
                PUT: async (event, c) => {
                    const asJson = await event.request.json();
                    const asText = await event.request.text();
                    // Proves the formData() override also resolves without throwing.
                    await event.request.formData();
                    return new Response(JSON.stringify({ asJson, asText, viaCtx: c.input?.body }), {
                        status: 200,
                    });
                },
            },
        });
        const { PUT } = mount(def, ctx);

        const event = makeReqEvent({ method: 'PUT', json: { role: 'editor' } });
        // Freezing the event makes `(event as {request: Request}).request = rebuilt`
        // throw a TypeError (strict-mode assignment to a non-writable property),
        // forcing restoreRequestBody() into its catch-fallback branch.
        Object.freeze(event);

        const res = await PUT!(event);

        expect(res.status).toBe(200); // NOT 500 — the fallback must not throw
        const out = (await res.json()) as {
            asJson: { role: string };
            asText: string;
            viaCtx: { role: string };
        };
        expect(out.asJson).toEqual({ role: 'editor' });
        expect(JSON.parse(out.asText)).toEqual({ role: 'editor' });
        expect(out.viaCtx).toEqual({ role: 'editor' });
    });
});

describe('mount(): no request contract + Idempotency-Key passthrough', () => {
    const ctx = { surface: 'v1' as const };

    it('leaves ctx.input slots undefined when no request schema is declared', async () => {
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                POST: async (_event, c) =>
                    new Response(
                        JSON.stringify({
                            body: c.input?.body ?? null,
                            query: c.input?.query ?? null,
                            params: c.input?.params ?? null,
                        }),
                        { status: 200 },
                    ),
            },
        });
        const { POST } = mount(def, ctx);
        const res = await POST!(makeReqEvent({ method: 'POST', json: { anything: 1 } }));
        expect(res.status).toBe(200);
        const out = (await res.json()) as Record<string, unknown>;
        expect(out).toEqual({ body: null, query: null, params: null });
    });

    it('passes the Idempotency-Key header through on ctx.idempotencyKey', async () => {
        let seen: string | undefined;
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                POST: async (_event, c) => {
                    seen = c.idempotencyKey;
                    return new Response('ok');
                },
            },
        });
        const { POST } = mount(def, ctx);
        await POST!(makeReqEvent({ method: 'POST', idempotencyKey: 'idem-42' }));
        expect(seen).toBe('idem-42');
    });
});

/**
 * Security review 2026-09-12, C1 (defense in depth): readRequestBody() treated a
 * missing Content-Type as "JSON", which is exactly the CORS simple-request shape a
 * cross-site page can send with the victim's cookies. Refuse it on cookie auth;
 * Bearer requests are unaffected.
 */
describe('mount(): a body with no Content-Type is refused on cookie auth', () => {
    const ctx = { surface: 'v1' as const };
    const def = defineEndpoint({
        auth: { kind: 'user' },
        request: { body: z.object({ a: z.number() }) },
        handlers: { POST: async () => new Response('created', { status: 201 }) },
    });

    it('rejects a cookie-authenticated request with a body and no Content-Type', async () => {
        const { POST } = mount(def, ctx);
        const ev = makeReqEvent({ method: 'POST', rawBody: '{"a":1}' });
        ev.request.headers.delete('content-type');
        const res = await POST!(ev);
        // Body errors surface as the 422 validation_failed problem, like malformed JSON.
        expect(res.status).toBe(422);
        const body = (await res.json()) as {
            code: string;
            details: Array<{ field: string; message: string }>;
        };
        expect(body.code).toBe('validation_failed');
        expect(body.details).toEqual([
            { field: 'body', message: 'Content-Type header is required for a request body' },
        ]);
    });

    it('accepts the same body on a Bearer-authenticated request', async () => {
        const { POST } = mount(def, ctx);
        const ev = makeReqEvent({ method: 'POST', rawBody: '{"a":1}' });
        ev.request.headers.delete('content-type');
        ev.request.headers.set('authorization', 'Bearer pat_abc');
        const res = await POST!(ev);
        expect(res.status).toBe(201);
    });
});

/**
 * Security review 2026-09-12, C2: a service token with `forceNonAdmin` was
 * never admin for `{kind:'admin'}` defs, but its expanded scope set still held
 * `admin` and every `*:admin`, so the scope-gated admin plane stayed open.
 */
describe('enforce(): forceNonAdmin service token cannot pass an admin scope gate (C2)', () => {
    const ctx = { surface: 'v1' as const };
    // This is the one place the REAL scopeGranted() must run: the finding is
    // about what buildPrincipal() puts into `principal.scopes`, and a mocked
    // gate would pass or fail regardless of it.
    beforeEach(async () => {
        const actual = await vi.importActual<typeof import('$lib/server/tasks/api-auth.js')>(
            '$lib/server/tasks/api-auth.js',
        );
        mockScopeGranted.mockImplementation(actual.scopeGranted);
    });
    afterEach(() => {
        mockScopeGranted.mockReset();
    });
    const def = defineEndpoint({
        auth: { kind: 'scope', anyOf: ['tokens:admin'] },
        handlers: { GET: async () => new Response('ok') },
    });
    const owner = {
        kind: 'service_token' as const,
        userId: toUserId('00000000-0000-0000-0000-000000000009'),
        username: 'monitor',
        userGroups: ['admins'],
        ownerIsAdmin: true,
    };

    it("forceNonAdmin + scopes ['admin'] -> 403", async () => {
        const { GET } = mount(def, ctx);
        const ev = makeEvent({
            principal: buildPrincipal({ ...owner, tokenScopes: ['admin'], forceNonAdmin: true }),
        });
        const res = await GET!(ev);
        expect(res.status).toBe(403);
    });

    it('the same token without forceNonAdmin -> 200 (control)', async () => {
        const { GET } = mount(def, ctx);
        const ev = makeEvent({
            principal: buildPrincipal({ ...owner, tokenScopes: ['admin'], forceNonAdmin: false }),
        });
        const res = await GET!(ev);
        expect(res.status).toBe(200);
    });
});

describe('mount SQLSTATE fallback', () => {
    beforeEach(() => {
        dbWarn.mockClear();
    });

    it.each(['internal', 'v1'] as const)('maps only known input errors on %s', async (surface) => {
        for (const [code, status, problemCode] of [
            ['22P02', 422, 'validation_failed'],
            ['22003', 422, 'validation_failed'],
            ['23514', 422, 'validation_failed'],
            ['23503', 409, 'conflict'],
            ['23505', 409, 'conflict'],
        ] as const) {
            dbWarn.mockClear();
            const err = Object.assign(new Error('secret parameter'), {
                code,
                constraint_name: 'test_constraint',
                detail: 'secret detail',
                query: 'secret query',
                parameters: ['secret value'],
            });
            const def = defineEndpoint({
                auth: { kind: 'public' },
                handlers: {
                    GET: async () => {
                        throw err;
                    },
                },
            });
            const response = await mount(def, { surface }).GET!(makeEvent());
            expect(response.status, code).toBe(status);
            expect(await bodyCode(response)).toBe(problemCode);
            expect(dbWarn).toHaveBeenCalledWith(expect.any(String), {
                sqlstate: code,
                constraint: 'test_constraint',
            });
            expect(JSON.stringify(dbWarn.mock.calls)).not.toContain('secret');
            expect(await response.text()).not.toContain('secret');
        }
    });

    it('maps a postgres.PostgresError instance', async () => {
        const err = Object.assign(new postgres.PostgresError('private database detail'), {
            code: '23514',
            constraint_name: 'value_check',
        });
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => {
                    throw err;
                },
            },
        });
        expect((await mount(def, { surface: 'v1' }).GET!(makeEvent())).status).toBe(422);
    });

    it.each(['08006', '40001', '42P01', '22001', 'EEXIST', undefined, 23505])(
        'leaves unrelated code %s as 500',
        async (code) => {
            const def = defineEndpoint({
                auth: { kind: 'public' },
                handlers: {
                    GET: async () => {
                        throw { code };
                    },
                },
            });
            const response = await mount(def, { surface: 'internal' }).GET!(makeEvent());
            expect(response.status).toBe(500);
            expect(dbWarn).not.toHaveBeenCalled();
        },
    );

    it('preserves local catches and explicit statusCode, and does not wrap direct calls', async () => {
        const err = { code: '23505', statusCode: 404, message: 'Specific missing resource' };
        const handler = async (): Promise<Response> => {
            throw err;
        };
        const def = defineEndpoint({ auth: { kind: 'public' }, handlers: { GET: handler } });
        await expect(handler()).rejects.toBe(err);
        const response = await mount(def, { surface: 'v1' }).GET!(makeEvent());
        expect(response.status).toBe(404);
        const local = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => {
                    try {
                        return await handler();
                    } catch {
                        return new Response(null, { status: 418 });
                    }
                },
            },
        });
        expect((await mount(local, { surface: 'v1' }).GET!(makeEvent())).status).toBe(418);
        expect(dbWarn).not.toHaveBeenCalled();
    });
});
