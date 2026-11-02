// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/tasks/{taskId}/run
 *
 * Auth scope: tasks:run
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import { RunRequestSchema } from '$lib/schemas/api-v1.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { manualRunActor } from '$lib/server/tasks/run-trigger-actor.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

// Documents the gate truth (RunRequestSchema). The handler destructures
// `{ input, libraryGroupId, userId, priority }` — the previously-documented
// `params` key mapped to nothing and was removed.
const RunTaskBodySchema = z.object({
    input: z
        .unknown()
        .optional()
        .meta({ description: 'Task-specific run input payload (passed to startRun)' }),
    libraryGroupId: z
        .string()
        .optional()
        .meta({ description: 'Scope the run to a single library group' }),
    userId: z.string().optional().meta({ description: 'Attribute the run to a specific user' }),
    priority: z
        .union([z.literal(1), z.literal(5), z.literal(7)])
        .optional()
        .meta({ description: 'Run priority lane (1 = high, 5 = normal, 7 = low)' }),
});

// The handler returns orchestrator.startRun()'s result verbatim — { runId,
// deduped } — not the { runId, taskId, status, startedAt } shape this previously
// declared (which the handler never produces).
const RunTaskResponseSchema = z.object({
    runId: z.string().meta({
        description:
            'Id of the created run, or of the identical in-flight run when deduped (run_-prefixed, not a UUID)',
    }),
    deduped: z
        .boolean()
        .meta({ description: 'True when an identical run was already in progress' }),
});

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Tasks'],
            summary: 'Trigger a task run',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Triggers an immediate run of the specified task. Requires `tasks:run` scope. ' +
                'Answers 202 with `{ runId, deduped: false }` for a new run, or 200 with the ' +
                "identical in-flight run's id and `deduped: true` when that run is reused.",
            body: RunTaskBodySchema,
            responses: {
                200: {
                    schema: RunTaskResponseSchema,
                    description: 'An identical run was already in progress (deduped: true)',
                },
                202: {
                    schema: RunTaskResponseSchema,
                    description: 'Run accepted',
                },
                400: 'Invalid request body, or input the task rejects permanently',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                429: 'Task queue at capacity — retry after the Retry-After header value',
                503: 'Task queue unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    /**
     * REQUEST CONTRACT — POST body.
     *
     * Derived from RunRequestSchema in api-v1.ts.  mount() validates before
     * the handler runs; the handler's own safeParse() remains unchanged
     * (double-parse is safe; both use the same schema).
     * Unknown fields are stripped (no .strict()).
     */
    request: {
        body: RunRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const taskId = event.params.taskId!;
            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            // Mirror the list/detail endpoints' prod filter: a demo task is
            // not triggerable in production, only hidden from listings.
            if (process.env.NODE_ENV === 'production' && task.demo) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            // mount() has already validated + parsed the body via the `request`
            // contract — use ctx.input.body to avoid re-reading the consumed stream.
            // Fall back to manual parse for callers that bypass mount() in tests.
            let parsed: ReturnType<typeof RunRequestSchema.safeParse>;
            if (ctx.input?.body !== undefined) {
                parsed = { success: true as const, data: ctx.input.body };
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    rawBody = {};
                }
                parsed = RunRequestSchema.safeParse(rawBody);
            }
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid request body',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }

            const { input, libraryGroupId, userId, priority } = parsed.data;
            // The selected-file health mutation is admin-only through every
            // entry point, including this generic task trigger.
            if (
                taskId === 'media-probe' &&
                input &&
                typeof input === 'object' &&
                'fileId' in input &&
                !event.locals.principal?.isAdmin
            ) {
                return ApiProblem.forbidden();
            }
            const idempotencyKey = event.request.headers.get('idempotency-key') ?? undefined;

            // Who asked for the run; service tokens are attributed to the token.
            const actorId = manualRunActor(event.locals.principal);

            try {
                const result = await orchestrator.startRun(taskId, input ?? {}, {
                    libraryGroupId,
                    userId,
                    priority,
                    idempotencyKey,
                    trigger: { kind: 'manual', by: actorId },
                });
                // Security fix C24 (2026-09-16): auditActor(event) resolves
                // the USERNAME, not the users.id UUID the hand-built object
                // below used to pass as `username` — see work-profile.ts for
                // the GDPR-erasure rationale. `actorId` (the UUID, or the
                // service token's name) is still correct for `trigger.by` above.
                auditLog('task.run', taskId, auditActor(event), {
                    runId: result.runId,
                    deduped: result.deduped,
                    mode: parsed.data.priority,
                });
                // Always the declared shape: startRun() only sets `deduped` on a
                // dedup hit, so a fresh run used to answer `{ runId }` alone.
                const deduped = result.deduped === true;
                return json({ runId: result.runId, deduped }, { status: deduped ? 200 : 202 });
            } catch (err) {
                if (err instanceof BackpressureError) {
                    const retryAfterSec = Math.ceil(err.retryAfterMs / 1000);
                    return problem('rate_limited', {
                        error: 'Queue at capacity — retry after backoff',
                        retryAfter: retryAfterSec,
                    });
                }
                if (err instanceof TaskError && err.kind === 'permanent') {
                    return problem('validation_failed', { error: err.message });
                }
                // An open circuit breaker or a backpressure drop is an expected,
                // temporary refusal — say so instead of a generic 500.
                if (err instanceof TaskError && err.kind === 'transient') {
                    return problem('dependency_unavailable', { error: err.message });
                }
                throw err;
            }
        },
    },
});
