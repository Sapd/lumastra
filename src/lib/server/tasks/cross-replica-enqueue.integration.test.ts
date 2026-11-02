// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test — cross-replica simultaneous enqueue race (Test 1).
 *
 * Two TaskOrchestrator instances sharing the same BullMQ queue + Postgres
 * race to start a run with the same identityFor output. Only one row must
 * land in task_history; the loser must return deduped:true.
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

const getClient = () =>
    getCoordinationClient() as unknown as {
        customCommand: (cmd: string[]) => Promise<unknown>;
    };

describe.runIf(RUN)('Cross-replica simultaneous enqueue race', () => {
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
        await sql`DELETE FROM task_history WHERE task_id LIKE 'race-test-%'`;
        // Isolate from sibling test files sharing this Valkey instance: a
        // leftover enqueue-with-identity dedup key (or a script cache flushed
        // by another file) would otherwise make both racers dedup against
        // phantom state, breaking the "exactly one row" invariant. Serial file
        // execution (fileParallelism:false) makes a full FLUSHDB safe here.
        await getCoordinationClient()!.customCommand(['FLUSHDB']);
    });

    it('exactly one task_history row when two orchestrators call startRun simultaneously for the same scope', async () => {
        const taskId = `race-test-${ulid().toLowerCase()}`;
        ownedTaskIds.add(taskId);

        function makeRegistry(): TaskRegistry {
            const registry = new TaskRegistry();
            registry.registerTask(
                defineTask({
                    id: taskId,
                    name: 'Race Smoke',
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
            return registry;
        }

        const orchA = await TaskOrchestrator.start(['io'], {
            registry: makeRegistry(),
            stateMachine,
            getSql: () => sql,
            getClient,
        });

        const orchB = await TaskOrchestrator.start(['io'], {
            registry: makeRegistry(),
            stateMachine,
            getSql: () => sql,
            getClient,
        });

        try {
            // Both replicas race to claim the same scope.
            const [resultA, resultB] = await Promise.all([
                orchA.startRun(taskId, { scope: 'lib-1' }),
                orchB.startRun(taskId, { scope: 'lib-1' }),
            ]);

            const rows = await sql<{ id: string }[]>`
                    SELECT id FROM task_history WHERE task_id = ${taskId}
                `;

            // One row total — the dedup key is the identity formula.
            expect(rows).toHaveLength(1);

            // The winner and loser must agree on the canonical runId.
            const winnerRunId = rows[0].id;
            expect([resultA.runId, resultB.runId]).toContain(winnerRunId);

            // Both results report the SAME canonical runId — the loser's dedup
            // returns the winner's runId — so winner/loser must be identified by
            // the `deduped` flag, NOT by runId (both equal winnerRunId). The
            // length-1 check above guarantees exactly one non-deduped creator.
            const winner = resultA.deduped ? resultB : resultA;
            const loser = resultA.deduped ? resultA : resultB;

            expect(winner.deduped).toBeFalsy();
            expect(loser.deduped).toBe(true);
            // Both runIds must point at the single canonical row.
            expect(winner.runId).toBe(winnerRunId);
            expect(loser.runId).toBe(winnerRunId);
        } finally {
            await orchA.stop();
            await orchB.stop();
        }
    }, 30_000);
});
