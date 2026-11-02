// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for scheduler-vs-manual deduplication.
 * Plan §16.1 scenarios #2 + #7.
 *
 * #2: Manual trigger overlaps active scheduled run (dedup)
 * #7: Scheduler tick fires while manual run is executing
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated)
 *   - CACHE_URL pointing at a Valkey instance
 *
 * Skipped automatically when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

describe.runIf(RUN)('Scheduler-vs-manual deduplication (plan §16.1 #2 + #7)', () => {
    let sql: postgres.Sql;
    const ownedTaskIds = new Set<string>();

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
        for (const taskId of ownedTaskIds)
            await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE task_id LIKE 'dedup-test-%'`;
    });

    it('[§16.1 #2] manual trigger while scheduled run is active: startRun returns deduped:true with the active runId', async () => {
        const taskId = `dedup-test-${ulid().toLowerCase()}`;
        ownedTaskIds.add(taskId);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Dedup Smoke',
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

        try {
            // First call — simulates the scheduled run.
            const first = await orch.startRun(taskId, { scope: 'global' });
            expect(first.runId).toMatch(/^run_/);
            expect(first.deduped).toBeFalsy();

            // Second call with same identityFor output — simulates manual trigger
            // while the scheduled run is still active.
            const second = await orch.startRun(taskId, { scope: 'global' });
            expect(second.deduped).toBe(true);
            expect(second.runId).toBe(first.runId);
            expect(second.existingRunId).toBe(first.runId);

            // Exactly one row in task_history for this scope.
            const rows = await sql<{ id: string }[]>`
                    SELECT id FROM task_history WHERE task_id = ${taskId}
                `;
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(first.runId);
        } finally {
            await orch.stop();
        }
    }, 30_000);

    it('[§16.1 #7] scheduler tick fires while manual run executing: same identityFor → exactly one run', async () => {
        const taskId = `dedup-test-${ulid().toLowerCase()}`;
        ownedTaskIds.add(taskId);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Dedup Sched Tick',
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

        try {
            // Manual trigger first.
            const manual = await orch.startRun(
                taskId,
                { scope: 'lib-1' },
                {
                    trigger: { kind: 'manual' as const },
                },
            );

            // Scheduler tick fires for the same scope — must be deduped.
            const tick = await orch.startRun(
                taskId,
                { scope: 'lib-1' },
                {
                    trigger: { kind: 'scheduled' as const },
                },
            );

            expect(tick.deduped).toBe(true);
            expect(tick.runId).toBe(manual.runId);

            const rows = await sql<{ id: string }[]>`
                    SELECT id FROM task_history WHERE task_id = ${taskId}
                `;
            expect(rows).toHaveLength(1);
        } finally {
            await orch.stop();
        }
    }, 30_000);

    it('[§16.1 #7] different identityFor outputs produce two distinct runs', async () => {
        const taskId = `dedup-test-${ulid().toLowerCase()}`;
        ownedTaskIds.add(taskId);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Dedup Distinct Scopes',
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

        try {
            const runA = await orch.startRun(taskId, { scope: 'scope-A' });
            const runB = await orch.startRun(taskId, { scope: 'scope-B' });

            expect(runA.deduped).toBeFalsy();
            expect(runB.deduped).toBeFalsy();
            expect(runA.runId).not.toBe(runB.runId);

            const rows = await sql<{ id: string }[]>`
                    SELECT id FROM task_history WHERE task_id = ${taskId}
                    ORDER BY started_at ASC
                `;
            expect(rows).toHaveLength(2);
        } finally {
            await orch.stop();
        }
    }, 30_000);
});
