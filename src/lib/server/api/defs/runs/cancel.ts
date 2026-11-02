// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/runs/cancel?byTask={taskId}
 *
 * Bulk cancel of all active/pending runs for a task.
 *
 * Auth scope: tasks:run. The `?byTask=` parameter is required (must know the task id).
 * All cancellations are recorded in the audit log.
 *
 * Body `{ force?, reason? }`:
 *   force      — omitted/false: graceful cancel (same as single-run cancel);
 *                true: hard-kill escalation, also finalizes runs wedged in
 *                'cancelling'.
 *   reason     — recorded in the audit log.
 *
 * Response: `{ cancelled, orphaned }`
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { registry } from '$lib/server/tasks/registry.js';
import { CancelByTaskBodySchema } from '$lib/schemas/api-v1.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';

const BulkCancelResponseSchema = z.object({
    cancelled: z.number().meta({
        description: 'Runs the cancel was accepted for (including ones already stopping)',
    }),
    orphaned: z.number().meta({
        description: 'Runs that had already finished or vanished before they could be cancelled',
    }),
    escalated: z.number().optional().meta({
        description: 'Runs whose hard-kill was scheduled (only with `force: true`)',
    }),
});

const BulkCancelQuerySchema = z.object({
    byTask: z
        .string()
        .min(1)
        .meta({ description: 'Task slug — all active/pending runs for this task are cancelled' }),
});

/**
 * Query schema for POST /runs/cancel.
 *
 * `byTask` is the only meaningful query param and is REQUIRED (min 1) — this
 * endpoint only cancels by task id. mount() emits the 422 for a missing/empty
 * value; the handler's own presence check remains as a fallback for callers
 * that bypass mount() (tests). Unknown params are stripped (no .strict()).
 */
const CancelByTaskQuerySchema = z.object({
    byTask: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Runs'],
            summary: 'Bulk cancel runs by task',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Cancels all active and pending runs for the specified task. Graceful by ' +
                'default, like single-run cancel; `force: true` escalates to a hard-kill. ' +
                '`?byTask={taskId}` is required. All cancellations are recorded in the audit log. ' +
                'Requires `tasks:run` scope. Bulk cancellation of Media Probe requires an admin principal because it may include selected-file health rechecks.',
            query: BulkCancelQuerySchema,
            responses: {
                200: {
                    schema: BulkCancelResponseSchema,
                    description: 'Runs cancelled',
                },
                400: 'Missing or invalid byTask parameter',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    /**
     * REQUEST CONTRACT — POST body + query params.
     *
     * body:  CancelByTaskBodySchema  (force?, reason?)
     * query: CancelByTaskQuerySchema (byTask?)
     *
     * `byTask` is declared optional to avoid rejecting missing-param requests
     * before the handler's own 422 response fires with a better error message.
     * mount() validates types + bounds; the handler enforces business rules.
     * Unknown fields are stripped (no .strict()).
     */
    request: {
        body: CancelByTaskBodySchema,
        query: CancelByTaskQuerySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            // `byTask` is required — this endpoint only cancels by task id.
            // Single-run cancel is handled by POST runs/{id}/cancel.
            // Prefer ctx.input.query.byTask (parsed by mount()) over searchParams
            // to avoid re-reading the query after the stream was consumed.
            const taskId = ctx.input?.query?.byTask ?? event.url.searchParams.get('byTask') ?? '';
            if (!taskId) {
                return problem('validation_failed', {
                    error: '`byTask` query parameter is required',
                    details: [
                        {
                            field: 'byTask',
                            message:
                                'Provide the task id: POST /api/v1/runs/cancel?byTask={taskId}',
                        },
                    ],
                });
            }

            // This bulk verb can include admin-only physical-file rechecks.
            // Reject before taking any cancellation side effect, including a
            // selected run enqueued concurrently with this request.
            if (taskId === 'media-probe' && !event.locals.principal?.isAdmin)
                return ApiProblem.forbidden();
            if (!registry.getTask(taskId)) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            // mount() has already validated + parsed the body via the `request`
            // contract — use ctx.input.body to avoid re-reading the consumed stream.
            // Fall back to manual parse for callers that bypass mount() in tests.
            let parsed: ReturnType<typeof CancelByTaskBodySchema.safeParse>;
            if (ctx.input?.body !== undefined) {
                parsed = { success: true as const, data: ctx.input.body };
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    rawBody = {};
                }
                parsed = CancelByTaskBodySchema.safeParse(rawBody);
            }
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid cancel body',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }
            const { force, reason } = parsed.data;

            // nuclearStop cancels all active/pending/cancelling runs for this task.
            // Graceful unless force=true, which escalates to a hard-kill.
            let result: { cancelled: number; orphaned: number; escalated: number };
            try {
                result = await orchestrator.nuclearStop(taskId, { force, reason });
            } catch {
                // Some runs may already be cancelled; the call is idempotent, so
                // the operator can retry. Never report 0/0 for a failed lookup.
                // 500 (documented) rather than a new 503, to keep the published contract.
                return problem('internal_error', {
                    error: `Could not cancel the runs of '${taskId}'. Retry; some may already be stopping.`,
                });
            }

            // Security fix C24 (2026-09-16): auditActor(event) resolves the
            // USERNAME, not the users.id UUID the hand-built object below
            // used to pass as `username` — see work-profile.ts for the
            // GDPR-erasure rationale.
            auditLog('run.cancel-by-task', taskId, auditActor(event), {
                cancelled: result.cancelled,
                orphaned: result.orphaned,
                force,
                reason,
            });

            return json({
                cancelled: result.cancelled,
                orphaned: result.orphaned,
                escalated: result.escalated,
            });
        },
    },
});
