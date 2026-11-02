// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/{taskId}
 *
 * Auth scope: tasks:read
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getTaskLaneData } from '$lib/server/tasks/lane-data.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { getSchedulerState } from '$lib/server/tasks/scheduler-state.js';
import { Logger } from '$lib/server/utils/logger.js';
import { json } from '@sveltejs/kit';
import {
    TaskDefinitionSummarySchema,
    type TaskDefinitionSummary,
} from '$lib/schemas/task-definition.schema.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const log = Logger.for('api.v1.tasks.detail');

/** Every field optional: all three are absent together when the state is unknown. */
interface SchedulePauseFields {
    schedulePaused?: boolean;
    schedulePausedBy?: string | null;
    schedulePausedAt?: string | null;
}

/**
 * Schedule-pause switch for one task — the detail-endpoint counterpart to the
 * list endpoint's `getSchedulePauseMap`. `scheduler_state` lives on the TASK
 * database, so this is a separate read from the lane-data query rather than
 * another column on it. Returns an empty object when the task DB is
 * unreachable, so the fields are OMITTED (unknown) instead of reporting a
 * paused task as running.
 */
async function schedulePauseFields(taskId: string): Promise<SchedulePauseFields> {
    const sqlTask = getTaskDb();
    if (!sqlTask) return {};
    try {
        const state = await getSchedulerState(sqlTask, taskId);
        return {
            schedulePaused: state?.paused === true,
            schedulePausedBy: state?.pausedBy ?? null,
            schedulePausedAt: state?.pausedAt?.toISOString() ?? null,
        };
    } catch (err) {
        log.warn('task detail: scheduler-state query failed', { taskId, err: String(err) });
        return {};
    }
}

const TaskDetailResponseSchema = TaskDefinitionSummarySchema;

function taskSummary(t: ReturnType<typeof registry.getTask>): TaskDefinitionSummary | null {
    if (!t) return null;
    return {
        id: t.id,
        name: taskDisplayName(t.id, t.name),
        description: t.description,
        notes: t.notes,
        version: t.version,
        processingVersion: t.processingVersion,
        resourceClass: t.resourceClass,
        schedule: t.schedule
            ? {
                  every: t.schedule.every,
                  runOnStartup: t.schedule.runOnStartup,
                  envOverride: t.schedule.envOverride,
              }
            : undefined,
        capabilities: t.capabilities ?? {},
        scope: t.scope,
        retry: t.retry
            ? {
                  attempts: t.retry.attempts,
                  backoff: t.retry.backoff,
              }
            : undefined,
        backpressure: t.backpressure,
        backlog: t.backlog ? { unitLabel: t.backlog.unitLabel } : undefined,
        quotas: t.quotas,
        retention: t.retention,
        timeout: t.timeout,
        demo: t.demo,
        purpose: t.purpose,
        visibility: t.visibility ?? 'user',
        confirmBeforeRun: t.confirmBeforeRun,
        notManuallyRunnable: t.notManuallyRunnable,
        supportsFullRun: t.supportsFullRun,
        supportsForceRun: t.supportsForceRun,
        supportsPerItemRetry: typeof t.failures?.retry === 'function',
        destructive: t.destructive,
        exclusiveWith: t.exclusiveWith,
        pipeline: t.pipeline
            ? {
                  of: t.pipeline.of,
                  after: t.pipeline.after,
                  hasWhen: typeof t.pipeline.when === 'function',
              }
            : undefined,
        settings: t.settings
            ? {
                  // Per-plugin enable/disable does not exist (the SDK flag that
                  // promised it was removed); always false, kept for API shape.
                  canToggle: false,
                  fields: t.settings.fields.map((f) => ({
                      key: f.key,
                      label: f.label,
                      type: f.type,
                      description: f.description,
                      required: f.required,
                      default: f.type === 'secret' ? undefined : f.default,
                      options: f.options,
                      validation: f.validation,
                  })),
              }
            : undefined,
        // Stage ids this task covers — see index.ts's taskSummary() for the
        // same field on the list endpoint; kept in sync here so the detail
        // drawer can compute the same backlog totals as the catalog card.
        coveredStageIds: t.coversStages?.map((s) => s.id) ?? undefined,
        taskPriority: t.taskPriority,
    };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'Get a task',
            stability: 'beta',
            auth: 'bearer',
            description: 'Returns details for a single task by slug. Requires `tasks:read` scope.',
            responses: {
                200: {
                    schema: TaskDetailResponseSchema,
                    description: 'Task details',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Task not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:read'] },
    handlers: {
        GET: async (event) => {
            const { taskId } = event.params;
            const task = registry.getTask(taskId!);
            if (!task) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            // Mirror the list endpoint's prod filter: hide demos from end users.
            if (process.env.NODE_ENV === 'production' && task.demo) {
                return ApiProblem.notFound(`Task '${taskId}' not found`);
            }

            const base = taskSummary(task);

            // Lane data (activeCount/backlogRemaining/recentFailCount/circuitState/
            // itemsPerHour/lastFailedError) — the SAME fields the /api/tasks list
            // endpoint computes for the catalog card. Without this the detail
            // drawer's Overview stat tiles read as all-zero/healthy even when the
            // card right next to it shows a real backlog and failure count.
            const stagesByTask = new Map<string, string[]>();
            const coveredStageIds = task.coversStages?.map((s) => s.id) ?? [];
            if (coveredStageIds.length > 0) {
                stagesByTask.set(task.id, coveredStageIds);
            }
            const [laneMap, pauseFields] = await Promise.all([
                getTaskLaneData([task.id], stagesByTask),
                schedulePauseFields(task.id),
            ]);
            const lane = laneMap?.get(task.id);
            if (!lane) {
                return json({ ...base, ...pauseFields });
            }

            return json({
                ...base,
                ...pauseFields,
                activeCount: lane.activeCount,
                observedActiveCount: lane.observedActiveCount,
                lastStartedAt: lane.lastStartedAt,
                lastCompletedAt: lane.lastCompletedAt,
                backlogRemaining: lane.backlogRemaining,
                recentFailCount: lane.recentFailCount,
                circuitState: lane.circuitState,
                itemsPerHour: lane.itemsPerHour,
                lastFailedError: lane.lastFailedError,
                lastDurationMs: lane.lastDurationMs,
            });
        },
    },
});
