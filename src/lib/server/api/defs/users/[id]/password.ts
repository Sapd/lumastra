// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/users/[id]/password.ts — POST /api/v1/users/{id}/password
 *
 * Admin-set a user's native password. Requires `users:admin` scope.
 *
 * NOTE: The delegated admin handler resolves by username. We resolve the UUID
 * {id} to a username first, then inject params.username before delegation,
 * exactly as the hand-written route did.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/users/[id]/password/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 *
 * Admin ceiling (security review 2026-09-13, C1): `users:admin` is a
 * fine-grained, non-admin-equivalent delegation scope. Resetting an ADMIN's
 * password requires the caller to already be an administrator
 * (`requireAdminCeiling()`) — checked here, BEFORE `delegateToAdmin()` elevates
 * `locals.principal` for the internal handoff, so the ceiling always judges
 * the real (pre-delegation) caller. The internal admin handler
 * (`admin/users/[username]/password.ts`) carries the same check for its own
 * `/api/admin/...` surface, which a `users:admin` token can also call directly.
 */

import { PasswordBody } from '../../admin/users/[username]/password.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { POST as adminPOST } from '../../../../../../routes/api/admin/users/[username]/password/+server.js';
import { UserPasswordChangeResponseSchema } from '$lib/schemas/api-user-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    docs: {
        POST: {
            tags: ['Users'],
            summary: "Set a user's password (admin)",
            stability: 'stable',
            auth: 'bearer',
            // Documentation only: the delegated admin mount must read the body once.
            body: PasswordBody,
            bodyRequired: true,
            responses: {
                200: {
                    schema: UserPasswordChangeResponseSchema,
                    description: 'Password changed successfully',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (users:admin required), or caller is not an administrator (target is an admin)',
                404: 'User not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const user = await getUserById(db, event.params.id ?? '');
            if (!user) return ApiProblem.notFound('User not found');

            // Admin ceiling (security review 2026-09-13, C1): users:admin is a
            // non-admin delegation scope — resetting an ADMIN's password requires
            // the caller to already be an administrator. Judged BEFORE delegation
            // so the pre-delegation (real) caller is what's checked.
            // Formula A, not the raw is_admin column (which lags for an
            // unpinned in-app or IdP-group admin).
            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                user.username,
                "Only administrators can reset an admin's password",
            );
            if (ceilingErr) return ceilingErr;

            (event.params as Record<string, string>).username = user.username;

            return delegateToAdmin(event, adminPOST!);
        },
    },
});
