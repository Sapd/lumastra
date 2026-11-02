// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { defaultActivitySharing } from '$lib/server/config/activity-sharing.js';
import { applyActivitySharingDefault } from '$lib/server/database/queries/activity-sharing.queries.js';
import { auditActor, auditLog } from '$lib/server/utils/audit-log.js';

import { ApplyActivitySharingDefaultBodySchema } from '$lib/schemas/activity-sharing.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { body: ApplyActivitySharingDefaultBodySchema },
    handlers: {
        GET: async () =>
            json(
                { sharing: defaultActivitySharing() },
                { headers: { 'Cache-Control': 'no-store' } },
            ),
        POST: async (event, ctx) => {
            const sharing = defaultActivitySharing();
            if (ctx.input!.body.expectedDefault !== sharing) {
                return ApiProblem.conflict('The saved sharing default changed. Confirm it again.');
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const changedCount = await applyActivitySharingDefault(sql, sharing);
            auditLog('users.apply_activity_sharing_default', 'users', auditActor(event), {
                sharing,
                changedCount,
            });
            return json({ sharing, changedCount });
        },
    },
});
