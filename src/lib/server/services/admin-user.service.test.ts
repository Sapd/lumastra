// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the credential fan-out in `setDisabled`, `resetPassword`,
 * and `deleteUser` (security review 2026-09-13, C2): each must call
 * `revokeAllCredentialsForUser` — not just revoke the native session — so
 * PATs, OAuth refresh tokens, service-token impersonation grants, /j
 * sessions, and the Subsonic token all die with the target account too.
 *
 * All collaborators mocked — no real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./user-credential-lock.js', () => ({
    withUserCredentialLock: async (
        sql: unknown,
        _id: string,
        work: (tx: unknown) => Promise<unknown>,
    ) => work(sql),
}));

const {
    mockSetUserEmail,
    mockAdminCreateUser,
    mockGetUserByUsername,
    mockSetUserPassword,
    mockSetUserDisabled,
    mockEraseUserData,
    mockCountOtherEffectiveAdmins,
    mockIsLastEffectiveAdmin,
    mockInvalidateUserAdminCache,
    mockInvalidateUserMaxAgeCache,
    mockRecordIdentityBestEffort,
    mockHashPassword,
    mockValidatePasswordPolicy,
    mockRevokeAllCredentialsForUser,
    mockNarrowAdminScopedCredentialsForUser,
    mockRestoreAdminScopedCredentialsForUser,
    mockResolveEffectiveAccess,
    mockSetIsAdmin,
    mockUnpinAdmin,
    mockSetMaxAgeRating,
    mockUnpinAgeRating,
    mockSyncAdminFromGroups,
    mockSyncAgeRatingFromGroups,
    mockBuildUserPermissions,
    mockAuditLog,
} = vi.hoisted(() => ({
    mockAdminCreateUser: vi.fn(),
    mockSetUserEmail: vi.fn(),
    mockGetUserByUsername: vi.fn(),
    mockSetUserPassword: vi.fn(),
    mockSetUserDisabled: vi.fn(),
    mockEraseUserData: vi.fn(),
    mockCountOtherEffectiveAdmins: vi.fn(),
    mockIsLastEffectiveAdmin: vi.fn(),
    mockInvalidateUserAdminCache: vi.fn(),
    mockInvalidateUserMaxAgeCache: vi.fn(),
    mockRecordIdentityBestEffort: vi.fn(),
    mockHashPassword: vi.fn(),
    mockValidatePasswordPolicy: vi.fn(),
    mockRevokeAllCredentialsForUser: vi.fn(),
    mockNarrowAdminScopedCredentialsForUser: vi.fn(),
    mockRestoreAdminScopedCredentialsForUser: vi.fn(),
    mockResolveEffectiveAccess: vi.fn(),
    mockSetIsAdmin: vi.fn(),
    mockUnpinAdmin: vi.fn(),
    mockSetMaxAgeRating: vi.fn(),
    mockUnpinAgeRating: vi.fn(),
    mockSyncAdminFromGroups: vi.fn(),
    mockSyncAgeRatingFromGroups: vi.fn(),
    mockBuildUserPermissions: vi.fn(),
    mockAuditLog: vi.fn(),
}));

vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ invalidateUserLiveTvPolicy: vi.fn() }));
const mockConfig = vi.hoisted(() => ({ ADMIN_GROUPS: ['admin'], AUTH_NATIVE_LOGIN_ENABLED: true }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/crypto/password.js', () => ({
    hashPassword: (...a: unknown[]) => mockHashPassword(...a),
}));
vi.mock('$lib/shared/password-strength.js', () => ({
    validatePasswordPolicy: (...a: unknown[]) => mockValidatePasswordPolicy(...a),
}));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeAllCredentialsForUser: (...a: unknown[]) => mockRevokeAllCredentialsForUser(...a),
    narrowAdminScopedCredentialsForUser: (...a: unknown[]) =>
        mockNarrowAdminScopedCredentialsForUser(...a),
    restoreAdminScopedCredentialsForUser: (...a: unknown[]) =>
        mockRestoreAdminScopedCredentialsForUser(...a),
    // Mirrors the real applyAdminStatusTransition() (a trivial, separately
    // unit-tested pure branch — see credential-revocation.transition.test.ts)
    // so existing assertions on the narrow/restore mocks below keep working:
    // the real function's internal calls to narrowAdminScopedCredentialsForUser/
    // restoreAdminScopedCredentialsForUser bind to its OWN module-local
    // functions, not to this file's mocked re-exports, so it cannot be
    // exercised via `importOriginal` here.
    applyAdminStatusTransition: async (
        sql: unknown,
        userId: unknown,
        username: unknown,
        wasAdmin: boolean,
        isAdminNow: boolean,
    ) => {
        if (wasAdmin === isAdminNow) return { failedStores: [], counts: {} };
        return wasAdmin
            ? mockNarrowAdminScopedCredentialsForUser(sql, userId, username)
            : mockRestoreAdminScopedCredentialsForUser(sql, userId, username);
    },
}));
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...a: unknown[]) => mockResolveEffectiveAccess(...a),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminSetUserEmail: (...a: unknown[]) => mockSetUserEmail(...a),
    adminCreateUser: (...a: unknown[]) => mockAdminCreateUser(...a),
    setUserLiveTvAllowed: vi.fn().mockResolvedValue(true),
    setUserPassword: (...a: unknown[]) => mockSetUserPassword(...a),
    setUserDisabled: (...a: unknown[]) => mockSetUserDisabled(...a),
    getUserByUsername: (...a: unknown[]) => mockGetUserByUsername(...a),
    setIsAdmin: (...a: unknown[]) => mockSetIsAdmin(...a),
    unpinAdmin: (...a: unknown[]) => mockUnpinAdmin(...a),
    setMaxAgeRating: (...a: unknown[]) => mockSetMaxAgeRating(...a),
    unpinAgeRating: (...a: unknown[]) => mockUnpinAgeRating(...a),
    syncAdminFromGroups: (...a: unknown[]) => mockSyncAdminFromGroups(...a),
    syncAgeRatingFromGroups: (...a: unknown[]) => mockSyncAgeRatingFromGroups(...a),
}));
vi.mock('$lib/server/database/queries/gdpr-erasure.queries.js', () => ({
    eraseUserData: (...a: unknown[]) => mockEraseUserData(...a),
}));
vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: vi.fn(),
}));
vi.mock('$lib/server/database/queries/access-groups.queries.js', () => ({
    countOtherEffectiveAdmins: (...a: unknown[]) => mockCountOtherEffectiveAdmins(...a),
    isLastEffectiveAdmin: (...a: unknown[]) => mockIsLastEffectiveAdmin(...a),
    // The guard lock is a real PG advisory lock; here it only has to run `fn`.
    withLastAdminGuardLock: (_sql: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('$lib/shared/user-id.js', () => ({
    toUserId: (id: string) => id,
}));
vi.mock('$lib/server/services/native-auth.service.js', () => ({
    validateUsername: vi.fn(() => null),
}));
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    invalidateUserAdminCache: (...a: unknown[]) => mockInvalidateUserAdminCache(...a),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    invalidateUserMaxAgeCache: (...a: unknown[]) => mockInvalidateUserMaxAgeCache(...a),
}));
vi.mock('$lib/server/auth.js', () => ({
    buildUserPermissions: (...a: unknown[]) => mockBuildUserPermissions(...a),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...a: unknown[]) => mockAuditLog(...a),
}));
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: (...a: unknown[]) => mockRecordIdentityBestEffort(...a),
    PROVIDER_NATIVE: 'native',
}));

import {
    createUser,
    setUserEmail,
    setDisabled,
    resetPassword,
    deleteUser,
    setUserAgeRating,
    setUserAdmin,
    setUserAllowLiveTv,
} from './admin-user.service.js';

const TARGET = {
    id: '22222222-2222-2222-2222-222222222222',
    username: 'bob',
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null,
    age_rating_pinned: false,
    display_name: null,
    email: null,
    hide_streams: false,
    groups: [] as string[],
    groups_updated_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    last_seen_at: null,
    disabled_at: null as Date | null,
};

const sqlStub = {} as never;

const ACTOR = { username: 'admin' };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByUsername.mockResolvedValue(TARGET);
    mockCountOtherEffectiveAdmins.mockResolvedValue(1);
    mockIsLastEffectiveAdmin.mockResolvedValue(false);
    mockRevokeAllCredentialsForUser.mockResolvedValue({ failedStores: [] });
    mockNarrowAdminScopedCredentialsForUser.mockResolvedValue({ failedStores: [] });
    mockRestoreAdminScopedCredentialsForUser.mockResolvedValue({ failedStores: [] });
    mockBuildUserPermissions.mockReturnValue({ ownerIsAdmin: false, maxAgeRating: null });
    // Default: no in-app membership at all — most tests never reach this
    // (formulaAIsAdminForRow short-circuits for a PINNED row and never calls
    // resolveEffectiveAccess). Tests exercising an UNPINNED row's Formula-A
    // verdict override this.
    mockResolveEffectiveAccess.mockResolvedValue({
        inAppGroupNames: [],
        effectiveGroups: [],
        capabilities: {},
    });
});

