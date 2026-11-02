// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip
// Composed into devices/[id]/index.ts; this implementation requires its id param.

/**
 * defs/devices/index.ts — GET /devices?scope=mine
 *
 * GET /devices?scope=mine
 *   Returns all device sessions for the authenticated user, enriched with
 *   live presence data from Valkey (heartbeat state).  Query params:
 *     - scope: currently only "mine" (reserved for future scope=all admin view)
 *     - onlineOnly: boolean — filter to only online devices
 *     - watchTogether: boolean — filter to only Watch-Together-capable devices
 *
 * Auth: feature:DEVICE_AUTH → user
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getActiveRefreshTokens } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';
import { getJellyfinTokenBySession } from '$lib/server/database/queries/provider-device-tokens.queries.js';
import type { RefreshTokenRow } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';
import { revokeDeviceSession } from '$lib/server/oauth/device-session-revocation.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DeviceRevoke');
type OAuthTokenRow = RefreshTokenRow;
export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: { params: z.object({ id: z.string().min(1) }) },
    docs: {
        DELETE: {
            tags: ['Devices'],
            summary: 'Revoke a device session',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Revoked',
                404: 'Device not found',
                422: 'Invalid device session ID',
            },
        },
    },
    handlers: {
        DELETE: async (event, _ctx) => {
            const { locals } = event;

            const deviceSessionId = event.params.id;
            if (!deviceSessionId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Required query parameter: id (deviceSessionId)' },
                ]);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not initialised');
            }

            const userId = locals.user!.userId;

            // Existence and revocation are decided entirely from core state. A device
            // session is an OAuth session; whether Jellyfin also holds a token for it
            // is an implementation detail of an optional integration and must not
            // change whether this endpoint finds or revokes the session.
            const oauthTokens = (await getActiveRefreshTokens(sql, userId)) as OAuthTokenRow[];
            const tokenToRevoke = oauthTokens.find((t) => t.device_session_id === deviceSessionId);

            if (!tokenToRevoke) {
                // Already revoked (or never ours): idempotent cut-off for a
                // retry; a no-op for a session that isn't the user's.
                await revokeDeviceSession(sql, deviceSessionId, { userId });
                return ApiProblem.notFound('Device session not found');
            }

            // Revoke by session, not by the one token hash we happened to find: since
            // 16.218.0 a session can hold a superseded-but-still-valid predecessor
            // alongside its current token, and killing only one of them would leave the
            // "revoked" device able to refresh itself back to life.
            // Also cuts off the device's access JWTs and stream tokens.
            const { revokedCount } = await revokeDeviceSession(sql, deviceSessionId, { userId });

            // Optional integration cleanup: drop the paired Jellyfin token if one
            // exists. Lazily imported and failure-tolerant so that on an install
            // without Jellyfin this branch costs nothing and cannot fail the revoke.
            let jellyfinRevoked = false;
            try {
                const jellyfinToken = await getJellyfinTokenBySession(sql, deviceSessionId);
                if (jellyfinToken && jellyfinToken.user_id === userId) {
                    const { getJellyfinTokenService } =
                        await import('$lib/server/oauth/jellyfin-token.service.js');
                    jellyfinRevoked = await getJellyfinTokenService().revoke(
                        deviceSessionId,
                        userId,
                    );
                }
            } catch (error) {
                logger.warn('Jellyfin token cleanup failed; core session was still revoked', {
                    deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                    error: String(error),
                });
            }

            logger.info('Device session revoked', {
                username: locals.user!.username,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                jellyfinRevoked,
                oauthRevoked: revokedCount > 0,
            });

            return new Response(null, { status: 204 });
        },
    },
});
