// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    worker: false,
    calls: 0,
    fail: false,
    set: vi.fn(),
    reset: vi.fn(),
    depths: { io: { waiting: 7, active: 1, delayed: 0, paused: false } } as Record<string, unknown>,
}));
vi.mock('$lib/server/config.js', () => ({ shouldStartWorkers: () => state.worker }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('./metrics.js', () => ({ taskQueueDepth: { set: state.set, reset: state.reset } }));
vi.mock('./orchestrator.js', () => ({
    getOrchestrator: async () => ({
        getQueueDepths: async () => {
            state.calls++;
            if (state.fail) throw new Error('valkey down');
            return state.depths;
        },
    }),
}));

import { refreshQueueDepthMetrics, resetQueueDepthCollector } from './queue-depth-collector.js';

beforeEach(() => {
    state.worker = false;
    state.calls = 0;
    state.fail = false;
    state.set.mockClear();
    state.reset.mockClear();
    state.depths = { io: { waiting: 7, active: 1, delayed: 0, paused: false } };
    resetQueueDepthCollector();
});

describe('refreshQueueDepthMetrics', () => {
    it('publishes waiting counts from a web process, cached for 15 s', async () => {
        await refreshQueueDepthMetrics(20_000);
        await refreshQueueDepthMetrics(30_000);
        expect(state.calls).toBe(1);
        expect(state.set).toHaveBeenCalledWith({ queue: 'task:io', resource_class: 'io' }, 7);
        await refreshQueueDepthMetrics(35_001);
        expect(state.calls).toBe(2);
    });
    it('clears the gauge before setting, so a vanished class cannot keep a stale depth', async () => {
        await refreshQueueDepthMetrics(20_000);
        state.depths = { cpu: { waiting: 2, active: 0, delayed: 0, paused: false } };
        await refreshQueueDepthMetrics(40_000);
        expect(state.reset).toHaveBeenCalledTimes(2);
        const lastReset = state.reset.mock.invocationCallOrder.at(-1) ?? Infinity;
        const lastSet = state.set.mock.invocationCallOrder.at(-1) ?? 0;
        expect(lastReset).toBeLessThan(lastSet);
        expect(state.set).toHaveBeenLastCalledWith({ queue: 'task:cpu', resource_class: 'cpu' }, 2);
    });
    it('leaves the worker process to the coordinator', async () => {
        state.worker = true;
        await refreshQueueDepthMetrics(20_000);
        expect(state.calls).toBe(0);
    });
    it('never throws when the queue read fails', async () => {
        state.fail = true;
        await expect(refreshQueueDepthMetrics(20_000)).resolves.toBeUndefined();
        expect(state.set).not.toHaveBeenCalled();
    });
});
