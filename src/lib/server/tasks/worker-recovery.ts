// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { Queue } from 'bullmq';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import { withTaskQueueWrite } from '../../../task-runtime/authority/queue-write.js';
import { requireClient } from './valkey-types.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('WorkerRecovery');

/**
 * Startup-only: the caller holds the dedicated worker singleton lease and has
 * not started consumers. Lease expiry alone does not prove the old executor
 * stopped: live BullMQ locks and fresh PG heartbeats forbid forced recovery.
 * Keep the job/run/identity together; creating another run could duplicate work.
 * Every step can be repeated if startup itself is interrupted.
 */
export async function requeueInterruptedWorkerRuns(
    sql: postgres.Sql,
    queues: Iterable<Queue>,
    assertLeaseHeld: () => void,
    authority?: AuthorityToken,
): Promise<string[]> {
    const recovered: string[] = [];
    const deadline = Date.now() + 10_000;
    let inspected = 0;
    for (const queue of queues) {
        assertLeaseHeld();
        if (Date.now() >= deadline || inspected >= 1000) break;
        for (const job of await queue.getActive(0, 99)) {
            if (Date.now() >= deadline || ++inspected > 1000) return recovered;
            const runId: unknown = (job.data as { runId?: unknown }).runId;
            if (typeof runId !== 'string') continue;
            assertLeaseHeld();
            const lockKey = `${job.queueQualifiedName}:${job.id}:lock`;
            if (await requireClient().customCommand(['GET', lockKey])) continue;
            // Terminal rows and cancellations win, even if the queue still says
            // active. Pending also covers a crash between this UPDATE and move.
            const rows = await withExistingTaskWrite(sql, authority, async (tx) => {
                assertLeaseHeld();
                return tx<{ id: string }[]>`
                    UPDATE task_history
                    SET state = 'pending', heartbeat_at = NULL, owner_instance_id = NULL
                    WHERE id = ${runId} AND state IN ('active', 'pending')
                      AND (heartbeat_at IS NULL OR heartbeat_at <= NOW() - INTERVAL '60 seconds')
                    RETURNING id
                `;
            });
            if (!rows.length) continue;
            assertLeaseHeld();
            // Never bypass a still-held queue lock. Recheck after the PG wait.
            let moved = false;
            try {
                await withTaskQueueWrite(
                    sql,
                    authority,
                    { kind: 'recover-active', queue: queue.name, jobId: job.id },
                    async () => {
                        assertLeaseHeld();
                        if (Date.now() >= deadline) return;
                        if (await requireClient().customCommand(['GET', lockKey])) return;
                        await job.moveToWait('0');
                        moved = true;
                    },
                );
            } catch (err) {
                // A reconciler can remove the job after getActive() returned it.
                // That benign race must not take the new worker down.
                if (!(err instanceof Error) || !/Missing key for job/i.test(err.message)) throw err;
                log.info('Interrupted queue job disappeared during startup recovery', {
                    runId,
                    jobId: job.id,
                });
            }
            if (moved) recovered.push(runId);
        }
    }
    return recovered;
}
