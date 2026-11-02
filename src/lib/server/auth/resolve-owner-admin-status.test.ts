// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUserByUsername = vi.fn();
const mockGetUserById = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

// Deliberately does NOT mock '$lib/server/auth.js': computeOwnerIsAdmin (fix,
// security review 2026-09-23, C6) composes the REAL buildUserPermissions() —
// that composition IS the thing under test (Formula A), so stubbing it would
// put the predicate in the mock (Global Constraint 2). Only the config module
// underneath it is mocked, to make ADMIN_GROUPS deterministic.
vi.mock('$lib/server/config.js', () => ({
    config: {
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
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// resolveOwnerAdminStatus calls resolveEffectiveAccess (the in-app group ->
// capability layer) whenever the owner is UNPINNED — skipped entirely when
// pinned, since the pin decides on its own. Mocked at the leaf so the formula
// itself (computeOwnerIsAdmin / buildUserPermissions) runs for real.
const mockResolveEffectiveAccess = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) => mockResolveEffectiveAccess(...args),
}));

// Leaf for resolveOwnerIsAdminFailClosed()'s own sql lookup (fix round 1,
// fix-plan-5 task-1 review, MINOR 4) — mocked here, NOT resolveOwnerAdminStatus
// or resolveOwnerIsAdminFailClosed itself, so its direct unit tests below
// exercise the real function end to end.
const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

import {
    resolveOwnerAdminStatus,
    resolveOwnerIsAdminFailClosed,
    resolveOwnerIsAdminFailClosedById,
    computeOwnerIsAdmin,
    computeOwnerIsAdminOverride,
} from './resolve-owner-admin-status.js';

