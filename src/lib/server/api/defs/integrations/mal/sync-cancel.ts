// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/integrations/mal/sync/cancel — cancel an in-flight manual
 * Import/Export run for the current user. `runId` must be a
 * `watch-sync-manual` run OWNED by the caller (verified via
 * `assertRunOwnedBy`, Task 9 — it also narrows to
 * `task_id = 'watch-sync-manual'` so a user can't redirect this action at
 * one of their own unrelated runs). A missing run, a run owned by someone
 * else, and a run of the wrong task type all 404 identically — never
 * distinguish, to avoid leaking whether a given run id exists.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { assertRunOwnedBy } from '$lib/server/database/queries/watch-sync-run.queries.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';

const PROVIDER = 'mal';
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_S = 60;

const bodySchema = z.object({ runId: z.string() });

export const malSyncCancelDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        body: bodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rl = await checkRateLimit(
                `watch-sync-cancel:${PROVIDER}:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            const { runId } = ctx.input!.body;
            const owned = await assertRunOwnedBy(sql, runId, user.userId);
            if (!owned) return ApiProblem.notFound('Run not found');

            const result = await orchestrator.cancelRun(runId, { reason: 'user-requested' });
            return json(result);
        },
    },
});
