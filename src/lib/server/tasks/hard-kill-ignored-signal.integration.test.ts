// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test — hard-kill when task ignores abort signal (Test 6).
 *
 * Registers a synthetic task that blocks for 30s and never checks ctx.signal.
 * Starts a run, waits a moment, then triggers cancelRun with `hard: true`.
 * Asserts that the run reaches a terminal state within the hard-kill budget.
 *
 * Requires TEST_DATABASE_URL + CACHE_URL (skipped otherwise).
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

// Hard-kill fires after this many ms if the task ignores the abort signal.
// We use a short value in tests; production default is 60_000.
const TEST_HARD_KILL_GRACE_MS = 2_000;

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(RUN)('Hard-kill when task ignores abort signal', () => {
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
        await sql`DELETE FROM task_history WHERE task_id LIKE 'hard-kill-test-%'`;
    });

    it(
        'run transitions to a terminal state within hard-kill budget when task ignores signal',
        async () => {
            const taskId = `hard-kill-test-${ulid().toLowerCase()}`;
            const registry = new TaskRegistry();

            registry.registerTask(
                defineTask({
                    id: taskId,
                    name: 'Signal-Ignoring Task',
                    version: '1.0.0',
                    processingVersion: 1,
                    minAppVersion: '1.0.0',
                    capabilities: {},
                    resourceClass: 'io',
                    inputSchema: z.object({ scope: z.string() }),
                    identityFor: (input) => (input as { scope: string }).scope,
                    async execute() {
                        // Intentionally does NOT check ctx.signal.
                        await new Promise((resolve) => setTimeout(resolve, 30_000));
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
                const { runId } = await orch.startRun(taskId, {
                    scope: 'hk-1',
                });
                expect(runId).toMatch(/^run_/);

                // Let the task pick up the job and enter active state.
                await sleep(200);

                // Trigger hard cancel. The orchestrator schedules a hard-kill timer.
                const cancelResult = await orch.cancelRun(runId, {
                    hard: true,
                });
                expect(cancelResult.accepted).toBe(true);
                // The deferred hard-kill path must be indicated.
                expect(cancelResult.deferred).toBe('hard-kill');

                // Wait for hard-kill to fire and terminal state to land in Postgres.
                // Budget: TEST_HARD_KILL_GRACE_MS + 5s for BullMQ/Postgres round-trip.
                const deadline = Date.now() + TEST_HARD_KILL_GRACE_MS + 5_000;
                let finalState: string | null = null;

                while (Date.now() < deadline) {
                    await sleep(200);
                    const rows = await sql<{ state: string }[]>`
                        SELECT state FROM task_history WHERE id = ${runId}
                    `;
                    const state = rows[0]?.state ?? null;
                    if (state === 'cancelled' || state === 'failed' || state === 'completed') {
                        finalState = state;
                        break;
                    }
                }

                // Run must have reached a terminal state within the budget.
                expect(['cancelled', 'failed', 'completed']).toContain(finalState);
            } finally {
                await orch.stop();
            }
        },
        // Generous timeout: hard-kill grace + Postgres latency + task startup time.
        TEST_HARD_KILL_GRACE_MS + 15_000,
    );
});
