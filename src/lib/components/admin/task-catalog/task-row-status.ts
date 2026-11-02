// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The status of one row of the classic task list (spec 2026-09-27 §1.1/§1.2).
 *
 * "Needs attention" is the SAME predicate the system-task visibility rule and
 * the old monitoring groups use (`needsAttention`), so a row's amber icon, the
 * "Needs attention (N)" strip above the list and a hidden system task
 * resurfacing can never disagree about which tasks have a problem.
 */

import {
    needsAttention,
    type MonitoringContext,
} from '$lib/components/admin/task-dashboard/monitoring-groups.js';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';

export type TaskRowState =
    | 'problem'
    | 'running'
    | 'deferred'
    | 'queued'
    | 'in-flight'
    | 'paused'
    | 'waiting'
    | 'ok'
    | 'idle';

export interface TaskRowInput {
    /** A run of this task is live right now (run bus, or the server's lane). */
    running: boolean;
    /** A persisted pending/active/cancelling row exists without live execution proof. */
    inFlight?: boolean;
    queued?: boolean;
    deferred?: boolean;
    /** Items the task still has to process (live coverage backlog, else the server's). */
    waiting: number;
}

/**
 * Problem outranks running: a task that keeps failing while it runs again must
 * still read as failing (the progress bar shows the run regardless).
 */
export function taskRowState(
    task: TaskDefinitionSummary,
    input: TaskRowInput,
    ctx: MonitoringContext = {},
): TaskRowState {
    if (needsAttention(task, ctx)) return 'problem';
    if (input.running) return 'running';
    if (input.deferred) return 'deferred';
    if (input.queued) return 'queued';
    if (input.inFlight) return 'in-flight';
    if (task.schedulePaused === true) return 'paused';
    if (input.waiting > 0) return 'waiting';
    if (task.lastCompletedAt) return 'ok';
    return 'idle';
}

/**
 * Tasks that need attention but have no attention-board finding of their own
 * (a failed run that did not trip any finding yet). The strip lists these as
 * well so its count matches the amber rows below it one for one.
 */
export function failuresWithoutFinding(
    tasks: readonly TaskDefinitionSummary[],
    findingTaskIds: ReadonlySet<string>,
): TaskDefinitionSummary[] {
    return tasks
        .filter((t) => !findingTaskIds.has(t.id) && needsAttention(t))
        .sort((a, b) => a.name.localeCompare(b.name));
}
