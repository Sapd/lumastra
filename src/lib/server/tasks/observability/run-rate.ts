// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Schedule-adherence / over-firing detection.
 *
 * WHY THIS EXISTS — the mdblist quota incident (2026-07). `mdblist-sync` declares
 * `schedule.every = '12h'` (2 runs/day) but actually ran **1,037×/day** because a
 * stuck coverage backlog made `stage-sweep` re-enqueue it every 60s. It exhausted
 * the MDBList daily API quota for a week, and NOTHING surfaced it: the cost page
 * showed request counts but never compared them to the task's own declared
 * cadence, the "overdue" detector only catches tasks firing too LATE, and the
 * `dormant-stage-with-backlog` invariant only trips above 1,000 pending rows
 * (the incident sat at 828).
 *
 * This computes, per task: runs in the last 24h, the runs/day its own
 * `schedule.every` implies, the ratio between them, and — for coverage tasks —
 * the sweepable backlog driving the sweep. A task firing far above its declared
 * cadence is the signal every prior surface missed.
 */

import type postgres from 'postgres';
import { getRegistry } from '../registry.js';
import { parseDurationMs } from '../duration.js';
import { listRunsGrouped } from '$lib/server/database/queries/runs-grouped.queries.js';
import {
    countSweepBacklog,
    BACKLOG_COUNT_CEILING,
} from '$lib/server/database/queries/stage-sweep.queries.js';

/** ratio ≥ this ⇒ alert (red). mdblist ran ~518× its schedule. */
const ALERT_RATIO = 3;
/** ratio ≥ this ⇒ warn (amber). */
const WARN_RATIO = 1.5;
/** A schedule-less task (admin-triggered only) firing at least this many times
 * in 24h is anomalous — it's being driven by the sweep, not by an operator. */
const NO_SCHEDULE_ALERT_RUNS = 100;

const DAY_MS = 86_400_000;

export type RunRateSeverity = 'ok' | 'warn' | 'alert';

export interface TaskRunRateRow {
    taskId: string;
    taskName: string;
    /** Declared cadence, e.g. '12h'. null when the task has no `schedule`. */
    scheduleEvery: string | null;
    /** 86400s / every. null when there is no schedule. */
    expectedPerDay: number | null;
    runs24h: number;
    /** runs24h / expectedPerDay. null when there is no schedule to compare to. */
    ratio: number | null;
    /** Sweepable backlog across this task's enqueueable coverage stages. null if
     * the task drives no coverage stage. A value at the ceiling means "≥ that". */
    backlog: number | null;
    backlogAtCeiling: boolean;
    severity: RunRateSeverity;
}

function severityFor(
    ratio: number | null,
    expectedPerDay: number | null,
    runs24h: number,
    scheduleUnparseable: boolean,
): RunRateSeverity {
    // A `schedule.every` string that won't parse means the panel can't compute a
    // cadence at all — the exact case (a typo'd interval) that would silently mask
    // over-firing. Flag it: alert if it's actively firing, warn otherwise.
    if (scheduleUnparseable) return runs24h > 0 ? 'alert' : 'warn';
    if (ratio !== null) {
        if (ratio >= ALERT_RATIO) return 'alert';
        if (ratio >= WARN_RATIO) return 'warn';
        return 'ok';
    }
    // No schedule: the task should only run when an operator triggers it, so
    // sweep-driven volume is itself the anomaly.
    if (expectedPerDay === null && runs24h >= NO_SCHEDULE_ALERT_RUNS) return 'alert';
    return 'ok';
}

/**
 * Compute per-task run-rate rows, newest-window (24h) runs vs declared cadence.
 * Only tasks that ran in the window OR drive a coverage stage are returned, so
 * the panel stays focused on live behaviour rather than the full registry.
 *
 * Fail-soft: a backlog probe that errors leaves `backlog: null` for that task
 * rather than failing the whole page.
 */
export async function computeTaskRunRates(sql: postgres.Sql): Promise<TaskRunRateRow[]> {
    const since = new Date(Date.now() - DAY_MS);
    const grouped = await listRunsGrouped(sql, { since });
    const runsByTask = new Map<string, number>();
    for (const g of grouped) runsByTask.set(g.taskId, g.count);

    const registry = getRegistry();
    const rows: TaskRunRateRow[] = [];

    for (const task of registry.getAllTasks()) {
        const runs24h = runsByTask.get(task.id) ?? 0;

        // Enqueueable coverage stages this task drives — the sweep's re-fire
        // target. Deduped: a task may (mistakenly) list a stage id twice, which
        // would otherwise double-count its backlog below.
        const enqueueableStages = [
            ...new Set(
                (task.coversStages ?? []).filter((s) => s.enqueueable === true).map((s) => s.id),
            ),
        ];

        // Skip tasks that neither ran nor drive coverage — nothing to say.
        if (runs24h === 0 && enqueueableStages.length === 0) continue;

        const scheduleEvery = task.schedule?.every ?? null;
        const everyMs = scheduleEvery ? parseDurationMs(scheduleEvery) : null;
        // Present-but-unparseable is a config bug, distinct from "no schedule".
        const scheduleUnparseable = scheduleEvery !== null && (everyMs === null || everyMs <= 0);
        const expectedPerDay =
            everyMs && everyMs > 0 ? Math.max(1, Math.round(DAY_MS / everyMs)) : null;
        const ratio = expectedPerDay !== null ? runs24h / expectedPerDay : null;

        let backlog: number | null = null;
        let backlogAtCeiling = false;
        if (enqueueableStages.length > 0) {
            backlog = 0;
            for (const stageId of enqueueableStages) {
                try {
                    const n = await countSweepBacklog(sql, stageId);
                    backlog += n;
                    if (n >= BACKLOG_COUNT_CEILING) backlogAtCeiling = true;
                } catch {
                    // Fail-soft — a probe failure must not blank the whole page.
                }
            }
        }

        rows.push({
            taskId: task.id,
            taskName: task.name ?? task.id,
            scheduleEvery: task.schedule?.every ?? null,
            expectedPerDay,
            runs24h,
            ratio,
            backlog,
            backlogAtCeiling,
            severity: severityFor(ratio, expectedPerDay, runs24h, scheduleUnparseable),
        });
    }

    // Most anomalous first: alerts, then warns, then by raw run volume.
    const rank: Record<RunRateSeverity, number> = { alert: 0, warn: 1, ok: 2 };
    rows.sort((a, b) => rank[a.severity] - rank[b.severity] || b.runs24h - a.runs24h);
    return rows;
}
