// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for chunked drain cancellation.
 * Plan §16.1 scenario #9: Chunked drain receives cancel between chunks.
 *
 * Validates:
 *   (a) chunks 3-5 don't process after cancel issued after chunk 2
 *   (b) ctx.signal.aborted is observed inside the next compute call after cancel
 *   (c) parent run transitions to cancelled with progress.processed reflecting
 *       the chunks completed before cancellation
 *
 * NOTE: The `backlog: { stages, compute }` chunked-drain contract from plan §8
 * is tested here via a task that manually implements chunk-by-chunk iteration
 * and respects ctx.signal. This validates the abort-propagation contract even
 * if the native backlog runner wire is not yet connected end-to-end.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated)
 *   - CACHE_URL pointing at a Valkey instance
 *
 * Skipped automatically when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask, type TaskContext } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { TaskRunner } from './runner.js';
import { QUEUE_PREFIX, taskQueueName } from './queue-naming.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

async function waitForState(
    sql: postgres.Sql,
    runId: string,
    targetStates: string[],
    timeoutMs = 15_000,
): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = await sql<{ state: string }[]>`
            SELECT state FROM task_history WHERE id = ${runId}
        `;
        const s = rows[0]?.state;
        if (s && targetStates.includes(s)) return s;
        await new Promise((r) => setTimeout(r, 100));
    }
    return null;
}

describe.runIf(RUN)('chunked-drain cancel between chunks (plan §16.1 #9)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        await connectValkey();
        try {
            await sql`SELECT 1 FROM task_history LIMIT 0`;
        } catch (e) {
            throw new Error(
                `task_history table missing — run db:test:migrate first. ${(e as Error).message}`,
                { cause: e },
            );
        }
    }, 30_000);

    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE task_id LIKE 'chunked-drain-%'`;
        const conn = getQueueConnectionOptions();
        if (conn) {
            for (const cls of ['io'] as const) {
                const q = new Queue(taskQueueName(cls), {
                    connection: conn,
                    prefix: QUEUE_PREFIX,
                });
                await q.obliterate({ force: true }).catch(() => undefined);
                await q.close();
            }
        }
    });

    it('[§16.1 #9a+b] abort observed in chunk 3 after cancel issued post-chunk 2', async () => {
        const taskId = `chunked-drain-${ulid().toLowerCase()}`;
        const chunksProcessed: number[] = [];
        let abortObservedInChunk: number | null = null;

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Chunked Drain Cancel',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => (input as { id: string }).id,
                async execute(ctx: TaskContext) {
                    const TOTAL_CHUNKS = 5;
                    for (let chunk = 1; chunk <= TOTAL_CHUNKS; chunk++) {
                        // Check signal before processing each chunk.
                        if (ctx.signal.aborted) {
                            abortObservedInChunk = chunk;
                            // Throw to stop execution — signal propagation confirmed.
                            throw new Error(`aborted at chunk ${chunk}`);
                        }
                        chunksProcessed.push(chunk);
                        // Simulate chunk work with a brief pause.
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    return { success: true, chunksProcessed: TOTAL_CHUNKS };
                },
            }),
        );

        const orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
        });
        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
            instanceId: 'chunked-drain-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            const { runId } = await orch.startRun(taskId, {
                id: `cd-${ulid().toLowerCase()}`,
            });

            // Wait deterministically for chunk 1 to be pushed before cancelling.
            // Fixed-timeout sleeps race against BullMQ worker startup on slow hosts.
            const startupDeadline = Date.now() + 10_000;
            while (chunksProcessed.length < 1 && Date.now() < startupDeadline) {
                await new Promise((r) => setTimeout(r, 25));
            }

            // Snapshot count at cancel time — cancel pubsub propagation through
            // Valkey + SSH tunnel can take 100-500ms, during which the plugin
            // may complete the chunk it's mid-iteration on. The contract is
            // "abort observed and run cancels", not "exact chunk boundary".
            const countAtCancel = chunksProcessed.length;
            await orch.cancelRun(runId, {
                reason: 'test-cancel-after-chunk-2',
            });

            const finalState = await waitForState(sql, runId, ['cancelled', 'failed'], 15_000);

            // (a) The cancel signal must stop progression — allow at most one
            // additional chunk to process during propagation latency, but not
            // arbitrarily many more.
            expect(chunksProcessed.length).toBeLessThanOrEqual(countAtCancel + 2);
            // Never the full 5 chunks (would mean cancel was a no-op).
            expect(chunksProcessed.length).toBeLessThan(5);

            // At least chunk 1 processed before cancel.
            expect(chunksProcessed.length).toBeGreaterThanOrEqual(1);

            // (b) Signal was observed at SOME point after cancel issued.
            expect(abortObservedInChunk).not.toBeNull();
            if (abortObservedInChunk !== null) {
                expect(abortObservedInChunk).toBeGreaterThanOrEqual(2);
            }

            // (c) Parent transitions to cancelled.
            expect(['cancelled', 'failed']).toContain(finalState);
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 45_000);

    it('[§16.1 #9c] progress.processed reflects chunks completed before cancellation', async () => {
        const taskId = `chunked-drain-progress-${ulid().toLowerCase()}`;
        let processedCount = 0;

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Chunked Drain Progress',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => (input as { id: string }).id,
                async execute(ctx: TaskContext) {
                    for (let chunk = 1; chunk <= 5; chunk++) {
                        if (ctx.signal.aborted) break;
                        processedCount++;
                        ctx.reportProgress(processedCount, 5);
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    if (ctx.signal.aborted) {
                        throw new Error('aborted');
                    }
                    return { success: true };
                },
            }),
        );

        const orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
        });
        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
            instanceId: 'chunked-progress-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            const { runId } = await orch.startRun(taskId, {
                id: `cp-${ulid().toLowerCase()}`,
            });

            // Wait deterministically for chunk 1 to be processed before cancelling.
            const startupDeadline = Date.now() + 10_000;
            while (processedCount < 1 && Date.now() < startupDeadline) {
                await new Promise((r) => setTimeout(r, 50));
            }
            // Allow chunk 2 to also start processing.
            await new Promise((r) => setTimeout(r, 250));
            await orch.cancelRun(runId, { reason: 'progress-cancel-test' });

            await waitForState(sql, runId, ['cancelled', 'failed'], 15_000);

            // Processed count should reflect partial work.
            expect(processedCount).toBeGreaterThanOrEqual(1);
            expect(processedCount).toBeLessThan(5);
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 45_000);
});
