// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/coverage/backlog
 *
 * Returns the current sweepable backlog count for every enqueueable stage
 * registered in the task registry. Each count applies the same predicate as
 * the `stage-sweep` task: status IN (pending, failed_transient,
 * skipped_transient, obsolete) AND next_eligible_at elapsed AND not dismissed.
 *
 * Response shape: { stages: Array<{ stage_id: string; backlog: number }> }
 *
 * Auth: tasks:admin. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { registry } from '$lib/server/tasks/registry.js';
import { countSweepBacklog } from '$lib/server/database/queries/stage-sweep.queries.js';
import { getTrickplayDisplayCounts } from '$lib/server/services/trickplay-coverage.service.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const tasks = registry.getAllTasks();

            const enqueueable: Array<{ taskId: string; stageId: string }> = [];
            for (const task of tasks) {
                if (!task.coversStages) continue;
                for (const stage of task.coversStages) {
                    if (stage.enqueueable === true) {
                        enqueueable.push({ taskId: task.id, stageId: stage.id });
                    }
                }
            }

            const results = await Promise.all(
                enqueueable.map(async ({ stageId }) => ({
                    stage_id: stageId,
                    backlog:
                        stageId === 'trickplay-params-sync'
                            ? (await getTrickplayDisplayCounts(sql)).remaining
                            : await countSweepBacklog(sql, stageId),
                })),
            );

            return json({ stages: results });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
