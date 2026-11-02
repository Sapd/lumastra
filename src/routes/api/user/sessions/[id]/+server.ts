// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/user/sessions/{id} — revoke one of the caller's own native
 * web-login sessions by row id. IDOR-safe: `SessionService.revokeOwnSessionById`
 * scopes the UPDATE to `user_id = caller`, so a foreign/unknown id 404s rather
 * than leaking existence via a 403.
 */

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getSessionService } from '$lib/server/services/session.service.js';

export const DELETE: RequestHandler = requireAuth(
    withErrorHandler(async ({ locals, params }) => {
        const userId = locals.user.userId;
        const id = params.id;
        if (!id) return ApiResponses.notFound('Session');

        const revoked = await getSessionService().revokeOwnSessionById(id, userId);
        if (!revoked) return ApiResponses.notFound('Session');

        return new Response(null, { status: 204 });
    }),
);
