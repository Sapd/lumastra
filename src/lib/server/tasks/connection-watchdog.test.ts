// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi } from 'vitest';
import {
    ConnectionWedgeWatchdog,
    isConnectionError,
    type ConnectionWedgeWatchdogOpts,
} from './connection-watchdog.js';

const silentLog = { info() {}, warn() {}, error() {} };

function makeWatchdog(overrides: Partial<ConnectionWedgeWatchdogOpts> = {}): {
    wd: ConnectionWedgeWatchdog;
    clock: { t: number };
    exit: ReturnType<typeof vi.fn>;
    touched: number[];
} {
    const clock = { t: 0 };
    const exit = vi.fn();
    const touched: number[] = [];
    const wd = new ConnectionWedgeWatchdog({
        thresholdMs: 120_000,
        quietMs: 30_000,
        livenessFile: '/tmp/test-alive',
        now: () => clock.t,
        exit,
        touch: (_file, ts) => touched.push(ts),
        log: silentLog,
        ...overrides,
    });
    return { wd, clock, exit, touched };
}

const connErr = new Error('connect ETIMEDOUT 172.23.0.5:6379');

describe('isConnectionError', () => {
    test('matches connection-level errors', () => {
        for (const m of [
            'connect ETIMEDOUT 1.2.3.4:6379',
            'connect ECONNREFUSED',
            'read ECONNRESET',
            'getaddrinfo ENOTFOUND ai-valkey-tasks',
            'Connection is closed.',
        ]) {
            expect(isConnectionError(new Error(m))).toBe(true);
        }
    });

    test('ignores non-connection errors (e.g. BullMQ lock loss, app errors)', () => {
        expect(isConnectionError(new Error('could not renew lock for job 123'))).toBe(false);
        expect(isConnectionError(new Error('TypeError: x is not a function'))).toBe(false);
    });
});

