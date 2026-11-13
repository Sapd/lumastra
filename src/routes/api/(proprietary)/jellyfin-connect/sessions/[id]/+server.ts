// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Connect — Revoke One Connected Client
 *
 * DELETE - Sign out a single Jellyfin-compatible client, addressed by the
 *          opaque `id` from `GET /api/jellyfin-connect/sessions`.
 *
 * The lookup is scoped to the caller's own session index, so an id belonging to
 * (or guessed for) another account simply matches nothing. Missing ids answer
 * 404 rather than a silent success, so the UI can tell "already gone" from
 * "revoked just now".
 */

import type { RequestHandler } from './$types';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { features } from '$lib/server/config.js';
import { revokeSessionForUser } from '$lib/server/proprietary/jellyfin-compat/auth.js';
import { Database } from '$lib/server/database/connection.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { JellyfinClientSessionDeleteResponseSchema } from '$lib/schemas/api-user-responses.js';

const ENDPOINT = '/api/jellyfin-connect/sessions/[id]';

export const DELETE: RequestHandler = withValkeyRateLimit(
    30,
    60,
)(
    requireAuth(
        withErrorHandler(async ({ locals, params }) => {
            if (!features.jellyfinCompat) {
                return ApiResponses.notFound('Feature', ENDPOINT);
            }

            const id = params.id;
            if (!id) {
                return ApiResponses.badRequest('Session id is required');
            }

            const db = new Database();
            const sql = db.getSql();

            const userRow = await getUserByUsername(sql, locals.user.username);
            if (!userRow) {
                return ApiResponses.notFound('User', ENDPOINT);
            }

            const revoked = await revokeSessionForUser(userRow.id, id);
            if (!revoked) {
                return ApiResponses.notFound('Session', ENDPOINT);
            }

            return typedJson(JellyfinClientSessionDeleteResponseSchema, { success: true });
        }),
    ),
);
