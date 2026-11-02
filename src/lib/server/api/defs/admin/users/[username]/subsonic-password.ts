// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/subsonic-password — admin manage target user's Subsonic token.
 *
 * GET    /api/admin/users/:username/subsonic-password → { hasToken }
 * POST   /api/admin/users/:username/subsonic-password → generate/reset; shows token once
 * DELETE /api/admin/users/:username/subsonic-password → revoke token
 *
 * Feature-gated: subsonicCompat must be enabled.
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract:
 *   GET    → bare { hasToken }
 *   POST   → bare { token }
 *   DELETE → bare { revoked: true }
 * Errors: problem+json (incl. 503 dependency_unavailable, 404 not_found).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { features } from '$lib/server/config.js';
import {
    getOrCreateToken,
    resetToken,
    deleteUserToken,
    formatTokenForDisplay,
} from '$lib/server/subsonic-compat/auth.js';
import { getTokenByUserId } from '$lib/server/database/queries/subsonic-client-passwords.queries.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            if (!features.subsonicCompat) return ApiProblem.notFound('Feature not enabled');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const user = await getUserByUsername(db, username);
            if (!user) return ApiProblem.notFound('User');

            const row = await getTokenByUserId.one(db, { userId: user.id });
            return json({ hasToken: row !== null });
        },

        POST: async (event, _ctx) => {
            if (!features.subsonicCompat) return ApiProblem.notFound('Feature not enabled');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can reset an admin's Subsonic token",
            );
            if (ceilingErr) return ceilingErr;

            const user = await getUserByUsername(db, username);
            if (!user) return ApiProblem.notFound('User');

            const existing = await getTokenByUserId.one(db, { userId: user.id });
            const plaintext = existing
                ? await resetToken(user.id)
                : await getOrCreateToken(user.id);

            auditLog('user.subsonic_token_reset', user.username, auditActor(event), {
                targetUsername: user.username,
                reset: existing !== null,
            });
            return json({ token: formatTokenForDisplay(plaintext) });
        },

        DELETE: async (event, _ctx) => {
            if (!features.subsonicCompat) return ApiProblem.notFound('Feature not enabled');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can revoke an admin's Subsonic token",
            );
            if (ceilingErr) return ceilingErr;

            const user = await getUserByUsername(db, username);
            if (!user) return ApiProblem.notFound('User');

            await deleteUserToken(user.id);
            auditLog('user.subsonic_token_revoke', user.username, auditActor(event), {
                targetUsername: user.username,
            });
            return json({ revoked: true });
        },
    },
});
