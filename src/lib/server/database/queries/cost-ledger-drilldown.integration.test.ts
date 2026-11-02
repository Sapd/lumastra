// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the cost drill-down query (Slice 3 §4.5, §9).
 *
 * Real Postgres `lumastra_tests`. Asserts listRecentCostlyRuns surfaces recent
 * runs (with cost-unit filter) and that the page-load's ghost-metric `isKnown`
 * flag matches the SDK's COST_KINDS.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { COST_KINDS } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { listRecentCostlyRuns } from './cost-ledger.queries.js';

const KNOWN = new Set<string>(COST_KINDS);

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

describe('listRecentCostlyRuns (cost drill-down)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'it-cost-%'`;
    });

    afterAll(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE 'it-cost-%'`;
        await closeTestDb();
    });

    it('returns recent runs that recorded a cost_breakdown, newest first', async () => {
        await seedCostRun(sql, 'it-cost-task', { openai_tokens: 100 }, 5);
        await seedCostRun(sql, 'it-cost-task', { api_calls: 3 }, 1);

        const runs = (await listRecentCostlyRuns(sql, { limit: 50 })).filter((r) =>
            r.taskId.startsWith('it-cost'),
        );
        expect(runs.length).toBeGreaterThanOrEqual(2);
        // newest first
        expect(runs[0].completedAt.getTime()).toBeGreaterThan(runs[1].completedAt.getTime());
    });

    it('filters by cost unit', async () => {
        await seedCostRun(sql, 'it-cost-a', { openai_tokens: 100 });
        await seedCostRun(sql, 'it-cost-b', { api_calls: 3 });

        const onlyTokens = (
            await listRecentCostlyRuns(sql, {
                limit: 50,
                costUnit: 'openai_tokens',
            })
        ).filter((r) => r.taskId.startsWith('it-cost'));
        expect(onlyTokens.every((r) => 'openai_tokens' in r.costBreakdown)).toBe(true);
        expect(onlyTokens.some((r) => r.taskId === 'it-cost-b')).toBe(false);
    });

    it('flags ghost metrics (units not in SDK COST_KINDS) as isKnown=false', async () => {
        await seedCostRun(sql, 'it-cost-ghost', {
            openai_tokens: 100,
            gpu_hours: 4,
        });

        const run = (await listRecentCostlyRuns(sql, { limit: 50 })).find(
            (r) => r.taskId === 'it-cost-ghost',
        );
        expect(run).toBeDefined();
        // Replicate the page-load isKnown mapping.
        const flags = Object.keys(run!.costBreakdown).map((unit) => ({
            unit,
            isKnown: KNOWN.has(unit),
        }));
        expect(flags.find((f) => f.unit === 'openai_tokens')?.isKnown).toBe(true);
        expect(flags.find((f) => f.unit === 'gpu_hours')?.isKnown).toBe(false);
    });
});