describe('resolveOwnerAdminStatus', () => {
    beforeEach(() => {
        mockGetUserByUsername.mockReset();
        mockResolveEffectiveAccess.mockReset();
        // Sane default for tests that don't care about the in-app layer:
        // no in-app groups, no capabilities, effectiveGroups === input groups.
        mockResolveEffectiveAccess.mockImplementation(
            async (_sql: unknown, _userId: string, groups: string[]) => ({
                inAppGroupNames: [],
                effectiveGroups: groups,
                capabilities: {},
            }),
        );
    });

    it('returns null when the username has no resolvable users row', async () => {
        mockGetUserByUsername.mockResolvedValue(null);
        const result = await resolveOwnerAdminStatus({} as never, 'ghost');
        expect(result).toBeNull();
    });

    it('lowercases the username before lookup', async () => {
        mockGetUserByUsername.mockResolvedValue(null);
        await resolveOwnerAdminStatus({} as never, 'AdminUser');
        expect(mockGetUserByUsername).toHaveBeenCalledWith(expect.anything(), 'adminuser');
    });

    it('pinned admin_pinned=true, is_admin=true is admin REGARDLESS of live groups', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            admin_pinned: true,
            is_admin: true,
            groups: ['regular-user'], // NOT an admin group — pin overrides
        });

        const result = await resolveOwnerAdminStatus({} as never, 'pinned-admin');
        expect(result?.isAdmin).toBe(true);
        // The pin path must skip the in-app round trip entirely — it is
        // authoritative and does not need resolveEffectiveAccess at all.
        expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
        // Fix round 1 (Important #1): adminPinned must be exposed on the
        // result so a caller (forward-auth.ts's computeOwnerIsAdminOverride
        // consumer) can decide WHETHER to apply isAdmin as an override,
        // rather than consuming it as the final verdict unconditionally.
        expect(result?.adminPinned).toBe(true);
    });

    it('pinned admin_pinned=true, is_admin=false is NOT admin even with a stale admin group', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000002',
            admin_pinned: true,
            is_admin: false,
            groups: ['admins'], // stale IdP group — pin demotes anyway
        });

        const result = await resolveOwnerAdminStatus({} as never, 'demoted-pinned');
        expect(result?.isAdmin).toBe(false);
        expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
    });

    // GUARD (security review 2026-09-23, C6; carries forward 2026-09-15's
    // C2 HIGH): the in-app `admin` capability must sit UNDER the pin, same
    // as a stale IdP admin group. A pin that explicitly DEMOTES a user
    // (admin_pinned=true, is_admin=false) must stay non-admin even when the
    // in-app layer would separately grant `admin`. This must be GREEN both
    // before and after the C6 fix — see the fix-plan-5 task-1 report for the
    // discrimination proof (a scratch edit that ORed the in-app term in
    // ABOVE the pin was observed to turn this RED, then was reverted by
    // hand — never with git).
    it('pinned-demoted owner stays non-admin even with an in-app admin capability (GUARD)', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000005',
            admin_pinned: true,
            is_admin: false,
            groups: ['admins'], // stale IdP admin group — pin already demotes this alone
        });
        // In-app layer separately says "admin" — must NOT re-elevate a pinned demotion.
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['in-app-admins'],
            effectiveGroups: ['admins', 'in-app-admins'],
            capabilities: { ownerIsAdmin: true },
        });

        const result = await resolveOwnerAdminStatus({} as never, 'pinned-demoted-inapp-admin');
        expect(result?.isAdmin).toBe(false);
        // Pinned still means the in-app round trip is skipped — the fixture
        // above configures it defensively, but resolveOwnerAdminStatus must
        // never even ask.
        expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
    });

    it('unpinned falls back to live group membership', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000003',
            admin_pinned: false,
            is_admin: false, // stale/never-synced column value — ignored when unpinned
            groups: ['admins'], // matches the mocked config.ADMIN_GROUPS
        });

        const result = await resolveOwnerAdminStatus({} as never, 'synced-admin');
        expect(result?.isAdmin).toBe(true);
        expect(mockResolveEffectiveAccess).toHaveBeenCalledWith(
            expect.anything(),
            '00000000-0000-0000-0000-000000000003',
            ['admins'],
        );
        expect(result?.adminPinned).toBe(false);
    });

    // RED at HEAD (security review 2026-09-23, C6): resolveOwnerAdminStatus
    // never consulted the in-app layer at all — an unpinned owner whose ONLY
    // admin grant is the in-app `admin` capability was denied here even
    // though every other admin surface (resolveTokenUserAccess, the SSO
    // session after this fix, native sessions) already grants it via
    // buildUserPermissions's `extra?.isAdmin === true` OR-term. GREEN now
    // that resolveOwnerAdminStatus calls resolveEffectiveAccess when unpinned
    // and feeds its `capabilities.isAdmin` into the same formula.
    it('[C6] unpinned owner becomes admin via an in-app admin CAPABILITY alone', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000006',
            admin_pinned: false,
            is_admin: false,
            groups: ['users'], // not an admin group
        });
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: { ownerIsAdmin: true },
        });

        const result = await resolveOwnerAdminStatus({} as never, 'inapp-capability-admin');
        expect(result?.isAdmin).toBe(true);
    });

    // RED at HEAD (fix-plan-3 ledger :170): resolveOwnerAdminStatus fed
    // computeOwnerIsAdmin the RAW `users.groups` column, never the in-app-
    // merged `effectiveGroups`. An in-app group whose NAME happens to match
    // a configured ADMIN_GROUPS entry (distinct from the `admin` capability
    // case above — no capability row at all here) therefore counts on every
    // Formula-A surface (which runs hasGroupPermission over effectiveGroups)
    // but did not here. GREEN now that resolveOwnerAdminStatus uses
    // effectiveGroups. Reachability note (task-1 report): createAccessGroup()
    // rejects a group NAME that collides with config.ADMIN_GROUPS at
    // creation time, so this state is not reachable via the group-management
    // API today — only via an ADMIN_GROUPS config change made AFTER an
    // in-app group with that name already exists. See also the pure
    // computeOwnerIsAdmin unit case below.
    it('[C6/ledger:170] unpinned owner becomes admin via an in-app group NAME matching ADMIN_GROUPS', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000007',
            admin_pinned: false,
            is_admin: false,
            groups: ['users'], // raw synced groups — no admin name here
        });
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['admins'], // matches the mocked config.ADMIN_GROUPS by NAME
            effectiveGroups: ['users', 'admins'],
            capabilities: {}, // no capability row at all — pure group-name path
        });

        const result = await resolveOwnerAdminStatus({} as never, 'inapp-groupname-admin');
        expect(result?.isAdmin).toBe(true);
        expect(result?.effectiveGroups).toEqual(['users', 'admins']);
    });

    it('treats a null groups column as an empty array for the unpinned path', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000004',
            admin_pinned: false,
            is_admin: false,
            groups: null,
        });

        const result = await resolveOwnerAdminStatus({} as never, 'no-groups');
        expect(result?.groups).toEqual([]);
        expect(result?.effectiveGroups).toEqual([]);
        expect(mockResolveEffectiveAccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            [],
        );
    });

    // Fail-closed on the admin axis specifically (security review 2026-09-23,
    // C6): an in-app lookup failure must be treated as "no in-app admin to
    // add", never as "in-app admin" — mirrors resolveInAppAccessSafe's
    // identical catch-shape in resolve-token-user-access.ts.
    it('fails closed on the admin axis when resolveEffectiveAccess throws for an unpinned owner', async () => {
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000008',
            admin_pinned: false,
            is_admin: false,
            groups: ['users'],
        });
        mockResolveEffectiveAccess.mockRejectedValue(new Error('DB blip'));

        const result = await resolveOwnerAdminStatus({} as never, 'inapp-error');
        expect(result?.isAdmin).toBe(false);
        expect(result?.effectiveGroups).toEqual(['users']);
    });
});

