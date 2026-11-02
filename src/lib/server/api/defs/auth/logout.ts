// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/auth/logout.ts — POST /auth/logout
 *
 * The ONLY auth endpoint on the v1 token surface.
 * All browser/native/forward-auth flows stay on /api/auth/*.
 *
 * Token logout = revoke the refresh token (+ Jellyfin device token), keyed by
 * the JWT's `deviceSessionId`. The access JWT is cut off too: forward-auth
 * checks the device session's liveness on every JWT request
 * (`oauth/device-session-liveness.ts`), and the stream tokens the device
 * minted are ended.
 *
 * Auth: feature-gated (FEATURE_DEVICE_AUTH) → {kind:'user'}.
 * When the feature is off, enforce() returns 404 (feature does not exist).
 * When the token has no deviceSessionId (PAT/svc), returns 422 validation_failed
 * (PATs are "logged out" by deleting them at user/pats — this endpoint is
 * device-JWT-only by design).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getJellyfinTokenService } from '$lib/server/oauth/jellyfin-token.service.js';
import { revokeDeviceSession } from '$lib/server/oauth/device-session-revocation.js';

const logger = Logger.for('AuthLogoutDef');

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Auth'],
            summary: 'Revoke device session (logout)',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Revokes the device session identified by the `deviceSessionId` claim in the caller's " +
                'device JWT. Revokes both the OAuth refresh token and the Jellyfin device token (if present). ' +
                '**Device JWT only** — PAT and service tokens cannot call this endpoint. ' +
                'To revoke a PAT, use `DELETE /api/v1/me/pats/{id}` instead. ' +
                'Requires `FEATURE_DEVICE_AUTH` to be enabled.',
            responses: {
                204: 'Session revoked',
                401: 'Authentication required',
                404: 'Feature not enabled',
                422: 'No device session found (PAT/svc token used)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    // Feature-gated: FEATURE_DEVICE_AUTH must be enabled.
    // When off, enforce() returns 404 not_found ("feature does not exist").
    // When on, any authenticated user is allowed (device JWT, PAT, svc all pass
    // {kind:'user'}; the handler narrows to device-JWT-only via deviceSessionId).
    auth: { kind: 'feature', flag: 'FEATURE_DEVICE_AUTH', then: { kind: 'user' } },
    handlers: {
        /**
         * POST /auth/logout
         *
         * Revokes:
         *   1. The OAuth refresh token (identified by deviceSessionId from the JWT).
         *   2. The Jellyfin device token (if issued via the device auth flow).
         *
         * After this, the device must re-authenticate via the device auth flow.
         *
         * PAT tokens: NOT handled here. Delete them at DELETE /me/pats/{id}.
         */
        POST: async (event, _ctx) => {
            const deviceSessionId = event.locals.deviceSessionId;
            const username = event.locals.principal?.username ?? event.locals.user?.username;

            if (!deviceSessionId) {
                // PAT/service tokens don't carry a deviceSessionId — wrong endpoint.
                return ApiProblem.validationFailed(
                    'No device session found. This endpoint is for device auth tokens only. ' +
                        'To revoke a PAT, use DELETE /api/v1/me/pats/{id}.',
                );
            }

            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) {
                return ApiProblem.unauthorized();
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            let jellyfinRevoked = false;
            let oauthRevoked: boolean;

            // Revoke Jellyfin device token (best-effort — don't fail logout if Jellyfin is down).
            try {
                const jellyfinTokenService = getJellyfinTokenService();
                jellyfinRevoked = await jellyfinTokenService.revoke(deviceSessionId, userId);
            } catch (err) {
                logger.warn('Failed to revoke Jellyfin token during logout', {
                    error: String(err),
                });
            }

            // Revoke the OAuth refresh token. This is the one that matters: a
            // 204 here tells the client its session is gone, so a failed
            // UPDATE must not be reported as success — the refresh token
            // would still mint access tokens (admin/users review 2026-10-07,
            // item 6). The client retries on 503.
            try {
                // Also cuts off the access JWT that made this call and the
                // stream tokens the device minted (on a retry too).
                const result = await revokeDeviceSession(sql, deviceSessionId, { userId });
                oauthRevoked = result.revokedCount > 0;
            } catch (err) {
                logger.error(
                    'Failed to revoke OAuth refresh token during logout',
                    err instanceof Error ? err : new Error(String(err)),
                    { deviceSessionId: deviceSessionId.substring(0, 8) + '...' },
                );
                return ApiProblem.dependencyUnavailable('Could not revoke the device session');
            }

            logger.info('Device logged out', {
                username,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                jellyfinRevoked,
                oauthRevoked,
            });

            return new Response(null, { status: 204 });
        },
    },
});
