// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for TaskOrchestrator.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated against 15.0.0).
 *   - CACHE_URL pointing at a Valkey instance.
 *
 * These tests are skipped automatically when those env vars are missing so
 * `npx vitest run` still works in unit-only mode. See docs/dev/QUICK-START.md
 * "Integration Testing" for setup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import postgres from 'postgres';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { ulid } from 'ulid';
import IORedis from 'ioredis';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { QUEUE_PREFIX, taskQueueName } from './queue-naming.js';
import {
    getCoordinationClient,
    connectValkey,
    disconnectValkey,
} from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { dummySyncTask } from './builtin/native/dummy-sync.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';

const RUN = TEST_DATABASE_URL && CACHE_URL;

describe.runIf(RUN)('TaskOrchestrator integration', () => {
    let sql: postgres.Sql;
    let orch: TaskOrchestrator;
    let queue: Queue;
    const ownedRunIds = new Set<string>();

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        await connectValkey();
        // Best-effort migration check.
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
        if (orch) await orch.stop();
        if (queue) await queue.close();
        for (const runId of ownedRunIds) await sql`DELETE FROM task_history WHERE id = ${runId}`;
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'run_test_%'`;
    });

    it('startRun inserts a pending row in task_history and adds a job to the queue', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'integration-noop',
                name: 'Integration Noop',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    return { success: true };
                },
            }),
        );

        orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine,
            getSql: () => sql,
            getClient: () =>
                getCoordinationClient() as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
        });

        const result = await orch.startRun('integration-noop', { id: 'first' });
        ownedRunIds.add(result.runId);
        expect(result.runId).toMatch(/^run_/);

        const rows = await sql<{ state: string }[]>`
            SELECT state FROM task_history WHERE id = ${result.runId}
        `;
        expect(rows[0]?.state).toBe('pending');

        const conn = getQueueConnectionOptions();
        if (conn) {
            queue = new Queue(taskQueueName('io'), {
                connection: conn,
                prefix: QUEUE_PREFIX,
            });
            const job = await queue.getJob('integration-noop~~first');
            expect(job).not.toBeNull();
            if (job) {
                expect((job.data as { runId: string }).runId).toBe(result.runId);
            }
            await job?.remove();
        }
    }, 30_000);

    it('listRuns paginates with stable cursor', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'paging-noop',
                name: 'Paging Noop',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    return { success: true };
                },
            }),
        );

        const inst = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine,
            getSql: () => sql,
            getClient: () =>
                getCoordinationClient() as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
        });
        try {
            const ids: string[] = [];
            for (let i = 0; i < 5; i++) {
                const r = await inst.startRun('paging-noop', { id: `pg-${i}` });
                ids.push(r.runId);
                ownedRunIds.add(r.runId);
            }
            const page1 = await inst.listRuns({
                taskId: 'paging-noop',
                limit: 2,
            });
            expect(page1.runs.length).toBe(2);
            const page2 = await inst.listRuns({
                taskId: 'paging-noop',
                limit: 2,
                cursor: page1.nextCursor,
            });
            expect(page2.runs.length).toBeGreaterThanOrEqual(2);
            // First page IDs must not appear on the second page.
            const overlap = page1.runs.find((p1) => page2.runs.some((p2) => p2.id === p1.id));
            expect(overlap).toBeUndefined();
        } finally {
            await inst.stop();
        }
    }, 30_000);

    it('listRuns cursor preserves microsecond precision across a same-millisecond boundary', async () => {
        // Regression for the listRuns keyset-cursor precision bug: Postgres
        // timestamptz carries microseconds; a cursor round-tripped through a JS
        // Date truncates to ms and would SKIP a row updated in the same
        // millisecond as the page boundary. These two rows share the same ms
        // (.123) but differ in the microsecond digit (…456 vs …457).
        const reg = new TaskRegistry();
        const inst = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine,
            getSql: () => sql,
            getClient: () =>
                getCoordinationClient() as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
        });
        try {
            const later = '2026-03-04 05:06:07.123457+00';
            const earlier = '2026-03-04 05:06:07.123456+00';
            const rows: ReadonlyArray<readonly [string, string]> = [
                ['run_test_ks_2', later],
                ['run_test_ks_1', earlier],
            ];
            for (const [id, ts] of rows) {
                ownedRunIds.add(id);
                await sql`
                    INSERT INTO task_history (
                        id, task_id, label, state, input, trigger, actor,
                        started_at, heartbeat_at, processing_version,
                        owner_instance_id, retention_policy, stages
                    ) VALUES (
                        ${id}, 'ks-micro-task', 'ks', 'completed',
                        ${sql.json({})}, ${sql.json({ kind: 'manual' })}, ${sql.json({ type: 'system' })},
                        ${ts}::timestamptz, ${ts}::timestamptz, '1',
                        'test-instance', 'standard', ${sql.json([])}
                    )
                `;
            }

            const page1 = await inst.listRuns({ taskId: 'ks-micro-task', limit: 1 });
            expect(page1.runs.map((r) => r.id)).toEqual(['run_test_ks_2']);
            expect(page1.nextCursor).toBeTypeOf('string');

            const page2 = await inst.listRuns({
                taskId: 'ks-micro-task',
                limit: 1,
                cursor: page1.nextCursor,
            });
            // The earlier same-ms row must be returned (not skipped by ms
            // truncation) and the page-1 row must not repeat.
            expect(page2.runs.map((r) => r.id)).toEqual(['run_test_ks_1']);
        } finally {
            await inst.stop();
        }
    }, 30_000);

    it('recoverOnBoot leaves fresh runs untouched', async () => {
        const reg = new TaskRegistry();
        const inst = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine,
            getSql: () => sql,
            getClient: () =>
                getCoordinationClient() as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
        });
        try {
            const report = await inst.recoverOnBoot();
            expect(report).toMatchObject({
                reclaimed: expect.any(Number),
                total: expect.any(Number),
            });
        } finally {
            await inst.stop();
        }
    }, 30_000);
});

// ── FEATURE_SHARED_QUEUE_CONNECTION: connection count + functional proof ─────
//
// Proves two things against a real Valkey instance in the same test:
//   1. Turning the flag on measurably reduces the number of NEW ioredis
//      connections a boot+run of the task system opens.
//   2. A real registered task (dummy-sync) still runs to completion under
//      BOTH the flag-off (today's default) and flag-on code paths.
//
// This is a separate `describe` block (own `sql`/Valkey setup) rather than a
// nested `it` in "TaskOrchestrator integration" above, because it needs
// `vi.resetModules()` — see bootRunAndCount() for why that's load-bearing,
// not decorative.
describe.skipIf(!RUN)('FEATURE_SHARED_QUEUE_CONNECTION (flag on)', () => {
    let sql: postgres.Sql;
    const ownedRunIds = new Set<string>();

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        // NOT connectValkey() from this file's top-of-file static import —
        // see bootRunAndCount() below for why the coordination client also
        // needs to come from the same fresh-per-phase module generation as
        // orchestrator.js/state-machine.js.
    }, 30_000);

    afterAll(async () => {
        for (const runId of ownedRunIds) await sql`DELETE FROM task_history WHERE id = ${runId}`;
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'run_test_%'`;
    });

    it('reduces ioredis connection count on Valkey and dummy-sync still completes, under both flag values', async () => {
        const inspector = new IORedis(process.env.TASK_CACHE_URL!);

        // NOTE: BullMQ 5.71.1 does not tag its ioredis connections via
        // `CLIENT SETINFO lib-name` (verified: no `lib-name`/`SETINFO` call
        // anywhere in node_modules/bullmq). The `lib-name=BullMQ` filter
        // from an earlier draft of this test would therefore have matched
        // zero lines in BOTH phases — a vacuous pass regardless of which
        // code path actually ran. ioredis itself DOES auto-tag connections
        // (`lib-name=ioredis`, verified in node_modules/ioredis/built/redis/
        // event_handler.js), but that's indiscriminate — it can't
        // distinguish a BullMQ connection from any other ioredis client on
        // the same server. Counting total connected clients and diffing
        // before/after a controlled boot+run+teardown window is what
        // actually measures "how many sockets did this specific code path
        // open," independent of tagging.
        const countClients = async (): Promise<number> => {
            const info = (await inspector.client('LIST')) as string;
            return info.split('\n').filter((line) => line.trim().length > 0).length;
        };

        async function waitForState(
            runId: string,
            targetStates: string[],
            timeoutMs = 15_000,
        ): Promise<string | null> {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const rows = await sql<{ state: string }[]>`
                        SELECT state FROM task_history WHERE id = ${runId}
                    `;
                const state = rows[0]?.state;
                if (state && targetStates.includes(state)) return state;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return null;
        }

        // Minimal no-op tasks purely to amplify the connection-count
        // signal: in per-task-queue mode (FEATURE_PER_TASK_QUEUES,
        // default on) both TaskOrchestrator.start() and TaskRunner.start()
        // eagerly materialize a Queue/Worker per REGISTERED task, not just
        // per task that actually runs (see orchestrator.ts bootstrap()'s
        // `taskQueueRegistry.materializeAll(this.registry.getAllTasks())`
        // and runner.ts start()'s loop over `registry.getAllTasks()`).
        // With only one registered task, the flag-on saving is a small,
        // timing-fragile 1-connection margin (Queue + Worker-main are
        // shared, but Worker's blocking pop and QueueEvents always
        // duplicate() regardless — see connection.ts's file header).
        // Registering several never-started tasks alongside dummy-sync
        // multiplies that margin into a robust, non-flaky gap without
        // changing what's actually exercised end-to-end.
        function makeNoopTask(id: string) {
            return defineTask({
                id,
                name: id,
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'maintenance',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    return { success: true };
                },
            });
        }

        /**
         * Boots a fresh orchestrator + runner pair under the given flag
         * value, runs the real `dummy-sync` builtin task to completion,
         * and reports how many NEW ioredis connections were observed open
         * for the boot+run window (before `.stop()` is called).
         *
         * `vi.resetModules()` + fresh dynamic imports of orchestrator.js /
         * runner.js / connection.js are NOT decorative here.
         * FEATURE_SHARED_QUEUE_CONNECTION (config.ts) is read once into a
         * module-level const at import time — connection.ts's
         * getQueueConnection() closes over that const. This file's
         * top-of-file static imports of TaskOrchestrator already forced
         * config.ts to evaluate once (flag off, its default) before this
         * test ever runs. Flipping `process.env` afterwards and reusing
         * those already-evaluated modules would silently no-op: both
         * phases would run the exact same (flag-off) code path and the
         * test would pass or fail regardless of Tasks 1-3's correctness.
         * `vi.resetModules()` forces the next `import()` of orchestrator.js
         * (and, transitively, connection.js/config.js) to re-evaluate from
         * scratch against the current `process.env` value.
         */
        async function bootRunAndCount(
            flagOn: boolean,
        ): Promise<{ opened: number; finalState: string | null }> {
            vi.resetModules();
            if (flagOn) {
                process.env.FEATURE_SHARED_QUEUE_CONNECTION = 'true';
            } else {
                delete process.env.FEATURE_SHARED_QUEUE_CONNECTION;
            }

            const { TaskOrchestrator: FreshOrchestrator } = await import('./orchestrator.js');
            const { TaskRunner: FreshRunner } = await import('./runner.js');
            const { __resetSharedQueueConnectionForTests } = await import('./connection.js');
            // Must come from the SAME fresh generation as the two imports
            // above: TaskOrchestrator.start() calls the module-level
            // `luaLoader.load()` singleton from ./lua/loader.js, and
            // stateMachine.transitionRun() calls `luaLoader.invoke()` on
            // it. Reusing this file's top-of-file static `stateMachine`
            // import here binds to the OLD generation's loader (never
            // `.load()`ed in this generation) and every state transition
            // fails with "LuaScriptLoader: call load() first" — caught by
            // actually running this test, not by reasoning about it.
            const { stateMachine: freshStateMachine } = await import('./state-machine.js');
            // Same reasoning applies to the Valkey coordination client:
            // state-machine.ts calls the module-level getCoordinationClient()
            // from cache/valkey.js directly (not through an injected opt), so
            // it must be a client CONNECTED in this same fresh generation —
            // this file's top-of-file static `connectValkey()`/
            // `getCoordinationClient()` bind to the OLD generation's valkey.js
            // module instance, whose `valkeyClient` is a completely separate
            // (here: never-connected) variable. Skipping this produces
            // "Valkey coordination client is not connected" from
            // state-machine.ts on every transition — caught by running the
            // test, not by reasoning about it.
            const {
                getCoordinationClient: freshGetValkeyClient,
                connectValkey: freshConnectValkey,
                disconnectValkey: freshDisconnectValkey,
            } = await import('$lib/server/cache/valkey.js');

            // Everything from here on opens a real resource (Valkey
            // coordination connection, then orchestrator, then runner) that
            // needs matching teardown. Track each one in a nullable
            // variable set only once its `.start()`/`connect()` call has
            // actually resolved, and guard each cleanup call on that
            // variable in `finally` — so a throw partway through booting
            // (e.g. orchestrator boots and acquires its leader lock, then
            // runner.start() throws) still tears down exactly what was
            // created instead of leaking the Valkey socket / leader lock
            // past this function's return.
            let valkeyConnected = false;
            let orch: Awaited<ReturnType<typeof FreshOrchestrator.start>> | null = null;
            let runner: Awaited<ReturnType<typeof FreshRunner.start>> | null = null;

            try {
                await freshConnectValkey();
                valkeyConnected = true;
                const getClient = () =>
                    freshGetValkeyClient() as unknown as {
                        customCommand: (cmd: string[]) => Promise<unknown>;
                    };
                // Defensive: guarantee no shared instance survives from a
                // previous generation (module-scope state a plain env-var
                // flip can't reach).
                __resetSharedQueueConnectionForTests();

                const reg = new TaskRegistry();
                reg.registerTask(dummySyncTask);
                const tag = flagOn ? 'on' : 'off';
                for (let i = 0; i < 4; i++) {
                    reg.registerTask(makeNoopTask(`conn-count-noop-${tag}-${i}`));
                }

                const before = await countClients();

                orch = await FreshOrchestrator.start(['maintenance'], {
                    registry: reg,
                    stateMachine: freshStateMachine,
                    getSql: () => sql,
                    getClient,
                });
                runner = await FreshRunner.start(['maintenance'], {
                    registry: reg,
                    stateMachine: freshStateMachine,
                    getSql: () => sql,
                    getClient,
                    instanceId: `conn-count-${tag}`,
                    bootId: ulid(),
                    heartbeatIntervalMs: 1_000,
                    // Stub the cancel-channel subscription (as
                    // runner.integration.test.ts's happy-path test does) so
                    // this test doesn't also open — and have to account for —
                    // a real pubsub connection that has nothing to do with
                    // what FEATURE_SHARED_QUEUE_CONNECTION touches.
                    subscribe: async () => null,
                });

                const { runId } = await orch.startRun(
                    'dummy-sync',
                    { itemCount: 2, itemDelayMs: 10 },
                    {
                        trigger: {
                            kind: 'in-process',
                            sourceRoute: 'connection.integration.test',
                        },
                    },
                );
                ownedRunIds.add(runId);
                const finalState = await waitForState(runId, ['completed', 'failed'], 15_000);
                const after = await countClients();
                return { opened: after - before, finalState };
            } finally {
                if (runner) {
                    await runner.stop();
                }
                if (orch) {
                    await orch.stop();
                }
                __resetSharedQueueConnectionForTests();
                if (valkeyConnected) {
                    await freshDisconnectValkey();
                }
            }
        }

        try {
            const off = await bootRunAndCount(false);
            // Let the previous phase's sockets actually leave the Valkey
            // server's client table before taking the next baseline —
            // `.close()`/`.disconnect()` resolving client-side doesn't
            // guarantee the server has pruned the connection yet.
            await new Promise((resolve) => setTimeout(resolve, 300));
            const on = await bootRunAndCount(true);

            // Functional correctness FIRST: a connection-count win means
            // nothing if the task no longer runs under either code path.
            expect(off.finalState).toBe('completed');
            expect(on.finalState).toBe('completed');

            // Sanity check on the measurement itself: if this were 0 (or
            // negative), the whole comparison below would be vacuous.
            expect(off.opened).toBeGreaterThan(0);

            // The actual point of this test: flag-on opens strictly fewer
            // new ioredis connections than flag-off for the identical
            // registry/workload. This is the assertion that would fail if
            // Tasks 1-3 were reverted (getQueueConnection() would collapse
            // to getQueueConnectionOptions() and both phases would open
            // the same connection count).
            expect(on.opened).toBeLessThan(off.opened);
        } finally {
            delete process.env.FEATURE_SHARED_QUEUE_CONNECTION;
            await inspector.quit();
        }
    }, 30_000);
});