// C2/C3 (security review 2026-09-15), extended for C6 (2026-09-23):
// computeOwnerIsAdmin() is the pure formula resolveOwnerAdminStatus() wraps,
// exported so a caller that already holds a `users` row (and, since C6, an
// in-app verdict) can apply the SAME logic without a second, username-keyed
// DB round trip. This describe block is the "divergence guard": if
// resolveOwnerAdminStatus() and computeOwnerIsAdmin() ever disagree for the
// same inputs, one of them stopped being a thin wrapper around the other.
describe('computeOwnerIsAdmin — the shared pure formula, and its agreement with resolveOwnerAdminStatus', () => {
    beforeEach(() => {
        mockGetUserByUsername.mockReset();
        mockResolveEffectiveAccess.mockReset();
    });

    it.each([
        {
            effectiveGroups: ['regular-user'],
            isAdminColumn: true,
            adminPinned: true,
            inAppIsAdmin: false,
            expected: true,
        },
        {
            effectiveGroups: ['admins'],
            isAdminColumn: false,
            adminPinned: true,
            inAppIsAdmin: true, // must NOT re-elevate a pinned demotion
            expected: false,
        },
        {
            effectiveGroups: [],
            isAdminColumn: false,
            adminPinned: false,
            inAppIsAdmin: false,
            expected: false,
        },
        {
            // C6: no group/column admin at all — the in-app capability alone decides.
            effectiveGroups: ['users'],
            isAdminColumn: false,
            adminPinned: false,
            inAppIsAdmin: true,
            expected: true,
        },
    ])(
        'agrees with resolveOwnerAdminStatus for effectiveGroups=$effectiveGroups is_admin=$isAdminColumn admin_pinned=$adminPinned inAppIsAdmin=$inAppIsAdmin',
        async ({ effectiveGroups, isAdminColumn, adminPinned, inAppIsAdmin, expected }) => {
            expect(
                computeOwnerIsAdmin(effectiveGroups, isAdminColumn, adminPinned, inAppIsAdmin),
            ).toBe(expected);

            mockGetUserByUsername.mockResolvedValue({
                id: '00000000-0000-0000-0000-000000000099',
                admin_pinned: adminPinned,
                is_admin: isAdminColumn,
                groups: effectiveGroups,
            });
            mockResolveEffectiveAccess.mockResolvedValue({
                inAppGroupNames: [],
                effectiveGroups,
                capabilities: inAppIsAdmin ? { ownerIsAdmin: true } : {},
            });
            const viaResolve = await resolveOwnerAdminStatus({} as never, 'someone');
            expect(viaResolve?.isAdmin).toBe(expected);
        },
    );

    // Pure-unit reachability case for fix-plan-3 ledger :170 (see the task-1
    // report for the reachability note: createAccessGroup() rejects a
    // reserved-name group at creation time, so this exact effectiveGroups
    // shape is not reachable via the group-management API today — only via
    // an ADMIN_GROUPS config change made after group creation). Written
    // directly against the pure formula rather than through
    // resolveOwnerAdminStatus, per the task brief, precisely because the
    // resolveOwnerAdminStatus-level equivalent
    // ("[C6/ledger:170] unpinned owner becomes admin via an in-app group
    // NAME matching ADMIN_GROUPS", above) already carries the RED-before-
    // GREEN evidence for the wiring; this case pins the formula in isolation.
    it('[ledger:170] an in-app group NAME equal to a configured ADMIN_GROUPS entry elevates via hasGroupPermission, with NO capability row', () => {
        expect(computeOwnerIsAdmin(['users', 'admins'], false, false, false)).toBe(true);
        // Isolate the mechanism: the SAME effectiveGroups without the
        // admin-named entry, and the SAME false inAppIsAdmin, is not admin.
        expect(computeOwnerIsAdmin(['users'], false, false, false)).toBe(false);
    });
});

