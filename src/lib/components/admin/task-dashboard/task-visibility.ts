// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which tasks the admin task list shows (spec 2026-09-27 §1.3).
 *
 * Internal machinery (`visibility: 'system'` — sweepers, reapers, retention
 * jobs, monitors) is hidden unless the operator turns on "Show system tasks".
 * A hidden task that needs attention or whose schedule was paused is listed
 * anyway: hiding may never hide a problem.
 */

import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
import { needsAttention, type MonitoringContext } from './monitoring-groups.js';

export function isListedTask(
    task: TaskDefinitionSummary,
    showSystem: boolean,
    ctx: MonitoringContext = {},
): boolean {
    if (task.visibility !== 'system' || showSystem) return true;
    return needsAttention(task, ctx) || task.schedulePaused === true;
}
