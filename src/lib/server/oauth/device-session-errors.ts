// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown by {@link RefreshTokenService.create} when asked to add a token to a
 * device session that has already been revoked (a logout raced the login that
 * reused the session id). The caller fails the grant; the client's next poll
 * resolves a fresh session.
 */
export class DeviceSessionRevokedError extends Error {
    constructor() {
        super('Device session has been revoked');
        this.name = 'DeviceSessionRevokedError';
    }
}
