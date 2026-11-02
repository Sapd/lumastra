// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Counters for the canonical admin status payload (admin IA redesign, spec §5).
 *
 * Pure SQL helpers consumed by admin-status-payload.service.ts. User and
 * media-item totals are NOT here — they already come from
 * system-status.queries.ts inside the nested system block (reuse, don't
 * duplicate).
 */

import type postgres from 'postgres';
import { actionableTaskFailure } from './fragments/task-failure.fragments.js';

export interface TaskCounters {
    /** Runs currently executing (active or winding down). */
    running: number;
    /** Completed runs since midnight UTC. */
    ranToday: number;
    /**
     * Actionable failed runs in the last 24 h — the SAME predicate the
     * failed-run-spike attention source uses (fragments/task-failure), so the
     * stat can never contradict the alerts ("0 failed in 24h" bug class).
     */
    failedRuns24h: number;
}

/** One round-trip for all three task counters. */
export async function getTaskCounters(sql: postgres.Sql): Promise<TaskCounters> {
    const [row] = await sql<
        [{ running: number; ran_today: number; failed_24h: number } | undefined]
    >`
        SELECT
            (SELECT COUNT(*)::int FROM task_history
              WHERE state IN ('active', 'cancelling')) AS running,
            (SELECT COUNT(*)::int FROM task_history
              WHERE state = 'completed'
                AND completed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            ) AS ran_today,
            (SELECT COUNT(*)::int FROM task_history
              WHERE ${actionableTaskFailure(sql)}) AS failed_24h
    `;
    return {
        running: row?.running ?? 0,
        ranToday: row?.ran_today ?? 0,
        failedRuns24h: row?.failed_24h ?? 0,
    };
}

/** Total library size in bytes (sum of all scanned media files). */
export async function getLibraryTotalSizeBytes(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<[{ total: string } | undefined]>`
        SELECT COALESCE(SUM(file_size_bytes), 0)::text AS total
        FROM media_files
    `;
    const n = Number(row?.total ?? 0);
    return Number.isFinite(n) ? n : 0;
}
