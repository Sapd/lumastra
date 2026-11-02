// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * airing-series-refresh queues one series-sync per due series under the
 * coverage key the scan paths use, reports a run that queued nothing as
 * failed, stops when the queue keeps refusing, and stays off when TMDB is not
 * the primary provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    due: [] as Array<{ id: string; title: string; synced_at: Date | null }>,
    startRun: vi.fn(),
    findArgs: [] as unknown[],
    provider: 'tmdb',
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/database/queries/airing-series.queries.js', () => ({
    findAiringSeriesDueForRefresh: async (_sql: unknown, opts: unknown) => {
        h.findArgs.push(opts);
        return h.due;
    },
}));
vi.mock('../../../orchestrator.js', () => ({ orchestrator: { startRun: h.startRun } }));
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => h.provider,
}));

import {
    airingSeriesRefreshTask,
    MAX_CONSECUTIVE_FAILURES,
    MAX_SERIES_PER_RUN,
    STALE_AFTER_HOURS,
} from '../airing-series-refresh.js';
import { SERIES_SYNC_FRESHNESS_MINUTES } from '../series-sync-freshness.js';

function ctx(signal = new AbortController().signal) {
    return {
        sql: {},
        signal,
        runId: 'run-1',
        input: {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
        reportProgress: vi.fn(),
    } as unknown as Parameters<typeof airingSeriesRefreshTask.execute>[0];
}

function series(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        id: `s${i + 1}`,
        title: `Series ${i + 1}`,
        synced_at: null,
    }));
}

describe('airing-series-refresh', () => {
    beforeEach(() => {
        h.due = [];
        h.findArgs = [];
        h.provider = 'tmdb';
        h.startRun.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps its threshold above the series-sync freshness window', () => {
        expect(STALE_AFTER_HOURS * 60).toBeGreaterThan(SERIES_SYNC_FRESHNESS_MINUTES);
    });

    it('asks for series stale beyond the threshold, capped per run', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));

        await airingSeriesRefreshTask.execute(ctx());

        const opts = h.findArgs[0] as { staleBefore: Date; limit: number };
        expect(opts.limit).toBe(MAX_SERIES_PER_RUN);
        expect(opts.staleBefore.toISOString()).toBe(
            new Date(
                Date.parse('2026-10-13T12:00:00Z') - STALE_AFTER_HOURS * 3_600_000,
            ).toISOString(),
        );
    });

    it('queues one series-sync per due series and counts dedupes and failures', async () => {
        h.due = series(3);
        h.startRun
            .mockResolvedValueOnce({ runId: 'r1', deduped: false })
            .mockResolvedValueOnce({ runId: 'r2', deduped: true })
            .mockRejectedValueOnce(new Error('queue down'));

        const res = await airingSeriesRefreshTask.execute(ctx());

        expect(h.startRun).toHaveBeenCalledTimes(3);
        expect(h.startRun.mock.calls[0][0]).toBe('series-sync');
        expect(h.startRun.mock.calls[0][1]).toEqual({ mediaItemId: 's1' });
        expect(h.startRun.mock.calls[0][2]).toMatchObject({
            idempotencyKey: 'coverage:series-sync:s1',
            parentRunId: 'run-1',
            priority: 7,
            subject: { type: 'mediaItem', id: 's1' },
        });
        expect(res).toMatchObject({
            success: true,
            itemsProcessed: 1,
            result: { due: 3, queued: 1, deduped: 1, failed: 1 },
        });
    });

    it('reports a run that queued nothing as failed and stops after repeated errors', async () => {
        h.due = series(MAX_CONSECUTIVE_FAILURES + 3);
        h.startRun.mockRejectedValue(new Error('queue down'));

        const res = await airingSeriesRefreshTask.execute(ctx());

        expect(h.startRun).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
        expect(res).toMatchObject({ success: false, itemsProcessed: 0 });
    });

    it('reports an abort mid-run as aborted', async () => {
        h.due = series(3);
        const controller = new AbortController();
        h.startRun.mockImplementationOnce(async () => {
            controller.abort();
            return { runId: 'r1', deduped: false };
        });

        const res = await airingSeriesRefreshTask.execute(ctx(controller.signal));

        expect(h.startRun).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ success: false, stopReason: 'aborted', itemsProcessed: 1 });
    });

    it('does nothing when TMDB is not the primary provider', async () => {
        h.provider = 'tvdb';
        h.due = series(2);

        const res = await airingSeriesRefreshTask.execute(ctx());

        expect(h.findArgs).toHaveLength(0);
        expect(h.startRun).not.toHaveBeenCalled();
        expect(res).toMatchObject({ success: true, itemsProcessed: 0 });
    });
});
