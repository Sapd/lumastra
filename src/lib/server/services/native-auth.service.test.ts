// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the first-admin bootstrap TOCTOU fix in
 * `completeForwardAuthSetup`, and (security review 5, MINOR 3, 2026-09-23)
 * `completeNativeSetup`'s group-derived-cache invalidation after
 * `createNativeAdmin` — a fifth writer of `users.groups`/`is_admin` that the
 * `upsertUserGroups` wrapper/lint rule don't cover (it's a different query).
 * The check-then-act (`adminExists` then `upsertUser`) in
 * `completeForwardAuthSetup` is wrapped in a transaction-scoped advisory lock
 * shared with `createNativeAdmin` (same `FIRST_ADMIN_LOCK_KEY`), so it can't
 * race a concurrent native OR forward-auth setup submission into creating two
 * admins. All collaborators mocked — no real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';

const {
    mockAdminExists,
    mockUpsertUser,
    mockGetUserByUsername,
    mockEnsureUserProfileExists,
    mockRecordIdentityBestEffort,
    mockInvalidateAdminExistsCache,
    mockCreateNativeAdmin,
    mockInvalidateGroupDerivedCaches,
    mockSaveConfig,
    mockMarkSetupCompleted,
} = vi.hoisted(() => ({
    mockAdminExists: vi.fn(),
    mockUpsertUser: vi.fn(),
    mockGetUserByUsername: vi.fn(),
    mockEnsureUserProfileExists: vi.fn(),
    mockRecordIdentityBestEffort: vi.fn(),
    mockInvalidateAdminExistsCache: vi.fn(),
    mockCreateNativeAdmin: vi.fn(),
    mockInvalidateGroupDerivedCaches: vi.fn(),
    mockSaveConfig: vi.fn(async (..._args: unknown[]) => undefined),
    mockMarkSetupCompleted: vi.fn(async (..._args: unknown[]) => undefined),
}));

// Effective config values and env locks the pre-admin OIDC discard reads.
const { configValues, envLocked, mockResetOidcCache } = vi.hoisted(() => ({
    configValues: new Map<string, unknown>(),
    envLocked: new Set<string>(),
    mockResetOidcCache: vi.fn(),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: (...a: unknown[]) => mockAdminExists(...a),
    createNativeAdmin: (...a: unknown[]) => mockCreateNativeAdmin(...a),
    getNativeLoginRecord: vi.fn(),
    setUserPassword: vi.fn(),
    upsertUser: (...a: unknown[]) => mockUpsertUser(...a),
    getUserByUsername: (...a: unknown[]) => mockGetUserByUsername(...a),
    markSetupCompleted: (...a: unknown[]) => mockMarkSetupCompleted(...a),
    FIRST_ADMIN_LOCK_KEY: 'lumastra:setup:first-admin',
}));
vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: (...a: unknown[]) => mockEnsureUserProfileExists(...a),
}));
vi.mock('$lib/server/middleware/forward-auth.js', () => ({
    invalidateAdminExistsCache: (...a: unknown[]) => mockInvalidateAdminExistsCache(...a),
}));
vi.mock('$lib/shared/user-id.js', () => ({
    toUserId: (id: string) => id,
}));
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: (...a: unknown[]) => mockRecordIdentityBestEffort(...a),
    PROVIDER_NATIVE: 'native',
    PROVIDER_FORWARD_AUTH: 'forward-auth',
}));
vi.mock('$lib/server/services/user-groups.service.js', () => ({
    invalidateGroupDerivedCaches: (...a: unknown[]) => mockInvalidateGroupDerivedCaches(...a),
}));
vi.mock('$lib/shared/password-strength.js', () => ({
    validatePasswordPolicy: () => null,
}));
vi.mock('$lib/server/crypto/password.js', () => ({
    hashPassword: vi.fn(async () => 'hashed-password'),
    verifyPassword: vi.fn(),
    needsRehash: vi.fn(() => false),
}));
vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({
        create: vi.fn(async () => ({ token: 'session-token', expiresAt: new Date(0) })),
    }),
}));
vi.mock('$lib/server/config/config.service.js', async () => {
    const { getSettingDefinition } = await import('$lib/config/schema.js');
    return {
        saveConfig: (...a: unknown[]) => mockSaveConfig(...a),
        get: (key: string) =>
            configValues.has(key) ? configValues.get(key) : getSettingDefinition(key)?.defaultValue,
        isEnvOverridden: (key: string) => envLocked.has(key),
    };
});
vi.mock('$lib/server/services/oidc.service.js', () => ({
    resetOidcConfigCache: () => mockResetOidcCache(),
}));

