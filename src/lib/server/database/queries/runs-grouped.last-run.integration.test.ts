// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getLastCompletedRunAt` — "when did this task last run".
 *
 * Exists because /admin/fix/missing-episodes read
 * `scheduler_state.last_fired_at` and therefore told the operator
 * "series-sync has never run" while series-sync was running 313 times in 12
 * hours on prod. series-sync declares no schedule ("admin-triggered per-item
 * only"), so it never gets a scheduler_state row and that field is null by
 * design, forever. Run history is the only source that answers this for a
 * per-item task AND a scheduled one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getLastCompletedRunAt } from './runs-grouped.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

const TASK = 'series-sync';

describe('getLastCompletedRunAt (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, ['task_history'] as const);
    });

    async function seedRun(state: string, completedAt: Date | null, id: string): Promise<void> {
        // started_at is anchored to completed_at, never to now(): duration_ms is a
        // generated INTEGER column (completed_at - started_at in ms), so a fixed
        // completed_at against a now()-relative start overflows int4 once the
        // calendar is ~25 days past the fixture date.
        const startedAt = new Date((completedAt ?? new Date()).getTime() - 60 * 60 * 1000);
        await sql`
            INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version,
                 started_at, completed_at)
            VALUES (${id}, ${TASK}, 'Full Series Metadata Sync', ${state},
                    '{}'::jsonb, '{"kind":"in-process"}'::jsonb, '{"kind":"system"}'::jsonb, '1',
                    ${startedAt}, ${completedAt})
        `;
    }

    it('returns null when the task has genuinely never run', async () => {
        expect(await getLastCompletedRunAt(sql, TASK)).toBeNull();
    });

    it('reports the last COMPLETED run for a task that has no schedule row at all', async () => {
        // The regression: no scheduler_state row exists for series-sync and never
        // will, so anything reading that table reports "never run" here.
        const when = new Date('2026-08-28T05:00:00.000Z');
        await seedRun('completed', when, 'run-1');
        expect((await getLastCompletedRunAt(sql, TASK))?.toISOString()).toBe(when.toISOString());
    });

    it('takes the NEWEST completed run, not the first', async () => {
        await seedRun('completed', new Date('2026-08-28T01:00:00.000Z'), 'run-old');
        await seedRun('completed', new Date('2026-08-28T07:00:00.000Z'), 'run-new');
        expect((await getLastCompletedRunAt(sql, TASK))?.toISOString()).toBe(
            '2026-08-28T07:00:00.000Z',
        );
    });

    it('ignores runs that failed or are still active', async () => {
        // A failed run is not evidence the task produced anything, and an active run
        // has no completed_at at all.
        await seedRun('failed', new Date('2026-08-28T08:00:00.000Z'), 'run-failed');
        await seedRun('active', null, 'run-active');
        expect(await getLastCompletedRunAt(sql, TASK)).toBeNull();
    });

    it('does not report runs belonging to a different task', async () => {
        await sql`
            INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version,
                 started_at, completed_at)
            VALUES ('other-1', 'image-sync', 'Image Sync', 'completed',
                    '{}'::jsonb, '{"kind":"in-process"}'::jsonb, '{"kind":"system"}'::jsonb, '1',
                    now(), now())
        `;
        expect(await getLastCompletedRunAt(sql, TASK)).toBeNull();
    });
});
