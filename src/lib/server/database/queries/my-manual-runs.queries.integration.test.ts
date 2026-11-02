// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * listMyManualRuns — the source of the app-wide "my manual actions" tracker.
 *
 * `trigger.by` is a USERNAME on most manual routes and the user's UUID on a
 * few; both must match, case-insensitively, and nobody else's runs may leak in.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { insertTaskHistoryRow } from '$lib/server/tasks/task-history.js';
import { listMyManualRuns } from './my-manual-runs.queries.js';

const USER_ID = '5b3f2c1e-0000-4000-8000-00000000abcd';
const PREFIX = 'mmr-test-';

describe('listMyManualRuns', () => {
    let sql: postgres.Sql;
    let seq = 0;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE ${PREFIX + '%'}`;
    });

    async function run(opts: {
        by?: string;
        kind?: string;
        state?: string;
        completedAt?: Date | null;
        parent?: string;
        taskId?: string;
    }): Promise<string> {
        const id = `${PREFIX}${++seq}`;
        await insertTaskHistoryRow(sql, {
            id,
            taskId: opts.taskId ?? 'file-library-scan',
            parentRunId: opts.parent ?? null,
            label: 'scan',
            state: 'pending',
            input: {},
            scope: null,
            trigger: { kind: opts.kind ?? 'manual', by: opts.by },
            actor: {},
            startedAt: new Date(Date.now() - 60_000),
            processingVersion: 1,
            ownerInstanceId: 'test',
            retentionPolicy: 'default',
            stages: [],
        });
        if (opts.state && opts.state !== 'pending') {
            await sql`UPDATE task_history SET state = ${opts.state},
                      completed_at = ${opts.completedAt ?? null} WHERE id = ${id}`;
        }
        return id;
    }

    it('matches username or user id, any case; excludes others, automatic runs and old completions', async () => {
        const since = new Date(Date.now() - 10_000);
        const mineByName = await run({ by: 'Denis', state: 'active' });
        const mineById = await run({ by: USER_ID.toUpperCase(), state: 'pending' });
        const finishedAfter = await run({
            by: 'denis',
            state: 'completed',
            completedAt: new Date(),
        });
        await run({ by: 'denis', state: 'failed', completedAt: new Date(Date.now() - 60_000) });
        await run({ by: 'someone-else', state: 'active' });
        await run({ by: 'denis', kind: 'scheduled', state: 'active' });

        const rows = await listMyManualRuns(sql, ['denis', USER_ID], since);
        expect(rows.map((r) => r.id).sort()).toEqual([mineByName, mineById, finishedAfter].sort());
    });

    it("includes the children of my manual fan-out, but not another user's", async () => {
        const since = new Date(Date.now() - 10_000);
        const parent = await run({ by: 'denis', state: 'completed', completedAt: new Date() });
        const child = await run({ kind: 'in-process', state: 'active', parent });
        const theirs = await run({ by: 'bob', state: 'completed', completedAt: new Date() });
        await run({ kind: 'in-process', state: 'active', parent: theirs });

        const rows = await listMyManualRuns(sql, ['denis'], since);
        expect(rows.map((r) => r.id).sort()).toEqual([parent, child].sort());
    });

    it("keeps finding a fan-out's children after the parent has left the window", async () => {
        // "Scan all": the parent completes at once; one poll later it is older
        // than `since`, but its children still run — and must still be found,
        // or their completions are never announced.
        const parent = await run({
            by: 'denis',
            state: 'completed',
            completedAt: new Date(Date.now() - 120_000),
        });
        const running = await run({ kind: 'in-process', state: 'active', parent });
        const justDone = await run({
            kind: 'in-process',
            state: 'completed',
            completedAt: new Date(),
            parent,
        });
        await run({
            kind: 'in-process',
            state: 'completed',
            completedAt: new Date(Date.now() - 120_000),
            parent,
        });

        const rows = await listMyManualRuns(sql, ['denis'], new Date(Date.now() - 10_000));
        expect(rows.map((r) => r.id).sort()).toEqual([running, justDone].sort());
    });

    it("leaves out a DIFFERENT task's children (pipeline members, __gate__ rows) and lists live first", async () => {
        const parent = await run({ by: 'denis', state: 'active' });
        await run({
            kind: 'pipeline-child',
            state: 'active',
            parent,
            taskId: '__gate__media-probe',
        });
        await run({ kind: 'pipeline-child', state: 'active', parent, taskId: 'media-probe' });
        const done = await run({ by: 'denis', state: 'completed', completedAt: new Date() });

        const rows = await listMyManualRuns(sql, ['denis'], new Date(Date.now() - 10_000));
        expect(rows.map((r) => r.id)).toEqual([parent, done]);
    });

    it('returns nothing without an identity', async () => {
        await run({ by: 'denis', state: 'active' });
        expect(await listMyManualRuns(sql, [], new Date())).toEqual([]);
    });
});