describe('createUser identity', () => {
    it('warns immediately when built-in login is disabled', async () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
        mockAdminCreateUser.mockResolvedValue(TARGET.id);
        mockHashPassword.mockResolvedValue('hash');
        mockValidatePasswordPolicy.mockReturnValue(null);
        try {
            const result = await createUser(sqlStub, {
                username: 'anna',
                password: 'Strong password 123!',
                isAdmin: false,
            });
            expect(result).toMatchObject({ ok: true, warnings: ['native_login_disabled'] });
        } finally {
            mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        }
    });
    it('rejects malformed email without echoing input or writing a user', async () => {
        const result = await createUser(sqlStub, {
            username: 'anna',
            password: 'Strong password 123!',
            isAdmin: false,
            email: 'https://secret:password@example.test',
        });
        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(mockAdminCreateUser).not.toHaveBeenCalled();
    });

    it('returns the UUID generated by storage along with the created account', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        mockAdminCreateUser.mockResolvedValue(id);
        mockHashPassword.mockResolvedValue('hash');
        mockValidatePasswordPolicy.mockReturnValue(null);
        const result = await createUser(sqlStub, {
            username: 'Alice',
            password: 'Strong password 123!',
            isAdmin: false,
        });
        expect(result).toEqual({ ok: true, data: { id, username: 'alice', isAdmin: false } });
    });
});

describe('setDisabled(disabled=true) — credential fan-out (C2)', () => {
    it('calls revokeAllCredentialsForUser with the target id + username', async () => {
        mockSetUserDisabled.mockResolvedValue(true);

        const result = await setDisabled(sqlStub, {
            targetUsername: 'bob',
            disabled: true,
            actingUsername: 'admin',
            actor: ACTOR,
        });

        expect(result.ok).toBe(true);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledTimes(1);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledWith(
            sqlStub,
            TARGET.id,
            TARGET.username,
        );
    });

    it('does NOT revoke credentials when re-enabling a user', async () => {
        mockSetUserDisabled.mockResolvedValue(true);

        await setDisabled(sqlStub, {
            targetUsername: 'bob',
            disabled: false,
            actingUsername: 'admin',
            actor: ACTOR,
        });

        expect(mockRevokeAllCredentialsForUser).not.toHaveBeenCalled();
    });

    it('audits user.disable / user.enable with the given actor (security review 2026-09-23, Shape B)', async () => {
        mockSetUserDisabled.mockResolvedValue(true);

        await setDisabled(sqlStub, {
            targetUsername: 'bob',
            disabled: true,
            actingUsername: 'admin',
            actor: ACTOR,
        });
        expect(mockAuditLog).toHaveBeenCalledWith('user.disable', 'bob', ACTOR, {
            targetUsername: 'bob',
        });

        mockAuditLog.mockClear();
        await setDisabled(sqlStub, {
            targetUsername: 'bob',
            disabled: false,
            actingUsername: 'admin',
            actor: ACTOR,
        });
        expect(mockAuditLog).toHaveBeenCalledWith('user.enable', 'bob', ACTOR, {
            targetUsername: 'bob',
        });
    });
});

