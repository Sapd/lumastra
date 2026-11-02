// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/password — admin-set a user's native password.
 *
 * POST /api/admin/users/:username/password
 *   No current-password check. Sets a password on forward-auth-only accounts too,
 *   granting native login. Force-logs-out the target.
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract: bare { username, passwordChanged }
 * Errors: problem+json (incl. 503 dependency_unavailable).
 *
 * Admin ceiling (security review 2026-09-13, C1): `users:admin` is a
 * fine-grained, non-admin-equivalent delegation scope. Resetting an ADMIN's
 * password requires the caller to already be an administrator
 * (`requireAdminCeiling()`). This endpoint is reachable directly (a
 * `users:admin` token calling `/api/admin/...`) as well as via
 * `delegateToAdmin()` from the v1 facade (`users/[id]/password.ts`, which
 * carries the same check pre-delegation) — `requireAdminCeiling()` judges the
 * caller via `principalBeforeDelegation()` first, so it catches both paths.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { resetPassword } from '$lib/server/services/admin-user.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

export const PasswordBody = z.object({
    newPassword: z.string().min(1, 'A new password is required'),
});

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: {
        body: PasswordBody,
    },
    handlers: {
        POST: async (event, ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Admin ceiling (security review 2026-09-13, C1): users:admin is a
            // non-admin delegation scope — resetting an ADMIN's password requires
            // the caller to already be an administrator.
            // Formula A, not the raw is_admin column (which lags for an
            // unpinned in-app or IdP-group admin).
            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can reset an admin's password",
            );
            if (ceilingErr) return ceilingErr;

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const { newPassword } = ctx.input!.body;

            const result = await resetPassword(db, { targetUsername: username, newPassword });
            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                if (result.status === 400) return ApiProblem.validationFailed(result.message);
                return ApiProblem.internalError(result.message);
            }
            auditLog('user.reset_password', username, auditActor(event), {
                targetUsername: username,
            });
            return json({ username, passwordChanged: true });
        },
    },
});
