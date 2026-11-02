// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test — F2: BullMQ Worker slot reclaim after a wedged in-process run.
 *
 * Proves the F2 fix in `runner.ts`: when the wall-clock watchdog auto-fails a
 * wedged IN-PROCESS run (an `execute()` whose promise never settles and ignores
 * `ctx.signal`), `autoFailRun` fires a per-run "watchdog trip" that rejects
 * `processJob`'s execute race with `UnrecoverableError`. BullMQ then
 * `moveToFailed`s the job, which FREES the Worker concurrency slot immediately —
 * instead of the pre-fix behaviour where the never-settling promise held the
 * slot until container restart.
 *
 * The task declares `quotas.maxConcurrent: 1`, so its per-task Worker runs at
 * concurrency 1: while run A holds the slot, run B cannot be picked up. The F2
 * proof is that run B reaches `active` (i.e. leaves `pending`) shortly after
 * A is watchdog-failed — direct evidence the slot was reclaimed. Before the fix,
 * B would stay `pending` forever.
 *
 * Requires TEST_DATABASE_URL + CACHE_URL (skipped otherwise).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { TaskRunner } from './runner.js';
import {
    PER_TASK_QUEUE_PREFIX,
    QUEUE_PREFIX,
    perTaskQueueName,
    taskQueueName,
} from './queue-naming.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { FEATURE_PER_TASK_QUEUES } from '$lib/server/config.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

// Declared wall-clock hard cap for the wedged task. Short so the watchdog fires
// quickly in the test; the sampler period is min(heartbeatIntervalMs, hardMs).
const HARD_TIMEOUT = '2s';
const SOFT_TIMEOUT = '1s';
// Time we allow the watchdog to fire + the terminal 'failed' row to land in PG:
// hard cap (2s) + sampler + PG round-trip.
const AUTOFAIL_BUDGET_MS = 12_000;
// Heartbeat/deadline sampler cadence. Kept well below the hard cap so the
// dedicated deadline sampler fires close to the declared 2s.
const HEARTBEAT_INTERVAL_MS = 250;

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(
    sql: postgres.Sql,
    runId: string,
    targetStates: string[],
    timeoutMs: number,
): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = await sql<{ state: string }[]>`
            SELECT state FROM task_history WHERE id = ${runId}
        `;
        const state = rows[0]?.state;
        if (state && targetStates.includes(state)) return state;
        await sleep(100);
    }
    return null;
}

/**
 * Build a producer-side Queue handle on the SAME queue the runner's Worker polls
 * so the test can read `getActiveCount()`. Per-task queue when the flag is on
 * (the default + the F2 scenario), else the legacy per-class queue.
 */
function buildQueueForTask(taskId: string): Queue | null {
    const connection = getQueueConnectionOptions();
    if (!connection) return null;
    if (FEATURE_PER_TASK_QUEUES) {
        return new Queue(perTaskQueueName(taskId), {
            connection,
            prefix: PER_TASK_QUEUE_PREFIX,
        });
    }
    return new Queue(taskQueueName('io'), { connection, prefix: QUEUE_PREFIX });
}

/**
 * A throwaway task whose `execute` is an ASYNC wedge: it returns a never-settling
 * promise and ignores `ctx.signal`. The event loop keeps running (unlike a
 * synchronous busy-loop), so the wall-clock watchdog's dedicated sampler CAN fire
 * and auto-fail it. No `isolation` — this is the in-process path F2 targets.
 */
function makeWedgeTask(taskId: string) {
    return defineTask({
        id: taskId,
        name: 'F2 Async Wedge',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        quotas: { maxConcurrent: 1 },
        timeout: { hard: HARD_TIMEOUT, soft: SOFT_TIMEOUT },
        inputSchema: z.object({ scope: z.string() }),
        identityFor: (input) => (input as { scope: string }).scope,
        async execute() {
            // Never settles, never checks ctx.signal — an async wedge the
            // wall-clock watchdog must catch and whose slot F2 must reclaim.
            await new Promise(() => {});
            return { success: true };
        },
    });
}

