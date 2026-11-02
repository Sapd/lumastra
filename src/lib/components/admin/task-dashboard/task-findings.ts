// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins the attention board's open findings to the tasks they are about.
 *
 * Before this, /admin/tasks carried two unrelated "needs attention" sets: the
 * attention strip listed "Lumastra Intro Analyzer could not process 54 items"
 * while the same task's card said "Healthy & idle", and the "Needs your
 * attention (6)" chip filtered to six DIFFERENT tasks (failed + backlog). The
 * findings already name their subject in their stable id — `<kind>:<taskId>`
 * or `<kind>:<stageId>` — so the join needs no server change.
 */

import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';

/** Finding kinds whose id suffix is a task id (see services/attention/adapters.ts). */
const TASK_SCOPED = new Set(['plugin-failures', 'circuit', 'failed-run-spike', 'overdue-schedule']);

/** Finding kinds whose id suffix is a pipeline stage id, owned by the task covering it. */
const STAGE_SCOPED = new Set(['stuck-items', 'dead-letter', 'decline-loop']);

/**
 * Open findings per task id. Acknowledged and snoozed findings are left out —
 * the operator has already answered those, so they must not keep a card amber.
 */
export function findingsByTask(
    items: readonly AttentionItem[],
    tasks: readonly Pick<TaskDefinitionSummary, 'id' | 'coveredStageIds'>[],
): Map<string, AttentionItem[]> {
    const taskIds = new Set(tasks.map((t) => t.id));
    const stageOwner = new Map<string, string>();
    for (const t of tasks) {
        for (const stageId of t.coveredStageIds ?? []) stageOwner.set(stageId, t.id);
    }

    const out = new Map<string, AttentionItem[]>();
    for (const item of items) {
        if (item.acked || item.snoozed) continue;
        // Split on the FIRST colon only: stage ids may contain one
        // (`lumastra-intro-analyzer:visual`).
        const sep = item.id.indexOf(':');
        if (sep < 0) continue;
        const kind = item.id.slice(0, sep);
        const subject = item.id.slice(sep + 1);
        const taskId = TASK_SCOPED.has(kind)
            ? taskIds.has(subject)
                ? subject
                : undefined
            : STAGE_SCOPED.has(kind)
              ? stageOwner.get(subject)
              : undefined;
        if (!taskId) continue;
        const list = out.get(taskId);
        if (list) list.push(item);
        else out.set(taskId, [item]);
    }
    return out;
}
