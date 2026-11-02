// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SPIKE — PG-authoritative vs Lua-authoritative lifecycle transition latency.
 *
 * Companion to an internal architecture analysis.
 *
 * Question this spike answers: if we make Postgres authoritative for run/stage
 * lifecycle state (a transactional SQL CAS) instead of Valkey (transition-run.lua
 * EVALSHA), what is the per-transition latency cost at the documented concurrency?
 *
 * THREE ARMS (see §4.1 of the analysis):
 *   A — Lua baseline:   transition-run.lua EVALSHA against live Valkey.
 *   B — PG proposed:    UPDATE task_history ... WHERE state=$from RETURNING state.
 *   C — PG contention:  SELECT count(*) WHERE task_id=$t AND state='active'  (the
 *                       concurrency-gate probe) immediately before the UPDATE,
 *                       all hitting the SAME task_id → worst-case table contention.
 *
 * GO / NO-GO (see §4.3):
 *   Arm B p95 (N=16) < 5ms  → lifecycle-to-PG viable.
 *   Arm C p95 (N=64) < 10ms → concurrency counters may also move to PG.
 *
 * SAFETY (read before running):
 *   - No-ops unless BOTH `CACHE_URL` and `TEST_DATABASE_URL` are set.
 *   - REFUSES to run if TEST_DATABASE_URL does not name a database ending in
 *     `_tests` (guards against ever pointing at prod).
 *   - Inserts and deletes ONLY its own rows, all prefixed `bench:pgtr:<ts>:` in
 *     the `id` and `task_id = 'bench-pgtr'`. Cleans up in afterAll.
 *   - Requires `task_history` to exist (run db:test:migrate first).
 *
 * Run locally:
 *   CACHE_URL=redis://localhost:6379 \
 *   TEST_DATABASE_URL=postgres://lumastra:pass@localhost:5432/lumastra_tests \
 *   npm run bench -- src/lib/server/tasks/perf/pg-vs-lua-transition.bench.ts
 *
 * Run against a remote test database (still lumastra_tests, never a production DB):
 *   open an SSH tunnel to its Postgres, then point this bench at the tunnelled port.
 *
 * This file is a SPIKE: it is intentionally standalone and does NOT wire into the
 * orchestrator. It measures the transition primitive in isolation, which is the
 * correct first cut before any migration is designed.
 */

// Vitest 5 removed the top-level `bench` import: a benchmark is now declared with
// the `bench` fixture inside a regular `test()` in a `*.bench.ts` file, and started
// with `.run()`. The measured bodies and their iteration counts are unchanged.
import { test, describe, beforeAll, afterAll } from 'vitest';
import { GlideClient } from '@valkey/valkey-glide';
import postgres from 'postgres';
import { luaLoader } from '../lua/loader.js';
import { type ValkeyLike } from '../valkey-types.js';

// ── Guards ──────────────────────────────────────────────────────────────────

const CACHE_URL = process.env.CACHE_URL ?? '';
const PG_URL = process.env.TEST_DATABASE_URL ?? '';

/**
 * Hard refusal to run against anything that isn't an explicit *_tests database.
 * Mirrors the test-integration safety rule. If the URL
 * cannot be parsed or the db name doesn't end in `_tests`, the whole suite
 * no-ops — we never want this inserting rows into a real task_history.
 */
