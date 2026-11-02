// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/queues/{queue}/resume
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

/**
 * Params schema for /queues/{queue}/resume.
 *
 * SvelteKit guarantees the `queue` segment is present; `.min(1)` closes the
 * degenerate-empty-string gap. Business-logic validation (is it a known
 * resource class?) is in the handler.
 */
const QueueParamsSchema = z.object({
    queue: z.string().min(1),
});
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

const log = Logger.for('api.v1.queues.resume');

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
            summary: 'Resume a task queue',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Resumes processing in the specified queue. ' +
                'Valid queues: `cpu`, `io`, `embedding`, `maintenance`, `ingest`, `bulk`, `analysis`, `discovery`. ' +
                'Requires `tasks:admin` scope.',
            responses: {
                200: { schema: queuePauseResponseSchema, description: 'Queue resumed' },
                400: 'Invalid queue name',
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    /**
     * REQUEST CONTRACT — params only.
     *
     * Resume has no meaningful body (unlike pause which accepts `reason`).
     * The `queue` path param is declared for typing; business validation
     * (is it a known resource class?) remains in the handler.
     * Unknown fields are stripped (no .strict()).
     */
    request: {
        params: QueueParamsSchema,
    },
    handlers: {
        POST: async (event) => {
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

            const connection = getQueueConnectionOptions();
            if (!connection) {
                return ApiProblem.dependencyUnavailable(
                    'Queue unavailable — CACHE_URL not configured',
                );
            }

            const queues = targetQueues(queueParam as ResourceClass, connection);

            let anyStartedPaused = false;
            let stillPaused = false;
            let resumeErr: Error | null = null;
            try {
                for (const queue of queues) {
                    const startedPaused = await queue.isPaused();
                    if (startedPaused) {
                        anyStartedPaused = true;
                        await queue.resume();
                    }
                    if (await queue.isPaused()) {
                        stillPaused = true;
                    }
                }
            } catch (err) {
                resumeErr = err instanceof Error ? err : new Error(String(err));
                stillPaused = true;
            } finally {
                await Promise.all(queues.map((q) => q.close()));
            }

            const wasAlreadyResumed = !anyStartedPaused && !stillPaused;
            if (wasAlreadyResumed) {
                log.info('admin requested resume on already-resumed queue', {
                    queue: queueParam,
                    queueCount: queues.length,
                });
            }

            if (stillPaused) {
                log.error('queue resume left at least one target queue paused', undefined, {
                    queue: queueParam,
                    queueCount: queues.length,
                    error: resumeErr?.message,
                });
                const detail = resumeErr
                    ? `resume threw: ${resumeErr.message}`
                    : 'Valkey may have rejected the DEL';
                const responseBody = queuePauseResponseSchema.parse({
                    queueName: queueParam,
                    paused: true,
                    message: `Queue '${queueParam}' did not transition out of paused — ${detail}`,
                });
                return json(responseBody, { status: 503 });
            }

            const client = getCoordinationClient();
            if (client) {
                try {
                    await client.del([`task:queue-paused:${queueParam}`]);
                } catch (err) {
                    log.warn('failed to clear pause flag in Valkey', {
                        queue: queueParam,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            const responseBody = queuePauseResponseSchema.parse({
                queueName: queueParam,
                paused: false,
                message: wasAlreadyResumed
                    ? `Queue '${queueParam}' was already resumed (no-op)`
                    : `Queue '${queueParam}' resumed`,
                wasAlreadyResumed: wasAlreadyResumed ? true : undefined,
            });
            if (!wasAlreadyResumed) {
                // Security fix C24 (2026-09-16): auditActor(event) resolves
                // the USERNAME, not the users.id UUID the hand-built object
                // below used to pass as `username` — see work-profile.ts for
                // the GDPR-erasure rationale.
                auditLog('queue.resume', queueParam, auditActor(event));
            }
            return json(responseBody);
        },
    },
});
