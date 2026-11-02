// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';

export interface MonitoringContext {
    /** Tasks with open (unacknowledged, unsnoozed) attention findings. */
    findingTaskIds?: ReadonlySet<string>;
}

/**
 * The ONE definition of "needs attention" on /admin/tasks: a recent failure,
 * an open circuit (the server folds it into the `failed` lane), or an open
 * finding on the attention board. The row icon, the "Needs attention" box and
 * the system-task visibility rule all read this, so they can never disagree.
 *
 * Pending backlog is deliberately NOT attention — work waiting its turn is
 * the normal state of a busy pipeline.
 */
export function needsAttention(task: TaskDefinitionSummary, ctx: MonitoringContext = {}): boolean {
    return (
        task.lane === 'failed' ||
        (task.recentFailCount ?? 0) > 0 ||
        ctx.findingTaskIds?.has(task.id) === true
    );
}
