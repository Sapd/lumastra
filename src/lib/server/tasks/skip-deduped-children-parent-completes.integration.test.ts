// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for skip-deduped-children scenario.
 * Plan §16.1 scenario #6: All children skip-deduped → parent still completes.
 *
 * Validates that when a pipeline parent's children all return deduped:true
 * (because their identity keys point at already-active runs), the parent
 * still transitions to 'completed' and is not stuck in a 'waiting-children' state.
 *
 * This tests the orphan-sweep / FlowProducer unblocking contract.
 *
 * NOTE: If the FlowProducer multi-child dedup path is not yet wired, this test
 * exercises the simpler equivalent: two startRun calls for the same identity
 * produce one run (deduped), and the caller receives the correct runId.
 * The full pipeline parent-waits-for-children scenario is marked as it.todo()
 * pending the pipeline DAG wiring.
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
import { defineTask } from '@sapd/lumastra-plugin-sdk';
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

describe.runIf(RUN)('skip-deduped-children → parent completes (plan §16.1 #6)', () => {
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
        await sql`DELETE FROM task_history WHERE task_id LIKE 'skip-dedup-%'`;
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

    it('[§16.1 #6] deduplicated second enqueue returns original runId; original run completes', async () => {
        // When all pipeline children are deduped (they share identity with in-flight runs),
        // the dedup returns the existing runId. The original run (the "child") must complete,
        // which in turn allows the parent to advance. This test validates the contract at the
        // single-run level: dedup → original runId → original run completes.

        const taskId = `skip-dedup-${ulid().toLowerCase()}`;
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Skip Dedup Child',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ scope: z.string() }),
                identityFor: (input) => (input as { scope: string }).scope,
                exclusiveWith: { scope: 'global' as const, ttl: '24h' },
                async execute() {
                    // Simulate child work.
                    await new Promise((r) => setTimeout(r, 100));
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
            instanceId: 'skip-dedup-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            // First enqueue — "the in-flight child".
            const original = await orch.startRun(taskId, {
                scope: 'shared-scope',
            });
            expect(original.deduped).toBeFalsy();

            // Second enqueue with same identity — returns duplicate.
            const duplicate = await orch.startRun(taskId, {
                scope: 'shared-scope',
            });
            expect(duplicate.deduped).toBe(true);
            expect(duplicate.runId).toBe(original.runId);

            // The original run completes (child completing unblocks parent).
            const finalState = await waitForState(
                sql,
                original.runId,
                ['completed', 'failed'],
                15_000,
            );
            expect(finalState).toBe('completed');
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 45_000);

    it('[§16.1 #6] three children all deduped → their shared run completes successfully', async () => {
        const taskId = `skip-dedup-multi-${ulid().toLowerCase()}`;
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Skip Dedup Multi',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ scope: z.string() }),
                identityFor: (input) => (input as { scope: string }).scope,
                exclusiveWith: { scope: 'global' as const, ttl: '24h' },
                async execute() {
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
            instanceId: 'skip-dedup-multi-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            // Enqueue first (original).
            const first = await orch.startRun(taskId, {
                scope: 'multi-scope',
            });

            // Three more calls — all deduped.
            const [d1, d2, d3] = await Promise.all([
                orch.startRun(taskId, { scope: 'multi-scope' }),
                orch.startRun(taskId, { scope: 'multi-scope' }),
                orch.startRun(taskId, { scope: 'multi-scope' }),
            ]);

            expect(d1.deduped).toBe(true);
            expect(d2.deduped).toBe(true);
            expect(d3.deduped).toBe(true);
            expect(d1.runId).toBe(first.runId);
            expect(d2.runId).toBe(first.runId);
            expect(d3.runId).toBe(first.runId);

            // Exactly one run in task_history.
            const rows = await sql<{ id: string }[]>`
                    SELECT id FROM task_history WHERE task_id = ${taskId}
                `;
            expect(rows).toHaveLength(1);

            // The one run completes.
            const finalState = await waitForState(
                sql,
                first.runId,
                ['completed', 'failed'],
                15_000,
            );
            expect(finalState).toBe('completed');
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 45_000);

    it.todo(
        '[§16.1 #6 full pipeline] FlowProducer parent with 3 children all sharing identity with ' +
            'in-flight runs — parent transitions to completed, not stuck in waiting-children. ' +
            'Requires multi-stage pipeline DAG wiring in pipeline-builder.ts + FlowProducer.',
    );
});
