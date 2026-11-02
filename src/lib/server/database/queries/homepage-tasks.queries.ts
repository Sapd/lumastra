// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * Task-run counts for the Homepage integration endpoint. Exact counts — the run
 * LIST shown next to them is capped, these numbers are not. Both predicates are
 * served by partial indexes (idx_task_history_state, idx_task_history_task_failed_completed).
 */
export interface HomepageTaskCounts {
    /** Runs active or cancelling right now. */
    running: number;
    /** Runs that ended in `failed` during the last 24 hours (by completion time). */
    failed24h: number;
}

export async function getHomepageTaskCounts(sql: postgres.Sql): Promise<HomepageTaskCounts> {
    const rows = await sql<HomepageTaskCounts[]>`
        SELECT
            (SELECT COUNT(*)::int FROM task_history
              WHERE state IN ('active', 'cancelling')) AS running,
            (SELECT COUNT(*)::int FROM task_history
              WHERE state = 'failed' AND completed_at >= now() - interval '24 hours') AS "failed24h"
    `;
    return rows[0] ?? { running: 0, failed24h: 0 };
}
