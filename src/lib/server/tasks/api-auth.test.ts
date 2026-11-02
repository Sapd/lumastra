// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { scopeGranted, authenticate, ApiAuthError } from './api-auth.js';

const mockSvcValidate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: mockSvcValidate }),
}));
const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: mockPatValidate }),
}));

// Item 1 (2026-09-13 deferred fix): the svc_ branch's identity resolution.
const mockResolveUserIdByUsername = vi.fn();
vi.mock('$lib/server/auth/resolve-user-id.js', () => ({
    resolveUserIdByUsername: (...args: unknown[]) => mockResolveUserIdByUsername(...args),
}));
const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

// Fix round 1 (Critical): the pin-aware owner-admin verdict for a PAT owner
// / non-impersonating creator — consumed via the shared
// resolveOwnerIsAdminFailClosed() (security review 2026-09-23, C6 collapse
// of api-auth.ts's and forward-auth.ts's byte-identical private wrappers),
// never a raw isUserAdmin(groups) re-derivation. Mocked directly as a plain
// vi.fn rather than re-implementing its body in terms of a second mocked
// resolveOwnerAdminStatus. resolveOwnerAdminStatus itself is exported as an
// unused stub only because the module also exports it.
//
// fix-plan-5 Task 3 (C1): the IMPERSONATION-TARGET axis no longer goes
// through this wrapper at all — the shared token-identity.ts producer
// resolves the target's admin verdict the SAME way forward-auth.ts's
// primary /api/v1 producer always has (an inline
// computeOwnerIsAdminOverride() + buildUserPermissions() over the fresh
// impersonation-target row, see the raw-SQL mock below), closing the C1
// target-vs-creator divergence. Only the non-impersonating CREATOR axis
// still uses this wrapper.
const mockResolveOwnerIsAdminFailClosed = vi.fn();
// Task 3 review, Minor 5: computeOwnerIsAdminOverride() is a pure, two-line
// formula (`adminPinned ? isAdminColumn : undefined`) — importOriginal() it
// instead of re-implementing it a third time in a mock factory, so this file
// can never silently drift from the real formula's own tri-state semantics.
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/auth/resolve-owner-admin-status.js')>();
    return {
        resolveOwnerAdminStatus: vi.fn(),
        resolveOwnerIsAdminFailClosed: (...args: unknown[]) =>
            mockResolveOwnerIsAdminFailClosed(...args),
        // API package 15: the non-impersonating owner verdict is resolved by
        // `owner_user_id`; same fixture.
        resolveOwnerIsAdminFailClosedById: (...args: unknown[]) =>
            mockResolveOwnerIsAdminFailClosed(...args),
        computeOwnerIsAdminOverride: actual.computeOwnerIsAdminOverride,
    };
});

// fix-plan-5 Task 3: the PAT owner axis of the shared token-identity.ts
// producer resolves identity via resolveTokenUserAccess() (Formula A), not
// resolveOwnerIsAdminFailClosed() directly. Delegates to the SAME
// mockResolveOwnerIsAdminFailClosed/mockPatValidate fixtures every existing
// test already configures, so those test bodies don't need editing — this
// is mock plumbing, not a behaviour change to what this suite asserts
// (resolveTokenUserAccess's OWN formula has its own unmocked-resolver
// coverage in resolve-token-user-access.test.ts).
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async (username: string) => {
        const validated = await mockPatValidate();
        if (!validated || validated.username !== username) return null;
        const isAdmin = await mockResolveOwnerIsAdminFailClosed(username);
        return {
            userGroups: validated.groups ?? [],
            disabled: false,
            deleted: false,
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                hasReviewPermission: false,
                hasMediaAnnotationPermission: false,
                ownerIsAdmin: isAdmin === true,
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

// fix-plan-5 Task 3 (C1): the service-token IMPERSONATION-TARGET axis now
// reads the target's row via the SAME id-keyed raw `new Database().getSql()`
// query forward-auth.ts's primary /api/v1 producer always used (research
// doc `research-shape-a.md` §Q1: "keep FA's id-keyed fresh query" over the
// old AA copy's `getUserById()` + a second resolveOwnerIsAdminFailClosed
// round trip) — mirrors forward-auth.test.ts's own
// mockImpersonationRow/mockSqlQuery pattern for the identical scenario.
const mockImpersonationRow = {
    username: 'targetuser',
    groups: [] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
    is_admin: false,
    admin_pinned: false,
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

// Valkey is only consulted as an existence-hint cache in the impersonation
// branch — isValkeyReady:false skips every cacheGet/setEx/del call entirely,
// so the fresh DB row above is always the source of truth in this suite.
vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
}));

