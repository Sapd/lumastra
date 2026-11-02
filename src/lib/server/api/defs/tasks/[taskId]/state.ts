// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/v1/tasks/{taskId}/state
 * PATCH  /api/v1/tasks/{taskId}/state
 *
 * Unified task state control.
 *
 * GET  — reads the three independent switches as one aggregate view:
 *   - schedule:  paused | active          (from scheduler_state)
 *   - breaker:   closed | open | half_open + override details
 *   - effective: worst-of (paused > open > half_open > closed/active)
 *
 * PATCH  — mutates one or more switches idempotently (partial update).
 *   { schedule: "paused" | "active" }         replaces POST …/pause + …/resume
 *   { breaker: "enable", force?: true }        replaces POST …/circuit-breaker/force-enable
 *   { breaker: "reset" }                       new: manual close of an open breaker
 *
 * force=true on breaker:"enable" bypasses the cooldown TTL.
 *
 * Requires the `tasks:admin` scope.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getTaskDb, getDb } from '$lib/server/database/connection.js';
import { getSchedulerState, pauseTask, resumeTask } from '$lib/server/tasks/scheduler-state.js';
import { CircuitBreaker } from '$lib/server/tasks/circuit-breaker.js';
import { rescheduleAfterResume } from '$lib/server/tasks/trigger-service.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS } from '$lib/server/config.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { Logger } from '$lib/server/utils/logger.js';
import { TaskStateUpdateSchema, V1TaskStateResponseSchema } from '$lib/schemas/api-v1.js';
import { json } from '@sveltejs/kit';

// GET/PATCH both emit readTaskState()'s flat schedule/breaker aggregate, which the
// canonical V1TaskStateResponseSchema (api-v1.ts) declares exactly. The PATCH body
// is TaskStateUpdateSchema. The previous local { taskId, state{enabled,paused,
// scheduled} } schemas matched neither.

const log = Logger.for('api.v1.tasks.state');

/**
 * Composite state read — assembles the three switches into one response object.
 *
 * Returns null when the database is unavailable (caller returns 503).
 */
