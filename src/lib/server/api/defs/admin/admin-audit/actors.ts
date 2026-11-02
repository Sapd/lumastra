// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/admin-audit/actors.ts
 *
 * GET /api/admin/admin-audit/actors
 *
 * Returns the distinct actor usernames seen in audit_log (source='admin'),
 * sorted alphabetically. Used to populate the actor filter chip bar in
 * AdminAuditFeed on initial load so that rarely-active admins appear
 * immediately rather than only when their events happen to scroll into view.
 *
 * Response: { actors: string[] }
 * 503 dependency_unavailable when DB is down.
 *
 * Auth: admin.  Surface: internal-only.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listDistinctAdminActors } from '$lib/server/database/queries/admin-audit.queries.js';
import { AdminAuditActorsResponseSchema } from '$lib/schemas/admin-audit.schema.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const actors = await listDistinctAdminActors(sql);
            return json(AdminAuditActorsResponseSchema.parse({ actors }));
        },
    },
});
