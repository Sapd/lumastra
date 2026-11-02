// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const validateMock = vi.fn();
const setIfNotExistsMock = vi.fn();
const cacheDelMock = vi.fn();
const cacheExistsMock = vi.fn();
const isValkeyReadyMock = vi.fn();
const revokeBySessionMock = vi.fn();
const revokeBySubjectMock = vi.fn();
let cascadeFlag = false;

vi.mock('./oidc-logout-token.js', () => ({
    validateLogoutTokenFromConfig: (...a: unknown[]) => validateMock(...a),
    LogoutTokenError: class LogoutTokenError extends Error {},
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    setIfNotExists: (...a: unknown[]) => setIfNotExistsMock(...a),
    cacheDel: (...a: unknown[]) => cacheDelMock(...a),
    cacheExists: (...a: unknown[]) => cacheExistsMock(...a),
    isValkeyReadyFor: (...a: unknown[]) => isValkeyReadyMock(...a),
}));
vi.mock('./session.service.js', () => ({
    getSessionService: () => ({
        revokeByOidcSession: (...a: unknown[]) => revokeBySessionMock(...a),
        revokeByOidcSubject: (...a: unknown[]) => revokeBySubjectMock(...a),
    }),
}));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE() {
            return cascadeFlag;
        },
    },
}));
const cascadeRefresh = vi.fn();
const cascadeJellyfin = vi.fn();
vi.mock('$lib/server/oauth/index.js', () => ({
    isDeviceAuthEnabled: () => true,
    getRefreshTokenService: () => ({ revokeAllForUser: (...a: unknown[]) => cascadeRefresh(...a) }),
}));
vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: () => ({
        revokeAllForUser: (...a: unknown[]) => cascadeJellyfin(...a),
    }),
}));

import { processBackchannelLogout } from './oidc-backchannel-logout.js';

// Cascade passes user ids through toUserId(), which throws on a non-UUID, so the
// cascade-path fixtures must be real users.id UUIDs.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
    vi.clearAllMocks();
    cascadeFlag = false;
    isValkeyReadyMock.mockReturnValue(true); // guard active by default
    setIfNotExistsMock.mockResolvedValue(true); // not a replay by default
    cacheDelMock.mockResolvedValue(1);
    cacheExistsMock.mockResolvedValue(true); // a `false` SET is a confirmed replay by default
});

