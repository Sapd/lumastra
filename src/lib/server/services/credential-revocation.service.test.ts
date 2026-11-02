// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `revokeAllCredentialsForUser` — the shared fan-out used by
 * disable / admin password-reset / self password-change / delete (security
 * review 2026-09-13, C2). Verifies every credential store is called, the
 * `keepSessionToken` option is threaded through to the native-session store,
 * and one store's failure does not skip the others.
 *
 * All collaborators mocked — no real database, no real Valkey.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: async (sql: unknown, work: (tx: unknown) => Promise<unknown>) => work(sql),
}));

const {
    mockSessionRevokeAllForUser,
    mockSessionRevokeAllForUserExcept,
    mockRefreshRevokeAllForUser,
    mockPatRevokeAllForUser,
    mockJellyfinTokenRevokeAllForUser,
    mockServiceTokenRevokeAllImpersonating,
    mockEnsureProprietaryLoaded,
    mockGetJellyfinCompatRevocationProvider,
    mockJfCompatRevokeSessionsForUser,
    mockDeleteUserToken,
    mockInvalidateCacheForUser,
    mockCloseConsumersForUsername,
} = vi.hoisted(() => ({
    mockSessionRevokeAllForUser: vi.fn(),
    mockSessionRevokeAllForUserExcept: vi.fn(),
    mockRefreshRevokeAllForUser: vi.fn(),
    mockPatRevokeAllForUser: vi.fn(),
    mockJellyfinTokenRevokeAllForUser: vi.fn(),
    mockServiceTokenRevokeAllImpersonating: vi.fn(),
    mockEnsureProprietaryLoaded: vi.fn(),
    mockGetJellyfinCompatRevocationProvider: vi.fn(),
    mockJfCompatRevokeSessionsForUser: vi.fn(),
    mockDeleteUserToken: vi.fn(),
    mockInvalidateCacheForUser: vi.fn(),
    mockCloseConsumersForUsername: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({
        revokeAllForUser: (...a: unknown[]) => mockSessionRevokeAllForUser(...a),
        revokeAllForUserExcept: (...a: unknown[]) => mockSessionRevokeAllForUserExcept(...a),
    }),
}));
vi.mock('$lib/server/oauth/refresh-token.service.js', () => ({
    getRefreshTokenService: () => ({
        revokeAllForUser: (...a: unknown[]) => mockRefreshRevokeAllForUser(...a),
    }),
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        revokeAllForUser: (...a: unknown[]) => mockPatRevokeAllForUser(...a),
    }),
}));
vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: () => ({
        revokeAllForUser: (...a: unknown[]) => mockJellyfinTokenRevokeAllForUser(...a),
    }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        revokeAllImpersonating: (...a: unknown[]) => mockServiceTokenRevokeAllImpersonating(...a),
    }),
}));
vi.mock('$lib/server/licensing/entitlements.js', () => ({
    ensureProprietaryLoaded: (...a: unknown[]) => mockEnsureProprietaryLoaded(...a),
}));
vi.mock('$lib/server/auth/jellyfin-compat-revocation.js', () => ({
    getJellyfinCompatRevocationProvider: (...a: unknown[]) =>
        mockGetJellyfinCompatRevocationProvider(...a),
}));
vi.mock('$lib/server/subsonic-compat/auth.js', () => ({
    deleteUserToken: (...a: unknown[]) => mockDeleteUserToken(...a),
    invalidateCacheForUser: (...a: unknown[]) => mockInvalidateCacheForUser(...a),
}));
vi.mock('$lib/server/services/notification-events.service.js', () => ({
    userEventsHub: {
        closeConsumersForUsername: (...a: unknown[]) => mockCloseConsumersForUsername(...a),
    },
}));

import {
    revokeAllCredentialsForUser,
    revokeDeviceClassCredentialsForUser,
} from './credential-revocation.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const USERNAME = 'alice';
const sqlStub = {} as never;

