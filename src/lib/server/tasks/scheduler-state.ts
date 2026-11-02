// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// scheduler_state table queries — last_fired_at persistence for the scheduler subsystem.
// Pure SQL query module; no side effects.

import type postgres from 'postgres';
import type { TaskTrigger } from '$lib/schemas/task-definition.schema.js';

export interface SchedulerState {
    taskId: string;
    lastFiredAt: Date | null;
    nextFireAt: Date;
    paused: boolean;
    pausedBy: string | null;
    pausedAt: Date | null;
}

interface SchedulerStateRow {
    task_id: string;
    last_fired_at: Date | null;
    next_fire_at: Date;
    paused: boolean;
    paused_by: string | null;
    paused_at: Date | null;
}

function rowToState(row: SchedulerStateRow): SchedulerState {
    return {
        taskId: row.task_id,
        lastFiredAt: row.last_fired_at,
        nextFireAt: row.next_fire_at,
        paused: row.paused,
        pausedBy: row.paused_by,
        pausedAt: row.paused_at,
    };
}

export async function getSchedulerState(
    sql: postgres.Sql,
    taskId: string,
): Promise<SchedulerState | null> {
    const rows = await sql<SchedulerStateRow[]>`
        SELECT task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at
        FROM scheduler_state
        WHERE task_id = ${taskId}
        LIMIT 1
    `;
    return rows.length > 0 ? rowToState(rows[0]) : null;
}

export async function upsertSchedulerState(
    sql: postgres.Sql,
    state: SchedulerState,
): Promise<void> {
    await sql`
        INSERT INTO scheduler_state (task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at)
        VALUES (
            ${state.taskId},
            ${state.lastFiredAt},
            ${state.nextFireAt},
            ${state.paused},
            ${state.pausedBy},
            ${state.pausedAt}
        )
        ON CONFLICT (task_id) DO UPDATE SET
            last_fired_at = EXCLUDED.last_fired_at,
            next_fire_at  = EXCLUDED.next_fire_at,
            paused        = EXCLUDED.paused,
            paused_by     = EXCLUDED.paused_by,
            paused_at     = EXCLUDED.paused_at
    `;
}

/**
 * Seed a scheduler_state row ONLY if one does not already exist, then return the
 * PERSISTED row — the one that actually won, not the caller's proposed values.
 *
 * This is the convergence primitive for the first-fire (runOnStartup, no prior
 * state) path. Two clock-skewed replicas booting together can compute DIFFERENT
 * bucket-aligned anchors when `now` straddles a bucket boundary. A blind
 * last-writer-wins upsert lets each fire on its OWN anchor, producing different
 * `sched:<id>:<anchor>` idempotency keys that the DB partial-unique index cannot
 * collapse — a double-fire. Doing `INSERT ... ON CONFLICT DO NOTHING` and then
 * reading back the surviving row makes every replica agree on ONE anchor
 * (whichever insert landed first), so they build an identical key and dedup.
 */
export async function seedSchedulerStateIfAbsent(
    sql: postgres.Sql,
    state: SchedulerState,
): Promise<SchedulerState> {
    const rows = await sql<SchedulerStateRow[]>`
        INSERT INTO scheduler_state (task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at)
        VALUES (
            ${state.taskId},
            ${state.lastFiredAt},
            ${state.nextFireAt},
            ${state.paused},
            ${state.pausedBy},
            ${state.pausedAt}
        )
        ON CONFLICT (task_id) DO NOTHING
        RETURNING task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at
    `;
    if (rows.length > 0) {
        // Our INSERT landed — no pre-existing row. Our anchor is the winner.
        return rowToState(rows[0]);
    }
    // Conflict: another replica (or a prior boot) already seeded the row.
    // Re-read so we converge on the persisted anchor instead of our local one.
    const existing = await getSchedulerState(sql, state.taskId);
    // Defensive fallback for the vanishingly unlikely delete-between-insert-and-
    // read race: degrade to the local proposal rather than throwing.
    return existing ?? state;
}

export async function listAllScheduledTasks(sql: postgres.Sql): Promise<SchedulerState[]> {
    const rows = await sql<SchedulerStateRow[]>`
        SELECT task_id, last_fired_at, next_fire_at, paused, paused_by, paused_at
        FROM scheduler_state
        ORDER BY task_id
    `;
    return rows.map(rowToState);
}

export async function pauseTask(sql: postgres.Sql, taskId: string, by: string): Promise<void> {
    await sql`
        INSERT INTO scheduler_state (task_id, next_fire_at, paused, paused_by, paused_at)
        VALUES (${taskId}, NOW(), true, ${by}, NOW())
        ON CONFLICT (task_id) DO UPDATE SET
            paused    = true,
            paused_by = ${by},
            paused_at = NOW()
    `;
}

