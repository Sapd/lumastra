// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for TaskHistoryTrimService against a real PostgreSQL
 * database.
 *
 * Covers the DELETE...RETURNING-driven archive+delete rewrite in
 * `trimTaskHistory` (see task-history-trim.service.ts): a single-pass query
 * replaced the old "SELECT eligible, INSERT from eligible, DELETE WHERE id IN
 * (SELECT id FROM eligible)" shape, which re-scanned task_history twice. This
 * suite pins the externally observable behaviour that rewrite must preserve:
 * same rows archived, same rows deleted, same predicate (age + state +
 * optional task_id filter), idempotent re-run, and rows outside the predicate
 * left untouched.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/task-history-trim.service.integration.test.ts
 *
 * Run against preprod:
 *   npm run test:integration -- src/lib/server/services/task-history-trim.service.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { trimTaskHistory } from './task-history-trim.service.js';

let sql: postgres.Sql;

interface TaskHistorySeed {
    id: string;
    task_id: string;
    state: 'completed' | 'failed' | 'cancelled' | 'pending' | 'active';
    completedAt: Date | null;
}

async function seedTaskHistoryRow(row: TaskHistorySeed): Promise<void> {
    // `duration_ms` is a GENERATED column (`(completed_at - started_at)` in
    // ms, as `integer`) — started_at must stay close to completed_at or the
    // generated expression overflows int4 (~24.8 days in ms). Use a fixed
    // short run length instead of a shared started_at for every row.
    const startedAt = row.completedAt
        ? new Date(row.completedAt.getTime() - 60_000)
        : new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await sql`
        INSERT INTO task_history (
            id, task_id, label, state, input, trigger, actor,
            started_at, completed_at, processing_version
        ) VALUES (
            ${row.id}, ${row.task_id}, ${row.task_id}, ${row.state},
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            ${startedAt}, ${row.completedAt}, 'v1'
        )
    `;
}

async function cleanup(): Promise<void> {
    // Delete only this suite's rows. Other suites read task_history_archive, so
    // dropping the table here broke them when they ran later in the same database.
    const [{ exists }] = await sql<{ exists: boolean }[]>`
        SELECT to_regclass('task_history_archive') IS NOT NULL AS exists
    `;
    if (exists) {
        await sql`DELETE FROM task_history_archive WHERE id LIKE 'trim-test-%'`;
    }
    await sql`DELETE FROM task_history WHERE id LIKE 'trim-test-%'`;
}

describe('trimTaskHistory (integration)', () => {
    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanup();
        await closeTestDb();
    });

    beforeEach(async () => {
        await cleanup();
    });

    it('archives and deletes only rows matching the age+state predicate', async () => {
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

        // Eligible: old + terminal state.
        await seedTaskHistoryRow({
            id: 'trim-test-eligible-1',
            task_id: 'task-a',
            state: 'completed',
            completedAt: old,
        });
        await seedTaskHistoryRow({
            id: 'trim-test-eligible-2',
            task_id: 'task-b',
            state: 'failed',
            completedAt: old,
        });
        // NOT eligible: old but non-terminal state is impossible with
        // completed_at set, so instead cover "too recent" and "still active".
        await seedTaskHistoryRow({
            id: 'trim-test-too-recent',
            task_id: 'task-a',
            state: 'completed',
            completedAt: recent,
        });
        await seedTaskHistoryRow({
            id: 'trim-test-still-active',
            task_id: 'task-a',
            state: 'active',
            completedAt: null,
        });

        const result = await trimTaskHistory(sql, { olderThanDays: 30 });

        expect(result.kind).toBe('complete');
        expect(result.archived).toBe(2);
        expect(result.deleted).toBe(2);

        const remaining = await sql<{ id: string }[]>`
            SELECT id FROM task_history WHERE id LIKE 'trim-test-%' ORDER BY id
        `;
        expect(remaining.map((r) => r.id)).toEqual([
            'trim-test-still-active',
            'trim-test-too-recent',
        ]);

        const archived = await sql<{ id: string }[]>`
            SELECT id FROM task_history_archive WHERE id LIKE 'trim-test-%' ORDER BY id
        `;
        expect(archived.map((r) => r.id)).toEqual(['trim-test-eligible-1', 'trim-test-eligible-2']);
    });

    it('filters by taskType when provided, leaving other eligible tasks untouched', async () => {
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        await seedTaskHistoryRow({
            id: 'trim-test-type-a',
            task_id: 'task-a',
            state: 'completed',
            completedAt: old,
        });
        await seedTaskHistoryRow({
            id: 'trim-test-type-b',
            task_id: 'task-b',
            state: 'completed',
            completedAt: old,
        });

        const result = await trimTaskHistory(sql, { olderThanDays: 30, taskType: 'task-a' });

        expect(result.archived).toBe(1);
        expect(result.deleted).toBe(1);

        const remaining = await sql<{ id: string }[]>`
            SELECT id FROM task_history WHERE id LIKE 'trim-test-%' ORDER BY id
        `;
        expect(remaining.map((r) => r.id)).toEqual(['trim-test-type-b']);

        const archived = await sql<{ id: string }[]>`
            SELECT id FROM task_history_archive WHERE id LIKE 'trim-test-%'
        `;
        expect(archived.map((r) => r.id)).toEqual(['trim-test-type-a']);
    });

    it('is idempotent — a second run with nothing new eligible archives/deletes nothing', async () => {
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        await seedTaskHistoryRow({
            id: 'trim-test-once',
            task_id: 'task-a',
            state: 'completed',
            completedAt: old,
        });

        const first = await trimTaskHistory(sql, { olderThanDays: 30 });
        expect(first.archived).toBe(1);
        expect(first.deleted).toBe(1);

        const second = await trimTaskHistory(sql, { olderThanDays: 30 });
        expect(second.archived).toBe(0);
        expect(second.deleted).toBe(0);
    });
});
