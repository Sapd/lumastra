// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ingest/diagnostics
 *
 * Aggregates the four "actionable detail" datasets that power the
 * Ingest Map's diagnostic panels (health strip, stuck items, dead
 * letter, error groups) into a single response.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    loadIngestPipelineSummary,
    loadStuckItems,
    loadDeadLetterItems,
    loadErrorGroups,
} from '$lib/server/database/queries/ingest-map.queries.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const [summary, stuck, deadLetter, errorGroups] = await Promise.all([
                loadIngestPipelineSummary(sql),
                loadStuckItems(sql, 20),
                loadDeadLetterItems(sql, 20),
                loadErrorGroups(sql, 20),
            ]);
            return json({
                summary,
                stuckItems: stuck,
                deadLetter,
                errorGroups,
            });
        },
    },
});
