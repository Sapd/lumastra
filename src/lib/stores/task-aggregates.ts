// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// task-aggregates.ts — compute per-task live aggregates from runSSEBus.
//
// Why this helper exists:
// /admin/tasks lane cards used to subscribe to runSSEBus.onAnyChange
// individually (N cards × event rate = the "effect update depth exceeded"
// crash). The page now subscribes once, computes Map<taskId, TaskAggregate>,
// and passes the aggregate down as a prop. Cards become pure functions of
// props and never re-subscribe — re-renders happen only when their
// aggregate identity changes.
//
// Shape decisions:
// - `runningCount` needs live admission evidence, not an SQL active row.
// - `queuedCount` needs a confirmed waiting job, not a pending SQL row.
// - `primaryStage` is for singleton-shaped tasks (runningCount === 1)
//   that report progress via reportProgress(). Lets the card render a
//   CompactRunProgress-style "12/40 episodes · ~3m" line.
// - `lastCompletedAt` / `lastCompletedLabel` are observed-via-bus only
//   (terminal runs the page has seen since mount). Powers the "Last
//   completed Ns ago" pulse on fan-out cards.

import type { Run, RunStage } from '$lib/schemas/run.schema.js';

export interface TaskAggregate {
    /** Active or cancelling runs with runtime admission evidence. */
    runningCount: number;
    /** Pending runs confirmed present in a BullMQ waiting state. */
    queuedCount: number;
    /** Pending runs whose queue record carries playback deferral evidence. */
    deferredCount: number;
    /** For singleton tasks (single active run), the active stage's progress. */
    primaryStage?: {
        label: string;
        processed?: number;
        total?: number;
        currentItem?: string;
    };
    /** Most recent observed terminal completion timestamp (ISO). */
    lastCompletedAt?: string;
    /** Short label for the most recent completion (e.g. media item id). */
    lastCompletedLabel?: string;
    /**
     * media_item_stage_state pending count summed across all stages this
     * task covers — the "macro backlog" behind whatever's currently
     * running. Distinct from queuedCount (= task_history pending, the
     * subset already enqueued into BullMQ). Together they let the card
     * answer "of the 412 items needing this, 17 are queued and 1 is
     * running right now."
     */
    coverageBacklog?: number;
    /**
     * Estimated milliseconds to drain `coverageBacklog` at the current
     * throughput (items/hour over the last 1h window, from the server).
     * Undefined when throughput is unknown (zero recent completions) or
     * when there's no backlog to drain. The card formats this to a short
     * duration like "~6h" or "~2d".
     */
    etaMs?: number;
    /**
     * Recent failure count (last 24h) — copied from server lane data so
     * the card body can render "⚠ N failed in 24h" on idle cards
     * without forcing the operator to open the lane header.
     */
    recentFailCount?: number;
    /** Truncated last-failure error message (last 24h window, server-side). */
    lastFailedError?: string;
    /**
     * Set when this task has backlog but is idle because another task on
     * the same resourceClass is currently running and holding the only
     * worker slot. Lets the card render "waiting for bulk slot (series-sync
     * running)" so the operator knows it's queued, not stalled.
     */
    slotHoldingTaskName?: string;
    /** The resource class held — used for the "waiting for X slot" wording. */
    slotHoldingResourceClass?: string;
    /**
     * "Working as configured" signal. True when the task is idle AND its
     * `taskPriority` is set higher than the default of 5 (i.e., explicitly
     * deprioritized). The lane card uses this to render
     *   ⚙ deprioritized — by design (priority N)
     * instead of the warning-style "waiting for slot" copy. Distinguishes
     * an operator's intentional starvation choice from an accidental one.
     */
    deprioritizedByDesign?: boolean;
}

/**
 * Per-task metadata input for computeTaskAggregates. Lets the helper
 * resolve resource-class collisions ("who's holding the bulk slot
 * while artist-enrichment waits?") and copy server-derived fields onto
 * the aggregate without the page wiring each one separately.
 */
export interface TaskMetadata {
    name: string;
    resourceClass?: string;
    lastFailedError?: string | null;
    recentFailCount?: number;
    /** From TaskDefinition.taskPriority; default 5 if undefined. */
    taskPriority?: number;
}

