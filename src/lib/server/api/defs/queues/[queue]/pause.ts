// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/queues/{queue}/pause
 *
 * The `{queue}` param uses the SvelteKit FS segment `[queue]`.
 * Valid values: cpu, io, embedding, maintenance, ingest, bulk, analysis, discovery.
 *
 * Requires `tasks:admin` scope.
 */

import { z } from 'zod';
import { Queue } from 'bullmq';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import {
    QUEUE_PREFIX,
    PER_TASK_QUEUE_PREFIX,
    taskQueueName,
    perTaskQueueName,
} from '$lib/server/tasks/queue-naming.js';
import { registry } from '$lib/server/tasks/registry.js';
import { FEATURE_PER_TASK_QUEUES } from '$lib/server/config.js';
import { RESOURCE_CLASSES, type ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { queuePauseResponseSchema } from '$lib/schemas/admin.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';

// The handler emits queuePauseResponseSchema.parse(...) — declare that same
// schema (queueName/paused/message/wasAlreadyResumed?), not a { queue, paused }
// stub the handler never produces.

/**
 * Params schema for /queues/{queue}/pause.
 *
 * The `queue` route param must be present and non-empty (SvelteKit guarantees
 * presence; `.min(1)` closes the degenerate-empty-string gap). Business-logic
 * validation (is it a known resource class?) remains in the handler.
 */
const QueueParamsSchema = z.object({
    queue: z.string().min(1),
});

/**
 * Body schema for POST /queues/{queue}/pause.
 *
 * Only `reason` is meaningful; the handler reads it via extractBody() but
 * any other fields are harmless. Unknown fields are stripped (no .strict()).
 */
const QueuePauseBodySchema = z.object({
    reason: z.string().optional(),
});

const log = Logger.for('api.v1.queues.pause');

const VALID_QUEUES = new Set<string>(RESOURCE_CLASSES);

function targetQueues(
    cls: ResourceClass,
    connection: NonNullable<ReturnType<typeof getQueueConnectionOptions>>,
): Queue[] {
    if (FEATURE_PER_TASK_QUEUES) {
        return registry
            .getAllTasks()
            .filter((t) => t.resourceClass === cls)
            .map(
                (t) =>
                    new Queue(perTaskQueueName(t.id), {
                        connection,
                        prefix: PER_TASK_QUEUE_PREFIX,
                    }),
            );
    }
    return [new Queue(taskQueueName(cls), { connection, prefix: QUEUE_PREFIX })];
}

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Tasks'],
            summary: 'Pause a task queue',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Pauses all processing in the specified queue. ' +
                'Valid queues: `cpu`, `io`, `embedding`, `maintenance`, `ingest`, `bulk`, `analysis`, `discovery`. ' +
                'Requires `tasks:admin` scope.',
            responses: {
                200: { schema: queuePauseResponseSchema, description: 'Queue paused' },
                400: 'Invalid queue name',
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    /**
     * REQUEST CONTRACT — POST body + params.
     *
     * params: QueueParamsSchema  (queue — string presence declared for typing)
     * body:   QueuePauseBodySchema  (reason? — optional annotation)
     *
     * Business validation (is `queue` a known resource class?) remains in the
     * handler.  mount() provides type safety; unknown fields are stripped.
     */
    request: {
        params: QueueParamsSchema,
        body: QueuePauseBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const queueParam = (event.params as Record<string, string | undefined>).queue ?? '';
            if (!VALID_QUEUES.has(queueParam)) {
                return problem('validation_failed', {
                    error: `Unknown queue '${queueParam}'`,
                    details: [
                        {
                            field: 'queue',
                            message: `Valid queues: ${RESOURCE_CLASSES.join(', ')}`,
                        },
                    ],
                });
            }

            // Use the pre-parsed body from ctx.input (mount() already consumed
            // event.request for validation; re-reading via extractBody would
            // get an empty stream on a real Request object).
            const reason = ctx.input?.body?.reason;

            const connection = getQueueConnectionOptions();
            if (!connection) {
                return ApiProblem.dependencyUnavailable(
                    'Queue unavailable — CACHE_URL not configured',
                );
            }

            const queues = targetQueues(queueParam as ResourceClass, connection);
            let verified = true;
            let pauseErr: Error | null = null;
            try {
                for (const queue of queues) {
                    await queue.pause();
                    if (!(await queue.isPaused())) {
                        verified = false;
                    }
                }
            } catch (err) {
                pauseErr = err instanceof Error ? err : new Error(String(err));
                verified = false;
            } finally {
                await Promise.all(queues.map((q) => q.close()));
            }

            if (!verified) {
                log.error('queue pause did not transition all target queues to paused', undefined, {
                    queue: queueParam,
                    reason,
                    queueCount: queues.length,
                    error: pauseErr?.message,
                });
                const detail = pauseErr
                    ? `pause threw: ${pauseErr.message}`
                    : 'Valkey may have rejected the SET';
                const responseBody = queuePauseResponseSchema.parse({
                    queueName: queueParam,
                    paused: false,
                    message: `Queue '${queueParam}' did not transition to paused — ${detail}`,
                });
                return json(responseBody, { status: 503 });
            }

            const client = getCoordinationClient();
            if (client) {
                try {
                    await client.set(`task:queue-paused:${queueParam}`, '1');
                } catch (err) {
                    log.warn('failed to persist pause flag in Valkey', {
                        queue: queueParam,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            const responseBody = queuePauseResponseSchema.parse({
                queueName: queueParam,
                paused: true,
                message: reason
                    ? `Queue '${queueParam}' paused (${reason})`
                    : `Queue '${queueParam}' paused`,
            });
            // Security fix C24 (2026-09-16): auditActor(event) resolves the
            // USERNAME, not the users.id UUID the hand-built object below
            // used to pass as `username` — see work-profile.ts for the
            // GDPR-erasure rationale.
            auditLog('queue.pause', queueParam, auditActor(event), { reason });
            return json(responseBody);
        },
    },
});