import {
    completeForwardAuthSetup,
    completeNativeSetup,
    discardPreAdminOidcConfig,
} from './native-auth.service.js';

/** A sql handle whose `.begin(cb)` runs `cb` against the SAME tx handle every
 * time — asserts the lock-acquire (`tx\`SELECT pg_advisory_xact_lock(...)\`` —
 * `tx` must be callable as a tagged-template) and the check-then-write land on
 * one transaction-pinned connection, mirroring createNativeAdmin's fix. */
function makeSql() {
    const tx = vi.fn(() => Promise.resolve(undefined)) as unknown as postgres.Sql;
    const begin = vi.fn(async (cb: (tx: postgres.Sql) => unknown) => cb(tx));
    const sql = { begin } as unknown as postgres.Sql;
    return { sql, tx, begin };
}

describe('completeForwardAuthSetup — first-admin bootstrap TOCTOU', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUpsertUser.mockResolvedValue(undefined);
        mockEnsureUserProfileExists.mockResolvedValue(undefined);
        mockRecordIdentityBestEffort.mockResolvedValue(undefined);
    });

    it('returns 409 immediately when an admin already exists (outer, pre-lock check)', async () => {
        mockAdminExists.mockResolvedValueOnce(true);
        const { sql, begin } = makeSql();

        const result = await completeForwardAuthSetup(sql, {
            username: 'alice',
            groups: ['admin'],
            isAdmin: true,
        });

        expect(result).toEqual({
            ok: false,
            status: 409,
            message: 'Setup has already been completed.',
        });
        expect(begin).not.toHaveBeenCalled();
    });

    it('returns 403 when the identity is not in an admin group', async () => {
        mockAdminExists.mockResolvedValueOnce(false);
        const { sql, begin } = makeSql();

        const result = await completeForwardAuthSetup(sql, {
            username: 'bob',
            groups: ['users'],
            isAdmin: false,
        });

        expect(result.ok).toBe(false);
        expect((result as { status: number }).status).toBe(403);
        expect(begin).not.toHaveBeenCalled();
    });

    it('acquires the lock, re-checks adminExists on the SAME tx, and provisions the admin', async () => {
        mockAdminExists.mockResolvedValueOnce(false); // outer check
        const { sql, tx } = makeSql();

        // Inside the lock: re-check (still false) then the provisioned lookup.
        mockAdminExists.mockResolvedValueOnce(false);
        mockGetUserByUsername.mockResolvedValueOnce({
            id: 'user-1',
            username: 'alice',
            is_admin: true,
        });

        const result = await completeForwardAuthSetup(sql, {
            username: 'Alice',
            groups: ['admin'],
            isAdmin: true,
        });

        expect(result).toEqual({ ok: true, oidcConfigDiscarded: false });
        // Both the re-check and the upsert ran against the transaction handle.
        expect(mockAdminExists).toHaveBeenLastCalledWith(tx, config.ADMIN_GROUPS);
        expect(mockUpsertUser).toHaveBeenCalledWith(tx, { username: 'alice', isAdmin: true });
        expect(mockGetUserByUsername).toHaveBeenCalledWith(tx, 'alice');
        // The setup lock (S-C5c-2) is written on the same transaction as the admin.
        expect(mockMarkSetupCompleted).toHaveBeenCalledWith(tx, 'user-1');
        expect(mockEnsureUserProfileExists).toHaveBeenCalledWith(sql, 'user-1');
        expect(mockRecordIdentityBestEffort).toHaveBeenCalledWith(sql, {
            provider: 'forward-auth',
            subject: 'alice',
            userId: 'user-1',
        });
        expect(mockInvalidateAdminExistsCache).toHaveBeenCalledOnce();
    });

    it('returns 409 and writes no setup lock when the account is pinned as a non-admin (S-C5c-2, review M2)', async () => {
        mockAdminExists.mockResolvedValueOnce(false); // outer check
        const { sql } = makeSql();
        mockAdminExists.mockResolvedValueOnce(false); // in-lock re-check
        mockGetUserByUsername.mockResolvedValueOnce({
            id: 'user-2',
            username: 'dave',
            is_admin: false,
        });

        const result = await completeForwardAuthSetup(sql, {
            username: 'dave',
            groups: ['admin'],
            isAdmin: true,
        });

        expect(result).toMatchObject({ ok: false, status: 409 });
        expect(mockMarkSetupCompleted).not.toHaveBeenCalled();
        expect(mockInvalidateAdminExistsCache).not.toHaveBeenCalled();
    });

    it('returns 409 (no upsert) when the lock-scoped re-check finds an admin was just created by a concurrent submission', async () => {
        mockAdminExists.mockResolvedValueOnce(false); // outer check passes
        const { sql } = makeSql();
        // Inside the lock, after waiting for the winner to commit, the
        // re-check now sees the admin the concurrent request just created.
        mockAdminExists.mockResolvedValueOnce(true);

        const result = await completeForwardAuthSetup(sql, {
            username: 'carol',
            groups: ['admin'],
            isAdmin: true,
        });

        expect(result).toEqual({
            ok: false,
            status: 409,
            message: 'Setup has already been completed.',
        });
        expect(mockUpsertUser).not.toHaveBeenCalled();
        expect(mockMarkSetupCompleted).not.toHaveBeenCalled();
        expect(mockInvalidateAdminExistsCache).not.toHaveBeenCalled();
    });
});