async function readTaskState(taskId: string) {
    const sqlTask = getTaskDb();
    const sqlDb = getDb();
    if (!sqlTask || !sqlDb) return null;

    // Scheduler state (schedule switch)
    const schedState = await getSchedulerState(sqlTask, taskId);

    // Circuit breaker row (breaker switch). peek(), never check(): check() is
    // the admission gate and would take the probe lock on a read.
    const cb = new CircuitBreaker(sqlDb, () => getCoordinationClient());
    const cbDecision = await cb.peek(taskId);

    // effective: worst-of the three dimensions
    // paused schedule + open breaker → still paused
    const schedulePaused = schedState?.paused === true;
    const breakerBlocking =
        cbDecision.state === 'open' || (cbDecision.state === 'half_open' && !cbDecision.allowed);

    let effective: 'paused' | 'open' | 'half_open' | 'active';
    if (schedulePaused) {
        effective = 'paused';
    } else if (cbDecision.state === 'open') {
        effective = 'open';
    } else if (cbDecision.state === 'half_open' && !cbDecision.allowed) {
        // Probe slot not taken: still blocking from a client perspective.
        effective = 'half_open';
    } else {
        // closed, OR half_open with the probe slot claimed (task IS running).
        // Report 'active' so effective and blocked=false are consistent.
        effective = 'active';
    }

    return {
        schedule: schedulePaused ? 'paused' : 'active',
        schedulePausedBy: schedState?.pausedBy ?? undefined,
        schedulePausedAt: schedState?.pausedAt?.toISOString() ?? undefined,
        breaker: cbDecision.state,
        breakerAllowed: cbDecision.allowed,
        breakerNextProbeAt: cbDecision.nextProbeAt?.toISOString() ?? undefined,
        breakerReason: cbDecision.reason ?? undefined,
        effective,
        // Convenience: whether either switch is blocking the task
        blocked: schedulePaused || breakerBlocking,
    };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get task state flags',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the three independent state switches for a task: `enabled`, `paused`, `scheduled`. ' +
                'Requires `tasks:read` scope.',
            responses: {
                200: {
                    schema: V1TaskStateResponseSchema,
                    description: 'Task state',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Tasks'],
            summary: 'Update task state flags',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Updates one or more of the three task state switches. ' +
                'Omitted fields are unchanged. Requires `tasks:admin` scope.',
            body: TaskStateUpdateSchema,
            responses: {
                200: {
                    schema: V1TaskStateResponseSchema,
                    description: 'Updated task state',
                },
                400: 'Validation error or no fields provided',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    /**
     * REQUEST CONTRACT — PATCH body.
     *
     * Derived from TaskStateUpdateSchema in api-v1.ts.  mount() validates
     * this BEFORE the handler runs.  The handler's own safeParse() continues
     * to work unchanged (double-parse is safe; the schema is identical).
     * Unknown fields are stripped (no .strict()).
     */
    request: {
        body: TaskStateUpdateSchema,
    },
    handlers: {
        GET: async (event) => {
            const taskId = event.params.taskId!;
            if (!registry.getTask(taskId)) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            const state = await readTaskState(taskId);
            if (!state) {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable — cannot read task state',
                );
            }

            return json(state);
        },

        PATCH: async (event, ctx) => {
            const taskId = event.params.taskId!;
            if (!registry.getTask(taskId)) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            // mount() has already validated + parsed the body via the `request`
            // contract — use ctx.input.body to avoid re-reading the consumed stream.
            // Fall back to manual parse for callers that bypass mount() in tests.
            let parsed: ReturnType<typeof TaskStateUpdateSchema.safeParse>;
            if (ctx.input?.body !== undefined) {
                parsed = { success: true as const, data: ctx.input.body };
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    rawBody = {};
                }
                parsed = TaskStateUpdateSchema.safeParse(rawBody);
            }
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid task state update body',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }
            const { schedule, breaker, force, reason } = parsed.data;

            if (schedule === undefined && breaker === undefined) {
                return problem('validation_failed', {
                    error: 'At least one of `schedule` or `breaker` must be specified',
                });
            }

            // ── Schedule switch ──────────────────────────────────────────────
            if (schedule !== undefined) {
                const sqlTask = getTaskDb();
                if (!sqlTask) {
                    return ApiProblem.dependencyUnavailable(
                        'Database unavailable — cannot update schedule state',
                    );
                }
                // Derive userId from Principal or legacy authenticate() fallback.
                // The `userId` field exists on locals.principal; use it when present.
                const userId =
                    event.locals.principal && typeof event.locals.principal === 'object'
                        ? (event.locals.principal?.userId ?? 'unknown')
                        : 'unknown';
                // Security fix C24 (2026-09-16): auditActor(event) resolves
                // the USERNAME, not the users.id UUID `userId` above holds —
                // see work-profile.ts for the GDPR-erasure rationale.
                // `userId` is still correct for pauseTask/forceEnable below.
                const auditActorObj = auditActor(event);

                if (schedule === 'paused') {
                    await pauseTask(sqlTask, taskId, userId);
                    auditLog('task.pause', taskId, auditActorObj, { via: 'state' });
                } else {
                    await resumeTask(sqlTask, taskId);
                    const def = registry.getTask(taskId);
                    if (def) await rescheduleAfterResume(sqlTask, def);
                    auditLog('task.resume', taskId, auditActorObj, { via: 'state' });
                }
            }

            // ── Circuit breaker switch ───────────────────────────────────────
            if (breaker !== undefined) {
                const sqlDb = getDb();
                if (!sqlDb) {
                    return ApiProblem.dependencyUnavailable(
                        'Database unavailable — cannot update breaker state',
                    );
                }
                const userId =
                    event.locals.principal && typeof event.locals.principal === 'object'
                        ? (event.locals.principal?.userId ?? 'unknown')
                        : 'unknown';
                // Security fix C24 (2026-09-16): auditActor(event) resolves
                // the USERNAME, not the users.id UUID `userId` above holds —
                // see work-profile.ts for the GDPR-erasure rationale.
                // `userId` is still correct for forceEnable/the uuid column
                // write below.
                const auditActorObj = auditActor(event);
                const cb = new CircuitBreaker(sqlDb, () => getCoordinationClient());

                if (breaker === 'enable') {
                    // force=true is required to bypass the cooldown TTL.
                    // Without force we only allow enable when the breaker is already
                    // closed or the cooldown has elapsed (same as manual probe).
                    if (!force) {
                        // Non-force: just a regular check — if the circuit is closed
                        // or eligible for probe it will self-enable; nothing to do.
                        // Return 422 if the breaker is open and cooldown has NOT elapsed
                        // so the caller knows to use force=true.
                        const decision = await cb.peek(taskId);
                        if (!decision.allowed) {
                            return problem('validation_failed', {
                                error:
                                    'Circuit breaker cooldown has not elapsed. ' +
                                    'Use { breaker: "enable", force: true } to bypass.',
                                details: decision.nextProbeAt
                                    ? `Cooldown expires at ${decision.nextProbeAt.toISOString()}`
                                    : undefined,
                            });
                        }
                        // Already allowed — nothing to do
                    } else {
                        // force=true: write the manual override
                        await cb.forceEnable(taskId, userId);
                        const overrideUntil = new Date(
                            Date.now() + LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS,
                        ).toISOString();

                        // Best-effort audit write — mirror the old implementation.
                        // user_id is a uuid column: pass null when userId is not a
                        // valid UUID (e.g. the 'unknown' fallback). run_id is text
                        // but there is no run context here — pass null.
                        const auditUserId = userId !== 'unknown' ? userId : null;
                        try {
                            await sqlDb`
                                INSERT INTO plugin_secret_access_log
                                    (plugin_id, key, user_id, run_id, accessed_at)
                                VALUES (
                                    ${'circuit-breaker'},
                                    ${`force-enable:${taskId}`},
                                    ${auditUserId}::uuid,
                                    ${null},
                                    NOW()
                                )
                            `;
                        } catch (err) {
                            log.warn('circuit-breaker force-enable audit write failed', {
                                taskId,
                                userId,
                                err: err instanceof Error ? err.message : String(err),
                            });
                        }

                        auditLog('task.circuit-breaker.force-enable', taskId, auditActorObj, {
                            overrideUntil,
                            via: 'state',
                        });
                    }
                } else if (breaker === 'reset') {
                    // Manual close: write a closed override (the circuit has been manually
                    // reset by an operator). This defers to the same forceEnable mechanism
                    // but logs it as a reset for clarity.
                    await cb.forceEnable(taskId, userId);
                    auditLog('task.circuit-breaker.reset', taskId, auditActorObj, {
                        reason: reason ?? 'manual-reset-via-state',
                        via: 'state',
                    });
                }
            }

            // Return the new aggregate state after all mutations
            const newState = await readTaskState(taskId);
            if (!newState) {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable — state updated but cannot confirm',
                );
            }
            return json(newState);
        },
    },
});
