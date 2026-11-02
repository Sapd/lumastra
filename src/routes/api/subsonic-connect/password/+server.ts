// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subsonic Connect Token Management API
 *
 * Manages the per-user Subsonic token for OpenSubsonic-compatible client
 * connections (DSub, Substreamer, Ultrasonic, etc.).
 *
 * GET    - Check whether the current user has a Subsonic token configured
 * POST   - Generate (or reset) the token, returning it for display
 * DELETE - Revoke the token
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { features } from '$lib/server/config.js';
import {
    getOrCreateToken,
    resetToken,
    deleteUserToken,
    formatTokenForDisplay,
} from '$lib/server/subsonic-compat/auth.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getTokenByUserId } from '$lib/server/database/queries/subsonic-client-passwords.queries.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';

const ENDPOINT = '/api/subsonic-connect/password';

const HasTokenResponseSchema = z.object({
    hasToken: z.boolean(),
});

const TokenResponseSchema = z.object({
    token: z.string(),
});

const SuccessResponseSchema = z.object({
    success: z.boolean(),
});

/**
 * GET /api/subsonic-connect/password
 * Check if the current user has a Subsonic token configured.
 */
export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals }) => {
        if (!features.subsonicCompat) {
            return ApiResponses.notFound('Feature', ENDPOINT);
        }

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        const userRow = await getUserByUsername(sql, locals.user.username);
        if (!userRow) {
            return ApiResponses.notFound('User', ENDPOINT);
        }

        const row = await getTokenByUserId.one(sql, { userId: userRow.id });

        return typedJson(HasTokenResponseSchema, {
            hasToken: row !== null,
        });
    }),
);

/**
 * POST /api/subsonic-connect/password
 * Generate or reset the Subsonic token. Returns the plaintext token for
 * one-time display — only the value is stored (no hashing for Subsonic).
 *
 * Rate limited: 5 resets per minute per user to prevent session-revocation abuse.
 */
export const POST: RequestHandler = withValkeyRateLimit(
    5,
    60,
)(
    requireAuth(
        withErrorHandler(async ({ locals }) => {
            if (!features.subsonicCompat) {
                return ApiResponses.notFound('Feature', ENDPOINT);
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            const userRow = await getUserByUsername(sql, locals.user.username);
            if (!userRow) {
                return ApiResponses.notFound('User', ENDPOINT);
            }

            const existing = await getTokenByUserId.one(sql, {
                userId: userRow.id,
            });

            const plaintext = existing
                ? await resetToken(userRow.id)
                : await getOrCreateToken(userRow.id);

            return typedJson(TokenResponseSchema, {
                token: formatTokenForDisplay(plaintext),
            });
        }),
    ),
);

/**
 * DELETE /api/subsonic-connect/password
 * Revoke the Subsonic token, disconnecting all OpenSubsonic-compatible clients.
 */
export const DELETE: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals }) => {
        if (!features.subsonicCompat) {
            return ApiResponses.notFound('Feature', ENDPOINT);
        }

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        const userRow = await getUserByUsername(sql, locals.user.username);
        if (!userRow) {
            return ApiResponses.notFound('User', ENDPOINT);
        }

        await deleteUserToken(userRow.id);

        return typedJson(SuccessResponseSchema, { success: true });
    }),
);
