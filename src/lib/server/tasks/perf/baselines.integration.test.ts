// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Capture performance baselines for the task system (plan §16.3).
 *
 * Runs the same measurements as the *.bench.ts files in this folder but as
 * vitest `it()` blocks so they execute under the standard integration-test
 * harness (SvelteKit aliases resolved, TEST_DATABASE_URL / CACHE_URL honored).
 *
 * Three modes:
 *   - Default: measure, log, and assert only loose sanity bounds (10x the
 *     gate). Won't fail when running over SSH tunnel where RTT inflates the
 *     measurements. Enabled with LUMASTRA_BENCH_TEST=1.
 *   - `BENCH_CAPTURE=1`: additionally writes p50/p95/p99 to
 *     `perf/baselines.json`. This is the baseline-capture mode.
 *   - `BENCH_GATE=1`: enforces the strict §16.3 gates (5ms/500ms p95).
 *     Only meaningful when measurements are direct-network. Set this when
 *     wiring the CI perf-regression gate.
 *
 * Run baseline capture:
 *   LUMASTRA_BENCH_TEST=1 BENCH_CAPTURE=1 npm run test:integration -- src/lib/server/tasks/perf/baselines.integration.test.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '../registry.js';
import { stateMachine } from '../state-machine.js';
import { TaskOrchestrator } from '../orchestrator.js';
import { luaLoader } from '../lua/loader.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const CAPTURE = process.env.BENCH_CAPTURE === '1';
const STRICT_GATE = process.env.BENCH_GATE === '1';

// Capture/strictness remain independent modes once the benchmark suite is enabled.
const RUN = Boolean(TEST_DATABASE_URL && CACHE_URL && process.env.LUMASTRA_BENCH_TEST);

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };
interface Latencies {
    p50: number;
    p95: number;
    p99: number;
    iterations: number;
}

const BASELINES_FILE = path.join(import.meta.dirname, 'baselines.json');

