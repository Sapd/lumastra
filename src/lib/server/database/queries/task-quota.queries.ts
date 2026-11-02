// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

// Durable, eviction-proof daily-run quota enforcement (TASK-C4).
//
// The previous implementation stored the per-task daily run counter in a Valkey
// key (`task:quota:<taskId>:<day>`) with a 48h TTL. Under any eviction policy
// other than `noeviction` (the shipped compose used `volatile-lru`, the audited
// risk was `allkeys-lru`) that TTL'd key is an eviction candidate under memory
// pressure — once evicted the counter resets to zero and `maxRunsPerDay` is
// silently bypassed. Quota enforcement was therefore hollow exactly when it
// matters most (a runaway task flooding the queue raises memory pressure, which
// evicts the very counter meant to stop it).
//
// Postgres is the source of truth for the run record anyway (task_history is
// inserted right after this check), so the daily counter lives in the
// pre-existing `task_quota_usage` table. The cap is enforced atomically inside
// a single INSERT ... ON CONFLICT DO UPDATE ... WHERE statement: the row is only
// incremented when it is still below the cap, and the absence of a RETURNING row
// signals "would exceed cap". No read-modify-write window, no eviction.

// `task_quota_usage.tenant_id` is `NOT NULL` and part of the primary key
// `(task_id, tenant_id, day)`, so a global (non-tenanted) quota needs a stable
// sentinel rather than NULL. The all-zero UUID is reserved for "global / no
// tenant"; a real multi-tenant rollout would pass an actual tenant UUID here.
const GLOBAL_TENANT = '00000000-0000-0000-0000-000000000000';

function todayUTC(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Atomically reserve one slot in today's daily-run quota for `taskId`.
 *
 * Enforces `cap` (= `maxRunsPerDay`) transactionally:
 *  - inserts today's row at runs=1 when none exists, or
 *  - increments the existing row by 1 only while `runs < cap`.
 *
 * Returns `{ acquired: true, runs }` when a slot was reserved (caller may
 * proceed), or `{ acquired: false }` when the cap is already reached (caller
 * must reject the run). On the acquired path the caller MUST call
 * `releaseDailyQuotaSlot` if any later step in `startRun` fails, so the counter
 * stays accurate.
 *
 * `cap` must be > 0; callers should not invoke this for tasks without a quota.
 */
export async function acquireDailyQuotaSlot(
    sql: postgres.Sql,
    taskId: string,
    cap: number,
): Promise<{ acquired: boolean; runs: number; day: string }> {
    // Capture the UTC day once and return it so the matching release targets the
    // SAME bucket. Without this, a run that reserves a slot just before UTC
    // midnight and rolls back just after would release against the new day's
    // (absent) row, leaking +1 in the prior day's bucket (TASK-C4).
    const day = todayUTC();
    const rows = await sql<{ runs: number }[]>`
        INSERT INTO task_quota_usage (task_id, tenant_id, day, runs)
        VALUES (${taskId}, ${GLOBAL_TENANT}, ${day}, 1)
        ON CONFLICT (task_id, tenant_id, day) DO UPDATE
            SET runs = task_quota_usage.runs + 1
            WHERE task_quota_usage.runs < ${cap}
        RETURNING runs
    `;
    // ON CONFLICT ... WHERE that filters out the UPDATE returns zero rows when
    // the predicate is false (cap already reached): that is the over-cap signal.
    const reserved = rows[0];
    if (!reserved) return { acquired: false, runs: cap, day };
    return { acquired: true, runs: reserved.runs, day };
}

/**
 * Release a previously-acquired daily quota slot for `taskId`.
 *
 * Used to roll back the increment from `acquireDailyQuotaSlot` when a later step
 * in `startRun` fails after the slot was reserved. Clamps at zero so a stray
 * double-release can never push the counter negative (which would let a future
 * run squeeze past the cap). No-ops when the target row is absent.
 *
 * Pass the `day` returned by the paired `acquireDailyQuotaSlot` so the release
 * targets the same bucket even when the UTC day rolls over between acquire and
 * release (TASK-C4). Defaults to today's bucket when omitted.
 */
export async function releaseDailyQuotaSlot(
    sql: postgres.Sql,
    taskId: string,
    day: string = todayUTC(),
): Promise<void> {
    await sql`
        UPDATE task_quota_usage
        SET runs = GREATEST(runs - 1, 0)
        WHERE task_id = ${taskId}
          AND tenant_id = ${GLOBAL_TENANT}
          AND day = ${day}
    `;
}
