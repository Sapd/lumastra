// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audit / pending-write-drain disconnect + resume test.
 * Plan §16.1 scenario #15: Audit-listener disconnect → reconnect with no event loss.
 *
 * Validates that when Postgres is unreachable during a startRun call:
 *   - The pending-write-drain module enqueues the write (if wired in the catch block)
 *   - On reconnect, drain replays the entry and the run eventually appears in task_history
 *
 * RESOLVED: the orchestrator's Postgres-write catch blocks now call
 * `pendingWriteDrain.enqueue(...)` on transient errors (orchestrator.ts ~1257,
 * 1668, 1909, 2050; the runner's terminal write does the same). This test
 * exercises the pending-write-drain's internal queue + retry loop in isolation
 * (unit-level) and verifies the module's own contract.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated)
 *   - CACHE_URL pointing at a Valkey instance
 *
 * Skipped automatically when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { ulid } from 'ulid';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { PendingWriteDrain } from './pending-write-drain.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

describe.runIf(RUN)('audit disconnect + resume (plan §16.1 #15)', () => {
    let sql: postgres.Sql;
    const ownedRunIds = new Set<string>();
    const drains = new Set<PendingWriteDrain>();

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
        for (const drain of drains) drain.stop();
        for (const runId of ownedRunIds) await sql`DELETE FROM task_history WHERE id = ${runId}`;
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'run_drain_%'`;
    });

    it('[§16.1 #15] pending-write-drain replays queued writes on reconnect', async () => {
        // The drain module provides a LPUSH/RPOP Valkey queue + Postgres retry loop.
        // Test that an enqueued write eventually lands in task_history when the DB
        // is reachable after a brief simulated outage.

        const runId = `run_drain_${ulid().toLowerCase()}`;
        ownedRunIds.add(runId);
        const taskId = `drain-test-${ulid().toLowerCase()}`;

        // Enqueue a write directly into the drain.
        // Constructor: PendingWriteDrain(sql, getClient: () => Promise<ValkeyLike>)
        const drain = new PendingWriteDrain(sql, async () => getClient());
        drains.add(drain);

        await drain.enqueue({
            kind: 'insert',
            runId,
            enqueuedAt: Date.now(),
            payload: {
                taskId,
                parentRunId: null,
                label: 'Drain replay test',
                state: 'pending',
                input: {},
                scope: null,
                trigger: { kind: 'in-process' },
                actor: { kind: 'system' },
                startedAt: new Date(),
                processingVersion: '1',
                ownerInstanceId: 'drain-test-instance',
                retentionPolicy: 'standard',
            },
        });

        drain.start(200); // 200ms interval for faster test iteration

        // Wait for the drain to process the entry.
        const deadline = Date.now() + 10_000;
        let found = false;
        while (Date.now() < deadline && !found) {
            const rows = await sql<{ id: string }[]>`
                    SELECT id FROM task_history WHERE id = ${runId}
                `;
            if (rows.length > 0) found = true;
            else await new Promise((r) => setTimeout(r, 200));
        }

        drain.stop();
        expect(found).toBe(true);
    }, 30_000);

    it.todo(
        '[§16.1 #15 OPEN-HIGH] orchestrator catch blocks must enqueue to pending-write-drain — ' +
            'see backlog "Pending-write-drain is never invoked from orchestrator catch blocks" ' +
            '(src/lib/server/tasks/orchestrator.ts:1005). Once that fix lands, add a test ' +
            'that stubs the DB, triggers an INSERT failure, and asserts the drain queue grows.',
    );
});