describe.runIf(RUN)('F2 — BullMQ Worker slot reclaim after wedged in-process run', () => {
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
        await sql`DELETE FROM task_history WHERE task_id LIKE 'f2-slot-reclaim-test-%'`;
    });

    it('reclaims the slot: run B goes active after the watchdog auto-fails a wedged run A', async () => {
        const taskId = `f2-slot-reclaim-test-${ulid().toLowerCase()}`;
        const registry = new TaskRegistry();
        registry.registerTask(makeWedgeTask(taskId));

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
            instanceId: 'f2-integration-test',
            bootId: ulid(),
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            subscribe: async () => null,
        });

        const queue = buildQueueForTask(taskId);

        try {
            // ── Run A: start and wait for it to reach `active`. ──────────
            const { runId: runIdA } = await orch.startRun(taskId, { scope: 'f2-a' });
            expect(runIdA).toMatch(/^run_/);

            const activeA = await waitForState(sql, runIdA, ['active'], 10_000);
            expect(activeA).toBe('active');

            // ── The wall-clock watchdog must auto-fail the wedged A. ─────
            const failedA = await waitForState(sql, runIdA, ['failed'], AUTOFAIL_BUDGET_MS);
            expect(failedA).toBe('failed');

            // ── Direct slot evidence (per-task queue only): the BullMQ ───
            // active count returns to 0 once F2's watchdog-trip moves A's
            // job to 'failed'. The DB flip to 'failed' happens just BEFORE
            // the trip fires, so poll briefly for the count to drain.
            if (queue && FEATURE_PER_TASK_QUEUES) {
                let activeCount = await queue.getActiveCount();
                const countDeadline = Date.now() + 5_000;
                while (activeCount > 0 && Date.now() < countDeadline) {
                    await sleep(100);
                    activeCount = await queue.getActiveCount();
                }
                expect(activeCount).toBe(0);
            }

            // ── The F2 proof: run B of the SAME task must now be picked ──
            // up. Pre-fix, A's dead slot would keep B stuck in `pending`
            // forever. Reaching `active` (or racing straight to a terminal
            // on a slow host) proves the slot was reclaimed.
            const { runId: runIdB } = await orch.startRun(taskId, { scope: 'f2-b' });
            expect(runIdB).toMatch(/^run_/);

            const pickedUpB = await waitForState(
                sql,
                runIdB,
                ['active', 'completed', 'failed'],
                10_000,
            );
            expect(['active', 'completed', 'failed']).toContain(pickedUpB);
        } finally {
            await runner.stop();
            await orch.stop();
            if (queue) {
                await queue.obliterate({ force: true }).catch(() => undefined);
                await queue.close();
            }
        }
    }, 60_000);

    it('no cumulative slot loss: maxConcurrent+1 sequential wedges each reclaim their slot', async () => {
        const taskId = `f2-slot-reclaim-test-seq-${ulid().toLowerCase()}`;
        const registry = new TaskRegistry();
        registry.registerTask(makeWedgeTask(taskId));

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
            instanceId: 'f2-integration-test',
            bootId: ulid(),
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            subscribe: async () => null,
        });

        const queue = buildQueueForTask(taskId);

        try {
            // maxConcurrent is 1, so run N+1 = 2 wedges sequentially. Each
            // must reach `active` (slot acquired) and then be watchdog-failed
            // (slot released) — proving the slot cycles with no permanent
            // loss. A distinct `scope` per run avoids identity-dedup so each
            // enqueues a fresh run.
            const CYCLES = 2; // maxConcurrent (1) + 1
            for (let i = 0; i < CYCLES; i++) {
                const { runId } = await orch.startRun(taskId, { scope: `f2-seq-${i}` });
                expect(runId).toMatch(/^run_/);

                const active = await waitForState(sql, runId, ['active'], 12_000);
                expect(active).toBe('active');

                const failed = await waitForState(sql, runId, ['failed'], AUTOFAIL_BUDGET_MS);
                expect(failed).toBe('failed');
            }

            // After all cycles the Worker slot is free — active count is 0.
            if (queue && FEATURE_PER_TASK_QUEUES) {
                let activeCount = await queue.getActiveCount();
                const countDeadline = Date.now() + 5_000;
                while (activeCount > 0 && Date.now() < countDeadline) {
                    await sleep(100);
                    activeCount = await queue.getActiveCount();
                }
                expect(activeCount).toBe(0);
            }
        } finally {
            await runner.stop();
            await orch.stop();
            if (queue) {
                await queue.obliterate({ force: true }).catch(() => undefined);
                await queue.close();
            }
        }
    }, 60_000);
});
