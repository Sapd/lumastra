// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `changeOwnPassword`'s credential fan-out (security review
 * 2026-09-13, C2): the password changed, so every OTHER credential the
 * account holds (OAuth refresh tokens, PATs, Jellyfin OAuth device tokens,
 * service-token impersonation grants, /j sessions, Subsonic token) must be
 * revoked too — not just the native session. The caller's own freshly-issued
 * session must be kept alive throughout.
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
    mockGetNativeLoginRecord,
    mockSetUserPassword,
    mockVerifyPassword,
    mockHashPassword,
    mockNeedsRehash,
    mockValidatePasswordPolicy,
    mockSessionCreate,
    mockRevokeAllCredentialsForUser,
} = vi.hoisted(() => ({
    mockGetNativeLoginRecord: vi.fn(),
    mockSetUserPassword: vi.fn(),
    mockVerifyPassword: vi.fn(),
    mockHashPassword: vi.fn(),
    mockNeedsRehash: vi.fn(),
    mockValidatePasswordPolicy: vi.fn(),
    mockSessionCreate: vi.fn(),
    mockRevokeAllCredentialsForUser: vi.fn(),
}));

vi.mock('$lib/server/crypto/password.js', () => ({
    hashPassword: (...a: unknown[]) => mockHashPassword(...a),
    verifyPassword: (...a: unknown[]) => mockVerifyPassword(...a),
    needsRehash: (...a: unknown[]) => mockNeedsRehash(...a),
}));
vi.mock('$lib/shared/password-strength.js', () => ({
    validatePasswordPolicy: (...a: unknown[]) => mockValidatePasswordPolicy(...a),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(),
    createNativeAdmin: vi.fn(),
    getNativeLoginRecord: (...a: unknown[]) => mockGetNativeLoginRecord(...a),
    setUserPassword: (...a: unknown[]) => mockSetUserPassword(...a),
    upsertUser: vi.fn(),
    getUserByUsername: vi.fn(),
    markSetupCompleted: vi.fn(),
    FIRST_ADMIN_LOCK_KEY: 'lumastra:setup:first-admin',
}));
vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: vi.fn(),
}));
vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: vi.fn(),
}));
vi.mock('$lib/server/middleware/forward-auth.js', () => ({
    invalidateAdminExistsCache: vi.fn(),
}));
vi.mock('$lib/shared/user-id.js', () => ({
    toUserId: (id: string) => id,
}));
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: vi.fn(),
    PROVIDER_NATIVE: 'native',
    PROVIDER_FORWARD_AUTH: 'forward-auth',
}));
vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({
        create: (...a: unknown[]) => mockSessionCreate(...a),
    }),
}));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeAllCredentialsForUser: (...a: unknown[]) => mockRevokeAllCredentialsForUser(...a),
}));

import { changeOwnPassword } from './native-auth.service.js';

const RECORD = {
    id: '11111111-1111-1111-1111-111111111111',
    username: 'alice',
    password_hash: 'scrypt$existing-hash',
    groups: [] as string[],
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null,
    age_rating_pinned: false,
    disabled_at: null,
};

const sqlStub = {} as never;

beforeEach(() => {
    vi.clearAllMocks();
    mockGetNativeLoginRecord.mockResolvedValue(RECORD);
    mockVerifyPassword.mockResolvedValue(true);
    mockValidatePasswordPolicy.mockReturnValue(null);
    mockHashPassword.mockResolvedValue('scrypt$new-hash');
    mockSetUserPassword.mockResolvedValue(true);
    mockSessionCreate.mockResolvedValue({
        token: 'new-session-token',
        expiresAt: new Date(),
    });
    mockRevokeAllCredentialsForUser.mockResolvedValue({ failedStores: [] });
});

describe('changeOwnPassword — credential fan-out (C2)', () => {
    it('revokes every credential class via revokeAllCredentialsForUser, keeping the fresh session', async () => {
        const result = await changeOwnPassword(sqlStub, {
            username: 'alice',
            currentPassword: 'old-pass',
            newPassword: 'New-Pass-123!',
        });

        expect(result.ok).toBe(true);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledTimes(1);
        expect(mockRevokeAllCredentialsForUser).toHaveBeenCalledWith(
            sqlStub,
            RECORD.id,
            RECORD.username,
            { keepSessionToken: 'new-session-token' },
        );
    });

    it('issues the new session BEFORE revoking (no window with zero valid sessions)', async () => {
        const callOrder: string[] = [];
        mockSessionCreate.mockImplementation(async () => {
            callOrder.push('create');
            return { token: 'new-session-token', expiresAt: new Date() };
        });
        mockRevokeAllCredentialsForUser.mockImplementation(async () => {
            callOrder.push('revoke');
            return { failedStores: [] };
        });

        await changeOwnPassword(sqlStub, {
            username: 'alice',
            currentPassword: 'old-pass',
            newPassword: 'New-Pass-123!',
        });

        expect(callOrder).toEqual(['create', 'revoke']);
    });

    it('does not fail the password change when a credential store fails to revoke', async () => {
        mockRevokeAllCredentialsForUser.mockResolvedValue({ failedStores: ['pats'] });

        const result = await changeOwnPassword(sqlStub, {
            username: 'alice',
            currentPassword: 'old-pass',
            newPassword: 'New-Pass-123!',
        });

        expect(result.ok).toBe(true);
    });
});