// FIX ROUND 3 (security review 2026-09-16), extended for C6 (2026-09-23):
// computeOwnerIsAdminOverride() is the tri-state primitive
// `computeOwnerIsAdmin()` above composes internally
// (`buildUserPermissions(effectiveGroups, { isAdminOverride:
// computeOwnerIsAdminOverride(...), extraCapabilities })`), and the ONE tri-
// state forward-auth.ts's service-token impersonation branch,
// resolve-token-user-access.ts's resolveTokenUserAccess(), and (as of C6)
// resolveDbAuth()'s SSO session path all call directly — replacing
// independently-maintained inline `adminPinned ? isAdmin : undefined`
// ternaries that had no shared test coverage.
describe('computeOwnerIsAdminOverride — the shared tri-state primitive for buildUserPermissions({ isAdminOverride })', () => {
    it('pinned: returns the raw is_admin column value, even false', () => {
        expect(computeOwnerIsAdminOverride(true, true)).toBe(true);
        expect(computeOwnerIsAdminOverride(false, true)).toBe(false);
    });

    it("unpinned: returns undefined regardless of is_admin, so the caller's own groups/in-app check decides", () => {
        expect(computeOwnerIsAdminOverride(true, false)).toBeUndefined();
        expect(computeOwnerIsAdminOverride(false, false)).toBeUndefined();
    });

    // The exact attack state named across every round of this fix: a pin
    // that explicitly DEMOTES a user whose IdP groups have not caught up.
    it('the pinned-demoted attack state (admin_pinned=true, is_admin=false) yields a DEFINED false override, not undefined', () => {
        const override = computeOwnerIsAdminOverride(false, true);
        expect(override).toBe(false);
        // Specifically NOT undefined — a caller doing
        // `isAdminOverride ?? groupCheck` must not fall through to a stale
        // admin-name group here.
        expect(override).not.toBeUndefined();
    });
});

