// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for TaskRunner.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated against 15.0.0).
 *   - CACHE_URL pointing at a Valkey instance.
 *
 * Skipped automatically when those env vars are missing. See
 * docs/dev/QUICK-START.md "Integration Testing".
 *
 * Validates the end-to-end path: orchestrator.startRun → BullMQ →
 * runner.processJob → state-machine transitions → Postgres updated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask, type TaskContext } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator, parseHGetAll } from './orchestrator.js';
import { TaskRunner } from './runner.js';
import { QUEUE_PREFIX, taskQueueName } from './queue-naming.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
    subscribeToChannel,
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
    timeoutMs = 10_000,
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

describe.runIf(RUN)('TaskRunner integration', () => {
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
        await sql`DELETE FROM task_history WHERE id LIKE 'run_test_%'`;
    });

    it('processes a job end-to-end: startRun → BullMQ → runner → completed', async () => {
        const registry = new TaskRegistry();
        let executed = false;
        registry.registerTask(
            defineTask({
                id: 'integration-runner-happy',
                name: 'IntRunHappy',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    executed = true;
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
            instanceId: 'integration-test',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
            subscribe: async () => null,
        });

        try {
            const { runId } = await orch.startRun('integration-runner-happy', {
                id: `it-${ulid().toLowerCase()}`,
            });
            const finalState = await waitForState(sql, runId, ['completed', 'failed'], 15_000);
            expect(finalState).toBe('completed');
            expect(executed).toBe(true);
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 30_000);

    it('publishes the validated terminal count from the runner SQL RETURNING result', async () => {
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: 'trickplay-generation',
                name: 'Preview count fixture',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    return {
                        success: false,
                        itemsProcessed: 663,
                        stopReason: 'budget',
                        result: {
                            generated: 663,
                            countUnit: 'frames',
                            sourcesRemaining: 1,
                        },
                    };
                },
            }),
        );
        const events: Array<Record<string, unknown>> = [];
        const unsubscribe = await subscribeToChannel('task:events:io', (message) => {
            const parsed: unknown = JSON.parse(message);
            if (typeof parsed === 'object' && parsed !== null)
                events.push(parsed as Record<string, unknown>);
        });
        expect(unsubscribe).not.toBeNull();
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
            instanceId: 'integration-preview-summary',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
            subscribe: async () => null,
        });
        try {
            const { runId } = await orch.startRun('trickplay-generation', {
                id: `summary-${ulid().toLowerCase()}`,
            });
            expect(await waitForState(sql, runId, ['completed'], 15_000)).toBe('completed');
            const rows = await sql<
                {
                    started_at: Date;
                    execution_started_at: Date | null;
                    result: unknown;
                }[]
            >`SELECT started_at, execution_started_at, result FROM task_history WHERE id = ${runId}`;
            expect(rows[0]?.execution_started_at).toBeInstanceOf(Date);
            expect(rows[0]?.execution_started_at?.getTime()).toBeGreaterThanOrEqual(
                rows[0]!.started_at.getTime(),
            );
            expect(rows[0]?.result).toMatchObject({ itemsProcessed: 663 });
            const deadline = Date.now() + 3_000;
            let terminal: Record<string, unknown> | undefined;
            while (!terminal && Date.now() < deadline) {
                terminal = events.find(
                    (event) =>
                        event.type === 'org.lumastra.task.run.completed' &&
                        (event.data as { id?: string } | undefined)?.id === runId,
                );
                if (!terminal) await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(terminal?.data).toMatchObject({
                id: runId,
                countSummary: {
                    count: 663,
                    unit: 'frames',
                    continuation: {
                        kind: 'source-check',
                        remainingSources: 1,
                    },
                },
            });
            expect(terminal?.data).not.toHaveProperty('result');
        } finally {
            await runner.stop();
            await orch.stop();
            await unsubscribe?.();
        }
    }, 30_000);

    it('keeps a SQL-pending mirror failure distinguishable from the active worker', async () => {
        await sql.unsafe(`
            CREATE FUNCTION test_admission_mirror_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected active mirror failure'; END $$;
            CREATE TRIGGER test_admission_mirror_failure
            BEFORE UPDATE ON task_history FOR EACH ROW
            WHEN (NEW.task_id = 'integration-mirror-fail' AND NEW.state = 'active')
            EXECUTE FUNCTION test_admission_mirror_failure();
        `);
        const registry = new TaskRegistry();
        let executing = false;
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        registry.registerTask(
            defineTask({
                id: 'integration-mirror-fail',
                name: 'Mirror failure fixture',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    executing = true;
                    await gate;
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
            instanceId: 'integration-mirror-fail',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
            subscribe: async () => null,
        });
        try {
            const { runId } = await orch.startRun('integration-mirror-fail', {
                id: `mirror-${ulid().toLowerCase()}`,
            });
            const deadline = Date.now() + 10_000;
            while (!executing && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 25));
            expect(executing).toBe(true);
            const rows = await sql<{ state: string; execution_started_at: Date | null }[]>`
                SELECT state, execution_started_at FROM task_history WHERE id = ${runId}`;
            expect(rows[0]).toMatchObject({ state: 'pending', execution_started_at: null });
            expect(
                await getClient().customCommand(['HGET', `task:run:active:${runId}`, 'state']),
            ).toBe('active');
            const rawLive = await getClient().customCommand([
                'HGETALL',
                `task:run:active:${runId}`,
            ]);
            const live = parseHGetAll(rawLive);
            expect(live.state).toBe('active');
            expect(live.startedAt).toBeTruthy();
            const observed = await orch.getRun(runId);
            expect(observed?.state).toBe('active');
            expect(observed?.admissionObservation).toBe('active');
            expect(observed?.executionStartedAt).toBeTruthy();
            release?.();
            expect(await waitForState(sql, runId, ['completed'], 10_000)).toBe('completed');
            const terminal = await orch.getRun(runId);
            expect(terminal?.executionStartedAt).toBeUndefined();
        } finally {
            release?.();
            await runner.stop();
            await orch.stop();
            await sql.unsafe(
                'DROP TRIGGER IF EXISTS test_admission_mirror_failure ON task_history',
            );
            await sql.unsafe('DROP FUNCTION IF EXISTS test_admission_mirror_failure()');
        }
    }, 30_000);

    it('propagates soft cancel via task:cancel:<runId> pubsub', async () => {
        const registry = new TaskRegistry();
        let observedAborted = false;
        let executeStarted = false;
        registry.registerTask(
            defineTask({
                id: 'integration-runner-cancel',
                name: 'IntRunCancel',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute(ctx: TaskContext) {
                    executeStarted = true;
                    // Spin until aborted or timeout.
                    const start = Date.now();
                    while (Date.now() - start < 5_000) {
                        if (ctx.signal.aborted) {
                            observedAborted = true;
                            throw new Error('aborted');
                        }
                        await new Promise((resolve) => setTimeout(resolve, 50));
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
            instanceId: 'integration-test',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            const { runId } = await orch.startRun('integration-runner-cancel', {
                id: `cancel-${ulid().toLowerCase()}`,
            });
            // Wait deterministically for the plugin's execute() to actually start
            // before issuing cancel. A fixed sleep races against BullMQ worker
            // startup on slow hosts (and over the SSH tunnel) — if cancel beats
            // claim, the orchestrator finalizes cancel-before-pickup and the
            // plugin body never sees the abort signal (commit 88d3d0939).
            const startupDeadline = Date.now() + 10_000;
            while (!executeStarted && Date.now() < startupDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(executeStarted).toBe(true);
            await orch.cancelRun(runId, { reason: 'integration-test' });
            const finalState = await waitForState(sql, runId, ['cancelled', 'failed'], 10_000);
            expect(observedAborted).toBe(true);
            expect(['cancelled', 'failed']).toContain(finalState);
        } finally {
            await runner.stop();
            await orch.stop();
            // Drain any remaining job from the queue.
            const conn = getQueueConnectionOptions();
            if (conn) {
                const q = new Queue(taskQueueName('io'), {
                    connection: conn,
                    prefix: QUEUE_PREFIX,
                });
                await q.obliterate({ force: true }).catch(() => undefined);
                await q.close();
            }
        }
    }, 30_000);
});
