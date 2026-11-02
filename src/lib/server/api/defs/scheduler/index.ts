// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /scheduler — scheduler state with per-class queue depths + pause flags.
 *
 * Dual-mounted def: backs both `/api/v1/scheduler` (token surface) and
 * `/api/scheduler` (internal forward-auth/cookie surface). B1 facade port of
 * the former bespoke `/api/v1/scheduler/+server.ts` legacy handler — behaviour,
 * response shape and scope (`tasks:read`) are preserved EXACTLY.
 *
 * Auth scope: tasks:read.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { problem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { RESOURCE_CLASSES, type ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { V1SchedulerResponseSchema } from '$lib/schemas/api-v1.js';

type QueueDepthEntry = {
    waiting: number;
    active: number;
    delayed: number;
    paused: boolean;
};
type QueueDepths = Record<ResourceClass, QueueDepthEntry>;

function emptyDepths(): QueueDepths {
    const out = {} as QueueDepths;
    for (const cls of RESOURCE_CLASSES) {
        out[cls] = { waiting: 0, active: 0, delayed: 0, paused: false };
    }
    return out;
}

async function readQueuePauseFlag(cls: ResourceClass): Promise<boolean> {
    const client = getCoordinationClient();
    if (!client) return false;
    try {
        const val = await client.get(`task:queue-paused:${cls}`);
        return val === '1';
    } catch {
        return false;
    }
}

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Scheduler'],
            summary: 'Get scheduler state',
            stability: 'beta',
            description:
                'Internal dashboard projection of scheduler state, queue depths and pause flags. Requires `tasks:read` scope.',
            responses: {
                200: {
                    schema: V1SchedulerResponseSchema,
                    description: 'Scheduler state',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:read'] },
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) {
                const queuesPaused: Record<ResourceClass, boolean> = {} as Record<
                    ResourceClass,
                    boolean
                >;
                for (const cls of RESOURCE_CLASSES) queuesPaused[cls] = false;
                return typedJson(V1SchedulerResponseSchema, {
                    tasks: [],
                    queuesPaused,
                    queueDepths: emptyDepths(),
                });
            }

            // Fan-out: DB state + depth snapshot + per-class pause flags — all in parallel.
            const [dbStatesResult, depthSnapshotResult, ...pauseResults] = await Promise.allSettled(
                [
                    listAllScheduledTasks(sql),
                    orchestrator.getQueueDepths().catch(() => null),
                    ...RESOURCE_CLASSES.map((cls) => readQueuePauseFlag(cls)),
                ],
            );

            if (
                dbStatesResult.status === 'rejected' &&
                pauseResults.every((r) => r.status === 'rejected')
            ) {
                return problem('internal_error', { error: 'Scheduler state unavailable' });
            }

            const dbStates = dbStatesResult.status === 'fulfilled' ? dbStatesResult.value : [];
            const depthSnapshot =
                depthSnapshotResult.status === 'fulfilled' ? depthSnapshotResult.value : null;

            // Build per-class pause flags from the settled results.
            const pausedByClass: Record<ResourceClass, boolean> = {} as Record<
                ResourceClass,
                boolean
            >;
            RESOURCE_CLASSES.forEach((cls, i) => {
                const result = pauseResults[i];
                pausedByClass[cls] = result?.status === 'fulfilled' ? result.value : false;
            });

            // Merge per-class pause flags into the depth snapshot.
            const queueDepths: QueueDepths = emptyDepths();
            for (const cls of RESOURCE_CLASSES) {
                const snap = depthSnapshot?.[cls] as QueueDepthEntry | undefined;
                queueDepths[cls] = {
                    waiting: snap?.waiting ?? 0,
                    active: snap?.active ?? 0,
                    delayed: snap?.delayed ?? 0,
                    paused: pausedByClass[cls] || (snap?.paused ?? false),
                };
            }

            // Top-level per-queue state record.
            const queueStates: Record<ResourceClass, { paused: boolean; reachable: boolean }> =
                {} as Record<ResourceClass, { paused: boolean; reachable: boolean }>;
            for (const cls of RESOURCE_CLASSES) {
                const snap = depthSnapshot?.[cls];
                queueStates[cls] = {
                    paused: queueDepths[cls].paused,
                    reachable: snap !== undefined,
                };
            }

            // Legacy `queuesPaused` shape — flat boolean record, kept for API compat.
            const queuesPaused: Record<ResourceClass, boolean> = {} as Record<
                ResourceClass,
                boolean
            >;
            for (const cls of RESOURCE_CLASSES) {
                queuesPaused[cls] = pausedByClass[cls];
            }

            // Merge DB state with task manifest schedule info.
            const tasks = dbStates.map((s) => {
                const task = registry.getTask(s.taskId);
                return {
                    taskId: s.taskId,
                    lastFiredAt: s.lastFiredAt,
                    nextFireAt: s.nextFireAt,
                    paused: s.paused,
                    pausedBy: s.pausedBy ?? undefined,
                    pausedAt: s.pausedAt ?? undefined,
                    schedule: task?.schedule
                        ? {
                              every: task.schedule.every,
                              runOnStartup: task.schedule.runOnStartup,
                          }
                        : undefined,
                };
            });

            return typedJson(V1SchedulerResponseSchema, {
                tasks,
                queuesPaused,
                queueDepths,
                queueStates,
            });
        },
    },
});