describe('setUserAgeRating — C3 + R1 residual (security review 2026-09-23)', () => {
    it('set: writes, invalidates the max-age cache, and audits user.set_age_rating', async () => {
        mockSetMaxAgeRating.mockResolvedValue({
            ...TARGET,
            max_age_rating: 6,
            age_rating_pinned: true,
        });

        const result = await setUserAgeRating(sqlStub, {
            targetUsername: 'bob',
            change: { kind: 'set', value: 6 },
            actor: ACTOR,
        });

        expect(result).toEqual({
            ok: true,
            data: { username: 'bob', maxAgeRating: 6, ageRatingPinned: true },
        });
        expect(mockSetMaxAgeRating).toHaveBeenCalledWith(sqlStub, 'bob', 6);
        expect(mockInvalidateUserMaxAgeCache).toHaveBeenCalledWith('bob');
        expect(mockAuditLog).toHaveBeenCalledWith('user.set_age_rating', 'bob', ACTOR, {
            targetUsername: 'bob',
            maxAgeRating: 6,
        });
    });

    it('unpin: clears the pin, re-derives the cap via buildUserPermissions (configured prefix), invalidates, and audits', async () => {
        mockUnpinAgeRating.mockResolvedValue({
            ...TARGET,
            groups: ['age-12'],
            max_age_rating: 6,
            age_rating_pinned: false,
        });
        mockBuildUserPermissions.mockReturnValue({ ownerIsAdmin: false, maxAgeRating: 12 });

        const result = await setUserAgeRating(sqlStub, {
            targetUsername: 'bob',
            change: { kind: 'unpin' },
            actor: ACTOR,
        });

        expect(mockUnpinAgeRating).toHaveBeenCalledWith(sqlStub, 'bob');
        expect(mockBuildUserPermissions).toHaveBeenCalledWith(['age-12']);
        expect(mockSyncAgeRatingFromGroups).toHaveBeenCalledWith(sqlStub, 'bob', 12);
        expect(mockInvalidateUserMaxAgeCache).toHaveBeenCalledWith('bob');
        expect(mockAuditLog).toHaveBeenCalledWith('user.unpin_age_rating', 'bob', ACTOR, {
            targetUsername: 'bob',
        });
        expect(result).toEqual({
            ok: true,
            data: { username: 'bob', maxAgeRating: 12, ageRatingPinned: false },
        });
    });

    it('404s when the target does not exist', async () => {
        mockGetUserByUsername.mockResolvedValue(null);

        const result = await setUserAgeRating(sqlStub, {
            targetUsername: 'ghost',
            change: { kind: 'set', value: 6 },
            actor: ACTOR,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(404);
    });
});

describe('setUserAdmin — C3 residual + latent last-admin bug (security review 2026-09-23)', () => {
    it('refuses self-demotion', async () => {
        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'BOB',
            change: { kind: 'set', value: false },
            actor: ACTOR,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(400);
        expect(mockSetIsAdmin).not.toHaveBeenCalled();
    });

    it('demotes, narrows credentials, invalidates the admin cache, and audits user.set_admin', async () => {
        mockGetUserByUsername.mockResolvedValue({ ...TARGET, is_admin: true, admin_pinned: true });
        mockSetIsAdmin.mockResolvedValue({
            ...TARGET,
            is_admin: false,
            admin_pinned: true,
        });

        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
            change: { kind: 'set', value: false },
            actor: ACTOR,
        });

        expect(result.ok).toBe(true);
        expect(mockNarrowAdminScopedCredentialsForUser).toHaveBeenCalledWith(
            sqlStub,
            TARGET.id,
            'bob',
        );
        expect(mockRestoreAdminScopedCredentialsForUser).not.toHaveBeenCalled();
        expect(mockInvalidateUserAdminCache).toHaveBeenCalledWith('bob');
        expect(mockAuditLog).toHaveBeenCalledWith('user.set_admin', 'bob', ACTOR, {
            targetUsername: 'bob',
            newAdminStatus: false,
        });
    });

    it('an idempotent PATCH {isAdmin:true} on an already-admin user does not re-run the restore', async () => {
        mockGetUserByUsername.mockResolvedValue({ ...TARGET, is_admin: true, admin_pinned: true });
        mockSetIsAdmin.mockResolvedValue({ ...TARGET, is_admin: true, admin_pinned: true });

        await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
            change: { kind: 'set', value: true },
            actor: ACTOR,
        });

        expect(mockRestoreAdminScopedCredentialsForUser).not.toHaveBeenCalled();
    });

    it('fix round 2, Important 2: an explicit {isAdmin:false} on an ALREADY non-admin user still narrows (operator remedy / retry, unconditional)', async () => {
        // Formula A says non-admin BEFORE this call too (target.is_admin already
        // false, unpinned, no groups) — fix round 1's bug gated narrowing on a
        // real Formula-A transition, so this call would have been treated as a
        // no-op and never narrowed a stale, un-narrowed ['admin'] PAT. This is
        // also the retry path after an earlier call's `failedStores` reported a
        // partial credential-store failure — it must be safe to call again.
        mockGetUserByUsername.mockResolvedValue({
            ...TARGET,
            is_admin: false,
            admin_pinned: false,
        });
        mockSetIsAdmin.mockResolvedValue({ ...TARGET, is_admin: false, admin_pinned: true });

        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
            change: { kind: 'set', value: false },
            actor: ACTOR,
        });

        expect(result.ok).toBe(true);
        expect(mockNarrowAdminScopedCredentialsForUser).toHaveBeenCalledWith(
            sqlStub,
            TARGET.id,
            'bob',
        );
        expect(mockRestoreAdminScopedCredentialsForUser).not.toHaveBeenCalled();
    });

    it('X3: re-pinning isAdmin:true on a dual-membership admin (unpinned, column false, in-app admin true) is a no-op transition — no restore', async () => {
        // Formula A was ALREADY true before this call (in-app admin), even
        // though the raw is_admin COLUMN was false. The OLD code compared
        // against `!target.is_admin` (the column) and would have wrongly
        // treated this as a promotion, restoring credentials that were never
        // narrowed. The Formula-A `wasAdminBefore` this fix introduces sees
        // true -> true: no transition, no restore call.
        mockGetUserByUsername.mockResolvedValue({
            ...TARGET,
            is_admin: false,
            admin_pinned: false,
            groups: ['nobody'],
        });
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['ops'],
            effectiveGroups: ['nobody', 'ops'],
            capabilities: { ownerIsAdmin: true },
        });
        // The real buildUserPermissions() would honour isAdminOverride ??
        // (groups || inApp) — this mock is call-shape aware for this test
        // specifically, unlike the file's default dumb stub, so the
        // Formula-A composition through computeOwnerIsAdmin() is genuinely
        // exercised rather than trivially satisfied.
        mockBuildUserPermissions.mockImplementation(
            (
                _groups: string[],
                opts?: {
                    isAdminOverride?: boolean;
                    extraCapabilities?: { ownerIsAdmin?: boolean };
                },
            ) => ({
                ownerIsAdmin:
                    opts?.isAdminOverride ?? opts?.extraCapabilities?.ownerIsAdmin === true,
                maxAgeRating: null,
            }),
        );
        mockSetIsAdmin.mockResolvedValue({ ...TARGET, is_admin: true, admin_pinned: true });

        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
            change: { kind: 'set', value: true },
            actor: ACTOR,
        });

        expect(result.ok).toBe(true);
        expect(mockRestoreAdminScopedCredentialsForUser).not.toHaveBeenCalled();
        expect(mockNarrowAdminScopedCredentialsForUser).not.toHaveBeenCalled();
    });

    it('X3: unpinning a dual-membership admin (groups say non-admin, in-app says admin) does not narrow and reports isAdmin:true', async () => {
        // Target is PINNED admin (is_admin=true) whose IdP groups alone would
        // derive to non-admin, but who is ALSO an in-app admin. The OLD code
        // derived the post-unpin verdict from buildUserPermissions(groups)
        // ALONE, dropping the in-app OR-term — it would have narrowed this
        // user's credentials and reported isAdmin:false, even though Formula
        // A says they remain admin via the in-app group.
        mockGetUserByUsername.mockResolvedValue({
            ...TARGET,
            is_admin: true,
            admin_pinned: true,
            groups: ['nobody'],
        });
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['ops'],
            effectiveGroups: ['nobody', 'ops'],
            capabilities: { ownerIsAdmin: true },
        });
        mockBuildUserPermissions.mockImplementation(
            (
                _groups: string[],
                opts?: {
                    isAdminOverride?: boolean;
                    extraCapabilities?: { ownerIsAdmin?: boolean };
                },
            ) => ({
                ownerIsAdmin:
                    opts?.isAdminOverride ?? opts?.extraCapabilities?.ownerIsAdmin === true,
                maxAgeRating: null,
            }),
        );
        mockUnpinAdmin.mockResolvedValue({ ...TARGET, is_admin: true, admin_pinned: false });

        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
            change: { kind: 'unpin' },
            actor: ACTOR,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.isAdmin).toBe(true);
        expect(mockNarrowAdminScopedCredentialsForUser).not.toHaveBeenCalled();
        expect(mockRestoreAdminScopedCredentialsForUser).not.toHaveBeenCalled();
        // fix round 2, Important 1: the COLUMN must get the groups-ONLY verdict
        // (false here — groups alone don't confer admin), never the Formula-A
        // (in-app-inclusive, true) one — an in-app verdict in the column
        // would outlive the membership it came from.
        expect(mockSyncAdminFromGroups).toHaveBeenCalledWith(sqlStub, 'bob', false);
    });

    it('the last-admin guard is in-app-aware: an in-app-only admin (is_admin=false) with no other effective admin cannot be demoted', async () => {
        // The latent bug this fix closes: both defs used to gate the guard on
        // `target.is_admin` alone, so a user who was ONLY an effective admin
        // via an in-app access group (never pinned true) skipped the guard
        // entirely and could be demoted even as the last one.
        mockGetUserByUsername.mockResolvedValue({
            ...TARGET,
            is_admin: false,
            admin_pinned: false,
        });
        mockIsLastEffectiveAdmin.mockResolvedValue(true);

        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
            change: { kind: 'set', value: false },
            actor: ACTOR,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(409);
        expect(mockSetIsAdmin).not.toHaveBeenCalled();
    });

    it('self-demotion is refused by actingUserId when given, even if actingUsername would not have matched', async () => {
        // Minor 4 (fix round 1): an id compare is robust to any
        // username-fold edge case a caller's own record might have; prefer
        // it when the caller has it, falling back to the username fold.
        const result = await setUserAdmin(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'someone-else',
            actingUserId: TARGET.id,
            change: { kind: 'set', value: false },
            actor: ACTOR,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(400);
        expect(mockSetIsAdmin).not.toHaveBeenCalled();
    });

    describe('unpin — fix round 1, Important 3: the last-admin guard must run BEFORE any write', () => {
        it('blocks the unpin (409) and never calls unpinAdmin, when the target is the last effective admin', async () => {
            // Target is pinned admin (is_admin=true, admin_pinned=true) whose
            // groups derive to non-admin — unpinning would demote them.
            mockGetUserByUsername.mockResolvedValue({
                ...TARGET,
                is_admin: true,
                admin_pinned: true,
                groups: ['nobody'],
            });
            mockBuildUserPermissions.mockReturnValue({ ownerIsAdmin: false, maxAgeRating: null });
            mockCountOtherEffectiveAdmins.mockResolvedValue(0);

            const result = await setUserAdmin(sqlStub, {
                targetUsername: 'bob',
                actingUsername: 'admin',
                change: { kind: 'unpin' },
                actor: ACTOR,
            });

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.status).toBe(409);
            // THE assertion for the write-before-guard bug: unpinAdmin() must
            // never be called when the guard blocks — the old code called it
            // FIRST, so a blocked (409) unpin still left admin_pinned=false
            // with no invalidation, and the next forward-auth upsert would
            // silently demote the "protected" last admin outside this request.
            expect(mockUnpinAdmin).not.toHaveBeenCalled();
            expect(mockSyncAdminFromGroups).not.toHaveBeenCalled();
            expect(mockInvalidateUserAdminCache).not.toHaveBeenCalled();
            expect(mockAuditLog).not.toHaveBeenCalled();
        });

        it('refuses to let an admin unpin themselves into non-admin (fix-plan-5 Task 9, carried C1)', async () => {
            // The `set` branch refuses isSelf demotion with 400 unconditionally;
            // the unpin branch had no equivalent — an admin whose IdP groups do
            // not grant admin could unpin themselves and self-demote. Another
            // effective admin exists (countOtherEffectiveAdmins=1) so this must
            // be the self-demotion guard tripping, not the last-admin guard.
            mockGetUserByUsername.mockResolvedValue({
                ...TARGET,
                is_admin: true,
                admin_pinned: true,
                groups: ['nobody'], // derives to non-admin once unpinned
            });
            mockBuildUserPermissions.mockReturnValue({ ownerIsAdmin: false, maxAgeRating: null });
            mockCountOtherEffectiveAdmins.mockResolvedValue(1);

            const result = await setUserAdmin(sqlStub, {
                targetUsername: 'bob',
                actingUsername: 'BOB',
                change: { kind: 'unpin' },
                actor: ACTOR,
            });

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.status).toBe(400);
            expect(mockUnpinAdmin).not.toHaveBeenCalled();
            expect(mockSyncAdminFromGroups).not.toHaveBeenCalled();
            expect(mockInvalidateUserAdminCache).not.toHaveBeenCalled();
            expect(mockAuditLog).not.toHaveBeenCalled();
        });

        it('allows an admin to unpin themselves when the post-unpin verdict is still admin (no self-demotion)', async () => {
            // Guard must not block a no-op-for-admin-status unpin: groups still
            // grant admin, so unpinning does not demote self.
            mockGetUserByUsername.mockResolvedValue({
                ...TARGET,
                is_admin: true,
                admin_pinned: true,
                groups: ['admin'],
            });
            mockBuildUserPermissions.mockReturnValue({ ownerIsAdmin: true, maxAgeRating: null });
            mockUnpinAdmin.mockResolvedValue({ ...TARGET, is_admin: true, admin_pinned: false });

            const result = await setUserAdmin(sqlStub, {
                targetUsername: 'bob',
                actingUsername: 'BOB',
                change: { kind: 'unpin' },
                actor: ACTOR,
            });

            expect(result.ok).toBe(true);
            expect(mockUnpinAdmin).toHaveBeenCalledWith(sqlStub, 'bob');
        });

        it('derives the verdict from buildUserPermissions(target.groups) — the PRE-write row, not the post-write RETURNING row', async () => {
            const targetRow = {
                ...TARGET,
                is_admin: true,
                admin_pinned: true,
                groups: ['nobody'],
            };
            mockGetUserByUsername.mockResolvedValue(targetRow);
            mockBuildUserPermissions.mockReturnValue({ ownerIsAdmin: false, maxAgeRating: null });
            mockCountOtherEffectiveAdmins.mockResolvedValue(1);
            // Threads the PRE-write row's groups through resolveEffectiveAccess
            // (a real DB round trip in production; mocked here to echo back
            // the group it was called with, so the assertion below can prove
            // the pre-write row's `groups`, not some other value, reached it).
            mockResolveEffectiveAccess.mockResolvedValue({
                inAppGroupNames: [],
                effectiveGroups: ['nobody'],
                capabilities: {},
            });
            mockUnpinAdmin.mockResolvedValue({
                ...TARGET,
                is_admin: true, // unpinAdmin() only clears admin_pinned; is_admin is synced separately below
                admin_pinned: false,
                groups: ['nobody'],
            });

            await setUserAdmin(sqlStub, {
                targetUsername: 'bob',
                actingUsername: 'admin',
                change: { kind: 'unpin' },
                actor: ACTOR,
            });

            expect(mockResolveEffectiveAccess).toHaveBeenCalledWith(sqlStub, TARGET.id, ['nobody']);
            // X3 fix: computeOwnerIsAdmin() now composes buildUserPermissions()
            // with a pin-tri-state + in-app extraCapabilities wrapper instead of
            // the old bare `buildUserPermissions(target.groups)` single-arg call.
            expect(mockBuildUserPermissions).toHaveBeenCalledWith(['nobody'], {
                isAdminOverride: undefined,
                extraCapabilities: undefined,
            });
            expect(mockUnpinAdmin).toHaveBeenCalledWith(sqlStub, 'bob');
            expect(mockSyncAdminFromGroups).toHaveBeenCalledWith(sqlStub, 'bob', false);
            expect(mockNarrowAdminScopedCredentialsForUser).toHaveBeenCalled();
        });
    });
});