function summarize(samples: number[]): Latencies {
    if (samples.length === 0) {
        // Defensive: if every iteration threw, latencies is empty. Returning
        // a NaN-laden summary would silently pollute baselines.json — fail
        // loudly instead so the test surfaces the underlying iteration error.
        throw new Error('summarize() received zero samples — measurement loop produced no data');
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return {
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
        iterations: samples.length,
    };
}

async function recordBaseline(
    name: string,
    gate: { metric: 'p95'; limitMs: number },
    l: Latencies,
): Promise<void> {
    console.log(
        `[bench] ${name}: p50=${l.p50.toFixed(2)}ms p95=${l.p95.toFixed(2)}ms p99=${l.p99.toFixed(2)}ms (n=${l.iterations})  GATE p95<${gate.limitMs}ms: ${l.p95 < gate.limitMs ? 'PASS' : 'FAIL'}`,
    );
    if (!CAPTURE) return;
    let baselines: Record<string, unknown> = {};
    try {
        baselines = JSON.parse(await fs.readFile(BASELINES_FILE, 'utf-8'));
    } catch {
        // First-time write.
    }
    // Regenerate _meta when absent (e.g., operator deleted the file) so the
    // gateComparable warning and capture-environment provenance don't
    // silently vanish from the regenerated baseline.
    if (!baselines._meta) {
        baselines._meta = {
            captureEnvironment: 'remote test host via SSH tunnel (BENCH_CAPTURE=1)',
            captureCommand:
                'LUMASTRA_BENCH_TEST=1 BENCH_CAPTURE=1 npm run test:integration -- src/lib/server/tasks/perf/baselines.integration.test.ts',
            gateComparable: false,
            warning:
                'Latencies include SSH tunnel RTT (~50-100ms). NOT directly comparable to the plan §16.3 gates (5ms / 500ms p95) which assume direct-network access.',
            capturedAt: new Date().toISOString(),
        };
    }
    baselines[name] = {
        schemaVersion: 1,
        ...l,
        gate,
        capturedAt: new Date().toISOString(),
    };
    await fs.writeFile(BASELINES_FILE, JSON.stringify(baselines, null, 2) + '\n');
}

describe.runIf(RUN)('Performance baselines (plan §16.3)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        await connectValkey();
        await luaLoader.load();
    }, 60_000);

    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    // ── transition-run.lua ────────────────────────────────────────────────────

    // Iteration count chosen so a SSH-tunneled preprod run still completes
    // inside the test timeout. The transition itself is sub-ms even over the
    // tunnel; setup/teardown HSET+DEL dominate wall clock. 200 samples gives
    // a stable p95 estimate without burning a minute per case on the tunnel.
    const TRANSITION_RUN_ITERATIONS = 200;
    const TRANSITION_RUN_TIMEOUT_MS = 300_000;

    it(
        'transition-run.lua pending→active (p95 < 5ms)',
        async () => {
            const client = getCoordinationClient() as unknown as ValkeyLike & {
                hset: (k: string, v: Record<string, string>) => Promise<unknown>;
                del: (keys: string[]) => Promise<unknown>;
            };
            const PREFIX = `bench:tr:${Date.now()}:`;
            const ACTIVE_TTL = '900000';
            const TERMINAL_TTL = '3600000';
            const latencies: number[] = [];
            for (let i = 0; i < TRANSITION_RUN_ITERATIONS; i++) {
                const ak = `task:run:active:${PREFIX}p${i}`;
                const tk = `task:run:terminal:${PREFIX}p${i}`;
                await client.hset(ak, { state: 'pending' });
                try {
                    const t0 = performance.now();
                    await luaLoader.invoke(
                        'transition-run',
                        [ak, tk],
                        ['pending', 'active', ACTIVE_TTL, TERMINAL_TTL],
                        client,
                    );
                    latencies.push(performance.now() - t0);
                } finally {
                    // Always best-effort delete both keys — if invoke threw, the
                    // active key has no TTL (HSET doesn't set one) and would
                    // otherwise leak indefinitely.
                    await client.del([ak, tk]).catch(() => {});
                }
            }
            const summary = summarize(latencies);
            await recordBaseline(
                'transition-run-pending-to-active',
                { metric: 'p95', limitMs: 5 },
                summary,
            );
            if (STRICT_GATE) expect(summary.p95).toBeLessThan(5);
        },
        TRANSITION_RUN_TIMEOUT_MS,
    );

    it(
        'transition-run.lua active→completed (p95 < 5ms)',
        async () => {
            const client = getCoordinationClient() as unknown as ValkeyLike & {
                hset: (k: string, v: Record<string, string>) => Promise<unknown>;
                del: (keys: string[]) => Promise<unknown>;
            };
            const PREFIX = `bench:tr:${Date.now()}:`;
            const ACTIVE_TTL = '900000';
            const TERMINAL_TTL = '3600000';
            const latencies: number[] = [];
            for (let i = 0; i < TRANSITION_RUN_ITERATIONS; i++) {
                const ak = `task:run:active:${PREFIX}c${i}`;
                const tk = `task:run:terminal:${PREFIX}c${i}`;
                await client.hset(ak, {
                    state: 'active',
                    taskId: 'bench-task',
                });
                try {
                    const t0 = performance.now();
                    await luaLoader.invoke(
                        'transition-run',
                        [ak, tk],
                        ['active', 'completed', ACTIVE_TTL, TERMINAL_TTL],
                        client,
                    );
                    latencies.push(performance.now() - t0);
                } finally {
                    await client.del([ak, tk]).catch(() => {});
                }
            }
            const summary = summarize(latencies);
            await recordBaseline(
                'transition-run-active-to-completed',
                { metric: 'p95', limitMs: 5 },
                summary,
            );
            if (STRICT_GATE) expect(summary.p95).toBeLessThan(5);
        },
        TRANSITION_RUN_TIMEOUT_MS,
    );

    // ── listRuns ──────────────────────────────────────────────────────────────

    it('listRuns() with 200 seeded rows (p95 < 500ms)', async () => {
        const registry = new TaskRegistry();
        // Task IDs must be lowercase per the SDK's `^[a-z][a-z0-9-]*$` regex;
        // ULID uses Crockford Base32 (uppercase) so we explicitly lowercase.
        const taskId = `bench-runs-list-${ulid().toLowerCase()}`;
        registry.registerTask(
            defineTask({
                id: taskId,
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
        const orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: () => getCoordinationClient() as unknown as ValkeyLike,
        });

        try {
            const SEED_COUNT = 200;
            await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
            for (let i = 0; i < SEED_COUNT; i++) {
                const id = `run_bench_${ulid()}`;
                const state = i % 5 === 0 ? 'completed' : i % 7 === 0 ? 'failed' : 'pending';
                await sql`
                    INSERT INTO task_history (id, task_id, label, state, input, trigger, actor,
                        started_at, heartbeat_at, processing_version, owner_instance_id,
                        retention_policy, stages)
                    VALUES (
                        ${id}, ${taskId}, ${`Bench ${i}`}, ${state},
                        ${'{}'}::jsonb, ${'{"kind":"manual"}'}::jsonb,
                        ${'{"kind":"user","userId":"bench"}'}::jsonb,
                        NOW(), NOW(), '1', 'bench-instance', 'standard', '[]'::jsonb
                    )
                `;
            }

            async function measure(limit: number, iterations: number): Promise<Latencies> {
                const samples: number[] = [];
                for (let i = 0; i < iterations; i++) {
                    const t0 = performance.now();
                    await orch.listRuns({ taskId, limit });
                    samples.push(performance.now() - t0);
                }
                return summarize(samples);
            }

            const limit50 = await measure(50, 100);
            await recordBaseline('runs-list-limit-50', { metric: 'p95', limitMs: 500 }, limit50);
            if (STRICT_GATE) expect(limit50.p95).toBeLessThan(500);

            const limit200 = await measure(200, 100);
            await recordBaseline('runs-list-limit-200', { metric: 'p95', limitMs: 500 }, limit200);
            if (STRICT_GATE) expect(limit200.p95).toBeLessThan(500);

            await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
        } finally {
            await orch.stop();
        }
    }, 120_000);
});
