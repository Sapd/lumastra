// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/stuck-check — the "something has been running forever" diagnostic.
 *
 * GET /api/admin/fix/stuck-check → StuckCheck.
 * Auth: admin. Errors: problem+json.
 *
 * ## What makes this a diagnostic and not a checklist
 *
 * Every field is MEASURED on the instance serving the request:
 *   - is anything completing right now        (stage completions in the window)
 *   - is anything queued at all               (in-flight / oldest pending age)
 *   - can a worker even pick work up          (live worker probe)
 *   - is the owning task switched off         (scheduler_state.paused)
 *   - is the lane that runs it paused         (BullMQ queue paused flag)
 *   - what already gave up                    (dead letters, degraded items)
 *
 * ## Throughput, not depth, is the measurement that matters
 *
 * "Stuck" and "slow" present identically — a bar that has not moved in hours —
 * and have completely different fixes. Depth cannot separate them: a 14,000-item
 * queue is healthy if it is draining and wedged if it is not. So the verdict
 * turns on completions in a five-minute window, which is the SAME gate
 * `/admin/fix/slow` uses to decide whether to reassure. Sharing the gate is
 * deliberate: two pages describing one instance must never disagree about
 * whether it is moving.
 *
 * ## The verdict is computed here, not in the page
 *
 * `library-scan-check` reports `PathProbe.state` rather than raw errno for the
 * same reason. A page that re-derived the verdict from the evidence would
 * eventually derive a different one, and the operator would get two answers
 * from one instance.
 *
 * ## Ordering of causes is not cosmetic
 *
 * `no-worker` and `paused` are checked BEFORE `stalled`, because both are
 * sufficient explanations with a specific fix, while `stalled` is the residual
 * "queued, workers alive, nothing moving" case that still needs investigation.
 * Reporting `stalled` when the real answer is "you paused this task last week"
 * would send the operator hunting for a bug that does not exist.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import {
    countRunnableStageItems,
    loadIngestPipelineSummary,
    loadStageActivity,
    loadStagePendingCounts,
} from '$lib/server/database/queries/ingest-map.queries.js';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getBackgroundWorkerStatus } from '$lib/server/services/worker-status.js';
import type {
    StuckCheck,
    StuckCheckFailed,
    StuckStage,
    StuckVerdict,
} from '$lib/components/admin/fix/stuck-check.schema.js';

const logger = Logger.for('AdminFixStuckCheck');

/**
 * Throughput window. Matches the five minutes `loadStageActivity` already
 * aggregates over — the number is fixed in that SQL, so this constant exists to
 * report the window to the operator, not to configure it. Changing one without
 * the other would make the page state a window it did not measure.
 */
const WINDOW_MINUTES = 5;

/** Evidence, not an inventory — the page shows the busiest stages, not all of them. */
const MAX_STAGES = 8;

/**
 * The sweep that enqueues every stage. Paused, it holds back all per-item work,
 * so it always counts as a cause.
 */
const STAGE_SWEEP_TASK_ID = 'stage-sweep';

