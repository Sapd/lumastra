// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task triggers — cadence operations behind
 * `PUT/DELETE /api/v1/tasks/{taskId}/triggers`. Pause/resume is controlled
 * separately via `PUT /api/v1/tasks/{taskId}/state`; trigger writes do not resume.
 *
 * Every write recomputes `scheduler_state.next_fire_at` straight away, so the
 * task list's "Next run" and the scheduler agree the moment an operator saves
 * — a trigger moved from weekly to hourly must not wait out the old week.
 */

import type postgres from 'postgres';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import type { TaskTrigger, TaskTriggersResponse } from '$lib/schemas/task-definition.schema.js';
import { parseDurationMs } from './duration.js';
import { unitForBareNumber } from './scheduler.js';
import {
    clearTaskTriggers,
    getSchedulerState,
    listTaskTriggers,
    replaceTaskTriggers,
    setNextFireAt,
} from './scheduler-state.js';
import { computeNextFireAt, isTimed, minIntervalMs, serverTimeZone } from './triggers.js';

/**
 * Whether a task can have triggers at all and, when not, the reason the admin
 * UI shows instead of the editor. Only tasks with a static `schedule` are ever
 * fired by the scheduler; everything else runs from somewhere else.
 */
export function taskSchedulability(task: TaskDefinition): {
    schedulable: boolean;
    reason?: string;
} {
    if (task.schedule) return { schedulable: true };
    if (task.dynamicSchedule) {
        return {
            schedulable: false,
            reason: "This task's cadence is derived from per-source settings (dynamic schedule) — there is no single schedule to change.",
        };
    }
    if (task.pipeline?.of) {
        return {
            schedulable: false,
            reason: `This task runs as a stage of the '${task.pipeline.of}' pipeline — it starts when its parent completes, not on its own schedule.`,
        };
    }
    if (task.notManuallyRunnable) {
        return {
            schedulable: false,
            reason: 'This is internal plumbing with no schedule of its own.',
        };
    }
    if (task.manualOnly) {
        return {
            schedulable: false,
            reason: 'This task only runs when started manually or by another service — it has no schedule.',
        };
    }
    if (task.demo) {
        return { schedulable: false, reason: 'This is a demo/tutorial task — it has no schedule.' };
    }
    return { schedulable: false, reason: 'This task has no configured schedule.' };
}

/** The env override's value when it holds a valid duration, else undefined. */
export function activeEnvEvery(task: TaskDefinition): string | undefined {
    const name = task.schedule?.envOverride;
    if (!name) return undefined;
    const raw = process.env[name];
    if (!raw) return undefined;
    const withUnit = unitForBareNumber(name, raw);
    return parseDurationMs(withUnit) !== null ? withUnit : undefined;
}

/** The default schedule's interval: env override, else the declared `every`. */
export function defaultEvery(task: TaskDefinition): string | undefined {
    return activeEnvEvery(task) ?? task.schedule?.every;
}

async function recomputeNextFire(
    sql: postgres.Sql,
    taskId: string,
    triggers: readonly TaskTrigger[],
): Promise<void> {
    const state = await getSchedulerState(sql, taskId);
    const now = Date.now();
    const next = computeNextFireAt(triggers, now, state?.lastFiredAt?.getTime() ?? null);
    if (next !== null) await setNextFireAt(sql, taskId, new Date(next));
}

/** Store the operator's triggers (replacing any) and reschedule the next start. */
export async function saveTaskTriggers(
    sql: postgres.Sql,
    task: TaskDefinition,
    triggers: readonly TaskTrigger[],
    by: string,
): Promise<void> {
    await replaceTaskTriggers(sql, task.id, triggers, by);
    await recomputeNextFire(sql, task.id, triggers);
}

/**
 * After a resume: a task with triggers gets its next start recomputed from
 * now, so a daily/weekly time that passed while it was paused is skipped (the
 * same rule as a restart) instead of firing the moment the pause lifts.
 * Tasks on their default schedule keep the existing interval catch-up.
 */
export async function rescheduleAfterResume(
    sql: postgres.Sql,
    task: TaskDefinition,
): Promise<void> {
    const stored = await listTaskTriggers(sql, task.id);
    if (stored) await recomputeNextFire(sql, task.id, stored.triggers);
}

/** Drop the operator's triggers: the declared schedule (or its env override) applies again. */
export async function resetTaskTriggers(sql: postgres.Sql, task: TaskDefinition): Promise<void> {
    await clearTaskTriggers(sql, task.id);
    const every = defaultEvery(task);
    if (every) await recomputeNextFire(sql, task.id, [{ kind: 'interval', every }]);
}

/** The triggers state an editor needs, for GET and as every write's response. */
export async function readTaskTriggers(
    sql: postgres.Sql,
    task: TaskDefinition,
): Promise<TaskTriggersResponse> {
    const { schedulable, reason } = taskSchedulability(task);
    const [state, stored] = await Promise.all([
        getSchedulerState(sql, task.id),
        schedulable ? listTaskTriggers(sql, task.id) : Promise.resolve(null),
    ]);
    const paused = state?.paused === true;
    const base = {
        schedulable,
        reason,
        paused,
        timeZone: serverTimeZone(),
    };
    if (!schedulable) return { ...base, isDefault: true, triggers: [], nextRunAt: null };

    const envEvery = activeEnvEvery(task);
    const declaredEvery = task.schedule?.every;
    const triggers: TaskTrigger[] = stored?.triggers ?? [
        { kind: 'interval', every: envEvery ?? declaredEvery },
    ];
    // A startup-only task has no "next run" to show.
    const nextRunAt =
        paused || !state || !triggers.some(isTimed) ? null : state.nextFireAt.toISOString();

    return {
        ...base,
        isDefault: stored === null,
        triggers,
        declaredEvery,
        envOverrideVar: task.schedule?.envOverride,
        envOverrideActive: envEvery !== undefined,
        minEvery: `${Math.round(minIntervalMs(declaredEvery) / 60_000)}m`,
        nextRunAt,
        updatedBy: stored?.updatedBy ?? null,
        updatedAt: stored?.updatedAt.toISOString() ?? null,
    };
}
