// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Connect Password Management API
 *
 * Manages the short human-readable client password for Jellyfin-compatible
 * client connections (Swiftfin, Findroid, etc.).
 *
 * GET    - Check whether the current user has a client password configured
 * POST   - Generate (or reset) the client password, returning it for display
 * DELETE - Revoke the client password
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
    getOrCreatePassword,
    resetPassword,
    deletePasswordForUser,
    formatPasswordForDisplay,
} from '$lib/server/proprietary/jellyfin-compat/auth.js';
import { Database } from '$lib/server/database/connection.js';
import { getPasswordByUserId } from '$lib/server/database/queries/jellyfin-client-passwords.queries.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';

const ENDPOINT = '/api/jellyfin-connect/password';

const HasPasswordResponseSchema = z.object({
    hasPassword: z.boolean(),
});

const PasswordResponseSchema = z.object({
    password: z.string(),
});

const SuccessResponseSchema = z.object({
    success: z.boolean(),
});

/**
 * GET /api/jellyfin-connect/password
 * Check if the current user has a client password configured.
 */
export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals }) => {
        if (!features.jellyfinCompat) {
            return ApiResponses.notFound('Feature', ENDPOINT);
        }

        const db = new Database();
        const sql = db.getSql();

        const userRow = await getUserByUsername(sql, locals.user.username);
        if (!userRow) {
            return ApiResponses.notFound('User', ENDPOINT);
        }

        const row = await getPasswordByUserId.one(sql, { userId: userRow.id });

        return typedJson(HasPasswordResponseSchema, {
            hasPassword: row !== null,
        });
    }),
);

/**
 * POST /api/jellyfin-connect/password
 * Generate or reset the client password. Returns the plaintext password for
 * one-time display — only the hash is stored.
 *
 * INTENTIONAL: no body validation. The plaintext password is generated
 * server-side; the request carries no JSON body and the authenticated user
 * identity (from `locals.user`) is the only input. Adding a schema here
 * would only validate {}. The DELETE handler is similarly bodyless.
 *
 * Rate limited: 5 resets per minute per user to prevent session-revocation abuse.
 */
export const POST: RequestHandler = withValkeyRateLimit(
    5,
    60,
)(
    requireAuth(
        withErrorHandler(async ({ locals }) => {
            if (!features.jellyfinCompat) {
                return ApiResponses.notFound('Feature', ENDPOINT);
            }

            const db = new Database();
            const sql = db.getSql();

            const userRow = await getUserByUsername(sql, locals.user.username);
            if (!userRow) {
                return ApiResponses.notFound('User', ENDPOINT);
            }

            const existing = await getPasswordByUserId.one(sql, {
                userId: userRow.id,
            });

            const plaintext = existing
                ? await resetPassword(userRow.id)
                : await getOrCreatePassword(userRow.id);

            return typedJson(PasswordResponseSchema, {
                password: formatPasswordForDisplay(plaintext),
            });
        }),
    ),
);

/**
 * DELETE /api/jellyfin-connect/password
 * Revoke the client password, disconnecting all Jellyfin-compatible clients.
 */
export const DELETE: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals }) => {
        if (!features.jellyfinCompat) {
            return ApiResponses.notFound('Feature', ENDPOINT);
        }

        const db = new Database();
        const sql = db.getSql();

        const userRow = await getUserByUsername(sql, locals.user.username);
        if (!userRow) {
            return ApiResponses.notFound('User', ENDPOINT);
        }

        await deletePasswordForUser(userRow.id);

        return typedJson(SuccessResponseSchema, { success: true });
    }),
);