/**
 * Build per-task aggregates from the bus's run map. O(N) over runs.
 *
 * `runs` is the live Map from `runSSEBus.runs` — the caller is responsible
 * for re-running this whenever the bus signals a change.
 *
 * `taskCoveredStages` maps taskId → stage_ids this task covers. Used with
 * `stageBacklogs` (stage_id → pending count from
 * /api/admin/coverage/backlog) to attach `coverageBacklog` per task.
 *
 * `taskItemsPerHour` maps taskId → server-computed throughput over the
 * last 1h window. Used with `coverageBacklog` to compute `etaMs`.
 *
 * All three lookup maps are optional — if omitted, aggregates carry
 * only bus-derived counts (runningCount, queuedCount, primaryStage,
 * lastCompletedAt).
 */
export function computeTaskAggregates(
    runs: Iterable<Run>,
    taskCoveredStages?: Map<string, readonly string[]>,
    stageBacklogs?: Map<string, number>,
    taskItemsPerHour?: Map<string, number | null>,
    taskMetadata?: Map<string, TaskMetadata>,
): Map<string, TaskAggregate> {
    const result = new Map<string, TaskAggregate>();

    for (const run of runs) {
        let agg = result.get(run.taskId);
        if (!agg) {
            agg = { runningCount: 0, queuedCount: 0, deferredCount: 0 };
            result.set(run.taskId, agg);
        }

        if (
            (run.state === 'active' || run.state === 'cancelling') &&
            run.admissionObservation === 'active'
        ) {
            agg.runningCount += 1;
            // Singleton heuristic: if this is the (so far) only running run
            // for this task and it has an active stage with non-trivial
            // progress data, surface it.
            if (agg.runningCount === 1 && !agg.primaryStage) {
                const active = pickActiveStage(run.stages);
                if (active) {
                    agg.primaryStage = {
                        label: active.label,
                        processed: active.processed,
                        total: active.total,
                        currentItem: active.currentItem,
                    };
                }
            } else if (agg.runningCount > 1 && agg.primaryStage) {
                // Multiple runs are now active — drop singleton view; the
                // card switches to fan-out display.
                agg.primaryStage = undefined;
            }
        } else if (run.state === 'pending' && run.admissionObservation === 'waiting') {
            agg.queuedCount += 1;
        } else if (run.state === 'pending' && run.admissionObservation === 'playback-deferred') {
            agg.deferredCount += 1;
        } else if (run.completedAt) {
            // Terminal — track most recent completion for the live pulse.
            if (!agg.lastCompletedAt || run.completedAt > agg.lastCompletedAt) {
                agg.lastCompletedAt = run.completedAt;
                agg.lastCompletedLabel = extractRunLabel(run);
            }
        }
    }

    // Attach coverage-table backlog per task. Sum across all stages the
    // task covers — multi-stage tasks (e.g. library-embeddings) aggregate
    // backlog over all their stages. Also seed an aggregate for tasks
    // with backlog but zero bus activity, so the card still shows the
    // queue depth.
    if (taskCoveredStages && stageBacklogs && stageBacklogs.size > 0) {
        for (const [taskId, stageIds] of taskCoveredStages) {
            let backlog = 0;
            for (const stageId of stageIds) {
                backlog += stageBacklogs.get(stageId) ?? 0;
            }
            if (backlog === 0) continue;
            const existing = result.get(taskId);
            if (existing) {
                existing.coverageBacklog = backlog;
            } else {
                result.set(taskId, {
                    runningCount: 0,
                    queuedCount: 0,
                    deferredCount: 0,
                    coverageBacklog: backlog,
                });
            }
        }
    }

    // Compute ETA per task from backlog + throughput. Skip when either
    // is missing — the display falls back to showing just the backlog
    // count without "~Xh to drain."
    if (taskItemsPerHour && taskItemsPerHour.size > 0) {
        for (const [taskId, agg] of result) {
            if (!agg.coverageBacklog || agg.coverageBacklog === 0) continue;
            const itemsPerHour = taskItemsPerHour.get(taskId);
            if (!itemsPerHour || itemsPerHour <= 0) continue;
            // ms-to-drain = items / (items per ms)
            //             = items / (itemsPerHour / 3_600_000)
            //             = items * 3_600_000 / itemsPerHour
            agg.etaMs = (agg.coverageBacklog * 3_600_000) / itemsPerHour;
        }
    }

    // Idle-state enrichment. For each task with metadata, copy recent
    // failure data onto the aggregate. Then for idle-but-backlogged
    // tasks, identify who's holding the worker slot on their resource
    // class — answers "why isn't this running?" on the card.
    if (taskMetadata && taskMetadata.size > 0) {
        // Pass 1: copy failure data onto every aggregate that has metadata.
        for (const [taskId, meta] of taskMetadata) {
            if (!meta.lastFailedError && !meta.recentFailCount) continue;
            let agg = result.get(taskId);
            if (!agg) {
                // Seed an aggregate for failure-only tasks (no backlog, no
                // bus activity) so failed-lane cards still surface the
                // truncated error inline.
                agg = { runningCount: 0, queuedCount: 0, deferredCount: 0 };
                result.set(taskId, agg);
            }
            if (meta.lastFailedError) agg.lastFailedError = meta.lastFailedError;
            if (meta.recentFailCount && meta.recentFailCount > 0) {
                agg.recentFailCount = meta.recentFailCount;
            }
        }

        // Pass 2: for each resource class, find the running task. Then
        // mark idle-with-backlog tasks on the same class as "waiting for
        // <holder>." The page shows this as "waiting for bulk slot
        // (series-sync running)."
        const runningByClass = new Map<string, string>(); // class → task name
        for (const [taskId, agg] of result) {
            if (agg.runningCount === 0) continue;
            const meta = taskMetadata.get(taskId);
            if (!meta?.resourceClass) continue;
            // Keep the first running task we see per class. Tasks within
            // the same class compete for the same finite worker pool;
            // any running task occupies the slot, so naming one is enough.
            if (!runningByClass.has(meta.resourceClass)) {
                runningByClass.set(meta.resourceClass, meta.name);
            }
        }

        for (const [taskId, agg] of result) {
            if (agg.runningCount > 0) continue;
            if (!agg.coverageBacklog || agg.coverageBacklog === 0) continue;
            const meta = taskMetadata.get(taskId);
            if (!meta?.resourceClass) continue;

            // "Working as configured" wins over "waiting for slot": if the
            // task is explicitly deprioritized (taskPriority > 5 = lower
            // than default), the operator chose this. Mark it so the card
            // can render the calm "by design" message instead of an
            // alarming "waiting" hint that suggests they should investigate.
            if (typeof meta.taskPriority === 'number' && meta.taskPriority > 5) {
                agg.deprioritizedByDesign = true;
                // Keep slotHoldingTaskName too so the card can show WHO
                // it's deprioritized behind — useful context even when
                // it's working as designed.
            }

            const holder = runningByClass.get(meta.resourceClass);
            // Don't mark a task as "waiting for itself" — could happen
            // when seeding a backlog-only aggregate while one is already
            // running (the running aggregate populates runningByClass
            // and the seeded one is a different runId for the same task).
            if (holder && holder !== meta.name) {
                agg.slotHoldingTaskName = holder;
                agg.slotHoldingResourceClass = meta.resourceClass;
            }
        }
    }

    return result;
}

