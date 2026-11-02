// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task triggers against a real Postgres (spec 2026-09-27 Part 2):
 *   - the table's CHECK constraints refuse rows the scheduler can't interpret,
 *   - replace / list / clear and `setNextFireAt` behave as the scheduler and
 *     the API rely on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
    clearTaskTriggers,
    getSchedulerState,
    listAllTaskTriggers,
    listTaskTriggers,
    replaceTaskTriggers,
    setNextFireAt,
} from './scheduler-state.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const RUN = Boolean(TEST_DATABASE_URL);
const PREFIX = 'trigger-it-';

describe.runIf(RUN)('task triggers (DB-backed)', () => {
    let sql: postgres.Sql;

    async function cleanup(): Promise<void> {
        await sql`DELETE FROM task_triggers WHERE task_id LIKE ${PREFIX + '%'}`;
        await sql`DELETE FROM scheduler_state WHERE task_id LIKE ${PREFIX + '%'}`;
    }

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
    }, 30_000);

    beforeEach(cleanup);

    afterAll(async () => {
        await cleanup();
        await sql.end();
    });

    it('replaces, lists in order, and clears', async () => {
        const taskId = `${PREFIX}replace`;
        await replaceTaskTriggers(sql, taskId, [{ kind: 'interval', every: '1h' }], 'a');
        await replaceTaskTriggers(
            sql,
            taskId,
            [
                { kind: 'daily', at: '03:00' },
                { kind: 'weekly', weekday: 0, at: '04:30' },
                { kind: 'startup' },
            ],
            'b',
        );
        const stored = await listTaskTriggers(sql, taskId);
        expect(stored?.triggers).toEqual([
            { kind: 'daily', at: '03:00' },
            { kind: 'weekly', weekday: 0, at: '04:30' },
            { kind: 'startup' },
        ]);
        expect(stored?.updatedBy).toBe('b');
        expect((await listAllTaskTriggers(sql)).get(taskId)?.triggers).toHaveLength(3);

        await clearTaskTriggers(sql, taskId);
        expect(await listTaskTriggers(sql, taskId)).toBeNull();
    });

    it('refuses rows the scheduler could not interpret', async () => {
        const taskId = `${PREFIX}bad`;
        await expect(
            sql`INSERT INTO task_triggers (task_id, kind, at, created_by) VALUES (${taskId}, 'daily', '25:00', 'x')`,
        ).rejects.toThrow();
        await expect(
            sql`INSERT INTO task_triggers (task_id, kind, created_by) VALUES (${taskId}, 'interval', 'x')`,
        ).rejects.toThrow();
        await expect(
            sql`INSERT INTO task_triggers (task_id, kind, at, created_by) VALUES (${taskId}, 'weekly', '03:00', 'x')`,
        ).rejects.toThrow();
        // Stray fields for another kind, and an unreadable duration.
        await expect(
            sql`INSERT INTO task_triggers (task_id, kind, at, every, created_by) VALUES (${taskId}, 'daily', '03:00', '6h', 'x')`,
        ).rejects.toThrow();
        await expect(
            sql`INSERT INTO task_triggers (task_id, kind, every, created_by) VALUES (${taskId}, 'interval', 'soon', 'x')`,
        ).rejects.toThrow();
    });

    it('setNextFireAt creates the row, then moves only next_fire_at', async () => {
        const taskId = `${PREFIX}next`;
        const first = new Date('2026-09-28T01:00:00Z');
        await setNextFireAt(sql, taskId, first);
        expect((await getSchedulerState(sql, taskId))?.nextFireAt.toISOString()).toBe(
            first.toISOString(),
        );

        await sql`UPDATE scheduler_state SET paused = true, last_fired_at = now() WHERE task_id = ${taskId}`;
        const second = new Date('2026-09-29T01:00:00Z');
        await setNextFireAt(sql, taskId, second);
        const state = await getSchedulerState(sql, taskId);
        expect(state?.nextFireAt.toISOString()).toBe(second.toISOString());
        expect(state?.paused).toBe(true);
        expect(state?.lastFiredAt).not.toBeNull();
    });
});
