// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/jellyfin-sync/pull  (backward-compat shim)
 *
 * The canonical endpoint is:
 *
 *   POST /api/v1/tasks/jellyfin-watch-sync/run
 *   GET  /api/v1/runs/{runId}
 *
 * This shim:
 *   1. Accepts admin `pat_`/`svc_` tokens via the mount() auth layer.
 *   2. Delegates to `orchestrator.startRun` — uses the scheduler's built-in
 *      concurrency guard (returns 409 on a concurrent run).
 *   3. Returns 202 with `{runId, location}` on success; 409 on conflict.
 *
 * Operators should use `POST /api/v1/tasks/jellyfin-watch-sync/run` and
 * poll `GET /api/v1/runs/{runId}` for the result.
 */

import { json } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { registry } from '$lib/server/tasks/registry.js';
import { features, config } from '$lib/server/config.js';

const TASK_ID = 'jellyfin-watch-sync';

const def = defineEndpoint({
    // tasks:run scope covers both admin PATs and service tokens.
    // mount()'s enforce() handles admin sessions too, so this is the
    // narrowest correct spec that doesn't require the old session-only path.
    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    handlers: {
        POST: async (event) => {
            // Feature gate — block when Jellyfin sync is not configured.
            if (!features.jellyfinSync || !config.JELLYFINAPIKEY) {
                return ApiProblem.dependencyUnavailable(
                    'Jellyfin sync is not configured on this server',
                );
            }

            // Verify the task is registered (guard against mis-configured deployments).
            if (!registry.getTask(TASK_ID)) {
                return ApiProblem.notFound(`Task '${TASK_ID}' is not registered`);
            }

            const actorId =
                event.locals.principal !== null && typeof event.locals.principal === 'object'
                    ? (event.locals.principal?.userId ?? 'unknown')
                    : 'unknown';

            try {
                const result = await orchestrator.startRun(
                    TASK_ID,
                    {},
                    { trigger: { kind: 'manual', by: actorId } },
                );

                return json(
                    {
                        runId: result.runId,
                        deduped: result.deduped,
                        location: `/api/v1/runs/${result.runId}`,
                    },
                    {
                        status: result.deduped ? 200 : 202,
                        headers: { Location: `/api/v1/runs/${result.runId}` },
                    },
                );
            } catch (err) {
                if (err instanceof BackpressureError) {
                    return ApiProblem.conflict(
                        'A Jellyfin watch-sync run is already in progress. ' +
                            'Poll GET /api/v1/runs?taskId=jellyfin-watch-sync for status.',
                    );
                }
                throw err;
            }
        },
    },
});

export const { POST } = mount(def, { surface: 'v1' });
