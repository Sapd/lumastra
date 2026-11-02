// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// queue-journal-janitor.ts — keeps the queue-operation journal observable and
// removes leftovers of the old unmanaged journaling path.
//
// Unmanaged task mode (the only production mode) no longer journals queue
// writes. Rows with no owner (generation IS NULL AND owner_id IS NULL) can only
// come from older builds; while no `tasks` authority row exists nothing reads
// them except first-management initialization, which they would block forever.
// Managed rows are never deleted here: an unknown queue outcome needs explicit
// reconciliation, so they are only reported.

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { TASK_AUTHORITY_PARTITION } from '../../../task-runtime/authority/store.js';
import { taskQueueJournalOldestPendingSeconds, taskQueueJournalPending } from './metrics.js';

const log = Logger.for('QueueJournalJanitor');

export const QUEUE_JOURNAL_STALE_MS = 10 * 60_000;

export interface QueueJournalSweepResult {
    pending: number;
    oldestPendingSeconds: number;
    unmanagedDeleted: number;
    staleManaged: number;
}

/** Cheap (partial-index backed) and never throws: a failure is logged. */
export async function sweepQueueOperationJournal(
    sql: postgres.Sql,
    staleMs: number = QUEUE_JOURNAL_STALE_MS,
): Promise<QueueJournalSweepResult | null> {
    try {
        const deleted = await sql`DELETE FROM task_runtime_queue_operations
            WHERE partition = ${TASK_AUTHORITY_PARTITION} AND state = 'pending'
                AND generation IS NULL AND owner_id IS NULL
                AND created_at < clock_timestamp() - ${staleMs} * interval '1 millisecond'
                AND NOT EXISTS (SELECT 1 FROM task_runtime_authorities
                    WHERE partition = ${TASK_AUTHORITY_PARTITION})
            RETURNING operation_id`;
        const [stats] = await sql<
            { pending: number; oldest_seconds: number; stale_managed: number }[]
        >`SELECT count(*)::integer AS pending,
                COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - min(created_at)), 0)::float8
                    AS oldest_seconds,
                (count(*) FILTER (WHERE generation IS NOT NULL
                    AND created_at < clock_timestamp() - ${staleMs} * interval '1 millisecond'))::integer
                    AS stale_managed
            FROM task_runtime_queue_operations
            WHERE partition = ${TASK_AUTHORITY_PARTITION} AND state = 'pending'`;
        const result: QueueJournalSweepResult = {
            pending: stats.pending,
            oldestPendingSeconds: stats.oldest_seconds,
            unmanagedDeleted: deleted.length,
            staleManaged: stats.stale_managed,
        };
        taskQueueJournalPending.set(result.pending);
        taskQueueJournalOldestPendingSeconds.set(result.oldestPendingSeconds);
        if (result.unmanagedDeleted > 0)
            log.info('Removed stale unmanaged queue-journal rows', {
                count: result.unmanagedDeleted,
            });
        if (result.staleManaged > 0)
            log.warn('Managed queue operations pending past the stale threshold need reconciliation', {
                count: result.staleManaged,
                oldestPendingSeconds: result.oldestPendingSeconds,
            });
        return result;
    } catch (err) {
        log.warn('Queue journal sweep failed', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