describe('resetPassword — credential fan-out (C2)', () => {
    it('P3 repeated POST password resets revoke credentials on every successful reset', async () => {
        mockValidatePasswordPolicy.mockReturnValue(null);
        mockHashPassword.mockResolvedValue('scrypt$new');
        mockSetUserPassword.mockResolvedValue(true);
        for (let i = 0; i < 2; i++) {
            expect(
                (
                    await resetPassword(sqlStub, {
                        targetUsername: 'bob',
                        newPassword: 'New-Pass-123!',
                    })
                ).ok,
            ).toBe(true);
        }
        expect(mockSetUserPassword).toHaveBeenCalledTimes(2);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledTimes(2);
    });

    it('calls revokeAllCredentialsForUser after setting the new password', async () => {
        mockValidatePasswordPolicy.mockReturnValue(null);
        mockHashPassword.mockResolvedValue('scrypt$new');
        mockSetUserPassword.mockResolvedValue(true);

        const result = await resetPassword(sqlStub, {
            targetUsername: 'bob',
            newPassword: 'New-Pass-123!',
        });

        expect(result.ok).toBe(true);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledTimes(1);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledWith(
            sqlStub,
            TARGET.id,
            TARGET.username,
        );
    });
});

describe('deleteUser — credential fan-out (C2)', () => {
    it('calls revokeAllCredentialsForUser after a successful erasure (for the /j Valkey sessions)', async () => {
        mockEraseUserData.mockResolvedValue({
            totalDeleted: 3,
            totalAnonymized: 0,
            blocked: [],
        });

        const result = await deleteUser(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
        });

        expect(result.ok).toBe(true);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledTimes(1);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledWith(
            sqlStub,
            TARGET.id,
            TARGET.username,
        );
    });

    it('does NOT call revokeAllCredentialsForUser when the erasure is blocked (nothing was changed)', async () => {
        mockEraseUserData.mockResolvedValue({
            totalDeleted: 0,
            totalAnonymized: 0,
            blocked: [{ table: 'courses', column: 'created_by', count: 2 }],
        });

        const result = await deleteUser(sqlStub, {
            targetUsername: 'bob',
            actingUsername: 'admin',
        });

        expect(result.ok).toBe(false);
        expect(mockRevokeAllCredentialsForUser).not.toHaveBeenCalled();
    });
});

