// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the Postgres-backed daily-run quota (TASK-C4).
 *
 * Verifies that `acquireDailyQuotaSlot` enforces `maxRunsPerDay` atomically in
 * Postgres (durable, eviction-proof) — the cap can no longer be bypassed the way
 * the old TTL'd Valkey counter could be when evicted under memory pressure.
 *
 * Run with: npm run test:integration src/lib/server/database/queries/task-quota.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { acquireDailyQuotaSlot, releaseDailyQuotaSlot } from './task-quota.queries.js';

const GLOBAL_TENANT = '00000000-0000-0000-0000-000000000000';

function todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
}

async function readRuns(sql: postgres.Sql, taskId: string): Promise<number | null> {
    const rows = await sql<{ runs: number }[]>`
        SELECT runs FROM task_quota_usage
        WHERE task_id = ${taskId} AND tenant_id = ${GLOBAL_TENANT} AND day = ${todayUTC()}
    `;
    return rows[0]?.runs ?? null;
}

describe('Task Quota Queries (TASK-C4)', () => {
    let sql: postgres.Sql;
    const taskId = `quota-test-${Date.now()}`;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['task_quota_usage']);
    });

    it('reserves slots up to the cap, then rejects', async () => {
        const cap = 3;
        const r1 = await acquireDailyQuotaSlot(sql, taskId, cap);
        const r2 = await acquireDailyQuotaSlot(sql, taskId, cap);
        const r3 = await acquireDailyQuotaSlot(sql, taskId, cap);
        expect([r1.acquired, r2.acquired, r3.acquired]).toEqual([true, true, true]);
        expect([r1.runs, r2.runs, r3.runs]).toEqual([1, 2, 3]);

        // 4th must be rejected and must NOT increment the row past the cap.
        const r4 = await acquireDailyQuotaSlot(sql, taskId, cap);
        expect(r4.acquired).toBe(false);
        expect(await readRuns(sql, taskId)).toBe(cap);

        // Still rejected on subsequent attempts (no slow leak past the cap).
        const r5 = await acquireDailyQuotaSlot(sql, taskId, cap);
        expect(r5.acquired).toBe(false);
        expect(await readRuns(sql, taskId)).toBe(cap);
    });

    it('release decrements the counter and frees a slot', async () => {
        const cap = 1;
        const first = await acquireDailyQuotaSlot(sql, taskId, cap);
        expect(first.acquired).toBe(true);

        // Cap reached.
        expect((await acquireDailyQuotaSlot(sql, taskId, cap)).acquired).toBe(false);

        // Releasing the reserved slot frees capacity again.
        await releaseDailyQuotaSlot(sql, taskId);
        expect(await readRuns(sql, taskId)).toBe(0);

        const reacquired = await acquireDailyQuotaSlot(sql, taskId, cap);
        expect(reacquired.acquired).toBe(true);
        expect(reacquired.runs).toBe(1);
    });

    it('release clamps at zero (no negative counter that could leak past the cap)', async () => {
        // Release with no prior acquire on an existing zero row.
        await acquireDailyQuotaSlot(sql, taskId, 5);
        await releaseDailyQuotaSlot(sql, taskId);
        await releaseDailyQuotaSlot(sql, taskId); // extra/double release
        expect(await readRuns(sql, taskId)).toBe(0);
    });

    it('enforces the cap atomically under concurrent acquires (no overshoot)', async () => {
        const cap = 5;
        const attempts = 20;
        const results = await Promise.all(
            Array.from({ length: attempts }, () => acquireDailyQuotaSlot(sql, taskId, cap)),
        );
        const acquired = results.filter((r) => r.acquired).length;
        // Exactly `cap` slots may be reserved no matter the interleaving.
        expect(acquired).toBe(cap);
        expect(await readRuns(sql, taskId)).toBe(cap);
    });
});
