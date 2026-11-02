// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/integrations/mal/sync/status — the current user's latest manual
 * Import/Export run status for MAL (Task 7's `watch-sync-manual`), plus
 * their last 10 activity items. Returns an idle status (`state: null`) when
 * the user has never triggered a manual sync for this provider.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    assertRunOwnedBy,
    getLatestManualRunId,
} from '$lib/server/database/queries/watch-sync-run.queries.js';
import { getSyncActivity } from '$lib/server/database/queries/watch-sync-activity.queries.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { idleSyncStatus, projectRunToStatus } from '../watch-sync-status-projection.js';

const PROVIDER = 'mal';
const ACTIVITY_LIMIT = 10;

export const malSyncStatusDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const recentActivity = await getSyncActivity(sql, {
                userId: user.userId,
                provider: PROVIDER,
                limit: ACTIVITY_LIMIT,
            });

            const runId = await getLatestManualRunId(sql, user.userId, PROVIDER);
            if (!runId) return json(idleSyncStatus(recentActivity));

            // Defensive re-check: getLatestManualRunId already scopes by
            // scope->>'userId', so this should never fail — but never trust a
            // run id belongs to the caller without re-verifying ownership.
            const owned = await assertRunOwnedBy(sql, runId, user.userId);
            if (!owned) return json(idleSyncStatus(recentActivity));

            const run = await orchestrator.getRun(runId);
            if (!run) return json(idleSyncStatus(recentActivity));

            return json(projectRunToStatus(run, recentActivity));
        },
    },
});