describe('ConnectionWedgeWatchdog', () => {
    test('exits(1) after sustained connection errors beyond the threshold', () => {
        const { wd, clock, exit } = makeWatchdog();
        wd.recordError('task-a', connErr); // streak starts at t=0
        clock.t = 60_000;
        wd.recordError('task-a', connErr); // errors still coming
        wd.check();
        expect(exit).not.toHaveBeenCalled(); // only 60s in

        clock.t = 125_000;
        wd.recordError('task-a', connErr); // still erroring at 125s
        wd.check();
        expect(exit).toHaveBeenCalledWith(1); // streak age >= 120s
    });

    test('does NOT exit when a job is processed mid-streak (recovery signal)', () => {
        const { wd, clock, exit } = makeWatchdog();
        wd.recordError('task-a', connErr); // t=0
        clock.t = 100_000;
        wd.recordError('task-a', connErr);
        wd.recordHealthy('task-a'); // a job got through → connection works
        clock.t = 130_000;
        wd.check();
        expect(exit).not.toHaveBeenCalled();
    });

    test('does NOT exit when errors stop (transient blip clears via quiet window)', () => {
        const { wd, clock, exit } = makeWatchdog();
        wd.recordError('task-a', connErr); // t=0
        clock.t = 40_000; // 40s later, no further errors (> quietMs=30s)
        wd.check();
        expect(exit).not.toHaveBeenCalled();
        // Streak cleared: a later short burst must not instantly trip the threshold.
        wd.recordError('task-a', connErr); // new streak at t=40s
        clock.t = 80_000;
        wd.check();
        expect(exit).not.toHaveBeenCalled(); // only 40s into the new streak
    });

    test('ignores non-connection errors — no streak, no exit', () => {
        const { wd, clock, exit } = makeWatchdog();
        wd.recordError('task-a', new Error('could not renew lock for job 99'));
        clock.t = 300_000;
        wd.check();
        expect(exit).not.toHaveBeenCalled();
    });

    test('touches the liveness file while healthy and stops once wedged', () => {
        const { wd, clock, exit, touched } = makeWatchdog();
        wd.check(); // healthy
        clock.t = 15_000;
        wd.check(); // healthy
        expect(touched).toEqual([0, 15_000]);

        // Now wedge it.
        wd.recordError('task-a', connErr);
        clock.t = 200_000;
        wd.recordError('task-a', connErr);
        const before = touched.length;
        wd.check(); // should exit, not touch
        expect(exit).toHaveBeenCalledWith(1);
        expect(touched.length).toBe(before); // no touch on the wedged tick
    });

    test('touches the liveness file immediately on start() (before the first tick)', () => {
        const { wd, touched } = makeWatchdog();
        wd.start();
        expect(touched).toEqual([0]); // exists from boot, not only after checkIntervalMs
        wd.stop();
    });

    test('does NOT refresh the liveness file during an active under-threshold streak', () => {
        const { wd, clock, exit, touched } = makeWatchdog();
        wd.recordError('task-a', connErr); // streak at t=0
        clock.t = 60_000;
        wd.recordError('task-a', connErr); // errors ongoing, 60s < 120s threshold
        wd.check();
        expect(exit).not.toHaveBeenCalled();
        expect(touched).toEqual([]); // stale on purpose → healthcheck backstop
    });

    test('only exits once even if check runs again', () => {
        const { wd, clock, exit } = makeWatchdog();
        wd.recordError('task-a', connErr);
        clock.t = 200_000;
        wd.recordError('task-a', connErr);
        wd.check();
        wd.check();
        expect(exit).toHaveBeenCalledTimes(1);
    });

    test('disabled when thresholdMs <= 0: start() is a no-op and never exits', () => {
        const { wd, clock, exit } = makeWatchdog({ thresholdMs: 0 });
        expect(wd.enabled).toBe(false);
        wd.start();
        wd.recordError('task-a', connErr);
        clock.t = 999_000;
        wd.recordError('task-a', connErr);
        wd.check();
        expect(exit).not.toHaveBeenCalled();
    });

    // Regression for the masking bug fixed 2026-07-07: with
    // FEATURE_PER_TASK_QUEUES (default ON), each task gets its own BullMQ
    // Worker/connection, so a healthy LOW-VOLUME task must NOT be able to
    // clear the wedge streak of an unrelated, genuinely-wedged task. Streaks
    // are now tracked per scope (task/queue id), so `recordHealthy('task-b')`
    // must have zero effect on `task-a`'s streak.
    test('healthy task B does NOT clear the wedge streak of a different, still-wedged task A', () => {
        const { wd, clock, exit } = makeWatchdog();

        // Task A's connection is genuinely wedged.
        wd.recordError('task-a', connErr); // t=0, streak starts for task-a
        clock.t = 100_000;
        wd.recordError('task-a', connErr); // task-a still wedged at 100s

        // Task B — a completely different task's Worker — processes a job on
        // its own, unrelated, healthy connection, repeatedly, throughout.
        wd.recordHealthy('task-b');
        clock.t = 150_000;
        wd.recordHealthy('task-b');

        // Task A's streak (started at t=0) is untouched by task B's health
        // signal, so it crosses the 120s threshold at t=125s.
        clock.t = 125_000;
        wd.recordError('task-a', connErr);
        wd.check();
        expect(exit).toHaveBeenCalledWith(1); // NOT masked: task-a's streak fired
    });

    // Companion: recordHealthy(scope) only clears its OWN scope — a call for
    // task A's scope does not affect task B's independently-tracked streak,
    // and vice versa (proves the Map is keyed correctly, not just "any
    // recordHealthy call clears everything").
    test('recordHealthy(scope) clears only that scope, leaving other scopes independent', () => {
        const { wd, clock, exit } = makeWatchdog();

        wd.recordError('task-a', connErr); // t=0
        wd.recordError('task-b', connErr); // t=0, separate scope

        clock.t = 100_000;
        wd.recordHealthy('task-a'); // only task-a recovers
        wd.recordError('task-b', connErr); // task-b keeps erroring

        clock.t = 125_000;
        wd.recordError('task-b', connErr);
        wd.check();
        expect(exit).toHaveBeenCalledWith(1); // task-b's own streak (0s→125s) tripped

        // task-a's streak was genuinely cleared: a fresh error at 125s alone
        // would not itself be sufficient to explain the trip above having
        // come from task-a — verified independently below.
        const { wd: wd2, clock: clock2, exit: exit2 } = makeWatchdog();
        wd2.recordError('task-a', connErr); // t=0
        clock2.t = 100_000;
        wd2.recordHealthy('task-a'); // cleared
        clock2.t = 125_000;
        wd2.recordError('task-a', connErr); // new streak starts at t=125s
        wd2.check();
        expect(exit2).not.toHaveBeenCalled(); // only 0s into the post-clear streak
    });
});