// Fix round 1 (fix-plan-5 task-1 review, MINOR 4): direct unit tests of
// resolveOwnerIsAdminFailClosed() itself, with only its own leaf
// (aiDbService.getSql) and resolveOwnerAdminStatus's leaves (getUserByUsername,
// resolveEffectiveAccess) mocked — the wrapper's try/catch/fail-closed logic
// runs for real, unlike api-auth.test.ts's mock of this module (which stubs
// the wrapper itself, appropriately, since that file is testing api-auth.ts's
// consumption of the verdict, not the wrapper).
describe('resolveOwnerIsAdminFailClosed — direct, leaf-mocked', () => {
    beforeEach(() => {
        mockGetUserByUsername.mockReset();
        mockResolveEffectiveAccess.mockReset();
        mockGetSql.mockReset();
    });

    it('pinned admin resolves true', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000f1',
            admin_pinned: true,
            is_admin: true,
            groups: ['regular-user'],
        });
        await expect(resolveOwnerIsAdminFailClosed('pinned-admin')).resolves.toBe(true);
    });

    it('unpinned in-app-only admin resolves true (Formula A)', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-0000000000f2',
            admin_pinned: false,
            is_admin: false,
            groups: ['users'],
        });
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: [],
            effectiveGroups: ['users'],
            capabilities: { ownerIsAdmin: true },
        });
        await expect(resolveOwnerIsAdminFailClosed('inapp-admin')).resolves.toBe(true);
    });

    it('no DB handle fails closed to false (and logs — see the module doc)', async () => {
        mockGetSql.mockResolvedValue(null);
        await expect(resolveOwnerIsAdminFailClosed('anyone')).resolves.toBe(false);
        expect(mockGetUserByUsername).not.toHaveBeenCalled();
    });

    it('no resolvable users row fails closed to false', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserByUsername.mockResolvedValue(null);
        await expect(resolveOwnerIsAdminFailClosed('ghost')).resolves.toBe(false);
    });

    it('a thrown error fails closed to false', async () => {
        mockGetSql.mockRejectedValue(new Error('DB unreachable'));
        await expect(resolveOwnerIsAdminFailClosed('anyone')).resolves.toBe(false);
    });
});

describe('resolveOwnerIsAdminFailClosedById — direct, leaf-mocked', () => {
    const OWNER = '00000000-0000-0000-0000-0000000000f3';

    beforeEach(() => {
        mockGetUserById.mockReset();
        mockGetUserByUsername.mockReset();
        mockResolveEffectiveAccess.mockReset();
        mockGetSql.mockReset();
    });

    it('an admin owner resolves true, looked up by id', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserById.mockResolvedValue({
            id: OWNER,
            admin_pinned: true,
            is_admin: true,
            groups: [],
        });
        await expect(resolveOwnerIsAdminFailClosedById(OWNER)).resolves.toBe(true);
        expect(mockGetUserById).toHaveBeenCalledWith({}, OWNER);
        expect(mockGetUserByUsername).not.toHaveBeenCalled();
    });

    it('a non-admin owner resolves false', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserById.mockResolvedValue({
            id: OWNER,
            admin_pinned: true,
            is_admin: false,
            groups: [],
        });
        await expect(resolveOwnerIsAdminFailClosedById(OWNER)).resolves.toBe(false);
    });

    it('no DB handle is a temporary dependency failure', async () => {
        mockGetSql.mockResolvedValue(null);
        await expect(resolveOwnerIsAdminFailClosedById(OWNER)).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
        expect(mockGetUserById).not.toHaveBeenCalled();
    });

    it('no users row fails closed to false', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserById.mockResolvedValue(null);
        await expect(resolveOwnerIsAdminFailClosedById(OWNER)).resolves.toBe(false);
    });

    it('a thrown error fails closed to false', async () => {
        mockGetSql.mockResolvedValue({});
        mockGetUserById.mockRejectedValue(
            Object.assign(new Error('DB unreachable'), { code: 'CONNECTION_CLOSED' }),
        );
        await expect(resolveOwnerIsAdminFailClosedById(OWNER)).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
    });
});