vi.mock('$lib/server/services/livetv/playback-session-lifecycle.js', () => ({
    revokeUserLiveTvPlayback: vi.fn().mockResolvedValue(undefined),
}));
it('turning Live TV off immediately tears down playback, including on a repeated off write', async () => {
    const { revokeUserLiveTvPlayback } = await import('./livetv/playback-session-lifecycle.js');
    for (let i = 0; i < 2; i++) {
        expect(
            (
                await setUserAllowLiveTv(sqlStub, {
                    targetUsername: 'bob',
                    allowed: false,
                    actor: ACTOR,
                })
            ).ok,
        ).toBe(true);
    }
    expect(revokeUserLiveTvPlayback).toHaveBeenCalledTimes(2);
    expect(revokeUserLiveTvPlayback).toHaveBeenCalledWith(sqlStub, 'bob');
});
it('allowing Live TV does not end playback', async () => {
    const { revokeUserLiveTvPlayback } = await import('./livetv/playback-session-lifecycle.js');
    await setUserAllowLiveTv(sqlStub, { targetUsername: 'bob', allowed: true, actor: ACTOR });
    expect(revokeUserLiveTvPlayback).not.toHaveBeenCalled();
});

it('keeps revocation effective and returns an actionable retry when resource cleanup fails', async () => {
    const { revokeUserLiveTvPlayback } = await import('./livetv/playback-session-lifecycle.js');
    const { invalidateUserLiveTvPolicy } = await import('$lib/server/auth/livetv-user-policy.js');
    vi.mocked(revokeUserLiveTvPlayback).mockRejectedValueOnce(
        new Error('private proxy URL credentials'),
    );
    const result = await setUserAllowLiveTv(sqlStub, {
        targetUsername: 'bob',
        allowed: false,
        actor: ACTOR,
    });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(result)).not.toContain('private proxy URL credentials');
    expect(invalidateUserLiveTvPolicy).toHaveBeenCalledWith('bob');
    expect(mockAuditLog).toHaveBeenCalledWith('user.set_allow_live_tv', 'bob', ACTOR, {
        allowLiveTv: false,
    });
});

