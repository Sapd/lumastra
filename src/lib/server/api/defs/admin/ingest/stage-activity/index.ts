// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ingest/stage-activity
 *
 * Returns per-stage activity (last completion timestamp, recent throughput,
 * current running count, recent failures) AND per-headline-stage PROGRESS
 * denominated in ELIGIBLE items. Powers the Ingest Map captions AND the
 * fresh-admin library-progress hero — "X of Y done, ~ETA" per stage.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    loadStageActivity,
    loadStageProgressByIds,
    HEADLINE_PROGRESS_STAGE_IDS,
} from '$lib/server/database/queries/ingest-map.queries.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const [stages, progressRows] = await Promise.all([
                loadStageActivity(sql),
                loadStageProgressByIds(sql, HEADLINE_PROGRESS_STAGE_IDS),
            ]);

            const activityById = new Map(stages.map((s) => [s.stage_id, s]));
            const progress = progressRows.map((p) => {
                const a = activityById.get(p.stage_id);
                return {
                    stage_id: p.stage_id,
                    completed: p.completed,
                    remaining: p.remaining,
                    notApplicable: p.not_applicable,
                    eligibleTotal: p.completed + p.remaining,
                    completed_5m: a?.completed_5m ?? 0,
                    running: a?.running ?? 0,
                    failedRecent: a?.failed_1h ?? 0,
                    failed_transient: p.failed_transient,
                    failed_permanent: p.failed_permanent,
                };
            });

            return json({ stages, progress });
        },
    },
});