beforeEach(() => {
    vi.clearAllMocks();
    mockSessionRevokeAllForUser.mockResolvedValue(1);
    mockSessionRevokeAllForUserExcept.mockResolvedValue(1);
    mockRefreshRevokeAllForUser.mockResolvedValue(1);
    mockPatRevokeAllForUser.mockResolvedValue(1);
    mockJellyfinTokenRevokeAllForUser.mockResolvedValue(1);
    mockServiceTokenRevokeAllImpersonating.mockResolvedValue(1);
    mockEnsureProprietaryLoaded.mockResolvedValue(undefined);
    mockJfCompatRevokeSessionsForUser.mockResolvedValue(1);
    mockGetJellyfinCompatRevocationProvider.mockReturnValue({
        revokeSessionsForUser: (...a: unknown[]) => mockJfCompatRevokeSessionsForUser(...a),
    });
    mockDeleteUserToken.mockResolvedValue(undefined);
    mockInvalidateCacheForUser.mockResolvedValue(undefined);
    mockCloseConsumersForUsername.mockReturnValue(0);
});

describe('revokeAllCredentialsForUser', () => {
    it('calls every credential store with the target user', async () => {
        const result = await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(mockSessionRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockSessionRevokeAllForUserExcept).not.toHaveBeenCalled();
        expect(mockRefreshRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockPatRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockJellyfinTokenRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockServiceTokenRevokeAllImpersonating).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockEnsureProprietaryLoaded).toHaveBeenCalled();
        expect(mockJfCompatRevokeSessionsForUser).toHaveBeenCalledWith(USER_ID);
        expect(mockDeleteUserToken).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockInvalidateCacheForUser).toHaveBeenCalledWith(USERNAME);
        expect(result.failedStores).toEqual([]);
    });

    // Security fix C28 (2026-09-16): an already-open per-user SSE stream had
    // no teardown path when its session was revoked — auth was checked only
    // at connect. This is the single chokepoint every revocation caller
    // (disable, admin password-reset, self password-change, delete) shares.
    it('closes any already-open SSE stream for the revoked user (C28)', async () => {
        await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(mockCloseConsumersForUsername).toHaveBeenCalledWith(USERNAME);
    });

    it('still closes the SSE stream even when a credential store fails', async () => {
        mockPatRevokeAllForUser.mockRejectedValue(new Error('db down'));

        await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(mockCloseConsumersForUsername).toHaveBeenCalledWith(USERNAME);
    });

    it('keeps the caller session alive via revokeAllForUserExcept when keepSessionToken is set', async () => {
        await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME, {
            keepSessionToken: 'my-token',
        });

        expect(mockSessionRevokeAllForUserExcept).toHaveBeenCalledWith(
            USER_ID,
            'my-token',
            sqlStub,
        );
        expect(mockSessionRevokeAllForUser).not.toHaveBeenCalled();
    });

    it('is a no-op for the /j store (no failure) when no proprietary provider is registered (AGPL-only build)', async () => {
        mockGetJellyfinCompatRevocationProvider.mockReturnValue(null);

        const result = await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(result.failedStores).toEqual([]);
    });

    it('continues revoking every other store when one store throws, and reports it in failedStores', async () => {
        mockPatRevokeAllForUser.mockRejectedValue(new Error('db down'));

        const result = await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(result.failedStores).toEqual(['pats']);
        // every OTHER store still ran despite the PAT failure
        expect(mockSessionRevokeAllForUser).toHaveBeenCalled();
        expect(mockRefreshRevokeAllForUser).toHaveBeenCalled();
        expect(mockJellyfinTokenRevokeAllForUser).toHaveBeenCalled();
        expect(mockServiceTokenRevokeAllImpersonating).toHaveBeenCalled();
        expect(mockJfCompatRevokeSessionsForUser).toHaveBeenCalled();
        expect(mockDeleteUserToken).toHaveBeenCalled();
    });

    it('reports multiple failed stores independently', async () => {
        mockRefreshRevokeAllForUser.mockRejectedValue(new Error('boom'));
        mockDeleteUserToken.mockRejectedValue(new Error('boom2'));

        const result = await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(result.failedStores).toContain('refresh_tokens');
        expect(result.failedStores).toContain('subsonic_token');
        expect(result.failedStores).toHaveLength(2);
    });

    it('returns per-store revoked counts', async () => {
        mockSessionRevokeAllForUser.mockResolvedValue(2);
        mockRefreshRevokeAllForUser.mockResolvedValue(3);
        mockJellyfinTokenRevokeAllForUser.mockResolvedValue(1);
        mockJfCompatRevokeSessionsForUser.mockResolvedValue(4);
        mockPatRevokeAllForUser.mockResolvedValue(5);
        mockServiceTokenRevokeAllImpersonating.mockResolvedValue(6);

        const result = await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(result.counts).toMatchObject({
            native_sessions: 2,
            refresh_tokens: 3,
            jellyfin_oauth_tokens: 1,
            jellyfin_compat_sessions: 4,
            pats: 5,
            service_token_impersonation: 6,
        });
    });
});

