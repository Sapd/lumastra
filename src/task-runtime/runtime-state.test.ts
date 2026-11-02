// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markLoopTick, resetLoopTicks } from '$lib/server/tasks/loop-progress.js';
import {
    getHeartbeatRuntimeState,
    getWorkerRuntimeState,
    isProgressStalled,
    recordUncaughtException,
    registerConsumerStateProvider,
    registerUpgradeStateProvider,
    registerWatcherStateProvider,
    registerWorkerLeaseStateProvider,
    resetRuntimeStateForTests,
    watcherReadinessReasons,
    type WatcherRuntimeState,
} from './runtime-state.js';

beforeEach(() => {
    resetRuntimeStateForTests();
    resetLoopTicks();
});
afterEach(() => {
    resetRuntimeStateForTests();
    resetLoopTicks();
});

describe('getWorkerRuntimeState', () => {
    it('works with no providers registered', () => {
        expect(getWorkerRuntimeState()).toEqual({ uncaughtExceptions: 0 });
    });
    it('assembles registered providers and survives a throwing one', () => {
        registerUpgradeStateProvider(() => 'prepared');
        registerConsumerStateProvider(() => ({ running: 4, paused: 4 }));
        registerWatcherStateProvider(() => {
            throw new Error('boom');
        });
        registerWorkerLeaseStateProvider(() => ({
            held: true,
            lastRenewAt: '2026-01-01T00:00:00Z',
        }));
        markLoopTick('consumer', 1_000);
        const state = getWorkerRuntimeState();
        expect(state.upgradeState).toBe('prepared');
        expect(state.consumers).toEqual({
            running: 4,
            paused: 4,
            lastProgressAt: new Date(1_000).toISOString(),
        });
        expect(state.watcher).toBeUndefined();
        expect(state.lease?.held).toBe(true);
        expect(state.lastTickAt).toBe(new Date(1_000).toISOString());
    });
    it('keeps error text and holder ids out of the heartbeat projection', () => {
        registerWatcherStateProvider(() => ({
            implementation: 'rust',
            state: 'degraded',
            limitations: ['inotify limit'],
            restarts: 2,
            lastError: 'ENOENT /srv/media/secret',
            leaseHeld: true,
        }));
        registerWorkerLeaseStateProvider(() => ({ held: true, holder: 'pod-abc' }));
        const json = JSON.stringify(getHeartbeatRuntimeState());
        expect(json).not.toContain('ENOENT');
        expect(json).not.toContain('pod-abc');
        expect(getHeartbeatRuntimeState().watcher).toEqual({
            state: 'degraded',
            restarts: 2,
            coverage: undefined,
        });
    });
});

describe('isProgressStalled', () => {
    const stallMs = 10 * 60_000;
    it('is never stalled before startup finished', () => {
        expect(isProgressStalled({ now: 10 ** 9, stallMs, startedAt: undefined })).toBe(false);
    });
    it('stalls when no loop ticked for stallMs, measured from the last tick or startup', () => {
        expect(isProgressStalled({ now: 1_000 + stallMs + 1, stallMs, startedAt: 1_000 })).toBe(
            true,
        );
        expect(isProgressStalled({ now: 1_000 + stallMs, stallMs, startedAt: 1_000 })).toBe(false);
        markLoopTick('scheduler', 500_000);
        markLoopTick('consumer', 500_000);
        expect(isProgressStalled({ now: 500_000 + stallMs, stallMs, startedAt: 1_000 })).toBe(
            false,
        );
        expect(isProgressStalled({ now: 500_000 + stallMs + 1, stallMs, startedAt: 1_000 })).toBe(
            true,
        );
    });
    it('an idle but ticking pair of loops is not a stall', () => {
        markLoopTick('consumer', 9_000_000);
        markLoopTick('scheduler', 9_000_000);
        expect(isProgressStalled({ now: 9_000_000 + 5_000, stallMs, startedAt: 1 })).toBe(false);
    });
    it('a ticking scheduler does not hide stale consumers, nor the reverse', () => {
        const now = 9_000_000;
        markLoopTick('scheduler', now - 1_000);
        markLoopTick('consumer', now - stallMs - 1);
        expect(isProgressStalled({ now, stallMs, startedAt: 1 })).toBe(true);
        markLoopTick('scheduler', now - stallMs - 1);
        markLoopTick('consumer', now - 1_000);
        expect(isProgressStalled({ now, stallMs, startedAt: 1 })).toBe(true);
        markLoopTick('scheduler', now - 1_000);
        expect(isProgressStalled({ now, stallMs, startedAt: 1 })).toBe(false);
    });
    it.each(['preparing', 'prepared', 'stopping', 'unknown'])(
        'does not fail liveness while the upgrade state is %s',
        (upgradeState) => {
            expect(isProgressStalled({ now: 10 ** 9, stallMs, startedAt: 1, upgradeState })).toBe(
                false,
            );
        },
    );
    it('still fails liveness when an upgrade is idle or postponed', () => {
        expect(
            isProgressStalled({ now: 10 ** 9, stallMs, startedAt: 1, upgradeState: 'idle' }),
        ).toBe(true);
        expect(
            isProgressStalled({ now: 10 ** 9, stallMs, startedAt: 1, upgradeState: 'postponed' }),
        ).toBe(true);
    });
});

describe('recordUncaughtException', () => {
    it('counts, and requests shutdown on the third within the window', () => {
        expect(recordUncaughtException({ now: 0, duringShutdown: false }).shutdown).toBe(false);
        expect(recordUncaughtException({ now: 1_000, duringShutdown: false }).shutdown).toBe(false);
        const third = recordUncaughtException({ now: 2_000, duringShutdown: false });
        expect(third).toMatchObject({ count: 3, shutdown: true });
        expect(getWorkerRuntimeState().uncaughtExceptions).toBe(3);
    });
    it('forgets exceptions older than the window', () => {
        recordUncaughtException({ now: 0, duringShutdown: false });
        recordUncaughtException({ now: 1_000, duringShutdown: false });
        const late = recordUncaughtException({ now: 11 * 60_000, duringShutdown: false });
        expect(late.shutdown).toBe(false);
    });
    it('requests shutdown at once when it happens during shutdown', () => {
        expect(recordUncaughtException({ now: 0, duringShutdown: true })).toMatchObject({
            count: 1,
            shutdown: true,
        });
    });
});

describe('watcherReadinessReasons', () => {
    const watcher = (state: WatcherRuntimeState['state']): WatcherRuntimeState => ({
        implementation: 'rust',
        state,
        limitations: [],
        restarts: 0,
        leaseHeld: true,
    });
    it.each([
        [undefined, []],
        ['stopped' as const, []],
        ['starting' as const, ['watcher_starting']],
        ['ready' as const, []],
        ['degraded' as const, []],
        ['failed' as const, ['watcher_failed']],
    ])('maps %s to %j', (state, expected) => {
        const input = typeof state === 'string' ? watcher(state) : undefined;
        expect(watcherReadinessReasons(input)).toEqual(expected);
    });
});
