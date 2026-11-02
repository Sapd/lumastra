// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /tasks — task catalog with per-lane health summary.
 *
 * Dual-mounted def: backs both `/api/v1/tasks` (token surface) and `/api/tasks`
 * (internal forward-auth/cookie surface). B1 facade port of the former bespoke
 * `/api/v1/tasks/+server.ts` legacy handler — behaviour, response shape and
 * scope (`tasks:read`) are preserved EXACTLY.
 *
 * Auth scope: tasks:read.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { registry } from '$lib/server/tasks/registry.js';
import { pluginIdForTask } from '$lib/server/plugins/runtime/task-origin.js';
import { getTaskLaneData, summarizeLanes, computeStaleEdges } from '$lib/server/tasks/lane-data.js';
import { parseDurationMs } from '$lib/server/tasks/scheduler.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import {
    listAllTaskTriggers,
    listAllScheduledTasks,
    type SchedulerState,
    type StoredTaskTriggers,
} from '$lib/server/tasks/scheduler-state.js';
import { defaultEvery } from '$lib/server/tasks/trigger-service.js';
import { isTimed } from '$lib/server/tasks/triggers.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getBuiltinRegistrationErrors } from '$lib/server/tasks/builtin/index.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { V1TasksResponseSchema } from '$lib/schemas/api-v1.js';
import { z } from 'zod';
import {
    TASK_SCHEDULE_PRESET_DURATIONS,
    type TaskDefinitionSummary,
} from '$lib/schemas/task-definition.schema.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const log = Logger.for('api.v1.tasks.list');

/**
 * Schedule-pause state per task id, read from `scheduler_state`.
 *
 * Lives here rather than in `getTaskLaneData` because it is not lane data:
 * `scheduler_state` is on the TASK database (`getTaskDb`), while lane-data
 * queries the main one, and a pause is an operator decision rather than an
 * observed metric. Returns null when the task DB is unreachable, so the
 * caller omits the fields entirely instead of reporting every task as
 * "not paused" — the same "absent means unknown" convention the lane
 * fields already use.
 */
async function getSchedulePauseMap(): Promise<Map<string, SchedulerState> | null> {
    const sqlTask = getTaskDb();
    if (!sqlTask) return null;
    try {
        const states = await listAllScheduledTasks(sqlTask);
        return new Map(states.map((s) => [s.taskId, s]));
    } catch (err) {
        log.warn('tasks: scheduler-state query failed', { err: String(err) });
        return null;
    }
}

/**
 * Operator triggers (spec 2026-09-27 Part 2), keyed by task id. Same
 * best-effort contract as `getSchedulePauseMap`: an unreachable task DB leaves
 * the fields off rather than asserting "no triggers", so the UI never claims
 * the declared cadence is the effective one when it simply could not check.
 */
async function getTriggerMap(): Promise<Map<string, StoredTaskTriggers> | null> {
    const sqlTask = getTaskDb();
    if (!sqlTask) return null;
    try {
        return await listAllTaskTriggers(sqlTask);
    } catch (err) {
        log.warn('tasks: task-triggers query failed', { err: String(err) });
        return null;
    }
}

