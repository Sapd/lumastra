// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import { TaskRunner } from '$lib/server/tasks/runner.js';
import { TaskOrchestrator } from '$lib/server/tasks/orchestrator.js';
import { stateMachine } from '$lib/server/tasks/state-machine.js';
import { requireClient } from '$lib/server/tasks/valkey-types.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { PER_TASK_QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { createBullMqExecutor } from './bullmq.js';
import type { ExecutionCommand } from './protocol.js';

// Mandatory real Postgres+isolated Valkey; no mock contexts/jobs or skip gate.
describe('production BullMQ executor adapter', () => {
    let sql: postgres.Sql;
    beforeAll(async () => {
        const databaseUrl = process.env.TEST_DATABASE_URL;
        const cacheUrl = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL;
        if (!databaseUrl || !cacheUrl || Number(new URL(cacheUrl).pathname.slice(1)) < 1)
            throw new Error('Isolated integration services required');
        sql = postgres(databaseUrl, { max: 3 });
        await connectValkey();
    });
    afterAll(async () => {
        await disconnectValkey();
        await sql?.end();
    });

    it('rehydrates real claimed jobs and reuses the complete capability-scoped TaskContext', async () => {
        const taskId = `executor-${randomUUID()}`;
        const registry = new TaskRegistry();
        let executions = 0;
        let cancellationStarted = false;
        let cancellationStopped = false;
        let finishWedge!: () => void;
        let wedgeStarted = false;
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Executor compatibility',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '0.1.0',
                resourceClass: 'io',
                timeout: { hard: '2s', soft: '1s' },
                capabilities: { database: true, cache: true },
                inputSchema: z.object({
                    identity: z.string(),
                    cancel: z.boolean().optional(),
                    wedge: z.boolean().optional(),
                }),
                identityFor: (input) => input.identity,
                async execute(ctx) {
                    if (ctx.input.wedge) {
                        wedgeStarted = true;
                        await new Promise<void>((resolve) => {
                            finishWedge = resolve;
                        });
                        return { success: true, itemsProcessed: 0 };
                    }
                    if (ctx.input.cancel) {
                        cancellationStarted = true;
                        await new Promise<void>((resolve) => {
                            if (ctx.signal.aborted) resolve();
                            else
                                ctx.signal.addEventListener('abort', () => resolve(), {
                                    once: true,
                                });
                        });
                        // Deliberately unwind asynchronously: cancellation is not teardown.
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        cancellationStopped = true;
                        return { success: false, itemsProcessed: 0 };
                    }
                    await ctx.sql`SELECT 1`;
                    expect(ctx.catalog).toBeDefined();
                    expect(ctx.mediaItems).toBeDefined();
                    expect(ctx.mediaFiles).toBeDefined();
                    expect(ctx.userCredentials).toBeDefined();
                    if (!ctx.cache) throw new Error('Scoped cache unavailable');
                    await ctx.cache.set('executor-check', { ok: true }, 60_000);
                    expect(await ctx.cache.get('executor-check')).toEqual({ ok: true });
                    ctx.reportProgress(1, 1);
                    ctx.logger.info('executor fixture');
                    executions++;
                    return { success: true, itemsProcessed: 1 };
                },
            }),
        );
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Queue connection missing');
        const orchestrator = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
            perTaskQueues: true,
        });
        const runner = TaskRunner.createExecutor({
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
            perTaskQueues: true,
            heartbeatIntervalMs: 50,
            subscribe: async () => null,
        });
        const backend = createBullMqExecutor({
            runner,
            registry,
            connection,
            eligibleTaskIds: [taskId],
        });
        const claimant = new Worker(taskId, null, {
            connection,
            prefix: PER_TASK_QUEUE_PREFIX,
            autorun: false,
            skipStalledCheck: true,
            skipLockRenewal: true,
            lockDuration: 120_000,
        });
        const queue = new Queue(taskId, { connection, prefix: PER_TASK_QUEUE_PREFIX });
        try {
            for (let index = 0; index < 2; index++) {
                const { runId } = await orchestrator.startRun(taskId, { identity: randomUUID() });
                const token = randomUUID();
                const job = await claimant.getNextJob(token, { block: false });
                if (!job?.id) throw new Error('Expected claimed job');
                const command: ExecutionCommand = {
                    invocationId: randomUUID(),
                    dispatchId: randomUUID(),
                    authority: {
                        partition: `task:${taskId}`,
                        generation: '1',
                        ownerId: randomUUID(),
                    },
                    catalogRevision: 'a'.repeat(64),
                    taskId,
                    queueName: taskId,
                    runId,
                    jobId: job.id,
                    lockToken: token,
                    lockDurationMs: 120_000,
                };
                const deniedBackend = createBullMqExecutor({ registry, connection });
                try {
                    await expect(
                        deniedBackend.execute(command, new AbortController().signal),
                    ).rejects.toThrow('eligibility not approved');
                    expect(executions).toBe(index);
                } finally {
                    await deniedBackend.close();
                }
                await expect(
                    backend.execute(
                        { ...command, lockToken: 'wrong-token' },
                        new AbortController().signal,
                    ),
                ).rejects.toThrow('lock lost');
                expect(executions).toBe(index);
                const outcome = await backend.execute(command, new AbortController().signal);
                expect(outcome).toMatchObject({
                    status: 'completed',
                    result: { success: true, itemsProcessed: 1 },
                });
                // Native claimant alone performs the BullMQ terminal transition.
                expect(await job.getState()).toBe('active');
                const lockTtl = await requireClient().customCommand([
                    'PTTL',
                    `${PER_TASK_QUEUE_PREFIX}:${taskId}:${job.id}:lock`,
                ]);
                expect(Number(lockTtl)).toBeGreaterThan(60_000);
                await job.moveToCompleted(outcome.result, token, false);
                expect(backend.isQuiescent()).toBe(true);
                const rows = await sql<
                    { state: string }[]
                >`SELECT state FROM task_history WHERE id = ${runId}`;
                expect(rows[0]?.state).toBe('completed');
            }
            expect(executions).toBe(2);
            const { runId } = await orchestrator.startRun(taskId, {
                identity: randomUUID(),
                cancel: true,
            });
            const token = randomUUID();
            const job = await claimant.getNextJob(token, { block: false });
            if (!job?.id) throw new Error('Expected cancellation job');
            const command: ExecutionCommand = {
                invocationId: randomUUID(),
                dispatchId: randomUUID(),
                authority: { partition: `task:${taskId}`, generation: '1', ownerId: randomUUID() },
                catalogRevision: 'a'.repeat(64),
                taskId,
                queueName: taskId,
                runId,
                jobId: job.id,
                lockToken: token,
                lockDurationMs: 120_000,
            };
            const abort = new AbortController();
            const work = backend.execute(command, abort.signal);
            await expect.poll(() => cancellationStarted).toBe(true);
            abort.abort();
            expect(backend.isQuiescent()).toBe(false);
            expect(cancellationStopped).toBe(false);
            expect(await work).toMatchObject({ status: 'unknown' });
            expect(cancellationStopped).toBe(true);
            expect(backend.isQuiescent()).toBe(true);
            await job.moveToFailed(new Error('test cancellation'), token, false);
            const wedgedRun = await orchestrator.startRun(taskId, {
                identity: randomUUID(),
                wedge: true,
            });
            const wedgedToken = randomUUID();
            const wedgedJob = await claimant.getNextJob(wedgedToken, { block: false });
            if (!wedgedJob?.id) throw new Error('Expected wedged job');
            const wedgedWork = backend.execute(
                {
                    ...command,
                    invocationId: randomUUID(),
                    dispatchId: randomUUID(),
                    runId: wedgedRun.runId,
                    jobId: wedgedJob.id,
                    lockToken: wedgedToken,
                },
                new AbortController().signal,
            );
            await expect.poll(() => wedgeStarted).toBe(true);
            expect(await wedgedWork).toMatchObject({ status: 'unrecoverable' });
            // A watchdog can settle processJob while execute() continues.
            // This is not permission to transfer ownership or close the host.
            expect(backend.isQuiescent()).toBe(false);
            finishWedge();
            await expect.poll(() => backend.isQuiescent()).toBe(true);
            await wedgedJob.moveToFailed(new Error('test timeout'), wedgedToken, false);
        } finally {
            await backend.close();
            await claimant.close();
            await orchestrator.stop();
            await queue.obliterate({ force: true });
            await queue.close();
            await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
        }
    }, 30_000);
});
