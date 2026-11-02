// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the `/admin/fix/stuck` endpoint FEEDS `decideVerdict`. The precedence is
 * pinned in stuck-check.test.ts; these pin the inputs: which pauses count as a
 * cause, and that a read which failed is reported rather than read as "nothing
 * found".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    runnable: 10,
    completed5m: 0,
    pending: [] as Array<{ stage_id: string; pending: number; oldest_pending_age_sec: number }>,
    pendingFails: false,
    scheduled: [] as Array<{ taskId: string; paused: boolean }>,
    schedulerFails: false,
    worker: { available: true, source: 'in-process' } as { available: boolean; source: string },
    pausedLanes: [] as string[],
    queuesFail: false,
    taskClass: {} as Record<string, string>,
}));

vi.mock('$lib/server/database/connection.js', () => ({ getAdminDb: () => ({}) }));
vi.mock('$lib/server/database/queries/ingest-map.queries.js', () => ({
    countRunnableStageItems: async () => state.runnable,
    loadIngestPipelineSummary: async () => ({
        inFlight: state.runnable + 5,
        running: 0,
        oldestPendingAgeSec: 60,
        deadLetterItems: 5,
        degradedItems: 0,
    }),
    loadStageActivity: async () =>
        state.completed5m > 0
            ? [
                  {
                      stage_id: 'probe',
                      completed_5m: state.completed5m,
                      running: 0,
                      failed_1h: 0,
                      last_completed_at: null,
                  },
              ]
            : [],
    loadStagePendingCounts: async () => {
        if (state.pendingFails) throw new Error('boom');
        return state.pending;
    },
}));
vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    listAllScheduledTasks: async () => {
        if (state.schedulerFails) throw new Error('boom');
        return state.scheduled;
    },
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getTask: (id: string) =>
            state.taskClass[id] ? { id, resourceClass: state.taskClass[id] } : undefined,
    },
}));
vi.mock('$lib/server/services/worker-status.js', () => ({
    getBackgroundWorkerStatus: async () => state.worker,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        getQueueDepths: async () => {
            if (state.queuesFail) throw new Error('valkey down');
            return Object.fromEntries(
                ['cpu', 'io', 'maintenance'].map((c) => [
                    c,
                    { waiting: 0, active: 0, delayed: 0, paused: state.pausedLanes.includes(c) },
                ]),
            );
        },
    },
}));

import { def } from './stuck-check.js';
import { StuckCheckSchema, type StuckCheck } from '$lib/components/admin/fix/stuck-check.schema.js';

async function check(): Promise<StuckCheck> {
    const resp = await def.handlers.GET!({} as never, {} as never);
    return StuckCheckSchema.parse(await (resp as Response).json());
}

beforeEach(() => {
    state.runnable = 10;
    state.completed5m = 0;
    state.pending = [
        { stage_id: 'trickplay-generation', pending: 10, oldest_pending_age_sec: 3600 },
    ];
    state.pendingFails = false;
    state.scheduled = [];
    state.schedulerFails = false;
    state.worker = { available: true, source: 'in-process' };
    state.pausedLanes = [];
    state.queuesFail = false;
    state.taskClass = { 'trickplay-generation': 'cpu' };
});

describe('stuck-check inputs', () => {
    it('reads idle when only dead letters remain, and reports the runnable count', async () => {
        state.runnable = 0;
        const body = await check();
        expect(body.verdict).toBe('idle');
        expect(body.inFlight).toBe(0);
        expect(body.deadLetterItems).toBe(5);
    });

    it('an unrelated paused task is listed but is not the cause', async () => {
        state.scheduled = [{ taskId: 'weekly-report', paused: true }];
        const body = await check();
        expect(body.verdict).toBe('stalled');
        expect(body.pausedTasks).toEqual(['weekly-report']);
        expect(body.blockingPauses).toBe(0);
    });

    it('a paused task owning a backlogged stage, or the stage sweep, is the cause', async () => {
        state.scheduled = [{ taskId: 'trickplay-generation', paused: true }];
        expect((await check()).verdict).toBe('paused');
        state.scheduled = [{ taskId: 'stage-sweep', paused: true }];
        expect((await check()).verdict).toBe('paused');
    });

    it('a paused lane that runs the backlog is the cause; another lane is not', async () => {
        state.pausedLanes = ['io'];
        let body = await check();
        expect(body.verdict).toBe('stalled');
        expect(body.pausedQueues).toEqual(['io']);
        state.pausedLanes = ['cpu'];
        body = await check();
        expect(body.verdict).toBe('paused');
        expect(body.blockingPauses).toBe(1);
    });

    it('without the backlog read, every pause counts and the failure is reported', async () => {
        state.pendingFails = true;
        state.scheduled = [{ taskId: 'weekly-report', paused: true }];
        const body = await check();
        expect(body.verdict).toBe('paused');
        expect(body.checksFailed).toContain('pending');
    });

    it('reports an unreadable scheduler or queue backend instead of hiding it', async () => {
        state.schedulerFails = true;
        state.queuesFail = true;
        const body = await check();
        expect(body.verdict).toBe('stalled');
        expect(body.checksFailed).toEqual(expect.arrayContaining(['scheduler', 'queues']));
    });

    it('a failed worker probe never names no-worker', async () => {
        state.worker = { available: false, source: 'probe-failed' };
        const body = await check();
        expect(body.verdict).toBe('stalled');
        expect(body.workerAvailable).toBe(true);
        expect(body.checksFailed).toContain('worker');
    });

    it('a measured missing worker is still no-worker', async () => {
        state.worker = { available: false, source: 'none' };
        expect((await check()).verdict).toBe('no-worker');
    });
});