describe('completeNativeSetup — invalidates the group-derived caches createNativeAdmin writes (security review 5, MINOR 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnsureUserProfileExists.mockResolvedValue(undefined);
        mockRecordIdentityBestEffort.mockResolvedValue(undefined);
        mockSaveConfig.mockResolvedValue(undefined);
    });

    it('calls invalidateGroupDerivedCaches with the new admin username after createNativeAdmin commits', async () => {
        mockAdminExists.mockResolvedValueOnce(false);
        mockCreateNativeAdmin.mockResolvedValueOnce('user-new-admin');
        const sql = {} as postgres.Sql;

        const result = await completeNativeSetup(sql, {
            username: 'NewAdmin',
            password: 'irrelevant-because-policy-is-mocked',
        });

        expect(result.ok).toBe(true);
        expect(mockCreateNativeAdmin).toHaveBeenCalledWith(sql, {
            username: 'NewAdmin',
            passwordHash: 'hashed-password',
            groups: expect.any(Array),
            adminGroupNames: expect.any(Array),
        });
        // The invalidation must run — createNativeAdmin's OWN withTx has
        // already committed by the time it returns a truthy id, so this is
        // always "after commit", unlike user-identity.service.ts's
        // provisionUserWithIdentity (which owns its withTx directly and must
        // invalidate outside the callback by hand).
        expect(mockInvalidateGroupDerivedCaches).toHaveBeenCalledTimes(1);
        expect(mockInvalidateGroupDerivedCaches).toHaveBeenCalledWith('NewAdmin');
    });

    it('does NOT invalidate when createNativeAdmin returns null (lost the first-admin race)', async () => {
        mockAdminExists.mockResolvedValueOnce(false);
        mockCreateNativeAdmin.mockResolvedValueOnce(null);
        const sql = {} as postgres.Sql;

        const result = await completeNativeSetup(sql, {
            username: 'racer',
            password: 'irrelevant-because-policy-is-mocked',
        });

        expect(result).toEqual({
            ok: false,
            status: 409,
            message: 'Setup has already been completed.',
        });
        expect(mockInvalidateGroupDerivedCaches).not.toHaveBeenCalled();
    });
});