describe('processBackchannelLogout', () => {
    it('sid-scoped: revokes by session, never cascades', async () => {
        validateMock.mockResolvedValue({ iss: 'I', sid: 'S', jti: 'j', iat: 1, exp: 9 });
        revokeBySessionMock.mockResolvedValue(1);
        cascadeFlag = true; // even with cascade on, sid must not cascade

        const out = await processBackchannelLogout('jwt');
        expect(out).toEqual({ revoked: 1, scope: 'sid' });
        expect(revokeBySessionMock).toHaveBeenCalledWith({ iss: 'I', sid: 'S' });
        expect(cascadeRefresh).not.toHaveBeenCalled();
        expect(cascadeJellyfin).not.toHaveBeenCalled();
    });

    it('sub-scoped without cascade: revokes sessions only', async () => {
        validateMock.mockResolvedValue({ iss: 'I', sub: 'U', jti: 'j', iat: 1, exp: 9 });
        revokeBySubjectMock.mockResolvedValue({ count: 2, userIds: ['u1', 'u2'] });

        const out = await processBackchannelLogout('jwt');
        expect(out).toEqual({ revoked: 2, scope: 'sub' });
        expect(cascadeRefresh).not.toHaveBeenCalled();
    });

    it('sub-scoped with cascade: also revokes device tokens per user', async () => {
        cascadeFlag = true;
        validateMock.mockResolvedValue({ iss: 'I', sub: 'U', jti: 'j', iat: 1, exp: 9 });
        revokeBySubjectMock.mockResolvedValue({ count: 1, userIds: [U1] });
        cascadeRefresh.mockResolvedValue(0);
        cascadeJellyfin.mockResolvedValue(0);

        await processBackchannelLogout('jwt');
        expect(cascadeRefresh).toHaveBeenCalledWith(U1);
        expect(cascadeJellyfin).toHaveBeenCalledWith(U1);
    });

    it('replayed jti: idempotent no-op success (SET false AND key confirmed present)', async () => {
        validateMock.mockResolvedValue({ iss: 'I', sid: 'S', jti: 'dup', iat: 1, exp: 9 });
        setIfNotExistsMock.mockResolvedValue(false); // already seen
        cacheExistsMock.mockResolvedValue(true); // key really is present → genuine replay

        const out = await processBackchannelLogout('jwt');
        expect(out).toEqual({ revoked: 0, scope: 'replayed' });
        expect(revokeBySessionMock).not.toHaveBeenCalled();
    });

    it('transient Valkey SET failure (false but key absent): fail-open, still revokes', async () => {
        // isValkeyReady() true, but setIfNotExists returns false due to a mid-call
        // error (NOT because the key exists). cacheExists confirms the key is absent,
        // so we must NOT treat it as a replay — proceed to revoke, never drop a logout.
        validateMock.mockResolvedValue({ iss: 'I', sid: 'S', jti: 'j', iat: 1, exp: 9 });
        setIfNotExistsMock.mockResolvedValue(false);
        cacheExistsMock.mockResolvedValue(false); // key not actually present → not a replay
        revokeBySessionMock.mockResolvedValue(1);

        const out = await processBackchannelLogout('jwt');
        expect(out).toEqual({ revoked: 1, scope: 'sid' });
        expect(revokeBySessionMock).toHaveBeenCalledWith({ iss: 'I', sid: 'S' });
    });

    it('Valkey down: fail-open, still revokes (never treated as replay)', async () => {
        isValkeyReadyMock.mockReturnValue(false);
        validateMock.mockResolvedValue({ iss: 'I', sid: 'S', jti: 'j', iat: 1, exp: 9 });
        revokeBySessionMock.mockResolvedValue(1);

        const out = await processBackchannelLogout('jwt');
        expect(out).toEqual({ revoked: 1, scope: 'sid' });
        expect(setIfNotExistsMock).not.toHaveBeenCalled();
    });

    it('revoke failure releases the jti marker so a retry is not dropped', async () => {
        validateMock.mockResolvedValue({ iss: 'I', sid: 'S', jti: 'j', iat: 1, exp: 9 });
        revokeBySessionMock.mockRejectedValue(new Error('db down'));

        await expect(processBackchannelLogout('jwt')).rejects.toThrow('db down');
        expect(cacheDelMock).toHaveBeenCalledTimes(1);
    });

    it('propagates validation failure', async () => {
        const { LogoutTokenError } = await import('./oidc-logout-token.js');
        validateMock.mockRejectedValue(new LogoutTokenError('bad'));
        await expect(processBackchannelLogout('jwt')).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('cascade: per-user isolation — first user failure does not skip second user', async () => {
        // Arrange: sub-scoped logout with two users; first Jellyfin revoke rejects.
        cascadeFlag = true;
        validateMock.mockResolvedValue({ iss: 'I', sub: 'U', jti: 'j', iat: 1, exp: 9 });
        revokeBySubjectMock.mockResolvedValue({ count: 2, userIds: [U1, U2] });
        cascadeJellyfin
            .mockRejectedValueOnce(new Error('jellyfin unavailable for first user'))
            .mockResolvedValueOnce(0);
        cascadeRefresh.mockResolvedValue(0);

        // Act: must resolve (per-user failure is swallowed).
        const out = await processBackchannelLogout('jwt');

        // Assert: outcome is still reported as a successful sub-scoped revocation.
        expect(out).toEqual({ revoked: 2, scope: 'sub' });
        // Both users were attempted despite the first rejection.
        expect(cascadeJellyfin).toHaveBeenCalledWith(U1);
        expect(cascadeJellyfin).toHaveBeenCalledWith(U2);
        expect(cascadeJellyfin).toHaveBeenCalledTimes(2);
        // Refresh was also called for both users.
        expect(cascadeRefresh).toHaveBeenCalledWith(U1);
        expect(cascadeRefresh).toHaveBeenCalledWith(U2);
    });
});