function pickActiveStage(stages: RunStage[]): RunStage | null {
    // Prefer the stage marked 'active'; fall back to the first stage with
    // any progress signal so single-stage runs without a state mark still
    // surface their progress.
    const explicit = stages.find((s) => s.state === 'active');
    if (explicit) return explicit;
    const withProgress = stages.find(
        (s) => (s.processed ?? 0) > 0 || (s.total ?? 0) > 0 || !!s.currentItem,
    );
    return withProgress ?? null;
}

function extractRunLabel(run: Run): string | undefined {
    // Best-effort: derive a short human label from run.input. Common shapes:
    //   { mediaItemId: '<uuid>' }       → first 8 chars of the uuid
    //   { sourceId: '<uuid>' }          → same
    //   { libraryGroupId: '<uuid>' }    → same
    //   { itemId: '<id>' }              → first 12 chars
    //   { runId: '<id>' }               → first 12 chars
    // Anything else: return undefined and let the card render just the time.
    const input = run.input;
    if (typeof input !== 'object' || input === null) return undefined;
    const obj = input as Record<string, unknown>;
    const candidates = ['mediaItemId', 'sourceId', 'itemId', 'libraryGroupId', 'runId'];
    for (const key of candidates) {
        const v = obj[key];
        if (typeof v === 'string' && v.length > 0) {
            return v.length > 12 ? v.slice(0, 12) + '…' : v;
        }
    }
    return undefined;
}
