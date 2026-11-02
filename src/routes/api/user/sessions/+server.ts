// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/user/sessions — owner-scoped native (built-in) web-login list + revoke.
 * GET  → list the caller's live `user_sessions` rows (never `token_hash`),
 *        flagging the one behind the current request's session cookie.
 * POST → revoke all OTHER native sessions for the caller (keep this device).
 *
 * Plain RequestHandlers (not `defineEndpoint`/`mount`) because GET needs
 * `event.cookies` to derive the current-session flag. Under forward-auth these
 * lists are expected to be empty — no native `user_sessions` row is created for
 * an Authentik-authenticated browser session.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { listUserSessions } from '$lib/server/database/queries/user-sessions.queries.js';
import { readSessionCookie } from '$lib/server/auth/native-session.js';
import { hashSessionToken, toWebLoginViews } from '$lib/server/utils/web-logins-util.js';

const ENDPOINT = '/api/user/sessions';

export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals, cookies }) => {
        const userId = locals.user.userId;
        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.aiDatabaseUnavailable(ENDPOINT);

        const rows = await listUserSessions(sql, userId);
        const currentToken = readSessionCookie(cookies);
        const currentHash = currentToken ? hashSessionToken(currentToken) : null;

        return json({ items: toWebLoginViews(rows, currentHash) });
    }),
);

// Revoke all OTHER native sessions for the caller (keep the current one).
export const POST: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals, cookies }) => {
        const userId = locals.user.userId;
        const token = readSessionCookie(cookies);
        if (!token) {
            return ApiResponses.badRequest(
                'No native session cookie on this request',
                undefined,
                ENDPOINT,
            );
        }

        // revokeAllForUserExcept hashes internally — pass the plaintext cookie.
        await getSessionService().revokeAllForUserExcept(userId, token);
        return new Response(null, { status: 204 });
    }),
);
