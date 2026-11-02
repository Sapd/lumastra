// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID, randomInt } from 'node:crypto';
import postgres from 'postgres';
import { Queue, Worker } from 'bullmq';
import { defineTask, type TaskContext, type TaskResult } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { TaskRegistry } from './registry.js';
import { TaskRunner, type WorkerLike } from './runner.js';
import { TaskOrchestrator } from './orchestrator.js';
import { StateMachine } from './state-machine.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';
import { PER_TASK_QUEUE_PREFIX, perTaskQueueName } from './queue-naming.js';
import { getQueueConnectionOptions } from './connection.js';
import { PendingWriteDrain } from './pending-write-drain.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function waitForGate(promise: Promise<unknown>, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Fixture gate timed out: ${label}`)),
                    10_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = performance.now() + 15_000;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error('Upgrade fixture observation timed out');
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

// Queue IDs, SQL application_name, runs and advisory keys belong only to this fixture.
// The parent runner provides disposable coordination Valkey and the sanctioned test DB.
describe('actual BullMQ worker upgrade preparation and restoration', () => {
    const applicationName = `upgrade-${randomUUID()}`;
    const sql = postgres(getTestDatabaseUrl(), {
        max: 8,
        connection: { application_name: applicationName },
    });
    beforeAll(async () => {
        await connectValkey();
    });
    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    async function fixture(
        definitions: Array<{
            id: string;
            execute: (ctx: TaskContext) => Promise<TaskResult>;
            hard?: string;
        }>,
        overrides: { runnerSql?: postgres.Sql; runnerClient?: () => ValkeyLike } = {},
    ): Promise<{
        owner: TaskOrchestrator;
        registry: TaskRegistry;
        runner: TaskRunner;
        queues: Map<string, Queue>;
        workers: Map<string, Worker>;
        close: () => Promise<void>;
    }> {
        const registry = new TaskRegistry();
        for (const definition of definitions)
            registry.registerTask(
                defineTask({
                    id: definition.id,
                    name: definition.id,
                    version: '1.0.0',
                    processingVersion: 1,
                    minAppVersion: '1.0.0',
                    resourceClass: 'io',
                    capabilities: { database: true },
                    inputSchema: z.object({ id: z.string() }),
                    identityFor: (input) => input.id,
                    timeout: {
                        soft: definition.hard ? '1s' : '30s',
                        hard: definition.hard ?? '1m',
                    },
                    execute: definition.execute,
                }),
            );
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Upgrade fixture requires queue connection');
        const queues = new Map<string, Queue>();
        for (const definition of definitions)
            queues.set(
                definition.id,
                new Queue(perTaskQueueName(definition.id), {
                    connection,
                    prefix: PER_TASK_QUEUE_PREFIX,
                }),
            );
        const stateMachine = new StateMachine(requireClient);
        const owner = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
            perTaskQueues: true,
        });
        const workers = new Map<string, Worker>();
        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine,
            getSql: () => overrides.runnerSql ?? sql,
            getClient: overrides.runnerClient ?? requireClient,
            perTaskQueues: true,
            instanceId: applicationName,
            heartbeatIntervalMs: 1000,
            concurrencyFor: () => 4,
            workerFactory: (_cls, processor, taskId) => {
                if (!taskId) throw new Error('Expected per-task worker');
                const worker = new Worker(perTaskQueueName(taskId), processor, {
                    connection,
                    prefix: PER_TASK_QUEUE_PREFIX,
                    concurrency: 1,
                    drainDelay: 0.02,
                });
                workers.set(taskId, worker);
                return worker as unknown as WorkerLike;
            },
        });
        return {
            owner,
            registry,
            runner,
            queues,
            workers,
            close: async () => {
                const failures: unknown[] = [];
                try {
                    await runner.stop({ strict: true });
                } catch (error) {
                    failures.push(error);
                }
                try {
                    await owner.stop({ strict: true });
                } catch (error) {
                    failures.push(error);
                }
                for (const queue of queues.values()) {
                    await queue.obliterate({ force: true });
                    await queue.close();
                }
                await sql`DELETE FROM task_history WHERE task_id IN ${sql(definitions.map((definition) => definition.id))}`;
                if (failures.length)
                    throw new AggregateError(failures, 'Upgrade fixture cleanup failed');
            },
        };
    }

    it('postpones a dependent parent, restores progress, and conserves admin-paused work through replacement', async () => {
        const parentId = `upgrade-parent-${randomUUID()}`;
        const childId = `upgrade-child-${randomUUID()}`;
        const heldId = `upgrade-held-${randomUUID()}`;
        const parentEntered = deferred();
        const allowChild = deferred();
        let childRan = 0;
        let heldRan = 0;
        let parentAborted = false;
        let owner: TaskOrchestrator;
        const f = await fixture([
            {
                id: parentId,
                execute: async (ctx) => {
                    parentEntered.resolve();
                    await allowChild.promise;
                    const child = await owner.startRun(childId, { id: randomUUID() });
                    await until(
                        async () =>
                            (
                                await sql<
                                    { state: string }[]
                                >`SELECT state FROM task_history WHERE id = ${child.runId}`
                            )[0]?.state === 'completed',
                    );
                    parentAborted = ctx.signal.aborted;
                    return { success: true };
                },
            },
            {
                id: childId,
                execute: async () => {
                    childRan++;
                    return { success: true };
                },
            },
            {
                id: heldId,
                execute: async () => {
                    heldRan++;
                    return { success: true };
                },
            },
        ]);
        owner = f.owner;
        const heldQueue = f.queues.get(heldId)!;
        let replacement: TaskRunner | undefined;
        try {
            await heldQueue.pause();
            const held = await owner.startRun(heldId, { id: randomUUID() });
            const original = (await heldQueue.getJobs(['waiting', 'prioritized']))[0];
            expect(original?.data.runId).toBe(held.runId);
            const parent = await owner.startRun(parentId, { id: randomUUID() });
            await waitForGate(parentEntered.promise, 'parent entered');
            const preparation = f.runner.prepareUpgrade({
                deadlineMs: 200,
                settled: () => owner.isUpgradeQuiescent(),
            });
            await until(() => [...f.workers.values()].every((worker) => worker.isPaused()));
            allowChild.resolve();
            expect(await preparation).toEqual({ prepared: false });
            expect(await heldQueue.isPaused()).toBe(true);
            await until(
                async () =>
                    (
                        await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE id = ${parent.runId}`
                    )[0]?.state === 'completed',
            );
            expect(parentAborted).toBe(false);
            expect(childRan).toBe(1);
            expect(heldRan).toBe(0);
            expect(
                await f.runner.prepareUpgrade({
                    deadlineMs: 5000,
                    settled: () => owner.isUpgradeQuiescent(),
                }),
            ).toEqual({ prepared: true });
            await f.runner.stop({ strict: true });
            // A real replacement consumer sees the original queue/job; no replay/import.
            replacement = await TaskRunner.start(['io'], {
                registry: f.registry,
                getSql: () => sql,
                getClient: requireClient,
                perTaskQueues: true,
                instanceId: `${applicationName}-replacement`,
            });
            expect(await heldQueue.isPaused()).toBe(true);
            expect((await heldQueue.getJob(original!.id!))?.data.runId).toBe(held.runId);
            expect(heldRan).toBe(0);
            await heldQueue.resume();
            await until(
                async () =>
                    (
                        await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE id = ${held.runId}`
                    )[0]?.state === 'completed',
            );
            expect(heldRan).toBe(1);
        } finally {
            allowChild.resolve();
            await replacement?.stop({ strict: true });
            await f.close();
        }
    }, 30_000);

    it('postpones after the job is failed while its actual raw SQL continuation still waits', async () => {
        const taskId = `upgrade-sql-${randomUUID()}`;
        const key = randomInt(1, 2_000_000_000);
        const lock = await sql.reserve();
        let lateSqlFinished = false;
        let f: Awaited<ReturnType<typeof fixture>> | undefined;
        try {
            f = await fixture([
                {
                    id: taskId,
                    hard: '2s',
                    execute: async (ctx) => {
                        await ctx.sql`SELECT pg_advisory_xact_lock(${key}::bigint)`;
                        lateSqlFinished = true;
                        return { success: true };
                    },
                },
            ]);
            const current = f;
            await lock`SELECT pg_advisory_lock(${key}::bigint)`;
            const run = await current.owner.startRun(taskId, { id: randomUUID() });
            await until(
                async () =>
                    Number(
                        (
                            await sql<
                                { count: string }[]
                            >`SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = ${applicationName} AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`
                        )[0]?.count,
                    ) > 0,
            );
            await until(
                async () =>
                    (
                        await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE id = ${run.runId}`
                    )[0]?.state === 'failed',
            );
            expect(current.runner.isExecutionQuiescent()).toBe(false);
            expect(await current.runner.prepareUpgrade({ deadlineMs: 100 })).toEqual({
                prepared: false,
            });
            expect(lateSqlFinished).toBe(false);
            expect(current.runner.isStopped()).toBe(false);
            await lock`SELECT pg_advisory_unlock(${key}::bigint)`;
            await until(() => lateSqlFinished && current.runner.isExecutionQuiescent());
            expect(
                await current.runner.prepareUpgrade({
                    deadlineMs: 5000,
                    settled: () => current.owner.isUpgradeQuiescent(),
                }),
            ).toEqual({ prepared: true });
        } finally {
            await lock`SELECT pg_advisory_unlock_all()`;
            lock.release();
            if (f) {
                await until(() => f!.runner.isExecutionQuiescent());
                await f.close();
            }
        }
    }, 30_000);
    it('retains an actual PG timeout result while its fallback ACK is held or rejected, then recovers once', async () => {
        const taskId = `upgrade-ack-${randomUUID()}`;
        const timeoutSql = postgres(getTestDatabaseUrl(), {
            max: 4,
            connection: { statement_timeout: 100 },
        });
        const releaseRow = deferred();
        const rowLocked = deferred();
        const releaseAck = deferred();
        const ackEntered = deferred();
        let rowTransaction: Promise<unknown> | undefined;
        let effects = 0;
        let ackMode: 'hold' | 'reject' | 'accept' = 'hold';
        const encodedRequests: string[] = [];
        const runnerClient = (): ValkeyLike => ({
            customCommand: async (command) => {
                if (
                    (command[0] === 'EVAL' || command[0] === 'EVALSHA') &&
                    command.includes('task:pending-writes') &&
                    command.some(
                        (value) => value.startsWith('{') && value.includes('"kind":"update"'),
                    )
                ) {
                    encodedRequests.push(
                        command.find(
                            (value) => value.startsWith('{') && value.includes('"kind":"update"'),
                        ) ?? '',
                    );
                    ackEntered.resolve();
                    if (ackMode === 'hold') await releaseAck.promise;
                    if (ackMode !== 'accept')
                        throw new Error('fixture lost fallback acknowledgement');
                }
                return requireClient().customCommand(command);
            },
        });
        let f: Awaited<ReturnType<typeof fixture>> | undefined;
        try {
            f = await fixture(
                [
                    {
                        id: taskId,
                        execute: async (ctx) => {
                            effects++;
                            rowTransaction = sql.begin(async (tx) => {
                                await tx`SELECT id FROM task_history WHERE id = ${ctx.runId} FOR UPDATE`;
                                rowLocked.resolve();
                                await releaseRow.promise;
                            });
                            await waitForGate(rowLocked.promise, 'terminal row locked');
                            return { success: true, itemsProcessed: 7 };
                        },
                    },
                ],
                { runnerSql: timeoutSql, runnerClient },
            );
            const current = f;
            const run = await current.owner.startRun(taskId, { id: randomUUID() });
            await waitForGate(ackEntered.promise, 'fallback ACK entered'); // Real PostgreSQL statement_timeout reached the fallback.
            expect(await current.runner.prepareUpgrade({ deadlineMs: 100 })).toEqual({
                prepared: false,
            });
            expect(current.runner.isExecutionQuiescent()).toBe(false);
            ackMode = 'reject';
            releaseAck.resolve();
            await until(() =>
                [...current.workers.values()].every(
                    (worker) => !worker.isRunning() || !worker.isPaused(),
                ),
            );
            expect(await current.runner.prepareUpgrade({ deadlineMs: 250 })).toEqual({
                prepared: false,
            });
            expect(effects).toBe(1);
            ackMode = 'accept';
            await current.runner.retryPendingTerminalWrites();
            expect(encodedRequests.length).toBeGreaterThan(1);
            expect(encodedRequests.every((entry) => entry === encodedRequests[0])).toBe(true);
            releaseRow.resolve();
            await rowTransaction;
            await new PendingWriteDrain(sql, async () => requireClient()).drain();
            await until(
                async () =>
                    (
                        await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE id = ${run.runId}`
                    )[0]?.state === 'completed',
            );
            expect(
                await current.runner.prepareUpgrade({
                    deadlineMs: 5000,
                    settled: () => current.owner.isUpgradeQuiescent(),
                }),
            ).toEqual({ prepared: true });
            const rows = await sql<
                { result: { itemsProcessed: number }; count: string }[]
            >`SELECT result, count(*) OVER()::text AS count FROM task_history WHERE id = ${run.runId}`;
            expect(rows[0]?.result.itemsProcessed).toBe(7);
            expect(rows[0]?.count).toBe('1');
            expect(effects).toBe(1);
        } finally {
            ackMode = 'accept';
            releaseAck.resolve();
            releaseRow.resolve();
            try {
                await waitForGate(rowTransaction ?? Promise.resolve(), 'row transaction cleanup');
                if (f) {
                    try {
                        await waitForGate(
                            f.runner.retryPendingTerminalWrites(),
                            'fallback cleanup',
                        );
                    } finally {
                        await f.close();
                    }
                }
            } finally {
                await timeoutSql.end({ timeout: 2 });
            }
        }
    }, 30_000);
});
