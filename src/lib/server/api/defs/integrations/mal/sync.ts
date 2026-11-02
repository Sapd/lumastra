// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/integrations/mal/sync — one-off Import (pull) or Export (push)
 * against the MAL connection for the current user. Requires the account to
 * be linked. Delegates to the `watch-sync-manual` task
 * (Task 7, `orchestrator.startRun`) — the task's own
 * `exclusiveWith: {scope:'user'}` guard plus this route's `idempotencyKey`
 * dedup an in-flight run for the SAME (user, provider, direction) into a
 * 200 `{runId, deduped:true}` instead of starting a second one; a genuinely
 * new run returns 202.
 *
 * Rate-limited (5 req / 60 s per user) — starting a run costs a Postgres
 * write + queue enqueue, and the common abuse case here is a double-click,
 * not a sustained attack; the task-level exclusivity guard is the
 * correctness backstop, this is just the cheap abuse cap.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMalLinkStatus } from '$lib/server/database/queries/mal-credentials.queries.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { StartSyncRequestSchema, SyncRunSchema } from '$lib/schemas/api-integrations-responses.js';

const PROVIDER = 'mal';
// Audit identifier persisted on the run's `trigger.sourceRoute` — not a URL emitted
// to any client, so it must stay a stable literal rather than a surface-derived path.
// eslint-disable-next-line callback-safety/no-hardcoded-api-path
const SOURCE_ROUTE = '/api/integrations/mal/sync';
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 60;

export const malSyncDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        body: StartSyncRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rl = await checkRateLimit(
                `watch-sync-manual:${PROVIDER}:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            const status = await getMalLinkStatus(sql, user.userId);
            if (!status) return ApiProblem.notFound('MyAnimeList account is not linked');

            const { direction } = ctx.input!.body;

            try {
                const { runId, deduped } = await orchestrator.startRun(
                    'watch-sync-manual',
                    { userId: user.userId, provider: PROVIDER, direction },
                    {
                        userId: user.userId,
                        trigger: { kind: 'manual', by: user.userId, sourceRoute: SOURCE_ROUTE },
                        idempotencyKey: `${user.userId}-${PROVIDER}-${direction}`,
                    },
                );
                return json(SyncRunSchema.parse({ runId, deduped }), {
                    status: deduped ? 200 : 202,
                });
            } catch (err) {
                if (err instanceof BackpressureError) {
                    return ApiProblem.conflict(
                        'A watch-sync run is already in progress. Poll GET /api/integrations/mal/sync/status.',
                    );
                }
                throw err;
            }
        },
    },
});
