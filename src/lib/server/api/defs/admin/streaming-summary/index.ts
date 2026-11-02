// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/streaming-summary/index.ts
 *
 * GET /api/admin/streaming-summary
 *
 * Compact, ambient "what's streaming right now" summary for the Operations
 * drawer: active stream count, distinct users, transcode count, aggregate
 * bandwidth, and a short per-stream list. Read-only. NOT part of the
 * attention/alert model — this is the glance; /admin/users/sessions is the console.
 *
 * Auth: admin.
 * Surface: internal-only.
 * Response: StreamingSummary bare object. Always Cache-Control: no-store.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getStreamingSummary } from '$lib/server/services/streaming-summary.service.js';
import { StreamingSummarySchema } from '$lib/schemas/api-streaming-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const summary = await getStreamingSummary(sql);
            return json(StreamingSummarySchema.parse(summary), {
                headers: { 'Cache-Control': 'no-store' },
            });
        },
    },
});