describe('discardPreAdminOidcConfig — OIDC settings any visitor could save before setup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configValues.clear();
        envLocked.clear();
    });

    function plantAttackerOidc(): void {
        configValues.set('AUTH_OIDC_ENABLED', true);
        configValues.set('AUTH_OIDC_ISSUER', 'https://attacker.example.com/');
        configValues.set('AUTH_OIDC_CLIENT_ID', 'attacker-client');
        configValues.set('AUTH_OIDC_CLIENT_SECRET', 'attacker-secret');
        configValues.set('AUTH_OIDC_PROVIDER_NAME', 'Company SSO');
    }

    it('resets every wizard-writable OIDC key that differs from its default', async () => {
        plantAttackerOidc();

        expect(await discardPreAdminOidcConfig()).toBe(true);

        expect(mockSaveConfig).toHaveBeenCalledTimes(1);
        expect(mockSaveConfig.mock.calls[0][0]).toEqual({
            AUTH_OIDC_ENABLED: false,
            AUTH_OIDC_ISSUER: '',
            AUTH_OIDC_CLIENT_ID: '',
            AUTH_OIDC_CLIENT_SECRET: '',
            AUTH_OIDC_PROVIDER_NAME: 'Single Sign-On',
        });
        expect(mockResetOidcCache).toHaveBeenCalled();
    });

    it("keeps environment-set OIDC keys: they are the operator's", async () => {
        plantAttackerOidc();
        for (const key of ['AUTH_OIDC_ENABLED', 'AUTH_OIDC_ISSUER', 'AUTH_OIDC_CLIENT_ID']) {
            envLocked.add(key);
        }

        expect(await discardPreAdminOidcConfig()).toBe(true);

        const resets = mockSaveConfig.mock.calls[0][0] as Record<string, unknown>;
        expect(Object.keys(resets).sort()).toEqual([
            'AUTH_OIDC_CLIENT_SECRET',
            'AUTH_OIDC_PROVIDER_NAME',
        ]);
    });

    it('writes nothing when no OIDC setting was saved', async () => {
        expect(await discardPreAdminOidcConfig()).toBe(false);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('native setup runs the discard and reports it', async () => {
        plantAttackerOidc();
        mockAdminExists.mockResolvedValueOnce(false);
        mockCreateNativeAdmin.mockResolvedValueOnce('user-1');

        const result = await completeNativeSetup({} as postgres.Sql, {
            username: 'owner',
            password: 'irrelevant-because-policy-is-mocked',
        });

        expect(result).toMatchObject({ ok: true, oidcConfigDiscarded: true });
        expect(mockSaveConfig).toHaveBeenCalledWith(
            expect.objectContaining({ AUTH_OIDC_ENABLED: false, AUTH_OIDC_ISSUER: '' }),
        );
    });

    it('forward-auth setup runs the discard and reports it', async () => {
        plantAttackerOidc();
        mockAdminExists.mockResolvedValue(false);
        mockGetUserByUsername.mockResolvedValue({
            id: 'user-1',
            username: 'owner',
            is_admin: true,
        });
        const { sql } = makeSql();

        const result = await completeForwardAuthSetup(sql, {
            username: 'owner',
            groups: ['admin'],
            isAdmin: true,
        });

        expect(result).toEqual({ ok: true, oidcConfigDiscarded: true });
    });
});

describe('completeForwardAuthSetup — reserved usernames', () => {
    beforeEach(() => vi.clearAllMocks());

    it('refuses the reserved "system" identity before provisioning anything', async () => {
        mockAdminExists.mockResolvedValue(false);
        const { sql, begin } = makeSql();

        const result = await completeForwardAuthSetup(sql, {
            username: 'System',
            groups: ['admin'],
            isAdmin: true,
        });

        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(begin).not.toHaveBeenCalled();
        expect(mockUpsertUser).not.toHaveBeenCalled();
    });
});
