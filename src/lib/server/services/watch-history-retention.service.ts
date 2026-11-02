// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WatchHistoryRetentionService — batched DELETE of watch_history rows older
 * than a configurable retention window.
 *
 * watch_history has no built-in expiry: without periodic pruning it grows
 * without bound at the rate of all user playback activity across the instance.
 * This service deletes rows whose session_start_time is older than the
 * retention window, processing them in batches to avoid long-held row locks
 * and to remain responsive to the abort signal between batches.
 *
 * The batch loop follows the same pattern as pruneUntilDrained() in
 * database-cleanup.ts: repeat until a pass deletes fewer than the batch size
 * (table is drained to the cutoff), the abort signal fires, or the runaway
 * cap is hit.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('WatchHistoryRetentionService');

// ── Types ────────────────────────────────────────────────────────────────────

export interface WatchHistoryRetentionResult {
    deleted: number;
    batches: number;
    aborted: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5_000;
const MAX_BATCHES = 1_000; // runaway guard: up to 5M rows per run

/**
 * Delete watch_history rows whose session_start_time is older than
 * `retentionDays` days. Processes in batches of 5 000 rows; honors the abort
 * signal between batches.
 *
 * @param sql        - Postgres connection (task pool).
 * @param retentionDays - Rows older than this many days are deleted.
 * @param signal     - Optional AbortSignal; when aborted the loop stops
 *                     between batches and returns with aborted=true.
 * @returns Counts of deleted rows and batch passes executed.
 */
export async function pruneWatchHistory(
    sql: postgres.Sql,
    retentionDays: number,
    signal?: AbortSignal,
): Promise<WatchHistoryRetentionResult> {
    // Safety floor: a misconfigured DB_CLEANUP_WATCH_HISTORY_DAYS of 0 or negative
    // (a raw env var bypasses the config schema's min=30 UI validation) would put
    // the cutoff at now-or-in-the-future and delete recent/all history. Refuse
    // anything below one day rather than nuke live data.
    if (!Number.isFinite(retentionDays) || retentionDays < 1) {
        log.warn('watch_history retention skipped: invalid retentionDays', {
            retentionDays,
        });
        return { deleted: 0, batches: 0, aborted: false };
    }
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    let totalDeleted = 0;
    let batches = 0;

    for (let pass = 0; pass < MAX_BATCHES; pass++) {
        if (signal?.aborted) {
            break;
        }

        const result = await sql<{ count: string }[]>`
            WITH deleted AS (
                DELETE FROM watch_history
                WHERE id IN (
                    SELECT id FROM watch_history
                    WHERE session_start_time < ${cutoff}
                    LIMIT ${BATCH_SIZE}
                )
                RETURNING 1
            )
            SELECT COUNT(*)::text AS count FROM deleted
        `;

        batches++;
        const batchDeleted = parseInt(result[0]?.count ?? '0', 10);
        totalDeleted += batchDeleted;

        if (batchDeleted < BATCH_SIZE) {
            // Fewer than a full batch means the table is drained to the cutoff.
            break;
        }
    }

    if (totalDeleted > 0) {
        log.info('watch_history retention prune completed', {
            deleted: totalDeleted,
            batches,
            retentionDays,
            cutoff: cutoff.toISOString(),
            aborted: signal?.aborted ?? false,
        });
    }

    return {
        deleted: totalDeleted,
        batches,
        aborted: signal?.aborted ?? false,
    };
}