export async function resumeTask(sql: postgres.Sql, taskId: string): Promise<void> {
    await sql`
        UPDATE scheduler_state
        SET paused    = false,
            paused_by = NULL,
            paused_at = NULL
        WHERE task_id = ${taskId}
    `;
}

// ── Task triggers (operator-set, admin UI) ──────────────────────────────────
//
// `task_triggers` (migration 16.272.0) replaces the old preset override that
// lived in `plugin_settings` under `sched-override:<taskId>`; the migration
// moved every such row in as an interval trigger. No rows ⇒ the task's
// declared schedule applies. See `triggers.ts` for the time arithmetic.

export interface StoredTaskTriggers {
    triggers: TaskTrigger[];
    updatedBy: string;
    updatedAt: Date;
}

interface TaskTriggerRow {
    task_id: string;
    kind: TaskTrigger['kind'];
    every: string | null;
    at: string | null;
    weekday: number | null;
    created_by: string;
    created_at: Date;
}

function rowToTrigger(row: TaskTriggerRow): TaskTrigger {
    const t: TaskTrigger = { kind: row.kind };
    if (row.every !== null) t.every = row.every;
    if (row.at !== null) t.at = row.at;
    if (row.weekday !== null) t.weekday = row.weekday;
    return t;
}

function groupTriggerRows(rows: TaskTriggerRow[]): Map<string, StoredTaskTriggers> {
    const out = new Map<string, StoredTaskTriggers>();
    for (const row of rows) {
        const entry = out.get(row.task_id);
        if (entry) {
            entry.triggers.push(rowToTrigger(row));
            if (row.created_at > entry.updatedAt) {
                entry.updatedAt = row.created_at;
                entry.updatedBy = row.created_by;
            }
        } else {
            out.set(row.task_id, {
                triggers: [rowToTrigger(row)],
                updatedBy: row.created_by,
                updatedAt: row.created_at,
            });
        }
    }
    return out;
}

export async function listTaskTriggers(
    sql: postgres.Sql,
    taskId: string,
): Promise<StoredTaskTriggers | null> {
    const rows = await sql<TaskTriggerRow[]>`
        SELECT task_id, kind, every, at, weekday, created_by, created_at
        FROM task_triggers
        WHERE task_id = ${taskId}
        ORDER BY position, created_at
    `;
    return groupTriggerRows(rows).get(taskId) ?? null;
}

/**
 * Every task's triggers in one query, keyed by task id — the scheduler reads
 * this once per tick and the task list once per request, instead of one query
 * per task.
 */
export async function listAllTaskTriggers(
    sql: postgres.Sql,
): Promise<Map<string, StoredTaskTriggers>> {
    const rows = await sql<TaskTriggerRow[]>`
        SELECT task_id, kind, every, at, weekday, created_by, created_at
        FROM task_triggers
        ORDER BY task_id, position, created_at
    `;
    return groupTriggerRows(rows);
}

/** Replace all of a task's triggers atomically (a reader never sees a half-written set). */
export async function replaceTaskTriggers(
    sql: postgres.Sql,
    taskId: string,
    triggers: readonly TaskTrigger[],
    createdBy: string,
): Promise<void> {
    await sql.begin(async (tx) => {
        await tx`DELETE FROM task_triggers WHERE task_id = ${taskId}`;
        let position = 0;
        for (const t of triggers) {
            await tx`
                INSERT INTO task_triggers (task_id, position, kind, every, at, weekday, created_by)
                VALUES (
                    ${taskId}, ${position++}, ${t.kind},
                    ${t.kind === 'interval' ? (t.every ?? null) : null},
                    ${t.kind === 'daily' || t.kind === 'weekly' ? (t.at ?? null) : null},
                    ${t.kind === 'weekly' ? (t.weekday ?? null) : null},
                    ${createdBy}
                )
            `;
        }
    });
}

export async function clearTaskTriggers(sql: postgres.Sql, taskId: string): Promise<void> {
    await sql`DELETE FROM task_triggers WHERE task_id = ${taskId}`;
}

/**
 * Point `next_fire_at` at a recomputed instant after the operator changed a
 * task's triggers (or after boot, to skip time-of-day triggers missed while
 * the server was down). Keeps `last_fired_at` and the pause switch as they
 * are; creates the row when the task has never been scheduled.
 */
export async function setNextFireAt(
    sql: postgres.Sql,
    taskId: string,
    nextFireAt: Date,
): Promise<void> {
    await sql`
        INSERT INTO scheduler_state (task_id, next_fire_at, paused)
        VALUES (${taskId}, ${nextFireAt}, false)
        ON CONFLICT (task_id) DO UPDATE SET next_fire_at = EXCLUDED.next_fire_at
    `;
}
