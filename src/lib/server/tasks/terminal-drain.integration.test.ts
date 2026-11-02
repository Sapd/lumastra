// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue, Job, type QueueEvents } from 'bullmq';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import * as configuration from '$lib/server/config.js';
import { TaskOrchestrator } from './orchestrator.js';
import { TaskRegistry } from './registry.js';
import { StateMachine } from './state-machine.js';
import { PendingWriteDrain } from './pending-write-drain.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';
import { AuthorityStore, type AuthorityToken } from '../../../task-runtime/authority/store.js';
import { taskJobId } from '../../../task-runtime/authority/queue-origin.js';
import { quarantineValkeyTaskAuthority, installValkeyTaskAuthority } from './lua/fenced-control.js';
import { VALKEY_TASK_AUTHORITY_KEY, VALKEY_TASK_MANAGED_KEY } from './lua/fenced.js';
import { HARD_KILL_QUEUE_PENDING_CODE } from './hard-kill.js';

const lists = [
    'task:pending-writes',
    'task:pending-writes:processing',
    'task:pending-writes:poison',
];

describe('terminal callback durability through real PostgreSQL and coordination Valkey', () => {
    const sql = postgres(getTestDatabaseUrl(), { max: 4 });
    beforeAll(async () => {
        await connectValkey();
    });
    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    it.each([
        'acknowledged',
        'unavailable',
        'lost-ack',
        'nontransient',
        'cancelled',
        'per-task-observation',
        'live-lookup-retry',
        'deferred-insert',
        'peer-completed',
        'peer-cancelled',
        'hard-kill-pending',
        'failed-to-completed',
    ] as const)('retains or hands off the actual terminal callback: %s', async (scenario) => {
        const runId = `run_terminal_${randomUUID()}`;
        const taskId = `terminal-drain-${randomUUID()}`;
        const perTask = scenario === 'per-task-observation' || scenario === 'live-lookup-retry';
        const deferredInsert = scenario === 'deferred-insert';
        const peerTerminal = scenario === 'peer-completed' || scenario === 'peer-cancelled';
        const initialState =
            scenario === 'cancelled' || scenario === 'hard-kill-pending'
                ? 'cancelling'
                : scenario === 'peer-completed'
                  ? 'completed'
                  : scenario === 'peer-cancelled'
                    ? 'cancelled'
                    : scenario === 'failed-to-completed'
                      ? 'failed'
                      : 'active';
        const terminalState =
            scenario === 'cancelled' || scenario === 'peer-cancelled' ? 'cancelled' : 'completed';
        const queueState = scenario === 'cancelled' ? 'failed' : 'completed';
        let holdInsert = deferredInsert;
        let failSql =
            !perTask &&
            !deferredInsert &&
            !peerTerminal &&
            scenario !== 'hard-kill-pending' &&
            scenario !== 'failed-to-completed';
        let failFallback = scenario !== 'acknowledged';
        let sqlAttempts = 0;
        let fallbackAttempts = 0;
        // Preserve the real authority transaction and only inject failure at
        // its terminal UPDATE. Wrapped transactions still execute on real PG.
        const wrapSql = (source: postgres.Sql): postgres.Sql =>
            new Proxy(source, {
                apply(target, thisArg, args): unknown {
                    const text = Array.isArray(args[0]) ? args[0].join('') : '';
                    if (
                        holdInsert &&
                        text.includes('INSERT INTO task_history') &&
                        args.includes(runId)
                    )
                        return Promise.reject(
                            Object.assign(new Error('deferred INSERT held for fixture'), {
                                code: '08006',
                            }),
                        );
                    if (
                        text.includes('UPDATE task_history') &&
                        text.includes('RETURNING task_id')
                    ) {
                        sqlAttempts++;
                        if (failSql)
                            return Promise.reject(
                                Object.assign(
                                    new Error(
                                        scenario === 'nontransient'
                                            ? 'terminal SQL check constraint violated'
                                            : 'terminal SQL connection lost',
                                    ),
                                    {
                                        code: scenario === 'nontransient' ? '23514' : '08006',
                                    },
                                ),
                            );
                    } else if (
                        failSql &&
                        text.includes('UPDATE task_history') &&
                        args.includes(runId)
                    )
                        // The same outage reaches the drain's replay of this run;
                        // otherwise a reconciler tick could apply it mid-test.
                        return Promise.reject(
                            Object.assign(new Error('replay SQL connection lost'), {
                                code: '08006',
                            }),
                        );
                    return Reflect.apply(target, thisArg, args);
                },
                get(target, property, receiver): unknown {
                    if (property === 'begin')
                        return (work: (tx: postgres.Sql) => Promise<unknown>): Promise<unknown> =>
                            target.begin(async (tx) =>
                                work(wrapSql(tx as unknown as postgres.Sql)),
                            );
                    return Reflect.get(target, property, receiver);
                },
            });
        const client: ValkeyLike = {
            async customCommand(command): Promise<unknown> {
                // Count only the enqueue script's ordered keys and this run's
                // update payload, never periodic drain/read/transfer scripts.
                const enqueue =
                    (command[0] === 'EVAL' || command[0] === 'EVALSHA') &&
                    command[3] === lists[0] &&
                    command[4] === lists[2] &&
                    command.some((argument) => {
                        try {
                            const value: unknown = JSON.parse(argument);
                            return (
                                typeof value === 'object' &&
                                value !== null &&
                                'kind' in value &&
                                value.kind === 'update' &&
                                'runId' in value &&
                                value.runId === runId
                            );
                        } catch {
                            return false;
                        }
                    });
                if (enqueue) {
                    fallbackAttempts++;
                    if (failFallback && (scenario === 'unavailable' || scenario === 'cancelled'))
                        throw new Error('coordination write unavailable');
                }
                const result = await requireClient().customCommand(command);
                if (enqueue && failFallback)
                    throw new Error('enqueue applied but acknowledgement lost');
                return result;
            },
        };
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Terminal drain fixture',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '0.1.0',
                resourceClass: 'io',
                capabilities: {},
                inputSchema: z.object({}),
                identityFor: () => 'global',
                async execute() {
                    return { success: true };
                },
            }),
        );
        const events = Object.assign(new EventEmitter(), {
            name: perTask ? taskId : 'io',
            close: vi.fn(async (): Promise<void> => {}),
        });
        const queue = {
            name: 'io',
            close: vi.fn(async (): Promise<void> => {}),
            getJob: vi.fn(async (id: string) => ({
                id,
                data: {},
                attemptsMade: 1,
                getState: async () => queueState,
                returnvalue: { success: true },
                failedReason: 'queue cancelled',
                finishedOn: Date.now(),
            })),
            getJobs: async () => [],
            getJobCounts: async () => ({}),
        };
        let failLookup = true;
        const lookup = perTask
            ? vi.spyOn(Queue.prototype, 'getJob').mockImplementation(async function (
                  this: Queue,
                  id: string,
              ) {
                  if (id !== `${taskId}#${runId}`) return undefined;
                  if (failLookup) throw new Error('per-task lookup unavailable');
                  const job = new Job(this, taskId, {}, {}, id);
                  job.attemptsMade = 1;
                  job.finishedOn = Date.now();
                  vi.spyOn(job, 'getState').mockResolvedValue('completed');
                  return job;
              })
            : undefined;
        const closeQueues = perTask ? vi.spyOn(Queue.prototype, 'close') : undefined;
        const workers = vi.spyOn(configuration, 'shouldStartWorkers').mockReturnValue(true);
        let orch: TaskOrchestrator | undefined;
        const belongsToRun = (raw: string): boolean => {
            try {
                const value: unknown = JSON.parse(raw);
                return (
                    typeof value === 'object' &&
                    value !== null &&
                    'runId' in value &&
                    value.runId === runId
                );
            } catch {
                return false;
            }
        };
        const pendingForRun = async (): Promise<string[]> => {
            const raw = await requireClient().customCommand(['LRANGE', lists[0], '0', '-1']);
            return Array.isArray(raw) ? raw.map(String).filter(belongsToRun) : [];
        };
        try {
            const insert = {
                kind: 'insert' as const,
                runId,
                enqueuedAt: Date.now(),
                payload: {
                    taskId,
                    label: 'Deferred terminal fixture',
                    state: 'pending',
                    input: {},
                    trigger: { kind: 'manual' },
                    actor: { type: 'system' },
                    processingVersion: 1,
                    startedAt: new Date().toISOString(),
                },
            };
            const deferredDrain = new PendingWriteDrain(wrapSql(sql), async () => requireClient());
            if (!deferredInsert) {
                await sql`INSERT INTO task_history
            (id, task_id, label, state, input, trigger, actor, processing_version, started_at, heartbeat_at, completed_at, error)
            VALUES (${runId}, ${taskId}, 'Terminal drain fixture', ${initialState}, '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), NOW(), ${peerTerminal ? new Date() : null}, ${scenario === 'hard-kill-pending' ? sql.json({ code: 'HARD_KILL_QUEUE_PENDING' }) : null})`;
            }
            await requireClient().customCommand([
                'HSET',
                `task:run:active:${runId}`,
                'state',
                scenario === 'cancelled' ? 'cancelling' : 'active',
            ]);
            orch = await TaskOrchestrator.start(['io'], {
                registry,
                stateMachine: new StateMachine(() => client),
                getClient: () => client,
                getSql: () => wrapSql(sql),
                instanceId: `terminal-${randomUUID()}`,
                perTaskQueues: perTask,
                perTaskQueueEventsFactory: () => events as unknown as QueueEvents,
                queueFactory: () => queue as unknown as Queue,
                queueEventsFactory: () => events as unknown as QueueEvents,
                flowProducer: null,
            });
            expect(workers).toHaveBeenCalled();
            expect(events.listenerCount('completed')).toBe(1);
            if (deferredInsert) {
                await deferredDrain.enqueue(insert, { strict: true });
                expect(await pendingForRun()).toHaveLength(1);
                expect(await sql`SELECT state FROM task_history WHERE id = ${runId}`).toHaveLength(
                    0,
                );
            }
            events.emit(queueState, {
                jobId: `${taskId}#${runId}`,
                returnvalue: '{"success":true}',
                failedReason: 'queue cancelled',
            });
            if (scenario === 'live-lookup-retry') {
                await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
                expect(orch.isUpgradeQuiescent()).toBe(false);
                failLookup = false;
                await vi.waitFor(() => expect(orch!.isUpgradeQuiescent()).toBe(true), {
                    timeout: 5000,
                });
                expect(orch.isHealthy()).toBe(true);
                expect(closeQueues).not.toHaveBeenCalled();
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe('completed');
                await orch.stop({ strict: true });
            } else if (perTask) {
                await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
                expect(lookup).toHaveBeenCalled();
                expect(closeQueues).not.toHaveBeenCalled();
                expect(orch.isShutdownCleanupComplete()).toBe(false);
                failLookup = false;
                await orch.stop({ strict: true });
                expect(closeQueues).toHaveBeenCalled();
                expect(orch.isShutdownCleanupComplete()).toBe(true);
            } else if (deferredInsert) {
                await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
                expect(orch.isShutdownCleanupComplete()).toBe(false);
                expect(queue.close).not.toHaveBeenCalled();
                expect(await sql`SELECT state FROM task_history WHERE id = ${runId}`).toHaveLength(
                    0,
                );
                await vi.waitFor(
                    async () => {
                        expect((await pendingForRun()).map((raw) => JSON.parse(raw).kind)).toEqual([
                            'insert',
                        ]);
                    },
                    { timeout: 5_000 },
                );
                // Runtime ticks may attempt this INSERT, but its targeted real
                // transaction failure keeps the row absent until this release.
                holdInsert = false;
                await deferredDrain.drain();
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe('pending');
                await orch.stop({ strict: true });
                expect(
                    (
                        await sql`SELECT state, completed_at FROM task_history WHERE id = ${runId}`
                    )[0],
                ).toMatchObject({ state: 'completed', completed_at: expect.any(Date) });
                // Crash/replay of the original pipeline insertion cannot reset
                // the terminal row after strict cleanup has acknowledged it.
                await deferredDrain.enqueue(insert, { strict: true });
                await deferredDrain.drain();
                expect(orch.isShutdownCleanupComplete()).toBe(true);
            } else if (peerTerminal) {
                await orch.stop({ strict: true });
                expect(orch.isShutdownCleanupComplete()).toBe(true);
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe(initialState);
            } else if (scenario === 'hard-kill-pending') {
                await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
                expect(
                    (await sql`SELECT state, error FROM task_history WHERE id = ${runId}`)[0],
                ).toMatchObject({
                    state: 'cancelling',
                    error: { code: 'HARD_KILL_QUEUE_PENDING' },
                });
                expect(orch.isShutdownCleanupComplete()).toBe(false);
                expect(queue.close).not.toHaveBeenCalled();
                await sql`UPDATE task_history SET error = NULL WHERE id = ${runId}`;
                await orch.stop({ strict: true });
                expect(orch.isShutdownCleanupComplete()).toBe(true);
            } else if (scenario === 'failed-to-completed') {
                await orch.stop({ strict: true });
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe('completed');
            } else if (scenario === 'acknowledged') {
                await orch.stop({ strict: true });
                expect(orch.isShutdownCleanupComplete()).toBe(true);
                // The reconciler's leader-acquisition tick may still be inside a
                // drain pass that holds the entry on the processing list; the
                // failing SQL makes that pass hand it back to the pending list.
                await vi.waitFor(
                    async () => {
                        expect(await pendingForRun()).toHaveLength(1);
                    },
                    { timeout: 5_000 },
                );
                // Whether that tick reaches the entry depends on timing, so
                // replay it explicitly: while SQL is down the entry stays.
                await new PendingWriteDrain(wrapSql(sql), async () => requireClient()).drain();
                expect(await pendingForRun()).toHaveLength(1);
                expect(
                    (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                ).toBe('active');
            } else {
                await orch.stop();
                expect(orch.isShutdownCleanupComplete()).toBe(false);
                expect(queue.close).not.toHaveBeenCalled();
                await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
                if (scenario === 'cancelled') {
                    expect(
                        await requireClient().customCommand([
                            'HGET',
                            `task:run:terminal:${runId}`,
                            'state',
                        ]),
                    ).toBe('cancelled');
                    expect(
                        (await sql`SELECT state FROM task_history WHERE id = ${runId}`)[0].state,
                    ).toBe('cancelling');
                }
                const retained = await pendingForRun();
                if (scenario === 'lost-ack') {
                    expect(retained.length).toBeGreaterThan(0);
                    for (const raw of retained)
                        expect(JSON.parse(raw)).toMatchObject({
                            runId,
                            payload: { state: 'completed' },
                        });
                } else expect(retained).toHaveLength(0);
                // Recover SQL itself; do not replay unknown fallback effects to
                // manufacture an acknowledgement. The retained request retries.
                failSql = false;
                failFallback = false;
                await orch.stop({ strict: true });
                expect(orch.isShutdownCleanupComplete()).toBe(true);
            }
            expect(sqlAttempts).toBeGreaterThan(0);
            if (
                scenario === 'nontransient' ||
                perTask ||
                deferredInsert ||
                peerTerminal ||
                scenario === 'hard-kill-pending' ||
                scenario === 'failed-to-completed'
            )
                expect(fallbackAttempts).toBe(0);
            else expect(fallbackAttempts).toBeGreaterThan(0);
            failSql = false;
            failFallback = false;
            await new PendingWriteDrain(sql, async () => requireClient()).drain();
            expect(
                (await sql`SELECT state, completed_at FROM task_history WHERE id = ${runId}`)[0],
            ).toMatchObject({ state: terminalState, completed_at: expect.any(Date) });
        } finally {
            failSql = false;
            failFallback = false;
            failLookup = false;
            holdInsert = false;
            if (deferredInsert)
                await new PendingWriteDrain(sql, async () => requireClient()).drain();
            await orch?.stop({ strict: true });
            lookup?.mockRestore();
            closeQueues?.mockRestore();
            workers.mockRestore();
            for (const list of lists) {
                const entries = await requireClient().customCommand(['LRANGE', list, '0', '-1']);
                if (Array.isArray(entries))
                    for (const entry of entries) {
                        const raw = String(entry);
                        if (belongsToRun(raw))
                            await requireClient().customCommand(['LREM', list, '0', raw]);
                    }
            }
            await requireClient().customCommand([
                'DEL',
                `task:run:active:${runId}`,
                `task:run:terminal:${runId}`,
            ]);
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
        }
    });
    it('retains managed terminal work across both SQL and Lua hard-kill guards', async () => {
        const runId = `run_managed_terminal_${randomUUID()}`;
        const taskId = `managed-terminal-${randomUUID()}`;
        const ownerId = randomUUID();
        const store = new AuthorityStore(sql);
        let authority: AuthorityToken | undefined;
        let orch: TaskOrchestrator | undefined;
        let mirrorInstalled = false;
        const workers = vi.spyOn(configuration, 'shouldStartWorkers').mockReturnValue(true);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Managed terminal barrier',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '0.1.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({}),
                identityFor: () => 'global',
                async execute() {
                    return { success: true };
                },
            }),
        );
        const events = Object.assign(new EventEmitter(), {
            name: 'io',
            close: vi.fn(async (): Promise<void> => {}),
        });
        const queue = {
            name: 'io',
            close: vi.fn(async (): Promise<void> => {}),
            getJob: vi.fn(),
            getJobs: async () => [],
            getJobCounts: async () => ({}),
        };
        const active = `task:run:active:${runId}`;
        const terminal = `task:run:terminal:${runId}`;
        try {
            authority = await store.initialize('tasks', ownerId, 'typescript', 120_000);
            await quarantineValkeyTaskAuthority(requireClient());
            mirrorInstalled = true;
            await installValkeyTaskAuthority(requireClient(), undefined, {
                authority,
                phase: 'active',
                leaseUntilMs: Date.now() + 120_000,
            });
            const jobId = taskJobId(`${taskId}#${runId}`, authority);
            queue.getJob.mockImplementation(async () => ({
                id: jobId,
                data: { taskAuthority: authority },
                attemptsMade: 1,
                getState: async () => 'failed',
                failedReason: 'queue cleanup notification',
                finishedOn: Date.now(),
            }));
            // Match executeManaged's reservation: history records cancelling
            // plus its error code; the original hash retains active + flag 1.
            await sql`INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version,
                 started_at, heartbeat_at, cancel_requested_at, error)
                VALUES (${runId}, ${taskId}, 'Managed terminal barrier', 'cancelling', '{}',
                    '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), NOW(), NOW(),
                    ${sql.json({ message: 'Hard kill awaiting acknowledged queue cleanup', kind: 'fatal', code: HARD_KILL_QUEUE_PENDING_CODE })})`;
            await requireClient().customCommand([
                'HSET',
                active,
                'state',
                'active',
                'hardKillQueuePending',
                '1',
            ]);
            const machine = new StateMachine(requireClient, authority);
            const transitions = vi.spyOn(machine, 'transitionRun');
            orch = await TaskOrchestrator.start(['io'], {
                registry,
                authority,
                stateMachine: machine,
                getClient: requireClient,
                getSql: () => sql,
                instanceId: `managed-terminal-${randomUUID()}`,
                perTaskQueues: false,
                queueFactory: () => queue as unknown as Queue,
                queueEventsFactory: () => events as unknown as QueueEvents,
                flowProducer: null,
            });
            expect(events.listenerCount('failed')).toBe(1);
            events.emit('failed', { jobId, failedReason: 'queue cleanup notification' });
            await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
            expect(orch.isShutdownCleanupComplete()).toBe(false);
            expect(queue.close).not.toHaveBeenCalled();
            expect(
                transitions.mock.calls.filter(([request]) => request.runId === runId),
            ).toHaveLength(0);
            expect(
                (await sql`SELECT state, error FROM task_history WHERE id = ${runId}`)[0],
            ).toMatchObject({ state: 'cancelling', error: { code: HARD_KILL_QUEUE_PENDING_CODE } });
            // Clearing only the SQL mirror must still hit the real fenced Lua
            // guard. It must not discard the retained original observation.
            await sql`UPDATE task_history SET error = NULL WHERE id = ${runId}`;
            await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
            expect(transitions.mock.calls.some(([request]) => request.runId === runId)).toBe(true);
            expect(
                await requireClient().customCommand(['HGET', active, 'hardKillQueuePending']),
            ).toBe('1');
            expect(await requireClient().customCommand(['HGET', active, 'state'])).toBe('active');
            // After acknowledged queue cleanup, executeManaged's settlement
            // produces this cancelled mirror with the original authority.
            // Simulate its outstanding SQL acknowledgement, then retry it.
            await requireClient().customCommand([
                'HSET',
                terminal,
                'state',
                'cancelled',
                'hardKillQueuePending',
                '0',
                'hardKillAuthorityGeneration',
                authority.generation,
                'hardKillAuthorityOwnerId',
                authority.ownerId,
                'cancelledAt',
                new Date().toISOString(),
                'errorMessage',
                'hard-killed',
            ]);
            await requireClient().customCommand(['DEL', active]);
            await orch.stop({ strict: true });
            expect(
                (await sql`SELECT state, completed_at FROM task_history WHERE id = ${runId}`)[0],
            ).toMatchObject({ state: 'cancelled', completed_at: expect.any(Date) });
            expect(orch.isShutdownCleanupComplete()).toBe(true);
            expect(queue.close).toHaveBeenCalledOnce();
            transitions.mockRestore();
        } finally {
            if (authority) {
                await sql`UPDATE task_history SET error = NULL WHERE id = ${runId}`;
                await requireClient().customCommand(['HDEL', active, 'hardKillQueuePending']);
                await orch?.stop({ strict: true });
                await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${ownerId}`;
            }
            if (mirrorInstalled)
                await requireClient().customCommand([
                    'DEL',
                    VALKEY_TASK_AUTHORITY_KEY,
                    VALKEY_TASK_MANAGED_KEY,
                ]);
            await requireClient().customCommand(['DEL', active, terminal]);
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
            workers.mockRestore();
        }
    });
});