function taskSummary(t: ReturnType<typeof registry.getAllTasks>[number]): TaskDefinitionSummary {
    return {
        id: t.id,
        name: taskDisplayName(t.id, t.name),
        description: t.description,
        notes: t.notes,
        version: t.version,
        processingVersion: t.processingVersion,
        resourceClass: t.resourceClass,
        pluginId: pluginIdForTask(t.id),
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
                      advanced: f.advanced,
                  })),
              }
            : undefined,
        // Stage ids this task covers — used client-side to sum the
        // matching media_item_stage_state backlog counts for the
        // "+N in backlog" hint on /admin/tasks lane cards. Server stays
        // the source of truth for the task→stages mapping; client doesn't
        // need the full coversStages shape (predicates, invalidatedBy, etc).
        coveredStageIds: t.coversStages?.map((s) => s.id) ?? undefined,
        // Surfaced so the lane card can distinguish "starved by design
        // (deprioritized)" from "starved by accident." Values > 5 mean
        // intentional deprioritization; default of 5 omits this signal.
        taskPriority: t.taskPriority,
    };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Tasks'],
            summary: 'List task definitions',
            stability: 'beta',
            description:
                'Returns all registered task definitions with lane summaries (active/pending/failed/healthy) and stale-edge alerts. Requires `read` scope.',
            query: z.object({
                includeStale: z.coerce
                    .boolean()
                    .optional()
                    .meta({ description: 'Include stale-edge alert computation' }),
            }),
            responses: {
                200: {
                    schema: V1TasksResponseSchema,
                    description: 'Task definitions with lane data',
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
            // Hide tutorial exemplars (demo: true) in production so end users don't
            // see fake jobs alongside real ones. Demos stay visible in dev / CI so
            // plugin authors can read + manual-trigger them as SDK references.
            const isProd = process.env.NODE_ENV === 'production';
            const rawTasks = registry.getAllTasks().filter((t) => !isProd || !t.demo);

            const ids = rawTasks.map((t) => t.id);
            // Map task_id → stage_ids it covers so getTaskLaneData can compute the
            // ETA denominator from actual stage-row completion rate instead of the
            // loosely-defined task_history.result.itemsProcessed (which varies by
            // plugin author from "rows updated" to "sprite tiles generated" to
            // "Jellyfin actors fetched").
            const stagesByTask = new Map<string, string[]>();
            for (const t of rawTasks) {
                const covered = t.coversStages;
                if (covered && covered.length > 0) {
                    stagesByTask.set(
                        t.id,
                        covered.map((s) => s.id),
                    );
                }
            }
            const [laneMap, pauseMap, triggerMap] = await Promise.all([
                getTaskLaneData(ids, stagesByTask),
                getSchedulePauseMap(),
                getTriggerMap(),
            ]);

            /**
             * Merge the schedule-pause switch onto a task summary. A task with
             * no `scheduler_state` row has never been scheduled or paused, so
             * it reports `schedulePaused: false` — only an unreachable task DB
             * (`pauseMap === null`) leaves the fields off.
             */
            const withPauseState = <T extends { id: string }>(base: T) => {
                if (!pauseMap) return base;
                const state = pauseMap.get(base.id);
                return {
                    ...base,
                    schedulePaused: state?.paused === true,
                    schedulePausedBy: state?.pausedBy ?? null,
                    schedulePausedAt: state?.pausedAt?.toISOString() ?? null,
                    // A paused schedule has no meaningful next start: the row
                    // keeps its last computed `next_fire_at`, which would read
                    // as a promise the scheduler is not going to keep.
                    nextRunAt: state && !state.paused ? state.nextFireAt.toISOString() : null,
                };
            };

            /**
             * Merge the EFFECTIVE schedule onto a task summary, with the same
             * precedence as the scheduler — operator triggers, else the env
             * override, else the declared `schedule.every` — because a row
             * showing a cadence the scheduler is not using is the same class
             * of bug as the surfaces that used to disagree about failed runs.
             *
             * `effectiveEvery` is set only when ONE interval describes the
             * schedule; "Daily at 03:00" has no interval, and `triggers`
             * carries it instead. A startup-only task has no next run.
             */
            const withEffectiveSchedule = <
                T extends { id: string; schedule?: { every?: string }; nextRunAt?: string | null },
            >(
                base: T,
            ) => {
                if (!triggerMap) return base;
                const stored = triggerMap.get(base.id);
                if (!stored) {
                    const def = registry.getTask(base.id);
                    return {
                        ...base,
                        effectiveEvery: def ? defaultEvery(def) : base.schedule?.every,
                    };
                }
                const [first] = stored.triggers;
                const single =
                    stored.triggers.length === 1 && first.kind === 'interval'
                        ? first.every
                        : undefined;
                return {
                    ...base,
                    triggers: stored.triggers,
                    scheduleOverride: single
                        ? {
                              preset:
                                  Object.entries(TASK_SCHEDULE_PRESET_DURATIONS).find(
                                      ([, every]) => every === single,
                                  )?.[0] ?? 'custom',
                              every: single,
                              updatedBy: stored.updatedBy,
                              updatedAt: stored.updatedAt.toISOString(),
                          }
                        : undefined,
                    effectiveEvery: single,
                    ...(stored.triggers.some(isTimed) ? {} : { nextRunAt: null }),
                };
            };

            // Registration errors captured during loadBuiltins(). Always include
            // in the response (even when DB is unreachable) so the admin UI can
            // surface a banner — silent disappearance of a task because its
            // module threw at boot is exactly the OSS-fragility class we just hit
            // with the metadata-sync duration-string regression.
            const registrationErrors = getBuiltinRegistrationErrors();

            // laneMap === null means DB is unreachable. Omit lane fields and summary
            // entirely so the UI shows "(metrics unavailable)" rather than rendering
            // every task as healthy with all-zero counters.
            if (!laneMap) {
                return typedJson(V1TasksResponseSchema, {
                    page: { limit: rawTasks.length, offset: 0, hasMore: false },
                    items: rawTasks.map((t) =>
                        withEffectiveSchedule(withPauseState(taskSummary(t))),
                    ),
                    registrationErrors: [...registrationErrors],
                });
            }

            const summary = summarizeLanes(laneMap);

            const edges: Array<{ upstream: string; downstream: string }> = [];
            for (const t of rawTasks) {
                if (t.feedsInto) {
                    for (const downstream of t.feedsInto) {
                        edges.push({ upstream: t.id, downstream });
                    }
                }
            }

            const schedulesByTask = new Map(
                rawTasks.map((t) => [
                    t.id,
                    {
                        everyMs: t.schedule?.every ? parseDurationMs(t.schedule.every) : null,
                    },
                ]),
            );

            const staleAlerts = computeStaleEdges(edges, laneMap, schedulesByTask);

            const staleByDownstream = new Map<string, typeof staleAlerts>();
            for (const alert of staleAlerts) {
                const existing = staleByDownstream.get(alert.downstreamId) ?? [];
                existing.push(alert);
                staleByDownstream.set(alert.downstreamId, existing);
            }

            const tasks = rawTasks.map((t) => {
                const base = withEffectiveSchedule(withPauseState(taskSummary(t)));
                const lane = laneMap.get(t.id);
                const staleUpstreams = staleByDownstream.get(t.id);
                // Currently-active runs stay in the Active lane even if their upstream
                // chain is stale — hiding a running task because of an alert about a
                // different one is the opposite of what an operator needs to see.
                const effectiveLane =
                    staleUpstreams?.length && lane?.lane !== 'active'
                        ? 'failed'
                        : (lane?.lane ?? undefined);
                if (!lane) return base;
                return {
                    ...base,
                    lane: effectiveLane,
                    staleUpstreams,
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
                };
            });

            return typedJson(V1TasksResponseSchema, {
                items: tasks,
                page: { limit: tasks.length, offset: 0, hasMore: false },
                summary,
                registrationErrors: [...registrationErrors],
            });
        },
    },
});