describe('admin matching email', () => {
    it('validates before any edit, without exposing the submitted credentials', async () => {
        const result = await setUserEmail(sqlStub, {
            targetUsername: 'bob',
            email: 'https://secret:password@example.test',
            actor: ACTOR,
        });
        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(mockSetUserEmail).not.toHaveBeenCalled();
    });
    it('normalizes and audits edits without including the email', async () => {
        mockSetUserEmail.mockResolvedValue(true);
        for (let i = 0; i < 2; i++)
            expect(
                (
                    await setUserEmail(sqlStub, {
                        targetUsername: 'bob',
                        email: ' Anna@Example.Test ',
                        actor: ACTOR,
                    })
                ).ok,
            ).toBe(true);
        expect(mockSetUserEmail).toHaveBeenCalledWith(sqlStub, TARGET.id, 'anna@example.test');
        expect(JSON.stringify(mockAuditLog.mock.calls)).not.toContain('anna@example.test');
        expect(mockAuditLog).toHaveBeenCalledWith('user.update', TARGET.username, ACTOR, {
            field: 'email',
            emailHash: 'fa8cb084c54d9b1b1837e67b6ceba88433135ad4588a091751592165c96b1c55',
        });
    });
    it('returns actionable conflicts for duplicate email edits and creates', async () => {
        mockSetUserEmail.mockRejectedValue(new Error('user_email_conflict'));
        const result = await setUserEmail(sqlStub, {
            targetUsername: 'bob',
            email: 'anna@example.test',
            actor: ACTOR,
        });
        expect(result).toMatchObject({ ok: false, status: 409 });
        expect(JSON.stringify(result)).not.toContain('anna@example.test');
        mockAdminCreateUser.mockRejectedValueOnce(new Error('user_email_conflict'));
        expect(
            await createUser(sqlStub, {
                username: 'anna',
                password: 'Strong password 123!',
                isAdmin: false,
                email: 'anna@example.test',
            }),
        ).toMatchObject({ ok: false, status: 409 });
    });
});