/** Paused flag per lane, or null when the queue backend did not answer. */
async function readPausedLanes(): Promise<string[] | null> {
    try {
        const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
        const depths = await orchestrator.getQueueDepths();
        return Object.entries(depths)
            .filter(([, d]) => d.paused)
            .map(([cls]) => cls);
    } catch (err) {
        logger.warn('queue depths unreadable; paused lanes omitted', {
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Decide the verdict from measured facts, in the order an operator can act on.
 *
 * Kept a pure function so the ordering is testable without a database: the
 * precedence between `no-worker`, `paused` and `stalled` is the part most likely
 * to be got wrong later, and it is the part that decides where an operator
 * spends the next hour.
 */
export function decideVerdict(input: {
    inFlight: number;
    completedInWindow: number;
    workerAvailable: boolean;
    /** Pauses that hold back the queued work: owning tasks, the sweep, their lanes. */
    pausedTaskCount: number;
}): StuckVerdict {
    // Nothing queued is not stuck, whatever else is true. Checked first so a
    // paused task on an idle instance does not masquerade as the cause of a
    // problem the operator does not have.
    if (input.inFlight === 0) return 'idle';
    if (input.completedInWindow > 0) return 'moving';
    if (!input.workerAvailable) return 'no-worker';
    if (input.pausedTaskCount > 0) return 'paused';
    return 'stalled';
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getAdminDb();
            if (!sql) {
                // Report the absence rather than a fabricated verdict. With no
                // database there is nothing measured, and `idle` would be a
                // confident wrong answer on an instance whose real problem is
                // that its database is gone.
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            // Independent reads, so failures do not cascade: a scheduler table
            // that will not answer must not cost the operator the throughput
            // numbers, which are the ones that decide the verdict.
            // A check that could not be read is reported, never folded into a
            // verdict as "nothing found": a scheduler table that will not
            // answer must not turn a paused task into `stalled`.
            const checksFailed: StuckCheckFailed[] = [];
            const [summary, runnable, activity, pendingByStage, scheduled, worker, pausedLanes] =
                await Promise.all([
                    loadIngestPipelineSummary(sql),
                    countRunnableStageItems(sql),
                    loadStageActivity(sql),
                    loadStagePendingCounts(sql).catch((err: unknown) => {
                        logger.warn('stage pending counts unreadable', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                        checksFailed.push('pending');
                        return [];
                    }),
                    listAllScheduledTasks(sql).catch((err: unknown) => {
                        logger.warn('scheduler state unreadable; paused tasks omitted', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                        checksFailed.push('scheduler');
                        return [];
                    }),
                    getBackgroundWorkerStatus().catch((err: unknown) => {
                        logger.warn('worker probe failed', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                        return { available: false, source: 'probe-failed' as const };
                    }),
                    readPausedLanes(),
                ]);
            if (pausedLanes === null) checksFailed.push('queues');

            // Fail toward `true`: reporting `no-worker` off a failed PROBE would
            // name a cause that was never measured, which is exactly the
            // "checklist pretending to be a diagnostic" failure this surface
            // exists to avoid. The service reports its own cluster-read failure
            // as `probe-failed` rather than throwing.
            const workerProbeFailed = worker.source === 'probe-failed';
            if (workerProbeFailed) checksFailed.push('worker');
            const workerAvailable = worker.available || workerProbeFailed;

            const completedInWindow = activity.reduce((n, a) => n + a.completed_5m, 0);
            const pausedTasks = scheduled.filter((t) => t.paused).map((t) => t.taskId);

            // Only a pause that holds back the QUEUED work explains it: the
            // sweep, a task that owns a backlogged stage, or the lane such a
            // task runs on. An unrelated paused nightly report is still listed
            // as evidence, but naming it the cause sends the operator to resume
            // the wrong thing. Without the backlog read there is nothing to
            // match against, so every pause counts — the pre-filter behaviour.
            const backlogStages = new Set(
                pendingByStage.filter((p) => p.pending > 0).map((p) => p.stage_id),
            );
            const backlogKnown = !checksFailed.includes('pending') && backlogStages.size > 0;
            const backlogLanes = new Set<string>(
                [...backlogStages].flatMap((id) => {
                    const cls = registry.getTask(id)?.resourceClass;
                    return cls ? [cls] : [];
                }),
            );
            const pausedQueues = pausedLanes ?? [];
            const blockingPauses =
                pausedTasks.filter(
                    (id) => !backlogKnown || id === STAGE_SWEEP_TASK_ID || backlogStages.has(id),
                ).length +
                pausedQueues.filter(
                    (cls) => !backlogKnown || backlogLanes.size === 0 || backlogLanes.has(cls),
                ).length;

            // Movement AND backlog, unioned by stage id.
            //
            // An earlier version listed only stages with movement — running,
            // recent completions, recent failures. Verified against a real
            // instance, that produced an EMPTY list on a `stalled` verdict with
            // 9,209 items in flight, because on a wedged instance all three
            // movement signals are zero by definition. The evidence disappeared
            // at exactly the moment it mattered. A stage with waiting work is
            // evidence too, so both sources are merged.
            const pendingMap = new Map(pendingByStage.map((p) => [p.stage_id, p]));
            const activityMap = new Map(activity.map((a) => [a.stage_id, a]));
            const allStageIds = new Set([...activityMap.keys(), ...pendingMap.keys()]);

            const stages: StuckStage[] = [...allStageIds]
                .map((stageId) => {
                    const a = activityMap.get(stageId);
                    const p = pendingMap.get(stageId);
                    return {
                        stageId,
                        completed5m: a?.completed_5m ?? 0,
                        running: a?.running ?? 0,
                        failed1h: a?.failed_1h ?? 0,
                        lastCompletedAt: a?.last_completed_at
                            ? new Date(a.last_completed_at).toISOString()
                            : null,
                        pending: p?.pending ?? 0,
                        oldestPendingAgeSec: p?.oldest_pending_age_sec ?? null,
                    };
                })
                .filter(
                    (s) => s.running > 0 || s.completed5m > 0 || s.failed1h > 0 || s.pending > 0,
                )
                // Waiting work first: on a stalled instance that is the whole
                // question, and on a moving one the busiest stage is also the
                // deepest. Running/failures break ties.
                .sort(
                    (x, y) =>
                        y.pending - x.pending || y.running - x.running || y.failed1h - x.failed1h,
                )
                .slice(0, MAX_STAGES);

            const payload: StuckCheck = {
                generatedAt: new Date().toISOString(),
                verdict: decideVerdict({
                    inFlight: runnable,
                    completedInWindow,
                    workerAvailable,
                    pausedTaskCount: blockingPauses,
                }),
                windowMinutes: WINDOW_MINUTES,
                completedInWindow,
                inFlight: runnable,
                running: summary.running,
                oldestPendingAgeSec: summary.oldestPendingAgeSec,
                deadLetterItems: summary.deadLetterItems,
                degradedItems: summary.degradedItems,
                workerAvailable,
                workerSource: worker.source,
                pausedTasks,
                pausedQueues,
                blockingPauses,
                checksFailed,
                stages,
            };

            return json(payload);
        },
    },
});
