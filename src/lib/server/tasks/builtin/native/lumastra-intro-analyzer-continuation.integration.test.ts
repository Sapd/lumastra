// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { config } from '$lib/server/config.js';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';

const startRun = vi.hoisted(() => vi.fn());
vi.mock('../../orchestrator.js', () => ({ orchestrator: { startRun } }));
import {
    introAnalyzerContinuationTask as task,
    introContinuationDue,
} from './lumastra-intro-analyzer-continuation.js';

const ANALYZER = 'lumastra-intro-analyzer';
let sql: postgres.Sql;
let serial = 0;
async function run(
    input: postgres.JSONValue = {},
    result: postgres.JSONValue = {
        stopReason: 'budget',
        itemsProcessed: 1,
        result: { pendingBacklog: { seasons: 12, singleEpisodes: 3, movies: 4 } },
    },
    state = 'completed',
): Promise<string> {
    const id = `run_intro_continuation_${++serial}`;
    await sql`INSERT INTO task_history(id,task_id,label,state,input,result,trigger,actor,started_at,processing_version,stages)
        VALUES (${id},${ANALYZER},'Invented segment analysis',${state},${sql.json(input)},${sql.json(result)},
        '{"kind":"scheduled"}'::jsonb,'{}'::jsonb,${new Date(Date.now() + serial * 1000)},'4','[]'::jsonb)`;
    return id;
}
async function clear(): Promise<void> {
    await sql`DELETE FROM task_history WHERE id LIKE 'run_intro_continuation_%'`;
    await sql`DELETE FROM scheduler_state WHERE task_id=${ANALYZER}`;
}
beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    vi.restoreAllMocks();
    startRun.mockReset();
    await clear();
});
afterAll(async () => {
    await clear();
    await closeTestDb();
});

describe('intro backlog continuation', () => {
    it('enqueues a new catchup within the minute sweep and suppresses duplicates while it is pending', async () => {
        const previousRunId = await run();
        const ctx = mockContext({ sql, input: { previousRunId } });
        const entries = await task.dynamicSchedule!.loader({ ...ctx, now: new Date() });
        expect(entries).toEqual([
            { rowId: previousRunId, bucket: previousRunId, input: { previousRunId } },
        ]);
        startRun.mockImplementation(async () => {
            await run({}, {}, 'pending');
            return { runId: 'run_intro_continuation_next', deduped: false };
        });
        expect(await task.execute(ctx)).toMatchObject({ itemsProcessed: 1 });
        expect(startRun).toHaveBeenCalledWith(ANALYZER, { mode: 'catchup' }, expect.any(Object));
        expect(await introContinuationDue(sql)).toBeNull();
        await task.execute(ctx);
        expect(startRun).toHaveBeenCalledTimes(1);
    });

    it('continues a partial acoustic chunk that only saved windows', async () => {
        const id = await run(
            {},
            {
                stopReason: 'budget',
                itemsProcessed: 0,
                result: { fingerprintsProcessed: 3, pendingBacklog: { seasons: 1 } },
            },
            'failed',
        );
        expect(await introContinuationDue(sql)).toBe(id);
    });

    it.each(['drained', 'no-progress', 'aborted'])(
        'does not continue %s exits',
        async (stopReason) => {
            await run(
                {},
                { stopReason, itemsProcessed: 3, result: { pendingBacklog: { seasons: 1 } } },
            );
            expect(await introContinuationDue(sql)).toBeNull();
        },
    );

    it('does not spin for zero progress or an empty backlog', async () => {
        await run(
            {},
            { stopReason: 'budget', itemsProcessed: 0, result: { pendingBacklog: { seasons: 1 } } },
        );
        expect(await introContinuationDue(sql)).toBeNull();
        await run(
            {},
            {
                stopReason: 'budget',
                itemsProcessed: 1,
                result: { pendingBacklog: { seasons: 0, singleEpisodes: 0, movies: 0 } },
            },
        );
        expect(await introContinuationDue(sql)).toBeNull();
    });

    it('honors pause and disable, and rechecks after the helper was queued', async () => {
        const previousRunId = await run();
        await sql`INSERT INTO scheduler_state(task_id,next_fire_at,paused) VALUES (${ANALYZER},now(),true)`;
        expect(await introContinuationDue(sql)).toBeNull();
        await task.execute(mockContext({ sql, input: { previousRunId } }));
        expect(startRun).not.toHaveBeenCalled();
        await sql`DELETE FROM scheduler_state WHERE task_id=${ANALYZER}`;
        vi.spyOn(config, 'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED', 'get').mockReturnValue(false);
        expect(await introContinuationDue(sql)).toBeNull();
    });

    it.each(['mediaId', 'seasonId', 'seriesId', 'seasonIds', 'segmentTypes', 'outroOnly'])(
        'does not widen a targeted %s request',
        async (key) => {
            await run({
                [key]:
                    key === 'seasonIds' || key === 'segmentTypes'
                        ? ['invented']
                        : key === 'outroOnly'
                          ? true
                          : 'invented',
            });
            expect(await introContinuationDue(sql)).toBeNull();
        },
    );

    it.each(['failed', 'cancelled'])('stops the chain after a newer %s run', async (state) => {
        await run();
        await run({}, {}, state);
        expect(await introContinuationDue(sql)).toBeNull();
    });
});
