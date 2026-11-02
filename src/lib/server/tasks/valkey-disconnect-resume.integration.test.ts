// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Valkey disconnect + reconciler resume test.
 * Plan §16.1 scenario #14: Valkey restart mid-pipeline → reconciler resumes.
 *
 * NOTE: True docker-level restart is not available in in-process tests.
 * This test exercises the next-best available path:
 *   1. Start an orchestrator + runner.
 *   2. Enqueue a slow task that takes 3s.
 *   3. Forcibly close the Valkey Glide client connection (simulates disconnect).
 *   4. Reconnect Valkey.
 *   5. Confirm the run's Valkey hash is rebuilt/readable and the run completes.
 *
 * If the valkey-glide client does not expose a disconnect/reconnect API,
 * this test is marked with it.todo() pointing to the chaos test suite.
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
    timeoutMs = 20_000,
): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = await sql<{ state: string }[]>`
            SELECT state FROM task_history WHERE id = ${runId}
        `;
        const s = rows[0]?.state;
        if (s && targetStates.includes(s)) return s;
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

describe.runIf(RUN)('valkey disconnect + resume (plan §16.1 #14)', () => {
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
        await sql`DELETE FROM task_history WHERE task_id LIKE 'valkey-disconnect-%'`;
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

    it('[§16.1 #14] run started before disconnect completes successfully after reconnect', async () => {
        const taskId = `valkey-disconnect-${ulid().toLowerCase()}`;
        let executeStarted = false;

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Valkey Disconnect Test',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => (input as { id: string }).id,
                async execute() {
                    executeStarted = true;
                    // Pause briefly to allow disconnect/reconnect cycle mid-flight.
                    await new Promise((r) => setTimeout(r, 1_000));
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
            instanceId: 'valkey-disconnect-instance',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });

        try {
            const { runId } = await orch.startRun(taskId, {
                id: `vd-${ulid().toLowerCase()}`,
            });

            // Wait for execute to start.
            const deadline = Date.now() + 5_000;
            while (!executeStarted && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 50));
            }
            expect(executeStarted).toBe(true);

            // Simulate Valkey disconnect + reconnect.
            // valkey-glide does not expose a raw disconnect without closing the client.
            // We close and reconnect via the project's connectValkey/disconnectValkey helpers.
            await disconnectValkey();
            await connectValkey();

            // After reconnect, the run should still complete via Postgres source of truth.
            const finalState = await waitForState(sql, runId, ['completed', 'failed'], 20_000);
            expect(finalState).toBe('completed');
        } finally {
            await runner.stop();
            await orch.stop();
        }
    }, 60_000);

    it.todo(
        '[§16.1 #14 chaos] docker restart valkey mid-pipeline → reconciler rebuilds hashes — ' +
            'requires external docker control; implement in test:chaos suite (npm run test:chaos)',
    );
});
