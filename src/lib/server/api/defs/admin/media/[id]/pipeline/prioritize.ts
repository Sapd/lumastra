// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/pipeline/prioritize.ts
 *
 * POST /api/admin/media/[id]/pipeline/prioritize
 *
 * "Do this one first" — start an EXPRESS, item-scoped run of one pipeline step
 * for one media item, instead of waiting for the stage sweep's turn.
 *
 * Body: { stageId: string }
 *
 * How the bump actually works (and what it is NOT): `media_item_stage_state` has
 * no priority column, and the sweep's claim order is a plain
 * `ORDER BY next_eligible_at ASC NULLS FIRST, updated_at ASC` FIFO — there is no
 * supported way to reorder a row inside it. (Backdating `next_eligible_at` is
 * WORSE than a no-op: `NULLS FIRST` puts the entire untouched pending backlog
 * ahead of any row carrying a timestamp, so it demotes the row. That exact
 * regression is recorded on `reclaimWedgedRunningStageRows`.)
 *
 * What this does instead is bypass the queue: `orchestrator.startRun` at
 * `priority: 1`, which is BullMQ priority 1 AND the express lane — the runner
 * holds a budget token below the class cap for express work
 * (`isExpressPriority` / `EXPRESS_RESERVE_MIN_CAP`), so the run finds a slot
 * rather than queueing behind the backlog. Same mechanism the existing per-item
 * admin actions already use (`admin/media/[id]/sync`, `.../trickplay/generate`).
 *
 * The step's idempotency key is deliberately the sweep's own
 * `coverage:<stageId>:<mediaItemId>`: if the sweep already has this item in
 * flight, we JOIN that run (`deduped: true`) rather than starting a second one
 * that would race it for the identity lock. A row still sitting at `pending` has
 * no such run, which is the case this action exists for.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: PipelinePrioritizeResponse
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { registry } from '$lib/server/tasks/registry.js';
import { canPrioritizeStage } from '$lib/server/services/pipeline-timeline.service.js';
import { PipelinePrioritizeResponseSchema } from '$lib/schemas/pipeline-timeline.schema.js';

// Re-export for route-file convenience
export { PipelinePrioritizeResponseSchema };

export const PrioritizeRequestSchema = z.object({
    stageId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: PrioritizeRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const { stageId } = ctx.input!.body;

            const task = registry.findTaskByStage(stageId);
            if (!task) {
                return json(
                    PipelinePrioritizeResponseSchema.parse({
                        started: false,
                        reason: 'no-owning-task',
                    }),
                );
            }

            // One shared predicate with the timeline payload's `prioritizable`,
            // re-checked here: the registry can change between render and click,
            // and an endpoint that trusts the client's read of it would start a
            // whole-backlog run when the caller asked for one item.
            if (!canPrioritizeStage(task, stageId, internalId)) {
                const multiStage = (task.coversStages?.length ?? 0) !== 1;
                return json(
                    PipelinePrioritizeResponseSchema.parse({
                        started: false,
                        reason: multiStage ? 'multi-stage-task' : 'not-item-scoped',
                    }),
                );
            }

            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            const result = await orchestrator.startRun(
                task.id,
                { mediaItemId: internalId },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: `admin/media/${internalId}/pipeline/prioritize`,
                    },
                    priority: 1,
                    idempotencyKey: `coverage:${stageId}:${internalId}`,
                    subject: { type: 'mediaItem', id: internalId },
                },
            );

            return json(
                PipelinePrioritizeResponseSchema.parse({
                    started: true,
                    runId: result.runId,
                    deduped: result.deduped,
                }),
            );
        },
    },
});