// In-app access layer for the impersonation target: simple passthrough
// (effective groups = synced groups, no extra capabilities) by default —
// resolveEffectiveAccess has its own dedicated coverage in
// access-control.service.test.ts.
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

// Sane default for every describe block below that doesn't otherwise care
// about service-token identity resolution: a resolvable, non-impersonating
// creator, and a "not admin" verdict. Blocks that DO care override/reset
// these themselves.
beforeEach(() => {
    mockResolveUserIdByUsername
        .mockReset()
        .mockResolvedValue('00000000-0000-4000-8000-000000000000');
    mockGetSql.mockReset().mockResolvedValue({});
    mockResolveOwnerIsAdminFailClosed.mockReset().mockResolvedValue(false);
    mockSqlQuery.mockReset().mockResolvedValue([mockImpersonationRow]);
    mockImpersonationRow.username = 'targetuser';
    mockImpersonationRow.groups = [];
    mockImpersonationRow.disabled_at = null;
    mockImpersonationRow.deleted_at = null;
    mockImpersonationRow.is_admin = false;
    mockImpersonationRow.admin_pinned = false;
    mockImpersonationRow.max_age_rating = null;
    mockImpersonationRow.age_rating_pinned = false;
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

describe('scopeGranted: tasks:run grants runs:read', () => {
    it('a tasks:run token can read runs', () => {
        expect(scopeGranted(['tasks:run'], 'runs:read')).toBe(true);
    });
    it('a no-scope token cannot read runs', () => {
        expect(scopeGranted([], 'runs:read')).toBe(false);
    });
    it('tasks:run still does NOT grant webhooks:write', () => {
        expect(scopeGranted(['tasks:run'], 'webhooks:write')).toBe(false);
    });
});

// C2 (security review 2026-09-12): the legacy authenticate() path stripped only
// 'admin' and 'tasks:admin' for forceNonAdmin tokens; every other *:admin scope
// (users:admin, livetv:admin, …) survived.
describe('authenticate(): forceNonAdmin service token loses every admin-class scope (C2)', () => {
    function svcEvent(): RequestEvent {
        return {
            request: new Request('http://localhost/api/tasks', {
                headers: { authorization: 'Bearer svc_abc' },
            }),
            url: new URL('http://localhost/api/tasks'),
            locals: {},
        } as unknown as RequestEvent;
    }

    it("['admin','users:admin','livetv:admin','read'] -> only 'read' remains", async () => {
        mockSvcValidate.mockResolvedValue({
            id: 7,
            name: 'monitor',
            ownerUserId: '00000000-0000-4000-8000-000000000000',
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: true,
            scopes: ['admin', 'users:admin', 'livetv:admin', 'read'],
        });
        const auth = await authenticate(svcEvent());
        expect(auth.scopes).toEqual(['read']);
        expect(scopeGranted(auth.scopes, 'users:admin')).toBe(false);
    });

    it('forceNonAdmin=false keeps the scopes verbatim while the creator IS admin (control)', async () => {
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(true);
        mockSvcValidate.mockResolvedValue({
            id: 8,
            name: 'ci',
            ownerUserId: '00000000-0000-4000-8000-000000000000',
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin', 'read'],
        });
        const auth = await authenticate(svcEvent());
        expect(auth.scopes).toEqual(['admin', 'read']);
    });
});

// 2026-10-02: a token can never hold more than its owner. authenticate()
// strips admin-class scopes when the owner (PAT) / creator or impersonation
// target (service token) is not CURRENTLY admin — the same
// stripsAdminScopesForToken() predicate buildPrincipal() uses, so this
// {kind:'scope'} fallback and the Principal path cannot disagree.
describe('authenticate(): admin-class scopes stripped when the owner is no longer admin', () => {
    function svcEvent(): RequestEvent {
        return {
            request: new Request('http://localhost/api/admin/x', {
                headers: { authorization: 'Bearer svc_abc' },
            }),
            url: new URL('http://localhost/api/admin/x'),
            locals: {},
        } as unknown as RequestEvent;
    }

    it("service token ['admin','read'] whose creator is demoted keeps only 'read'", async () => {
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(false);
        mockSvcValidate.mockResolvedValue({
            id: 10,
            name: 'monitor',
            ownerUserId: '00000000-0000-4000-8000-000000000000',
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['admin', 'read'],
        });
        const auth = await authenticate(svcEvent());
        expect(auth.scopes).toEqual(['read']);
        expect(scopeGranted(auth.scopes, 'metrics:read')).toBe(false);
        expect(scopeGranted(auth.scopes, 'users:read')).toBe(false);
    });

    it("PAT ['admin','write'] whose owner is no longer admin keeps only 'write'", async () => {
        // resolveTokenUserAccess() (mocked above) answers the owner's live
        // Formula-A verdict from mockResolveOwnerIsAdminFailClosed.
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(false);
        mockPatValidate.mockResolvedValue({
            id: 12,
            userId: '00000000-0000-4000-8000-000000000001',
            username: 'demoted',
            scopes: ['admin', 'write'],
            forceNonAdmin: false,
        });
        const auth = await authenticate({
            request: new Request('http://localhost/api/admin/x', {
                headers: { authorization: 'Bearer pat_abc' },
            }),
            url: new URL('http://localhost/api/admin/x'),
            locals: {},
        } as unknown as RequestEvent);
        expect(auth.scopes).toEqual(['write']);
        expect(scopeGranted(auth.scopes, 'tasks:admin')).toBe(false);
        expect(scopeGranted(auth.scopes, 'media:write')).toBe(true);
    });

    it('legacy fine-grained admin scope without literal admin is stripped (fail-closed)', async () => {
        // The producer's service-token verdict requires the literal 'admin'
        // scope, so a non-mintable legacy ['users:admin'] row reads as
        // non-admin and loses it, even under an admin creator.
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(true);
        mockSvcValidate.mockResolvedValue({
            id: 11,
            name: 'legacy',
            ownerUserId: '00000000-0000-4000-8000-000000000000',
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['users:admin', 'read'],
        });
        const auth = await authenticate(svcEvent());
        expect(auth.scopes).toEqual(['read']);
    });
});

// C20: mount.ts's enforce() {kind:'scope'} fallback (used for Bearer callers on
// /api/admin/* — forward-auth deliberately skips Principal construction there,
// see hooks.server.ts's "Bearer exception") needs a real caller identity to
// build a Principal from. Before this, handlers fell back to reading
// event.locals.user?.username, which is never populated on that path either,
// so callers pooled under mismatched sentinels ('unknown' in init.ts, '' in
// the other three).
describe('authenticate(): identity (C20)', () => {
    function patEvent(): RequestEvent {
        return {
            request: new Request('http://localhost/api/admin/upload/lib1/init', {
                headers: { authorization: 'Bearer pat_abc' },
            }),
            url: new URL('http://localhost/api/admin/upload/lib1/init'),
            locals: {},
        } as unknown as RequestEvent;
    }

    function svcEvent(): RequestEvent {
        return {
            request: new Request('http://localhost/api/admin/upload/lib1/init', {
                headers: { authorization: 'Bearer svc_abc' },
            }),
            url: new URL('http://localhost/api/admin/upload/lib1/init'),
            locals: {},
        } as unknown as RequestEvent;
    }

    it('a valid PAT resolves identity from the already-fetched owner row, plus a pin-aware ownerIsAdmin', async () => {
        mockPatValidate.mockResolvedValue({
            id: 3,
            userId: '11111111-1111-4111-8111-111111111111',
            username: 'alice',
            name: 'upload token',
            scopes: ['library:admin'],
            groups: ['users'],
            jellyfinUserId: null,
            tokenPrefix: 'pat_abc',
            allowedIps: null,
        });
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(false);
        const auth = await authenticate(patEvent());
        expect(auth.identity).toEqual({
            userId: '11111111-1111-4111-8111-111111111111',
            username: 'alice',
            userGroups: ['users'],
            ownerIsAdmin: false,
        });
        expect(mockResolveOwnerIsAdminFailClosed).toHaveBeenCalledWith('alice');
    });

    // Fix round 1 (Critical): a PAT owner whose IdP groups include the admin
    // group but who is PIN-DEMOTED (admin_pinned:true, is_admin:false) must
    // NOT resolve ownerIsAdmin:true — a raw isUserAdmin(groups) check would
    // have gotten this wrong.
    it('a PIN-DEMOTED PAT owner resolves ownerIsAdmin:false even though live groups include the admin group', async () => {
        mockPatValidate.mockResolvedValue({
            id: 4,
            userId: '22222222-2222-4222-8222-222222222222',
            username: 'carol',
            name: 'carol token',
            scopes: ['library:admin'],
            groups: ['admins'], // stale IdP membership — pin overrides it
            jellyfinUserId: null,
            tokenPrefix: 'pat_carol',
            allowedIps: null,
        });
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(false); // admin_pinned:true, is_admin:false
        const auth = await authenticate(patEvent());
        expect(auth.identity?.ownerIsAdmin).toBe(false);
    });

    // Item 1 (2026-09-13 deferred fix): the svc_ branch previously left
    // `identity` unset unconditionally — the mount.ts C20 fallback then
    // never materialised a Principal for a service-token caller, so the
    // four chunked-upload handlers (and any other {kind:'scope'} def) 401'd
    // every service-token Bearer caller. See resolveServiceTokenIdentity()
    // in api-auth.ts, mirroring forward-auth.ts's handleServiceTokenAuth.
    describe('service token identity resolution', () => {
        beforeEach(() => {
            mockResolveUserIdByUsername.mockReset();
            mockGetSql.mockReset().mockResolvedValue({});
        });

        it('a non-impersonating admin-scoped token resolves ownerIsAdmin:true only when the CREATING admin is CURRENTLY (pin-aware) admin', async () => {
            mockResolveOwnerIsAdminFailClosed.mockResolvedValue(true);
            mockSvcValidate.mockResolvedValue({
                id: 9,
                name: 'ci',
                createdBy: 'the-admin',
                ownerUserId: '99999999-9999-4999-8999-999999999999',
                actAsUser: null,
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['admin'],
            });
            const auth = await authenticate(svcEvent());
            expect(auth.identity).toEqual({
                userId: '99999999-9999-4999-8999-999999999999',
                username: 'service:ci',
                userGroups: ['admin'],
                ownerIsAdmin: true,
            });
            // API package 15: the owner is the token's owner_user_id, never
            // resolved from the created_by username label.
            expect(mockResolveUserIdByUsername).not.toHaveBeenCalled();
            // C3 fix (security review 2026-09-15): the creator's CURRENT
            // pin-aware admin status is now consulted for a non-impersonating
            // ADMIN-SCOPED token — closes the "demoted-creator asymmetry"
            // deliberately deferred in the 2026-09-13 round.
            expect(mockResolveOwnerIsAdminFailClosed).toHaveBeenCalledWith(
                '99999999-9999-4999-8999-999999999999',
            );
        });

        it('a non-impersonating admin-scoped token whose CREATOR is pin-demoted resolves ownerIsAdmin:false despite the creator holding an admin group', async () => {
            // admin_pinned:true, is_admin:false — resolveOwnerAdminStatus's
            // own formula already collapses this to isAdmin:false; this test
            // only asserts resolveServiceTokenIdentity CONSUMES that verdict
            // (via the collapsed resolveOwnerIsAdminFailClosed wrapper)
            // instead of re-deriving scope-only synthIsAdmin.
            mockResolveOwnerIsAdminFailClosed.mockResolvedValue(false);
            mockSvcValidate.mockResolvedValue({
                id: 13,
                name: 'ci-demoted-owner',
                createdBy: 'the-admin',
                ownerUserId: '99999999-9999-4999-8999-999999999999',
                actAsUser: null,
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['admin'],
            });
            const auth = await authenticate(svcEvent());
            expect(auth.identity?.ownerIsAdmin).toBe(false);
            expect(auth.identity?.userGroups).toEqual([]);
        });

        it("a non-impersonating token without admin scope gets an EMPTY synthetic group set and ownerIsAdmin:false, not the creator's own groups/pin", async () => {
            mockSvcValidate.mockResolvedValue({
                id: 10,
                name: 'monitor',
                createdBy: 'the-admin',
                ownerUserId: '88888888-8888-4888-8888-888888888888',
                actAsUser: null,
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['read'],
            });
            const auth = await authenticate(svcEvent());
            expect(auth.identity?.userGroups).toEqual([]);
            expect(auth.identity?.ownerIsAdmin).toBe(false);
        });

        it('forceNonAdmin strips the synthetic admin group and ownerIsAdmin even with admin scope', async () => {
            mockSvcValidate.mockResolvedValue({
                id: 11,
                name: 'sandboxed',
                createdBy: 'the-admin',
                ownerUserId: '77777777-7777-4777-8777-777777777777',
                actAsUser: null,
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: true,
                scopes: ['admin'],
            });
            const auth = await authenticate(svcEvent());
            expect(auth.identity?.userGroups).toEqual([]);
            expect(auth.identity?.ownerIsAdmin).toBe(false);
            expect(auth.forceNonAdmin).toBe(true);
        });

        it('a token without owner_user_id fails closed 403', async () => {
            mockSvcValidate.mockResolvedValue({
                id: 12,
                name: 'ci',
                createdBy: 'ghost-admin',
                ownerUserId: null,
                actAsUser: null,
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['admin'],
            });
            await expect(authenticate(svcEvent())).rejects.toMatchObject({
                statusCode: 403,
            });
        });

        // fix-plan-5 Task 3 (C1): this identity now comes from the SAME
        // shared token-identity.ts producer forward-auth.ts's /api/v1
        // primary authority uses (the id-keyed raw-SQL row + inline
        // computeOwnerIsAdminOverride()/buildUserPermissions() formula), NOT
        // resolveOwnerIsAdminFailClosed() — that wrapper is now the
        // non-impersonating CREATOR axis's helper only. `userId` comes
        // straight from the token's own `actAsUser` field (a stable
        // users.id UUID since mig 16.46.0), not from the row.
        it('an impersonating token resolves identity to the ACTIVE target user, non-admin (unpinned, non-admin group)', async () => {
            mockImpersonationRow.username = 'alice';
            mockImpersonationRow.groups = ['users'];
            mockSvcValidate.mockResolvedValue({
                id: 13,
                name: 'impersonator',
                createdBy: 'the-admin',
                actAsUser: '66666666-6666-4666-8666-666666666666',
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['library:admin'],
            });
            const auth = await authenticate(svcEvent());
            expect(auth.identity).toEqual({
                userId: '66666666-6666-4666-8666-666666666666',
                username: 'alice',
                userGroups: ['users'],
                ownerIsAdmin: false,
            });
            // Non-impersonating creator resolution must NOT also run.
            expect(mockResolveUserIdByUsername).not.toHaveBeenCalled();
            expect(mockResolveOwnerIsAdminFailClosed).not.toHaveBeenCalled();
        });

        // Fix round 1 (CRITICAL, carried from the earlier fix waves): the
        // review's exact failure scenario — an impersonation target whose
        // IdP groups still include the admin group, but who is PIN-DEMOTED
        // (admin_pinned:true, is_admin:false). A raw isUserAdmin(target.groups)
        // check (the pre-fix code at the mount.ts call site) would have
        // returned true here; the pin-aware formula must return false, and
        // THAT is what identity.ownerIsAdmin must carry.
        it('a PIN-DEMOTED admin impersonation target resolves ownerIsAdmin:false despite live groups including the admin group', async () => {
            mockImpersonationRow.username = 'carol';
            mockImpersonationRow.groups = ['admins']; // stale IdP membership
            mockImpersonationRow.is_admin = false;
            mockImpersonationRow.admin_pinned = true; // pin DEMOTES, overriding the stale group
            mockSvcValidate.mockResolvedValue({
                id: 16,
                name: 'impersonator',
                createdBy: 'the-admin',
                actAsUser: '33333333-3333-4333-8333-333333333333',
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['admin'],
            });
            const auth = await authenticate(svcEvent());
            expect(auth.identity?.userGroups).toEqual(['admins']);
            expect(auth.identity?.ownerIsAdmin).toBe(false);
        });

        it('an impersonating token whose target is DISABLED fails closed 403, message does not name the target', async () => {
            mockImpersonationRow.username = 'disabled-user';
            mockImpersonationRow.groups = ['users'];
            mockImpersonationRow.disabled_at = new Date('2026-01-01');
            mockSvcValidate.mockResolvedValue({
                id: 14,
                name: 'impersonator',
                createdBy: 'the-admin',
                actAsUser: '55555555-5555-4555-8555-555555555555',
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['library:admin'],
            });
            const err = await authenticate(svcEvent()).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ApiAuthError);
            expect((err as ApiAuthError).statusCode).toBe(403);
            expect((err as ApiAuthError).message).not.toContain('disabled-user');
        });

        // Security review 2026-09-17, C17: this producer (and its mirror,
        // forward-auth.ts's `handleServiceTokenAuth` impersonation branch)
        // must check `users.deleted_at`, not just `disabled_at`.
        it('an impersonating token whose target is SOFT-DELETED fails closed 403, message does not name the target', async () => {
            mockImpersonationRow.username = 'deleted-user';
            mockImpersonationRow.groups = ['users'];
            mockImpersonationRow.deleted_at = new Date('2026-01-01');
            mockSvcValidate.mockResolvedValue({
                id: 18,
                name: 'impersonator',
                createdBy: 'the-admin',
                actAsUser: '99999999-9999-4999-8999-999999999999',
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['library:admin'],
            });
            const err = await authenticate(svcEvent()).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ApiAuthError);
            expect((err as ApiAuthError).statusCode).toBe(403);
            expect((err as ApiAuthError).message).not.toContain('deleted-user');
        });

        it('an impersonating token whose target is MISSING fails closed 403', async () => {
            mockSqlQuery.mockResolvedValueOnce([]);
            mockSvcValidate.mockResolvedValue({
                id: 15,
                name: 'impersonator',
                createdBy: 'the-admin',
                actAsUser: '44444444-4444-4444-8444-444444444444',
                allowedPathPrefixes: null,
                allowedMethods: null,
                forceNonAdmin: false,
                scopes: ['library:admin'],
            });
            await expect(authenticate(svcEvent())).rejects.toMatchObject({ statusCode: 403 });
        });
    });
});

