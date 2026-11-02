// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Performance benchmark for transition-run.lua.
 * Plan §16.3: p95 < 5ms gate.
 *
 * Run via vitest bench (interactive summary, no baseline write):
 *   npx vitest bench src/lib/server/tasks/perf/transition-run.bench.ts
 *
 * For baseline capture into perf/baselines.json:
 *   BENCH_CAPTURE=1 npm run test:integration -- src/lib/server/tasks/perf/baselines.integration.test.ts
 *
 * IMPORTANT: Requires a live Valkey instance via CACHE_URL.
 */

// Vitest 5 removed the top-level `bench` import: a benchmark is now declared with
// the `bench` fixture inside a regular `test()` in a `*.bench.ts` file, and started
// with `.run()`. The measured bodies and their iteration counts are unchanged.
import { test, describe, beforeAll, afterAll } from 'vitest';
import { GlideClient } from '@valkey/valkey-glide';
import { luaLoader } from '../lua/loader.js';
import { type ValkeyLike } from '../valkey-types.js';

// ── Valkey connection ─────────────────────────────────────────────────────────

function parseUrl(
    url: string,
): { host: string; port: number; password?: string; username?: string } | null {
    try {
        const u = new URL(url);
        return {
            host: u.hostname,
            port: parseInt(u.port || '6379', 10),
            username: u.username || undefined,
            password: u.password || undefined,
        };
    } catch {
        return null;
    }
}

const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = Boolean(CACHE_URL);

let glideClient: GlideClient;
const PREFIX = `bench:tr:${Date.now()}:`;
const ACTIVE_TTL = '900000';
const TERMINAL_TTL = '3600000';

function activeKey(runId: string): string {
    return `task:run:active:${PREFIX}${runId}`;
}

function terminalKey(runId: string): string {
    return `task:run:terminal:${PREFIX}${runId}`;
}

let runCounter = 0;

describe.runIf(RUN)('transition-run.lua benchmark (plan §16.3 p95 < 5ms)', () => {
    beforeAll(async () => {
        const cfg = parseUrl(CACHE_URL);
        if (!cfg) throw new Error(`Cannot parse CACHE_URL: ${CACHE_URL}`);

        const glideConfig: Parameters<typeof GlideClient.createClient>[0] = {
            addresses: [{ host: cfg.host, port: cfg.port }],
            requestTimeout: 10_000,
            clientName: 'transition-run-bench',
        };
        if (cfg.password) {
            glideConfig.credentials = {
                username: cfg.username ?? 'default',
                password: cfg.password,
            };
        }
        glideClient = await GlideClient.createClient(glideConfig);
        await luaLoader.load();
    }, 30_000);

    afterAll(async () => {
        if (glideClient) glideClient.close();
    });

    test('transition-run.lua pending→active (single invocation)', async ({ bench }) => {
        await bench('transition-run.lua pending→active (single invocation)', async () => {
            // Each iteration uses a unique run ID to avoid state collisions.
            ++runCounter;
            const ak = activeKey(`r${runCounter}`);
            const tk = terminalKey(`r${runCounter}`);

            // Seed the run hash.
            await glideClient.hset(ak, { state: 'pending' });

            // Measure just the Lua script invocation.
            await luaLoader.invoke(
                'transition-run',
                [ak, tk],
                ['pending', 'active', ACTIVE_TTL, TERMINAL_TTL],
                glideClient as unknown as ValkeyLike,
            );

            // Cleanup.
            await glideClient.del([ak]);
        }).run({
            iterations: 1000,
            time: 0, // Let vitest run the fixed iteration count.
        });
    });

    test('transition-run.lua active→completed (terminal move)', async ({ bench }) => {
        await bench('transition-run.lua active→completed (terminal move)', async () => {
            const _id = `${PREFIX}t${++runCounter}`;
            const ak = activeKey(`t${runCounter}`);
            const tk = terminalKey(`t${runCounter}`);

            await glideClient.hset(ak, {
                state: 'active',
                taskId: 'bench-task',
            });

            await luaLoader.invoke(
                'transition-run',
                [ak, tk],
                ['active', 'completed', ACTIVE_TTL, TERMINAL_TTL],
                glideClient as unknown as ValkeyLike,
            );

            // Terminal key cleanup.
            await glideClient.del([tk]);
        }).run({
            iterations: 1000,
            time: 0,
        });
    });
});

// Baseline capture lives in baselines.integration.test.ts, which runs the same
// measurement loop under the integration harness.
