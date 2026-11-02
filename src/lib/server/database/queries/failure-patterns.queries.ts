// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { reviewedDurationFailureSql } from './file-health-review.queries.js';

/**
 * Failure-pattern source queries (Slice 3 §4.1).
 *
 * Return BOUNDED raw failure rows over an indexed recent window — the service
 * layer (`failure-patterns.service.ts`) normalizes + hashes + groups them into
 * `FailurePattern[]`. There is NO persisted fingerprint and NO rollup table; the
 * grouping is computed on read. The hard `LIMIT` keeps a pathological window
 * from ever returning the whole table.
 *
 * Each function takes `sql: postgres.Sql` first and has no side effects.
 */

import type postgres from 'postgres';
import { currentAnalyzerFailurePredicate } from './media-segment-input.queries.js';

/** Hard cap on raw rows scanned per source per window. */
export const RAW_ROW_LIMIT = 5000;

export interface RawRunFailureRow {
    taskId: string;
    message: string;
    kind: string | null;
    completedAt: Date;
}

export interface RawItemFailureRow {
    taskId: string; // plugin_id — the closest "task" grouping for item failures
    message: string;
    occurredAt: Date;
}

/**
 * Run-level failures from `task_history` over the last `sinceHours`. `state IN
 * ('failed','cancelled')`, indexed on `completed_at`. Returns the raw
 * `error->>'message'` + `error->>'kind'` for read-time fingerprinting.
 */
export async function listRunFailureRows(
    sql: postgres.Sql,
    { sinceHours, taskId }: { sinceHours: number; taskId?: string },
): Promise<RawRunFailureRow[]> {
    const rows = await sql<
        Array<{
            task_id: string;
            message: string | null;
            kind: string | null;
            completed_at: Date;
        }>
    >`
        SELECT
            th.task_id,
            th.error->>'message' AS message,
            th.error->>'kind'    AS kind,
            th.completed_at
        FROM task_history th
        WHERE th.state IN ('failed', 'cancelled')
          AND th.error IS NOT NULL
          AND th.completed_at >= NOW() - (${sinceHours} || ' hours')::interval
          AND ${taskId ? sql`th.task_id = ${taskId}` : sql`TRUE`}
        ORDER BY th.completed_at DESC
        LIMIT ${RAW_ROW_LIMIT}
    `;
    return rows
        .filter((r) => r.message != null && r.message !== '')
        .map((r) => ({
            taskId: r.task_id,
            message: r.message as string,
            kind: r.kind,
            completedAt: r.completed_at,
        }));
}

/**
 * Item-level failures from `plugin_failure_events` over the last `sinceHours`.
 * Only unresolved (`resolved_at IS NULL`) rows — those still actionable.
 * `reason` is already capped at 500 chars at write time.
 */
export async function listItemFailureRows(
    sql: postgres.Sql,
    { sinceHours, taskId }: { sinceHours: number; taskId?: string },
): Promise<RawItemFailureRow[]> {
    const rows = await sql<
        Array<{
            plugin_id: string;
            reason: string | null;
            occurred_at: Date;
        }>
    >`
        SELECT pfe.plugin_id, pfe.reason, pfe.occurred_at
        FROM plugin_failure_events pfe
        WHERE pfe.resolved_at IS NULL
          AND NOT (pfe.plugin_id = 'media-probe' AND ${reviewedDurationFailureSql(sql, sql`pfe.item_id`, sql`pfe.reason`)})
          ${currentAnalyzerFailurePredicate(sql, 'pfe')}
          AND pfe.occurred_at >= NOW() - (${sinceHours} || ' hours')::interval
          AND ${taskId ? sql`pfe.plugin_id = ${taskId}` : sql`TRUE`}
        ORDER BY pfe.occurred_at DESC
        LIMIT ${RAW_ROW_LIMIT}
    `;
    return rows
        .filter((r) => r.reason != null && r.reason !== '')
        .map((r) => ({
            taskId: r.plugin_id,
            message: r.reason as string,
            occurredAt: r.occurred_at,
        }));
}

/** One failed task run, trimmed to what a diagnostics bundle needs. */
export interface RecentRunFailureRow {
    taskId: string;
    message: string;
    kind: string | null;
    completedAt: Date;
}

/**
 * The most recent failed task runs, newest first — the task leg of the instance
 * diagnostics bundle.
 *
 * Distinct from {@link listRunFailureRows}, which scans a whole time window up
 * to `RAW_ROW_LIMIT` (5000) rows because its consumer fingerprints and GROUPS
 * them. The bundle only ever renders a few dozen lines, so it takes a hard
 * `LIMIT` instead of a window and never pulls thousands of rows it will drop.
 */
export async function listRecentRunFailures(
    sql: postgres.Sql,
    limit: number,
): Promise<RecentRunFailureRow[]> {
    const rows = await sql<
        Array<{
            task_id: string;
            message: string | null;
            kind: string | null;
            completed_at: Date;
        }>
    >`
        SELECT
            th.task_id,
            th.error->>'message' AS message,
            th.error->>'kind'    AS kind,
            th.completed_at
        FROM task_history th
        WHERE th.state IN ('failed', 'cancelled')
          AND th.error IS NOT NULL
          AND th.completed_at IS NOT NULL
        ORDER BY th.completed_at DESC
        LIMIT ${limit}
    `;
    return rows
        .filter((r) => r.message != null && r.message !== '')
        .map((r) => ({
            taskId: r.task_id,
            message: r.message as string,
            kind: r.kind,
            completedAt: r.completed_at,
        }));
}
