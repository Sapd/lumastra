// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// schedule-overdue.ts — schedule countdown + overdue detection (Slice 1).
//
// PURE projection over the already-persisted `scheduler_state` rows
// (`listAllScheduledTasks(sql)`). No I/O, no new write — fully unit-testable.
//
// Overdue is grace-banded: a non-paused task is overdue only once
// `now > next_fire_at + grace`. The grace tolerates the 10s scheduler tick,
// brief leader handoff, and minor NTP skew (see slice-1 spec §4.4 + the NTP
// caveat in tasks/CLAUDE.md). Paused tasks are NEVER overdue.

import type { SchedulerState } from '$lib/server/tasks/scheduler-state.js';
import type { ScheduleOverdueView } from '$lib/schemas/task-system-health.schema.js';

/**
 * Overdue grace window. The scheduler ticks every 10s and advances
 * `next_fire_at` only after `startRun` returns; a leader handoff or a busy tick
 * can legitimately delay a fire by tens of seconds. 60s tolerates that plus
 * minor clock skew without false "overdue" alarms.
 */
export const SCHEDULE_OVERDUE_GRACE_MS = 60_000;

/**
 * Below this remaining leader-lock TTL we flag a possible flap (leader locks
 * renew every 2s on a 5s TTL; a remaining TTL under one renewal interval means
 * the holder missed at least one renew).
 */
export const LEADER_TTL_WARN_MS = 2_000;

/**
 * Project `scheduler_state` rows into countdown / overdue views.
 *
 * @param states                 Rows from `listAllScheduledTasks(sql)`.
 * @param now                    `Date.now()` (injected for deterministic tests).
 * @param graceMs                Overdue grace window (default SCHEDULE_OVERDUE_GRACE_MS).
 * @param resourceClassByTaskId  Optional map taskId → resourceClass (from the
 *                               registry). Missing entries surface as `null`.
 * @param scheduledTaskIds       Optional set of task ids that currently declare a
 *                               schedule (from the registry). When provided, rows
 *                               whose task id is NOT in the set are ORPHANS — a
 *                               task that was renamed/removed or dropped its
 *                               `schedule` leaves a stale `scheduler_state` row
 *                               whose `next_fire_at` never advances and would
 *                               otherwise report overdue forever (phantom
 *                               DEGRADED). Such rows are dropped from the view.
 *                               Fail OPEN: when the set is `undefined` (registry
 *                               not populated in this process) no filtering
 *                               happens, so a genuine overdue is never silently
 *                               suppressed.
 */
export function computeScheduleOverdue(
    states: SchedulerState[],
    now: number,
    graceMs: number = SCHEDULE_OVERDUE_GRACE_MS,
    resourceClassByTaskId?: ReadonlyMap<string, string>,
    scheduledTaskIds?: ReadonlySet<string>,
): ScheduleOverdueView[] {
    const live = scheduledTaskIds ? states.filter((s) => scheduledTaskIds.has(s.taskId)) : states;
    return live.map((s): ScheduleOverdueView => {
        const nextFireMs = s.nextFireAt.getTime();
        const overdueByMs = Math.max(0, now - nextFireMs - graceMs);
        const countdownMs = Math.max(0, nextFireMs - now);
        const overdue = overdueByMs > 0 && !s.paused;
        return {
            taskId: s.taskId,
            resourceClass: resourceClassByTaskId?.get(s.taskId) ?? null,
            nextFireAt: s.nextFireAt.toISOString(),
            lastFiredAt: s.lastFiredAt ? s.lastFiredAt.toISOString() : null,
            paused: s.paused,
            overdueByMs,
            countdownMs,
            overdue,
        };
    });
}
