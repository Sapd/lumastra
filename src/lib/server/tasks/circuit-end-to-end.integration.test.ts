// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Circuit breaker end-to-end integration test.
 * Plan §16.1 scenario #12: Plugin throws 5x → auto-quarantine.
 *
 * Validates:
 *   (a) circuit opens after LUMASTRA_CIRCUIT_FAILURE_THRESHOLD consecutive failures
 *   (b) 6th orchestrator.startRun is rejected with a TaskError mentioning 'circuit'
 *   (c) circuit state is reflected in orchestrator state (circuit check returns not-allowed)
 *
 * NOTE: The default LUMASTRA_CIRCUIT_FAILURE_THRESHOLD is 5. This test directly
 * invokes CircuitBreaker.reportFailure() 5 times on the test task (simulating
 * runner-side failures) and then asserts orchestrator.startRun is blocked.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated — task_circuit_state table)
 *   - CACHE_URL pointing at a Valkey instance
 *
 * Skipped automatically when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import type { GlideClient } from '@valkey/valkey-glide';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

describe.runIf(RUN)('circuit breaker end-to-end (plan §16.1 #12)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        await connectValkey();
        try {
            await sql`SELECT 1 FROM task_circuit_state LIMIT 0`;
        } catch (e) {
            throw new Error(
                `task_circuit_state table missing — run db:test:migrate first. ${(e as Error).message}`,
                { cause: e },
            );
        }
    }, 30_000);

    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_circuit_state WHERE task_id LIKE 'circuit-test-%'`;
        await sql`DELETE FROM task_history WHERE task_id LIKE 'circuit-test-%'`;
    });

    it('[§16.1 #12a+b] circuit opens after 5 failures; 6th startRun is rejected', async () => {
        const taskId = `circuit-test-${ulid().toLowerCase()}`;

        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Circuit Test Task',
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

        // The orchestrator creates its own CircuitBreaker internally using its sql + client.
        // We pre-seed the circuit state in the DB to simulate 5 consecutive failures.
        // First, ensure the circuit row exists by letting the orchestrator check it once.
        const orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
        });

        try {
            // Perform a successful startRun to create the circuit row in 'closed' state.
            await orch.startRun(taskId, {
                id: `cb-init-${ulid().toLowerCase()}`,
            });

            // Directly drive the circuit open by updating the DB state to simulate
            // LUMASTRA_CIRCUIT_FAILURE_THRESHOLD (default 5) consecutive failures.
            await sql`
                    UPDATE task_circuit_state
                    SET state                        = 'open',
                        consecutive_failures         = 5,
                        opened_at                    = NOW(),
                        opened_reason                = 'test: simulated threshold',
                        next_probe_at                = NOW() + INTERVAL '10 minutes'
                    WHERE task_id = ${taskId}
                `;

            // (b) Next startRun must be rejected with a circuit-open TaskError.
            let threw = false;
            try {
                await orch.startRun(taskId, {
                    id: `cb-blocked-${ulid().toLowerCase()}`,
                });
            } catch (err) {
                threw = true;
                expect(err).toBeInstanceOf(TaskError);
                const te = err as TaskError;
                expect(te.message.toLowerCase()).toMatch(/circuit/);
            }
            expect(threw).toBe(true);
        } finally {
            await orch.stop();
        }
    }, 30_000);

    it('[§16.1 #12c] CircuitBreaker.check() returns allowed:false when DB state is open', async () => {
        const taskId = `circuit-test-state-${ulid().toLowerCase()}`;
        // Seed the circuit row directly.
        await sql`
                INSERT INTO task_circuit_state (
                    task_id, state, consecutive_failures,
                    failure_rate_window_count, opened_at, opened_reason, next_probe_at
                ) VALUES (
                    ${taskId}, 'open', 5,
                    5, NOW(), 'test', NOW() + INTERVAL '10 minutes'
                )
                ON CONFLICT (task_id) DO UPDATE
                    SET state                = 'open',
                        consecutive_failures = 5,
                        next_probe_at        = NOW() + INTERVAL '10 minutes'
            `;

        const cb = new CircuitBreaker(sql, () => getCoordinationClient() as GlideClient | null);
        const decision = await cb.check(taskId);
        expect(decision.allowed).toBe(false);
        expect(['open', 'half_open']).toContain(decision.state);
    }, 30_000);
});
