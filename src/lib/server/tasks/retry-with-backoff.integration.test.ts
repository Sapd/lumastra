// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for retry-with-backoff behavior.
 * Plan §16.1 scenario #3: Retry on failure honors backoff.
 *
 * Validates:
 *   (a) BullMQ invokes the worker exactly 3 times (retry.attempts=3, throws transient twice)
 *   (b) attemptNumber is threaded through ctx on each attempt
 *   (c) task_history reaches 'completed' with success on attempt 3
 *   (d) permanent-failure path: BullMQ skips remaining attempts
 *
 * NOTE on open backlog item §OPEN-HIGH "BullMQ retry path: claim-run.lua rejects because
 * state≠'pending'": the StateMachine.reseedForRetry() fix for this is already shipped.
 * The test below validates the full round-trip including that fix.
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
import { defineTask, TaskError, type TaskContext } from '@sapd/lumastra-plugin-sdk';
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
    timeoutMs = 20_000,
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

describe.runIf(RUN)('retry-with-backoff (plan §16.1 #3)', () => {
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
        await sql`DELETE FROM task_history WHERE task_id LIKE 'retry-test-%'`;
        // Purge queues to avoid cross-test contamination.
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

    it('[§16.1 #3a-c] transient throw on attempts 1+2 → success on attempt 3 → completed', async () => {
        const taskId = `retry-test-${ulid().toLowerCase()}`;
        const callRecord: number[] = [];

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Retry Transient',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => (input as { id: string }).id,
                retry: {
                    attempts: 3,
                    backoff: 'exponential',
                    retryOn: (err) => err instanceof TaskError && err.kind === 'transient',
                },
                async execute(ctx: TaskContext) {
                    const attempt = ctx.attemptNumber;
                    callRecord.push(attempt);
                    if (attempt < 3) {
                        throw new TaskError({
                            message: 'transient error',
                            kind: 'transient',
                        });
                    }
                    return { success: true, attemptNumber: attempt };
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
            instanceId: 'retry-test-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            const { runId } = await orch.startRun(taskId, {
                id: `retry-${ulid().toLowerCase()}`,
            });
            // Wait for the EXPECTED terminal ('completed'), not any terminal.
            // waitForState returns on first match; if we listed ['completed','failed'],
            // the transient-failure write between BullMQ retry attempts would short-
            // circuit the poll to 'failed' before the retry chance to re-seed and
            // run attempt 3. See §16.1 #3a-c rationale.
            const finalState = await waitForState(sql, runId, ['completed'], 30_000);

            // (c) Postgres state must be 'completed'
            expect(finalState).toBe('completed');

            // (a) BullMQ invoked the plugin 3 times
            expect(callRecord).toHaveLength(3);

            // (b) attemptNumber was threaded correctly (1-indexed)
            expect(callRecord).toEqual([1, 2, 3]);
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 60_000);

    it('[§16.1 #3d] permanent failure skips remaining attempts → failed', async () => {
        const taskId = `retry-test-perm-${ulid().toLowerCase()}`;
        let callCount = 0;

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Retry Permanent',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => (input as { id: string }).id,
                retry: {
                    attempts: 3,
                    backoff: 'exponential',
                    retryOn: () => false, // never retry permanent errors
                },
                async execute() {
                    callCount++;
                    throw new TaskError({
                        message: 'permanent error',
                        kind: 'permanent',
                    });
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
            instanceId: 'retry-perm-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            const { runId } = await orch.startRun(taskId, {
                id: `perm-${ulid().toLowerCase()}`,
            });
            const finalState = await waitForState(sql, runId, ['completed', 'failed'], 20_000);

            expect(finalState).toBe('failed');
            // Permanent error: BullMQ must not retry — only 1 invocation.
            expect(callCount).toBe(1);
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 45_000);
});
