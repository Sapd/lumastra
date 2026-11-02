// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device Logout API
 *
 * Allows third-party apps (tvOS, etc.) to log out and revoke their session.
 * This revokes both the OAuth refresh token and Jellyfin device token.
 *
 * POST /api/auth/logout
 * Requires Bearer token authentication (JWT from device auth flow)
 */

import { z } from 'zod';
import { typedJson } from '$lib/server/utils/typed-response.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getJellyfinTokenService } from '$lib/server/oauth/jellyfin-token.service.js';
import { features } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { revokeDeviceSession } from '$lib/server/oauth/device-session-revocation.js';

const ENDPOINT = '/api/auth/logout';
const logger = Logger.for('Auth:Logout');

const LogoutResponseSchema = z
    .object({
        loggedOut: z.boolean(),
        jellyfinRevoked: z.boolean(),
        oauthRevoked: z.boolean(),
    })
    .passthrough();

/**
 * POST /api/auth/logout
 * Revoke the current device session (logout)
 *
 * The device_session_id is extracted from the Bearer token (JWT).
 * This will:
 * 1. Revoke the OAuth refresh token
 * 2. Revoke the Jellyfin device token
 *
 * After this, the device will need to re-authenticate via the device auth flow.
 */
export const POST: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals }) => {
        if (!features.deviceAuth) {
            return ApiResponses.serviceUnavailable(
                'Device logout',
                'Device auth is not enabled',
                ENDPOINT,
            );
        }

        const deviceSessionId = locals.deviceSessionId;
        const username = locals.user.username;

        if (!deviceSessionId) {
            // This could happen if the token doesn't have a device_session_id
            // (e.g., PAT tokens or service tokens don't have device sessions)
            return ApiResponses.badRequest(
                'No device session found. This endpoint is for device auth tokens only.',
                undefined,
                ENDPOINT,
            );
        }

        const sql = getDb();
        if (!sql) {
            return ApiResponses.error('Database connection unavailable');
        }

        let jellyfinRevoked = false;
        let oauthRevoked = false;

        // Revoke Jellyfin device token
        try {
            const jellyfinTokenService = getJellyfinTokenService();
            jellyfinRevoked = await jellyfinTokenService.revoke(
                deviceSessionId,
                locals.user.userId,
            );
        } catch (error) {
            logger.warn('Failed to revoke Jellyfin token during logout', {
                error: String(error),
            });
        }

        // Revoke OAuth refresh token
        try {
            // Also cuts off this device's access JWTs and stream tokens.
            const result = await revokeDeviceSession(sql, deviceSessionId, {
                userId: locals.user.userId,
            });
            oauthRevoked = result.revokedCount > 0;
        } catch (error) {
            logger.warn('Failed to revoke OAuth token during logout', {
                error: String(error),
            });
        }

        logger.info('Device logged out', {
            username,
            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
            jellyfinRevoked,
            oauthRevoked,
        });

        return typedJson(LogoutResponseSchema, {
            loggedOut: true,
            jellyfinRevoked,
            oauthRevoked,
        });
    }),
);
