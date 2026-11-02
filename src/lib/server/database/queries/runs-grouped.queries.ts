// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs Grouped Query Module
 *
 * Server-side GROUP BY aggregation over task_history. Returns one row per
 * task_id so the admin UI can show a compact per-task summary across the full
 * run history rather than a flat 10k-row wall.
 *
 * All filters are identical to the flat listRuns query so the grouped and flat
 * views stay in sync with each other.
 */

import type postgres from 'postgres';

// ── Result types ──────────────────────────────────────────────────────────────

export interface RunStateCounts {
    pending: number;
    active: number;
    cancelling: number;
    completed: number;
    failed: number;
    cancelled: number;
}

export interface LatestRunRef {
    id: string;
    state: string;
    startedAt: string;
}

export interface RunGroupedRow {
    taskId: string;
    count: number;
    stateCounts: RunStateCounts;
    latestRun: LatestRunRef;
    oldestActiveAt: string | null;
}

// ── Filter types ──────────────────────────────────────────────────────────────

export interface RunGroupedFilter {
    state?: string[];
    libraryGroupId?: string;
    since?: Date;
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Aggregate task_history by task_id. Applies the same WHERE conditions as
 * listRuns (state filter, libraryGroupId scope, optional time window via
 * `since`) so grouped and flat views reflect a consistent data slice.
 *
 * Returns rows ordered by (active/cancelling/pending first, then by latest
 * run descending) so tasks that need attention sort to the top.
 */
/**
 * When a task last COMPLETED, read from the run history.
 *
 * Not `scheduler_state.last_fired_at`. That table only has rows for tasks the
 * scheduler fires, so for a per-item, admin-triggered task it is empty by design
 * — and reading it produced the flat lie "series-sync has never run" on
 * /admin/fix/missing-episodes while series-sync was running 313 times in 12
 * hours. A task that is enqueued rather than scheduled has run history but no
 * schedule row, so run history is the only source that answers this for BOTH
 * kinds of task.
 */
export async function getLastCompletedRunAt(
    sql: postgres.Sql,
    taskId: string,
): Promise<Date | null> {
    const [row] = await sql<{ last_completed_at: Date | null }[]>`
        SELECT MAX(completed_at) AS last_completed_at
          FROM task_history
         WHERE task_id = ${taskId}
           AND state = 'completed'
    `;
    return row?.last_completed_at ?? null;
}

export async function listRunsGrouped(
    sql: postgres.Sql,
    filter: RunGroupedFilter,
): Promise<RunGroupedRow[]> {
    const states = filter.state ?? null;
    const libraryGroupId = filter.libraryGroupId ?? null;
    const since = filter.since ?? null;

    const rows = await sql<
        Array<{
            task_id: string;
            total_count: string;
            pending_count: string;
            active_count: string;
            cancelling_count: string;
            completed_count: string;
            failed_count: string;
            cancelled_count: string;
            latest_run_id: string;
            latest_run_state: string;
            latest_run_started_at: Date;
            oldest_active_at: Date | null;
        }>
    >`
        SELECT
            task_id,
            COUNT(*)                                                         AS total_count,
            COUNT(*) FILTER (WHERE state = 'pending')                        AS pending_count,
            COUNT(*) FILTER (WHERE state = 'active')                         AS active_count,
            COUNT(*) FILTER (WHERE state = 'cancelling')                     AS cancelling_count,
            COUNT(*) FILTER (WHERE state = 'completed')                      AS completed_count,
            COUNT(*) FILTER (WHERE state = 'failed')                         AS failed_count,
            COUNT(*) FILTER (WHERE state = 'cancelled')                      AS cancelled_count,
            (ARRAY_AGG(id         ORDER BY started_at DESC, id DESC))[1]     AS latest_run_id,
            (ARRAY_AGG(state      ORDER BY started_at DESC, id DESC))[1]     AS latest_run_state,
            (ARRAY_AGG(started_at ORDER BY started_at DESC, id DESC))[1]     AS latest_run_started_at,
            MIN(started_at) FILTER (WHERE state IN ('active', 'cancelling', 'pending'))
                                                                             AS oldest_active_at
        FROM task_history
        WHERE TRUE
          AND (${states}::text[] IS NULL OR state = ANY(${states}::text[]))
          AND (${libraryGroupId}::text IS NULL OR scope->>'libraryGroupId' = ${libraryGroupId}::text)
          AND (${since}::timestamptz IS NULL OR started_at >= ${since}::timestamptz)
        GROUP BY task_id
        ORDER BY
            MAX(CASE WHEN state IN ('active', 'cancelling', 'pending') THEN 1 ELSE 0 END) DESC,
            MAX(started_at) DESC
    `;

    return rows.map((r) => ({
        taskId: r.task_id,
        count: Number(r.total_count),
        stateCounts: {
            pending: Number(r.pending_count),
            active: Number(r.active_count),
            cancelling: Number(r.cancelling_count),
            completed: Number(r.completed_count),
            failed: Number(r.failed_count),
            cancelled: Number(r.cancelled_count),
        },
        latestRun: {
            id: r.latest_run_id,
            state: r.latest_run_state,
            startedAt: r.latest_run_started_at.toISOString(),
        },
        oldestActiveAt: r.oldest_active_at ? r.oldest_active_at.toISOString() : null,
    }));
}
