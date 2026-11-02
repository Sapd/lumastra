// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/notifications/broadcasts/index.ts
 *
 * GET /api/admin/notifications/broadcasts — the admin broadcast log.
 *
 * Auth: admin. Surface: internal-only.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listBroadcasts } from '$lib/server/database/queries/admin-broadcasts.queries.js';
import { AdminBroadcastListResponseSchema } from '$lib/schemas/admin-broadcasts.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        /**
         * Recent broadcasts, newest first.
         *
         * Uncursored: the query bounds itself at 100, and this is an operator
         * log of deliberate, low-frequency actions rather than a feed. Paging
         * an install's entire announcement history is not a workflow anyone has.
         */
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const items = await listBroadcasts(sql);
            return json(AdminBroadcastListResponseSchema.parse({ items }), {
                headers: { 'Cache-Control': 'private, no-cache' },
            });
        },
    },
});