function isSafeTestDb(url: string): boolean {
    try {
        const u = new URL(url);
        const dbName = u.pathname.replace(/^\//, '');
        return dbName.endsWith('_tests');
    } catch {
        return false;
    }
}

const RUN = Boolean(CACHE_URL) && Boolean(PG_URL) && isSafeTestDb(PG_URL);

if (PG_URL && !isSafeTestDb(PG_URL)) {
    // Loud, but don't throw at import time (would break unrelated bench runs).
    // The describe.runIf below skips; this line just explains the skip.

    console.warn(
        '[pg-vs-lua-transition] SKIPPED: TEST_DATABASE_URL does not name a *_tests ' +
            'database. This spike refuses to run against any other DB.',
    );
}

// ── Valkey connection helpers (mirrors transition-run.bench.ts) ───────────────

function parseValkeyUrl(
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PREFIX = `bench:pgtr:${Date.now()}:`;
const BENCH_TASK_ID = 'bench-pgtr';
const ACTIVE_TTL = '900000';
const TERMINAL_TTL = '3600000';

let glideClient: GlideClient;
let sql: postgres.Sql;
let counter = 0;

function activeKey(runId: string): string {
    return `task:run:active:${runId}`;
}
function terminalKey(runId: string): string {
    return `task:run:terminal:${runId}`;
}

/** Minimal valid task_history row for the bench. Columns match the insert in
 *  pending-write-drain.replayInsert (the canonical minimal column set). */
async function seedPgRow(id: string, state: string): Promise<void> {
    await sql`
        INSERT INTO task_history (
            id, task_id, label, state, input, trigger, actor,
            started_at, heartbeat_at, processing_version, retention_policy, stages
        ) VALUES (
            ${id}, ${BENCH_TASK_ID}, 'pgtr-bench', ${state},
            ${sql.json({})}, ${sql.json({ kind: 'in-process' })}, ${sql.json({ type: 'system' })},
            NOW(), NOW(), '1', 'standard', ${sql.json([])}
        )
        ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state
    `;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.runIf(RUN)('PG-vs-Lua lifecycle transition (spike §4)', () => {
    beforeAll(async () => {
        const cfg = parseValkeyUrl(CACHE_URL);
        if (!cfg) throw new Error(`Cannot parse CACHE_URL: ${CACHE_URL}`);
        const glideConfig: Parameters<typeof GlideClient.createClient>[0] = {
            addresses: [{ host: cfg.host, port: cfg.port }],
            requestTimeout: 10_000,
            clientName: 'pg-vs-lua-transition-bench',
        };
        if (cfg.password) {
            glideConfig.credentials = {
                username: cfg.username ?? 'default',
                password: cfg.password,
            };
        }
        glideClient = await GlideClient.createClient(glideConfig);
        await luaLoader.load();

        sql = postgres(PG_URL, { max: 16, onnotice: () => {} });
        // Sanity: table must exist. Fail fast with a clear message otherwise.
        await sql`SELECT 1 FROM task_history LIMIT 1`;
    }, 30_000);

    afterAll(async () => {
        // Clean up ONLY our own rows + keys.
        try {
            await sql`DELETE FROM task_history WHERE task_id = ${BENCH_TASK_ID}`;
        } catch {
            /* best-effort cleanup */
        }
        if (sql) await sql.end({ timeout: 5 });
        if (glideClient) glideClient.close();
    });

    // ── Arm A: Lua baseline (active→completed terminal move) ──────────────────
    test('A) Lua transition-run.lua active→completed', async ({ bench }) => {
        await bench('A) Lua transition-run.lua active→completed', async () => {
            const id = `${PREFIX}A${++counter}`;
            const ak = activeKey(id);
            const tk = terminalKey(id);
            await glideClient.hset(ak, {
                state: 'active',
                taskId: BENCH_TASK_ID,
            });
            await luaLoader.invoke(
                'transition-run',
                [ak, tk],
                ['active', 'completed', ACTIVE_TTL, TERMINAL_TTL],
                glideClient as unknown as ValkeyLike,
            );
            await glideClient.del([tk]);
        }).run({ iterations: 1000, time: 0 });
    });

    // ── Arm B: PG CAS UPDATE active→completed ─────────────────────────────────
    test('B) PG UPDATE ... WHERE state=$from RETURNING (single-row CAS)', async ({ bench }) => {
        await bench('B) PG UPDATE ... WHERE state=$from RETURNING (single-row CAS)', async () => {
            const id = `${PREFIX}B${++counter}`;
            await seedPgRow(id, 'active');
            // The proposed authoritative transition: compare-and-swap on state.
            await sql`
                    UPDATE task_history
                       SET state = 'completed',
                           completed_at = NOW(),
                           heartbeat_at = NOW()
                     WHERE id = ${id}
                       AND state = 'active'
                    RETURNING state
                `;
            await sql`DELETE FROM task_history WHERE id = ${id}`;
        }).run({ iterations: 1000, time: 0 });
    });

    // ── Arm C: PG concurrency-gate probe (count(*) + UPDATE, same task_id) ─────
    // Worst-case table contention: every iteration counts active rows for the
    // SAME task_id before transitioning. This isolates the one operation (§1.6)
    // that decides whether concurrency counters can also move to PG.
    test('C) PG count(*) active gate + UPDATE (same task_id contention)', async ({ bench }) => {
        await bench('C) PG count(*) active gate + UPDATE (same task_id contention)', async () => {
            const id = `${PREFIX}C${++counter}`;
            await seedPgRow(id, 'active');
            // Concurrency gate read (what a PG-authoritative budget check would do).
            await sql`
                    SELECT count(*)::int AS n
                    FROM task_history
                    WHERE task_id = ${BENCH_TASK_ID} AND state = 'active'
                `;
            await sql`
                    UPDATE task_history
                       SET state = 'completed', completed_at = NOW()
                     WHERE id = ${id} AND state = 'active'
                    RETURNING state
                `;
            await sql`DELETE FROM task_history WHERE id = ${id}`;
        }).run({ iterations: 1000, time: 0 });
    });
});
