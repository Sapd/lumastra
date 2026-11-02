// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from './connection.js';
import { requireClient } from './valkey-types.js';
import { TaskRegistry } from './registry.js';
import { StateMachine } from './state-machine.js';
import { luaLoader } from './lua/loader.js';
import { TaskRunner } from './runner.js';
import { TaskOrchestrator } from './orchestrator.js';
import { computeIdentity, identityKey } from './identity.js';
import { requeueInterruptedWorkerRuns } from './worker-recovery.js';

let sql: postgres.Sql;
beforeAll(async () => {
    sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
    await connectValkey();
    await luaLoader.load();
});
afterAll(async () => {
    await sql?.end();
    await disconnectValkey();
});

async function until(predicate: () => Promise<boolean>): Promise<void> {
    await vi.waitFor(
        async () => {
            expect(await predicate()).toBe(true);
        },
        { timeout: 10_000, interval: 25 },
    );
}

describe('singleton worker startup recovery with real Postgres and BullMQ', () => {
    it.each([
        'active',
        'retry',
        'completed',
        'cancelling',
        'live-lock',
        'fresh-heartbeat',
        'removed',
        'mid-run-retry',
    ] as const)(
        'recovers only orphaned jobs and preserves live owners and terminal states: %s',
        async (scenario) => {
            const state = [
                'retry',
                'live-lock',
                'fresh-heartbeat',
                'removed',
                'mid-run-retry',
            ].includes(scenario)
                ? 'active'
                : scenario;
            const taskId = `restart-fixture-${randomUUID()}`;
            const runId = randomUUID();
            const connection = getQueueConnectionOptions();
            if (!connection) throw new Error('Isolated Valkey is required');
            const queue = new Queue(taskId, { connection, prefix: 'test:worker-recovery' });
            const deadWorker = new Worker(taskId, async () => {}, {
                connection,
                prefix: 'test:worker-recovery',
                autorun: false,
                lockDuration: 300_000,
            });
            const identity = `identity:${taskId}`;
            let runner: TaskRunner | undefined;
            try {
                await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, heartbeat_at, owner_instance_id, result)
                VALUES (${runId}, ${taskId}, 'Restart fixture', ${state}, '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), NOW(), 'dead-worker', '{"success":true}')`;
                await requireClient().customCommand([
                    'HSET',
                    `task:run:active:${runId}`,
                    'state',
                    state,
                    'ownerInstanceId',
                    'dead-worker',
                    'ownerBootId',
                    'old-boot',
                ]);
                await requireClient().customCommand(['SET', identity, runId, 'PX', '300000']);
                const job = await queue.add(
                    taskId,
                    { runId, input: {}, exclusivityKey: identity },
                    { jobId: runId, attempts: 3 },
                );
                const old = await deadWorker.getNextJob('old-token');
                if (!old) throw new Error('Fixture job was not claimed');
                // Simulate an attempt whose queue failure was recorded while
                // its run transition failed during the Valkey outage.
                if (scenario === 'retry')
                    await old.moveToFailed(new Error('Connection is closed'), 'old-token');
                await deadWorker.close(true);
                if (scenario !== 'live-lock') {
                    await requireClient().customCommand([
                        'DEL',
                        `${job.queueQualifiedName}:${job.id}:lock`,
                    ]);
                }
                if (scenario !== 'fresh-heartbeat')
                    await sql`UPDATE task_history SET heartbeat_at = NOW() - INTERVAL '2 minutes' WHERE id = ${runId}`;
                if (scenario === 'removed') {
                    const active = await queue.getActive();
                    vi.spyOn(queue, 'getActive').mockResolvedValue(active);
                    await job.remove();
                }
                const assertLease = vi.fn();
                const recovered = await requeueInterruptedWorkerRuns(sql, [queue], assertLease);
                expect(assertLease).toHaveBeenCalled();
                expect(recovered).toEqual(
                    scenario === 'active' || scenario === 'mid-run-retry' ? [runId] : [],
                );
                expect(await requireClient().customCommand(['GET', identity])).toBe(runId);
                if (scenario === 'removed') return;
                if (scenario === 'live-lock' || scenario === 'fresh-heartbeat') {
                    expect(await job.getState()).toBe('active');
                    expect(
                        (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                    ).toBe('active');
                    return;
                }
                if (state !== 'active') {
                    expect(await job.getState()).toBe('active');
                    expect(
                        (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                    ).toBe(state);
                    return;
                }
                expect(['wait', 'waiting', 'prioritized']).toContain(await job.getState());
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe(scenario === 'retry' ? 'active' : 'pending');
                let calls = 0;
                const execute = vi.fn(async () => {
                    if (scenario === 'mid-run-retry' && ++calls === 1)
                        throw new TaskError({
                            kind: 'transient',
                            message: 'storage temporarily unavailable',
                        });
                    return { success: true, itemsProcessed: 1 };
                });
                const registry = new TaskRegistry();
                registry.registerTask(
                    defineTask({
                        id: taskId,
                        name: 'Recovery fixture',
                        version: '1.0.0',
                        processingVersion: 1,
                        minAppVersion: '0.0.0',
                        capabilities: {},
                        resourceClass: 'maintenance',
                        inputSchema: z.object({}),
                        identityFor: () => 'one',
                        execute,
                    }),
                );
                const terminal = vi.spyOn(
                    TaskRunner.prototype as unknown as {
                        writeTerminalToPostgres(...args: unknown[]): Promise<void>;
                    },
                    'writeTerminalToPostgres',
                );
                runner = await TaskRunner.start(['maintenance'], {
                    registry,
                    stateMachine: new StateMachine(requireClient),
                    getSql: () => sql,
                    getClient: requireClient,
                    perTaskQueues: true,
                    pluginIsolation: false,
                    instanceId: 'new-worker',
                    bootId: 'new-boot',
                    queueFactory: () => queue,
                    workerFactory: (_cls, processor) =>
                        new Worker(taskId, processor, {
                            connection,
                            prefix: 'test:worker-recovery',
                        }),
                    subscribe: async () => null,
                });
                await until(async () => (await job.getState()) === 'completed');
                expect(execute).toHaveBeenCalledTimes(scenario === 'mid-run-retry' ? 2 : 1);
                expect(terminal.mock.calls.some(([, state]) => state === 'failed')).toBe(false);
                terminal.mockRestore();
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe('completed');
                expect(await requireClient().customCommand(['GET', identity])).toBeNull();
            } finally {
                vi.restoreAllMocks();
                await runner?.stop();
                await deadWorker.close(true);
                await queue.obliterate({ force: true });
                await queue.close();
                await sql`DELETE FROM task_history WHERE id = ${runId}`;
                await requireClient().customCommand([
                    'DEL',
                    identity,
                    `task:run:active:${runId}`,
                    `task:run:terminal:${runId}`,
                ]);
            }
        },
    );
});

it('cancel flow releases the pending identity before reseed skips the queued delivery', async () => {
    const taskId = `cancel-fixture-${randomUUID()}`;
    const connection = getQueueConnectionOptions();
    if (!connection) throw new Error('Isolated Valkey is required');
    const queue = new Queue(taskId, { connection, prefix: 'test:cancel-identity' });
    const registry = new TaskRegistry();
    const execute = vi.fn(async () => ({ success: true }));
    const task = defineTask({
        id: taskId,
        name: 'Cancel identity fixture',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '0.0.0',
        capabilities: {},
        resourceClass: 'maintenance',
        inputSchema: z.object({}),
        identityFor: () => 'one',
        exclusiveWith: { scope: 'global', ttl: '1h' },
        execute,
    });
    registry.registerTask(task);
    const sm = new StateMachine(requireClient);
    const orch = await TaskOrchestrator.start(['maintenance'], {
        registry,
        stateMachine: sm,
        getSql: () => sql,
        getClient: requireClient,
        perTaskQueues: false,
        queueFactory: () => queue,
        queueEventsFactory: () => null,
    });
    let runId: string | undefined;
    let runner: TaskRunner | undefined;
    const key = identityKey(taskId, computeIdentity(task, {}));
    try {
        const run = await orch.startRun(taskId, {});
        runId = run.runId;
        expect(await requireClient().customCommand(['GET', key])).toBe(runId);
        const jobs = await queue.getJobs(['wait', 'prioritized']);
        const job = jobs.find((candidate) => candidate.data.runId === runId);
        if (!job) throw new Error('Fixture job missing');
        await orch.cancelRun(runId);
        expect((await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state).toBe(
            'cancelled',
        );
        expect(await requireClient().customCommand(['GET', key])).toBeNull();
        runner = await TaskRunner.start([], {
            registry,
            stateMachine: sm,
            getSql: () => sql,
            getClient: requireClient,
            perTaskQueues: false,
            pluginIsolation: false,
            subscribe: async () => null,
        });
        await expect(runner.processJob(job, 'cancel-test-token')).rejects.toMatchObject({
            kind: 'permanent',
            message: expect.stringContaining('Retry skipped'),
        });
        expect(execute).not.toHaveBeenCalled();
        expect(await requireClient().customCommand(['GET', key])).toBeNull();
    } finally {
        await runner?.stop();
        await orch.stop();
        const cleanupQueue = new Queue(taskId, { connection, prefix: 'test:cancel-identity' });
        await cleanupQueue.obliterate({ force: true });
        await cleanupQueue.close();
        if (runId) {
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
            await requireClient().customCommand([
                'DEL',
                `task:run:active:${runId}`,
                `task:run:terminal:${runId}`,
                key,
            ]);
        }
    }
});
