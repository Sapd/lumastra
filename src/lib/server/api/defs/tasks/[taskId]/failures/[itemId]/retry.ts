// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/tasks/{taskId}/failures/{itemId}/retry
 *
 * Both path params are `{taskId}` — segment position disambiguates:
 * first {taskId} = task, second {taskId} = failure item.
 *
 * Auth scope: tasks:run
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { withAdvisoryLock } from '$lib/server/database/with-advisory-lock.js';
import { enqueueFileHealthRecheck } from '$lib/server/tasks/file-health-recheck.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { buildAdminContextStub } from '$lib/server/tasks/plugin-context.js';
import {
    findLatestFailureEventId,
    markFailureEventsResolved,
} from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { taskRetryResponseSchema, type TaskRetryResponse } from '$lib/schemas/admin.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';

function hashKey(taskId: string, itemId: string): string {
    return `retry:${taskId}:${itemId}`;
}

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Tasks'],
            summary: 'Retry a failed task job',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Re-queues a failed job from the dead-letter queue for the task. ' +
                'Requires `tasks:run` scope. ' +
                'Path params: `{taskId}` is the task slug, `{itemId}` is the failing item ID.',
            responses: {
                200: {
                    schema: taskRetryResponseSchema,
                    description:
                        'Retry outcome: `retried` says whether the item was re-queued; `message`, `itemSuccess` and `itemReason` explain the result',
                },
                202: {
                    schema: taskRetryResponseSchema,
                    description:
                        'Selected-file media probe accepted; runId tracks the result. History remains unresolved until the worker succeeds.',
                },
                400: 'Selected-file input rejected permanently',
                429: 'Selected-file queue at capacity — retry after the Retry-After header',
                503: 'Selected-file queue temporarily unavailable',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task or failure record not found',
                409: 'Job already re-queued',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    handlers: {
        POST: async (event) => {
            const taskId = event.params.taskId!;
            const itemId = event.params.itemId!;

            const task = registry.getTask(taskId);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            if (!task.failures?.retry) {
                return problem('validation_failed', {
                    error: `Task '${taskId}' does not support per-item retry`,
                    details: [{ field: 'taskId', message: 'failures.retry not implemented' }],
                });
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            if (taskId === 'media-probe') {
                if (!event.locals.principal?.isAdmin) return ApiProblem.forbidden();
                if (!UUID_RE.test(itemId))
                    return problem('validation_failed', { error: 'Invalid file id' });
                // Keep the historical retry contract. Health-only files enter
                // through the separate admin endpoint, without inventing events.
                if ((await findLatestFailureEventId(sql, taskId, itemId.toLowerCase())) === null) {
                    return ApiProblem.notFound(`Failure record for item '${itemId}' not found`);
                }
                const accepted = await enqueueFileHealthRecheck(itemId, event);
                if (accepted instanceof Response) return accepted;
                return json(
                    taskRetryResponseSchema.parse({
                        retried: false,
                        itemId,
                        ...accepted,
                        message: 'Selected-file recheck accepted; await the run result',
                    }),
                    { status: accepted.deduped ? 200 : 202 },
                );
            }

            const lockKey = hashKey(taskId, itemId);

            type RetryDone = {
                kind: 'completed' | 'not-found';
                itemSuccess?: boolean;
                itemReason?: string | undefined;
            };

            const lockResult = await withAdvisoryLock<RetryDone>(sql, lockKey, async (tx) => {
                const eventId = await findLatestFailureEventId(tx, taskId, itemId);
                if (eventId === null) {
                    return { kind: 'not-found' };
                }

                const ctx = buildAdminContextStub(taskId, { sql: tx });

                let itemSuccess: boolean;
                let itemReason: string | undefined;
                try {
                    const result = await task.failures!.retry!(ctx, itemId);
                    if (result === undefined || result === null) {
                        itemSuccess = true;
                    } else if (
                        typeof result === 'object' &&
                        'success' in (result as Record<string, unknown>)
                    ) {
                        const r = result as { success: boolean; reason?: string };
                        itemSuccess = r.success === true;
                        itemReason = r.reason;
                    } else {
                        itemSuccess = true;
                    }
                } catch (err) {
                    itemSuccess = false;
                    itemReason = err instanceof Error ? err.message : String(err);
                }

                if (itemSuccess) {
                    // Both statements live in the queries module rather than inline
                    // here, because inline SQL in a route handler is what let two
                    // bugs sit in this endpoint undetected for its whole life:
                    // the columns were `item_key`/`created_at` (renamed to
                    // `item_id`/`occurred_at` by migration 15.0.0), so every Retry
                    // click threw "column does not exist"; and the UPDATE only
                    // touched `reason`, never `resolved_at` — the column
                    // `listItemFailureRows` filters on — so even a SUCCESSFUL retry
                    // left the item in "Items it could not process" forever. Neither
                    // was reachable from a test while the SQL sat inside the
                    // advisory-lock callback. See retry.integration.test.ts.
                    await markFailureEventsResolved(tx, taskId, itemId);
                }

                return { kind: 'completed', itemSuccess, itemReason };
            });

            if (!lockResult.acquired) {
                const body: TaskRetryResponse = {
                    retried: false,
                    reason: 'item-already-retrying',
                    message: 'Another retry for this item is already in progress',
                    itemId,
                };
                return json(taskRetryResponseSchema.parse(body));
            }
            if (lockResult.value.kind === 'not-found') {
                // Says only what the lookup actually checks. It matches on the
                // (task, item) pair alone and does NOT filter `resolved_at`, so
                // a resolved item is still found and still retryable — the old
                // "or already resolved" wording claimed a condition that never
                // produces this 404.
                return ApiProblem.notFound(`Failure record for item '${itemId}' not found`);
            }

            const itemSuccess = lockResult.value.itemSuccess === true;
            const itemReason = lockResult.value.itemReason;

            // Security fix C24 (2026-09-16): auditActor(event) resolves the
            // USERNAME, not the users.id UUID the hand-built object below
            // used to pass as `username` — see work-profile.ts for the
            // GDPR-erasure rationale.
            auditLog('task.failure.retry', taskId, auditActor(event), {
                itemId,
                success: itemSuccess,
                reason: itemReason,
            });

            const body: TaskRetryResponse = {
                retried: itemSuccess,
                reason: itemSuccess ? 'item-retry' : 'item-retry-failed',
                message: itemSuccess
                    ? `Per-item retry succeeded for '${itemId}'`
                    : `Per-item retry failed for '${itemId}'`,
                itemId,
                itemSuccess,
                itemReason,
            };
            return json(taskRetryResponseSchema.parse(body));
        },
    },
});
