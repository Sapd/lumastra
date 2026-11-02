// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Cost Ledger Query Module
 *
 * Tests listCostAggregations and listRecentCostlyRuns against a real
 * PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import { listCostAggregations, listRecentCostlyRuns } from './cost-ledger.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

async function seedCostRun(
    sql: postgres.Sql,
    taskId: string,
    breakdown: Record<string, number>,
    ageMinutes = 0,
): Promise<void> {
    const id = `it-cost-${Date.now()}-${seq++}`;
    await sql`
        INSERT INTO task_history (
            id, task_id, label, state, input, trigger, actor, processing_version,
            started_at, completed_at, cost_breakdown
        ) VALUES (
            ${id}, ${taskId}, ${taskId}, 'completed',
            ${sql.json({})}, ${sql.json({ kind: 'scheduled' })}, ${sql.json({ type: 'system' })}, '1',
            NOW() - (${ageMinutes + 1} || ' minutes')::interval,
            NOW() - (${ageMinutes} || ' minutes')::interval,
            ${sql.json(breakdown)}
        )
    `;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Cost Ledger Queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'it-cost-%'`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'it-cost-%'`;
    });

    // ========================================================================
    // listCostAggregations
    // ========================================================================

    describe('listCostAggregations', () => {
        it('returns empty array when no task_history rows exist', async () => {
            const rows = await listCostAggregations(sql, { sinceDays: 7 });
            expect(rows).toEqual([]);
        });

        it('aggregates costs by task_id and cost_unit', async () => {
            await seedCostRun(sql, 'task-a', { openai_tokens: 100 });
            await seedCostRun(sql, 'task-a', { openai_tokens: 200 });
            await seedCostRun(sql, 'task-b', { api_calls: 5 });

            const rows = await listCostAggregations(sql, { sinceDays: 7 });
            const filtered = rows.filter((r) => r.taskId.startsWith('task-'));

            expect(filtered.length).toBe(2);

            const taskA = filtered.find(
                (r) => r.taskId === 'task-a' && r.costUnit === 'openai_tokens',
            );
            expect(taskA).toBeDefined();
            expect(taskA!.totalUnits).toBe(300);
            expect(taskA!.runCount).toBe(2);

            const taskB = filtered.find((r) => r.taskId === 'task-b' && r.costUnit === 'api_calls');
            expect(taskB).toBeDefined();
            expect(taskB!.totalUnits).toBe(5);
            expect(taskB!.runCount).toBe(1);
        });

        it('ignores rows older than sinceDays', async () => {
            await seedCostRun(sql, 'old-task', { openai_tokens: 500 }, 60 * 24 * 10); // 10 days old
            await seedCostRun(sql, 'new-task', { openai_tokens: 100 }, 5); // 5 minutes old

            const rows = await listCostAggregations(sql, { sinceDays: 7 });
            const filtered = rows.filter(
                (r) => r.taskId.startsWith('old-task') || r.taskId.startsWith('new-task'),
            );

            expect(filtered.length).toBe(1);
            expect(filtered[0].taskId).toBe('new-task');
        });

        it('ignores rows with null cost_breakdown', async () => {
            const id = `it-cost-${Date.now()}-${seq++}`;
            await sql`
                INSERT INTO task_history (
                    id, task_id, label, state, input, trigger, actor, processing_version,
                    started_at, completed_at, cost_breakdown
                ) VALUES (
                    ${id}, 'null-task', 'null-task', 'completed',
                    ${sql.json({})}, ${sql.json({ kind: 'scheduled' })}, ${sql.json({ type: 'system' })}, '1',
                    NOW(), NOW(), NULL
                )
            `;
            await seedCostRun(sql, 'has-cost', { openai_tokens: 50 });

            const rows = await listCostAggregations(sql, { sinceDays: 7 });
            const filtered = rows.filter(
                (r) => r.taskId === 'null-task' || r.taskId === 'has-cost',
            );

            expect(filtered.length).toBe(1);
            expect(filtered[0].taskId).toBe('has-cost');
        });

        it('orders results by total_units descending', async () => {
            await seedCostRun(sql, 'low-task', { tokens: 10 });
            await seedCostRun(sql, 'high-task', { tokens: 1000 });

            const rows = await listCostAggregations(sql, { sinceDays: 7 });
            const filtered = rows.filter(
                (r) => r.taskId === 'low-task' || r.taskId === 'high-task',
            );

            expect(filtered.length).toBe(2);
            expect(filtered[0].totalUnits).toBeGreaterThanOrEqual(filtered[1].totalUnits);
        });
    });

    // ========================================================================
    // listRecentCostlyRuns
    // ========================================================================

    describe('listRecentCostlyRuns', () => {
        it('returns empty array when no rows have cost_breakdown', async () => {
            const rows = await listRecentCostlyRuns(sql, { limit: 10 });
            const filtered = rows.filter((r) => r.taskId.startsWith('it-cost'));
            expect(filtered).toEqual([]);
        });

        it('returns recent runs ordered by completed_at descending', async () => {
            await seedCostRun(sql, 'older-run', { openai_tokens: 100 }, 10);
            await seedCostRun(sql, 'newer-run', { openai_tokens: 200 }, 1);

            const rows = (await listRecentCostlyRuns(sql, { limit: 50 })).filter(
                (r) => r.taskId === 'older-run' || r.taskId === 'newer-run',
            );

            expect(rows.length).toBe(2);
            expect(rows[0].completedAt.getTime()).toBeGreaterThan(rows[1].completedAt.getTime());
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                await seedCostRun(sql, `limit-task-${i}`, { tokens: 10 }, i);
            }

            const rows = (await listRecentCostlyRuns(sql, { limit: 2 })).filter((r) =>
                r.taskId.startsWith('limit-task'),
            );

            expect(rows.length).toBe(2);
        });

        it('filters by costUnit when provided', async () => {
            await seedCostRun(sql, 'filter-a', { openai_tokens: 100 });
            await seedCostRun(sql, 'filter-b', { gpu_hours: 2 });

            const rows = (
                await listRecentCostlyRuns(sql, {
                    limit: 50,
                    costUnit: 'openai_tokens',
                })
            ).filter((r) => r.taskId === 'filter-a' || r.taskId === 'filter-b');

            expect(rows.length).toBe(1);
            expect(rows[0].taskId).toBe('filter-a');
            expect(rows[0].costBreakdown).toHaveProperty('openai_tokens');
        });

        it('returns costBreakdown as an object even when empty', async () => {
            await seedCostRun(sql, 'empty-breakdown', { openai_tokens: 0 });

            const rows = (await listRecentCostlyRuns(sql, { limit: 50 })).filter(
                (r) => r.taskId === 'empty-breakdown',
            );

            expect(rows.length).toBe(1);
            expect(typeof rows[0].costBreakdown).toBe('object');
        });
    });
});
