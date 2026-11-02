// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { getHomepageTaskCounts } from './homepage-tasks.queries.js';

describe('getHomepageTaskCounts', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterEach(async () => {
        await sql`DELETE FROM task_history WHERE task_id = 'homepage-count-test'`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function insertRun(
        id: string,
        state: string,
        startedAgo: string,
        completedAgo: string | null,
    ): Promise<void> {
        await sql`
            INSERT INTO task_history (id, task_id, label, state, input, trigger, actor,
                processing_version, started_at, completed_at)
            VALUES (${id}, 'homepage-count-test', 'Homepage count test', ${state},
                ${sql.json({})}, ${sql.json({ kind: 'scheduled' })}, ${sql.json({ type: 'system' })}, '1',
                now() - ${startedAgo}::interval,
                ${completedAgo === null ? null : sql`now() - ${completedAgo}::interval`})
        `;
    }

    it('counts running runs and failures by completion time, uncapped', async () => {
        // The suite shares its database with other suites — compare against a baseline.
        const before = await getHomepageTaskCounts(sql);

        await insertRun('hp-active', 'active', '1 minute', null);
        await insertRun('hp-cancelling', 'cancelling', '1 minute', null);
        await insertRun('hp-pending', 'pending', '1 minute', null);
        await insertRun('hp-done', 'completed', '1 hour', '30 minutes');
        // Started two days ago but failed an hour ago: counts (completion time decides).
        await insertRun('hp-failed-recent', 'failed', '2 days', '1 hour');
        await insertRun('hp-failed-old', 'failed', '3 days', '2 days');

        const after = await getHomepageTaskCounts(sql);
        expect(after.running - before.running).toBe(2);
        expect(after.failed24h - before.failed24h).toBe(1);
    });
});
