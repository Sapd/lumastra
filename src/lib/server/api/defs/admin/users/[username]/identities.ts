// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/identities — federated identity management.
 *
 * GET    /api/admin/users/:username/identities  → list identities + JF map
 * DELETE /api/admin/users/:username/identities  → unlink one (provider + subject query params)
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract:
 *   GET    → bare { identities, jellyfinMap } (from service)
 *   DELETE → bare { username, unlinked }
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { listUserIdentities, unlinkIdentity } from '$lib/server/services/admin-identity.service.js';
import { json } from '@sveltejs/kit';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    // DELETE reads ?provider=&subject= directly from event.url.searchParams;
    // no shared query schema to avoid failing GET requests (no params).
    handlers: {
        GET: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const result = await listUserIdentities(db, username);
            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                return ApiProblem.internalError(result.message);
            }
            return json({ ...result.data });
        },

        DELETE: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const provider = event.url.searchParams.get('provider')?.trim();
            const subject = event.url.searchParams.get('subject')?.trim();
            if (!provider || !subject) {
                return ApiProblem.validationFailed([
                    {
                        field: 'provider',
                        message: 'provider and subject query params are required',
                    },
                ]);
            }

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can unlink an admin's sign-in identity",
            );
            if (ceilingErr) return ceilingErr;

            const result = await unlinkIdentity(db, username, provider, subject);
            if (!result.ok) {
                if (result.status === 404) return ApiProblem.notFound(result.message);
                return ApiProblem.internalError(result.message);
            }
            auditLog('user.identity-unlink', username, auditActor(event), { provider });
            return json({ username, unlinked: result.data.unlinked });
        },
    },
});