// Task 3 review, Important 2 (controller ruling: ACCEPTED as intended): a
// forceNonAdmin PAT reaching this {kind:'scope'} fallback used to keep its
// raw admin-class scopes here — this branch never called stripAdminScopes()
// for PAT the way the service-token branch always has (security review
// 2026-09-12, C2). A sandboxed (forceNonAdmin) admin-scoped PAT could
// therefore still pass `requireScope(auth, 'users:admin')` on this fallback,
// even though the SAME token correctly loses admin on every Principal-based
// surface. Fixed as a direct, intended consequence of collapsing the PAT and
// service-token branches onto one code path (Global Constraint 4) — not a
// new finding, but flagged here as an accepted intentional behaviour change.
describe('authenticate(): forceNonAdmin PAT loses every admin-class scope (Task 3 review, Important 2)', () => {
    function patEvent(): RequestEvent {
        return {
            request: new Request('http://localhost/api/admin/pats', {
                headers: { authorization: 'Bearer pat_sandboxed' },
            }),
            url: new URL('http://localhost/api/admin/pats'),
            locals: {},
        } as unknown as RequestEvent;
    }

    beforeEach(() => {
        mockPatValidate.mockResolvedValue({
            id: 20,
            userId: '55555555-5555-4555-8555-555555555555',
            username: 'sandboxed-user',
            name: 'sandboxed token',
            scopes: ['admin', 'users:admin', 'read'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'pat_sandboxed',
            allowedIps: null,
            forceNonAdmin: true,
        });
    });

    it("['admin','users:admin','read'] with forceNonAdmin:true -> scopes ['read'], forceNonAdmin true", async () => {
        const auth = await authenticate(patEvent());
        expect(auth.scopes).toEqual(['read']);
        expect(auth.forceNonAdmin).toBe(true);
        expect(scopeGranted(auth.scopes, 'users:admin')).toBe(false);
    });

    it("mount.ts's {kind:'scope', anyOf:['users:admin']} denies this PAT with 403", async () => {
        const { enforce } = await import('$lib/server/api/mount.js');
        const event = patEvent();
        const response = await enforce({ kind: 'scope', anyOf: ['users:admin'] }, event);
        expect(response).not.toBeNull();
        expect((response as Response).status).toBe(403);
    });
});

// API package 15: an `integrations:read` token authenticates only on its three
// endpoints, judged on the routed path, through this {kind:'scope'} fallback too.
describe('authenticate(): integrations:read service token', () => {
    function svcEventAt(path: string): RequestEvent {
        return {
            request: new Request(`http://localhost${path}`, {
                headers: { authorization: 'Bearer svc_abc' },
            }),
            url: new URL(`http://localhost${path}`),
            locals: {},
        } as unknown as RequestEvent;
    }

    beforeEach(() => {
        mockResolveOwnerIsAdminFailClosed.mockResolvedValue(true);
        mockSvcValidate.mockResolvedValue({
            id: 15,
            name: 'homepage',
            ownerUserId: '00000000-0000-4000-8000-000000000000',
            actAsUser: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            scopes: ['integrations:read'],
        });
    });

    it.each([
        '/api/tasks/runs',
        '/api/admin/x',
        '/api/v1/integrations/keys/1',
        '/api/v1/integr%61tions/keys/1',
    ])('is refused on %s', async (path) => {
        await expect(authenticate(svcEventAt(path))).rejects.toMatchObject({ statusCode: 403 });
    });

    it.each(['/api/v1/integrations/watch-history', '/api/v1/integr%61tions/watch-history'])(
        'authenticates on %s',
        async (path) => {
            const auth = await authenticate(svcEventAt(path));
            expect(auth.scopes).toEqual(['integrations:read']);
        },
    );
});
