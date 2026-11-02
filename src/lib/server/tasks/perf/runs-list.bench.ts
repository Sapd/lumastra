// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Performance benchmark for GET /api/v1/runs with 200 active runs.
 * Plan §16.3: p95 < 500ms gate.
 *
 * Seeds 200 runs in task_history, then measures listRuns() latency
 * across 100 invocations.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated)
 *   - CACHE_URL pointing at a Valkey instance
 *
 * Run with: npx vitest bench src/lib/server/tasks/perf/runs-list.bench.ts
 */

// Vitest 5 removed the top-level `bench` import: a benchmark is now declared with
// the `bench` fixture inside a regular `test()` in a `*.bench.ts` file, and started
// with `.run()`. The measured bodies and their iteration counts are unchanged.
import { test, describe, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '../registry.js';
import { stateMachine } from '../state-machine.js';
import { TaskOrchestrator } from '../orchestrator.js';
import { connectValkey, disconnectValkey, getValkeyClient } from '$lib/server/cache/valkey.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const getClient = () =>
    getValkeyClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

// `ulid()` is uppercase Crockford base32, and defineTask() requires
// /^[a-z][a-z0-9-]*$/ — without the fold this benchmark cannot even register
// its task (PluginDefinitionError before the first iteration).
const BENCH_TASK_ID = `bench-runs-list-${ulid().toLowerCase()}`;
const SEED_COUNT = 200;

describe.runIf(RUN)('GET /api/v1/runs with 200 seeds (plan §16.3 p95 < 500ms)', () => {
    let sql: postgres.Sql;
    let orch: TaskOrchestrator;

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

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: BENCH_TASK_ID,
                name: 'Bench Runs List',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => (input as { id: string }).id,
                async execute() {
                    return { success: true };
                },
            }),
        );

        orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
        });

        // Seed 200 runs directly into Postgres without dispatching to BullMQ.
        await sql`DELETE FROM task_history WHERE task_id = ${BENCH_TASK_ID}`;
        const insertRows = Array.from({ length: SEED_COUNT }, (_, i) => ({
            id: `run_bench_${ulid()}`,
            task_id: BENCH_TASK_ID,
            label: `Bench run ${i}`,
            state: i % 5 === 0 ? 'completed' : i % 7 === 0 ? 'failed' : 'pending',
        }));
        for (const row of insertRows) {
            await sql`
                INSERT INTO task_history (id, task_id, label, state, input, trigger, actor,
                    started_at, heartbeat_at, processing_version, owner_instance_id,
                    retention_policy, stages)
                VALUES (
                    ${row.id}, ${row.task_id}, ${row.label}, ${row.state},
                    ${'{}'}::jsonb, ${'{"kind":"manual"}'}::jsonb,
                    ${'{"kind":"user","userId":"bench"}'}::jsonb,
                    NOW(), NOW(), '1', 'bench-instance', 'standard', '[]'::jsonb
                )
            `;
        }
    }, 60_000);

    afterAll(async () => {
        await sql`DELETE FROM task_history WHERE task_id = ${BENCH_TASK_ID}`;
        if (orch) await orch.stop();
        await disconnectValkey();
        await sql.end();
    });

    test('listRuns() with 200 seeded rows (p95 gate: 500ms)', async ({ bench }) => {
        await bench('listRuns() with 200 seeded rows (p95 gate: 500ms)', async () => {
            await orch.listRuns({ taskId: BENCH_TASK_ID, limit: 50 });
        }).run({
            iterations: 100,
            time: 0,
        });
    });

    test('listRuns() full page (limit=200)', async ({ bench }) => {
        await bench('listRuns() full page (limit=200)', async () => {
            await orch.listRuns({ taskId: BENCH_TASK_ID, limit: 200 });
        }).run({
            iterations: 100,
            time: 0,
        });
    });
});
