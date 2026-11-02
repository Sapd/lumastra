// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { getLiveTvFeedEvidence } from './livetv-availability.queries.js';

/**
 * getLiveTvFeedEvidence filters on COALESCE(completed_at, started_at) within
 * 24 h, written in a sargable form. These rows pin that it still returns the
 * newest terminal channels/guide run per source, including a terminal row that
 * lacks completed_at.
 */
describe('getLiveTvFeedEvidence', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    async function run(opts: {
        taskId: string;
        sourceId: string;
        state: string;
        startedHoursAgo: number;
        completedHoursAgo: number | null;
    }): Promise<void> {
        await sql`
            INSERT INTO task_history (id, task_id, label, state, input, trigger, actor,
                                      processing_version, started_at, completed_at)
            VALUES (${`run_${randomUUID()}`}, ${opts.taskId}, ${opts.taskId}, ${opts.state},
                    ${sql.json({ sourceId: opts.sourceId })}, ${sql.json({ kind: 'manual' })},
                    ${sql.json({ type: 'system' })}, '1',
                    now() - ${`${opts.startedHoursAgo} hours`}::interval,
                    ${opts.completedHoursAgo === null ? null : sql`now() - ${`${opts.completedHoursAgo} hours`}::interval`})
        `;
    }

    it('returns the newest terminal run per source and feed within 24 hours', async () => {
        const a: string = randomUUID();
        const b: string = randomUUID();
        const c: string = randomUUID();
        // Source A: older failed + newer completed channel import; recent guide.
        await run({
            taskId: 'import-m3u',
            sourceId: a,
            state: 'failed',
            startedHoursAgo: 5,
            completedHoursAgo: 5,
        });
        await run({
            taskId: 'refresh-m3u',
            sourceId: a,
            state: 'completed',
            startedHoursAgo: 2,
            completedHoursAgo: 1,
        });
        await run({
            taskId: 'import-epg',
            sourceId: a,
            state: 'completed',
            startedHoursAgo: 3,
            completedHoursAgo: 3,
        });
        // Source B: only a run older than 24 h -> no evidence.
        await run({
            taskId: 'import-m3u',
            sourceId: b,
            state: 'completed',
            startedHoursAgo: 30,
            completedHoursAgo: 30,
        });
        // Source C: terminal row without completed_at, started recently -> counted.
        await run({
            taskId: 'import-epg',
            sourceId: c,
            state: 'failed',
            startedHoursAgo: 2,
            completedHoursAgo: null,
        });
        // A running import is not evidence.
        await run({
            taskId: 'import-m3u',
            sourceId: c,
            state: 'active',
            startedHoursAgo: 1,
            completedHoursAgo: null,
        });

        const rows = (await getLiveTvFeedEvidence(sql)).filter((r) =>
            [a, b, c].includes(r.source_id),
        );
        const view = rows
            .map(
                (r) =>
                    `${r.source_id === a ? 'A' : r.source_id === b ? 'B' : 'C'}:${r.feed}:${r.state}`,
            )
            .sort();
        expect(view).toEqual(['A:channels:completed', 'A:guide:completed', 'C:guide:failed']);
    });
});