// ---------------------------------------------------------------------------
// `scope: 'device'` (final fix wave, 2026-09-13): DELETE /api/admin/devices/all
// must revoke ONLY device-class stores (native sessions, refresh tokens,
// Jellyfin OAuth device tokens, /j compat sessions) and leave PATs + the
// Subsonic token untouched — its own admin-UI button promises "devices",
// and the C2 fan-out had silently started wiping both.
// ---------------------------------------------------------------------------
describe('revokeAllCredentialsForUser({ scope: "device" }) / revokeDeviceClassCredentialsForUser', () => {
    it('revokes device-class stores but leaves PATs and the Subsonic token untouched', async () => {
        const result = await revokeAllCredentialsForUser(sqlStub, USER_ID, USERNAME, {
            scope: 'device',
        });

        expect(mockSessionRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockRefreshRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockJellyfinTokenRevokeAllForUser).toHaveBeenCalledWith(USER_ID, sqlStub);
        expect(mockJfCompatRevokeSessionsForUser).toHaveBeenCalledWith(USER_ID);

        expect(mockPatRevokeAllForUser).not.toHaveBeenCalled();
        expect(mockServiceTokenRevokeAllImpersonating).not.toHaveBeenCalled();
        expect(mockDeleteUserToken).not.toHaveBeenCalled();
        expect(mockInvalidateCacheForUser).not.toHaveBeenCalled();

        expect(result.failedStores).toEqual([]);
        expect(result.counts.pats).toBeUndefined();
        expect(result.counts.service_token_impersonation).toBeUndefined();
    });

    it('revokeDeviceClassCredentialsForUser is equivalent to scope: "device"', async () => {
        mockSessionRevokeAllForUser.mockResolvedValue(1);
        mockRefreshRevokeAllForUser.mockResolvedValue(2);
        mockJellyfinTokenRevokeAllForUser.mockResolvedValue(3);
        mockJfCompatRevokeSessionsForUser.mockResolvedValue(4);

        const result = await revokeDeviceClassCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(result.counts).toMatchObject({
            native_sessions: 1,
            refresh_tokens: 2,
            jellyfin_oauth_tokens: 3,
            jellyfin_compat_sessions: 4,
        });
        expect(mockPatRevokeAllForUser).not.toHaveBeenCalled();
        expect(mockDeleteUserToken).not.toHaveBeenCalled();
    });

    it('a device-class store failure is still reported without touching the skipped stores', async () => {
        mockRefreshRevokeAllForUser.mockRejectedValue(new Error('boom'));

        const result = await revokeDeviceClassCredentialsForUser(sqlStub, USER_ID, USERNAME);

        expect(result.failedStores).toEqual(['refresh_tokens']);
        expect(mockPatRevokeAllForUser).not.toHaveBeenCalled();
    });
});
