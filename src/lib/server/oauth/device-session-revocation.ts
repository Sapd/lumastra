// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one place that revokes OAuth device sessions.
 *
 * Each function revokes the refresh-token rows under the device session's
 * advisory lock (see `lockDeviceSessions` in `oauth-refresh-tokens.queries.ts`)
 * and then calls {@link handleDeviceSessionsRevoked}, which cuts off the
 * sessions' access JWTs (this replica at once, the others via bus + Valkey
 * marker) and ends the stream tokens they minted.
 *
 * The hook runs whenever the session is established as the caller's —
 * including when this call revoked nothing because an earlier attempt already
 * did — so a retried logout still ends stream tokens a failed first attempt
 * left behind. The hook is idempotent.
 *
 * Route handlers and services must use these instead of the raw revoke
 * queries; a raw query skips the JWT / stream-token cut-off.
 */

import type postgres from 'postgres';
import { isInOpenTransaction } from '../database/with-tx.js';
import type { UserId } from '$lib/shared/user-id';
import {
    isDeviceSessionOwnedBy,
    listRevokedDeviceSessionIdsForUser,
    revokeAllUserRefreshTokensDetailed,
    revokeDeviceSessionTree,
    revokeUserClientRefreshTokensDetailed,
} from '../database/queries/oauth-refresh-tokens.queries.js';
import { Logger } from '../utils/logger';
import { handleDeviceSessionsRevoked } from './device-session-liveness.js';

const logger = Logger.for('OAuth:DeviceSessionRevocation');

export interface DeviceSessionRevokeResult {
    /** Refresh-token rows this call revoked. */
    revokedCount: number;
    /**
     * Whether the session belongs to the caller (`userId`), in any state. False
     * means "not yours / unknown" and nothing was cut off.
     */
    owned: boolean;
}

/**
 * Revoke one device session. With `userId`, only if the session belongs to
 * that user (a device_session_id is not a secret). Without it the caller
 * vouches for the session (it came from the caller's own JWT, or from a
 * refresh-token row the caller just validated).
 */
export async function revokeDeviceSession(
    sql: postgres.Sql,
    deviceSessionId: string,
    opts: { userId?: UserId } = {},
): Promise<DeviceSessionRevokeResult> {
    const { count: revokedCount, deviceSessionIds } = await revokeDeviceSessionTree(
        sql,
        deviceSessionId,
        opts.userId,
    );
    let owned = revokedCount > 0 || opts.userId === undefined;
    if (!owned && opts.userId !== undefined) {
        try {
            owned = await isDeviceSessionOwnedBy(sql, deviceSessionId, opts.userId);
        } catch (err) {
            logger.warn('Device session ownership lookup failed; skipping cut-off', {
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                error: String(err),
            });
        }
    }
    if (owned)
        await handleDeviceSessionsRevoked([...new Set([deviceSessionId, ...deviceSessionIds])]);
    return { revokedCount, owned };
}

/**
 * Collect the session ids for the cut-off: the ones this call revoked plus the
 * user's already-revoked ones (retry cleanup). Never a live session: one that
 * logged in after the revoke committed must not be tombstoned for the marker's
 * 24 h. Never fails the revoke.
 */
async function sessionsForCutOff(
    sql: postgres.Sql,
    userId: UserId,
    clientId: string | undefined,
    justRevoked: readonly string[],
): Promise<string[]> {
    try {
        return [
            ...new Set([
                ...justRevoked,
                ...(await listRevokedDeviceSessionIdsForUser(sql, userId, clientId)),
            ]),
        ];
    } catch (err) {
        logger.warn('Listing device sessions for cut-off failed; using the revoked ones', {
            error: String(err),
        });
        return [...justRevoked];
    }
}

/**
 * Revoke every device session of a user. The cut-off also covers sessions an
 * earlier attempt already revoked (retry cleanup).
 */
export async function revokeAllDeviceSessionsForUser(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{ count: number; deviceSessionIds: string[] }> {
    const { count, deviceSessionIds } = await revokeAllUserRefreshTokensDetailed(sql, userId);
    await handleDeviceSessionsRevoked(
        await sessionsForCutOff(sql, userId, undefined, deviceSessionIds),
        (await isInOpenTransaction(sql)) ? sql : undefined,
    );
    return { count, deviceSessionIds };
}

/** Revoke every device session of a user on one OAuth client. */
export async function revokeDeviceSessionsForUserClient(
    sql: postgres.Sql,
    userId: UserId,
    clientId: string,
): Promise<{ count: number; deviceSessionIds: string[] }> {
    const { count, deviceSessionIds } = await revokeUserClientRefreshTokensDetailed(
        sql,
        userId,
        clientId,
    );
    await handleDeviceSessionsRevoked(
        await sessionsForCutOff(sql, userId, clientId, deviceSessionIds),
    );
    return { count, deviceSessionIds };
}
