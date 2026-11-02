// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wall-clock timeout watchdog (task.timeout enforcement).
 *
 * Distinct from the heartbeat-staleness watchdog in runner-stall-watchdog.test.ts.
 * That one fires when `lastHeartbeatSuccessAt` ages past LUMASTRA_RUN_STALL_FAIL_MS.
 * THIS one fires when the handler's runtime since `startHeartbeat()` exceeds
 * `task.timeout.hard`, regardless of heartbeat freshness. Both ultimately
 * invoke the same `autoFailRun` path; the wall-clock check is the only thing
 * that catches a hung handler whose runner-side heartbeat keeps ticking.
 */
import * as timersPromises from 'node:timers/promises';
import * as playbackPressure from './playback-pressure.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';

import { config } from '$lib/server/config.js';
import { decidePlaybackPressure, type PlaybackPressureStatus } from './playback-pressure.js';
import { TaskRunner } from './runner.js';
import type { StateMachine } from './state-machine.js';

// Expose a spyable timer export; other tests retain Node's abort-aware implementation.
vi.mock('node:timers/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:timers/promises')>()),
}));

// TaskRunner tests explicitly host the dedicated consumer role.
beforeEach(() => {
    vi.spyOn(config, 'WORKER_MODE', 'get').mockReturnValue('enabled');
    vi.spyOn(config, 'DEDICATED_WORKER', 'get').mockReturnValue(true);
});
afterEach(() => {
    vi.restoreAllMocks();
});

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

function makeMockSql(): postgres.Sql {
    return vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;
}

function makeMockClient(): ValkeyLike {
    return { customCommand: vi.fn().mockResolvedValue(undefined) };
}

function makeMockStateMachine(): StateMachine {
    return {
        transitionRun: vi.fn().mockResolvedValue({ ok: true, current: 'failed' }),
        claimRun: vi.fn().mockRejectedValue(new Error('claimRun not stubbed')),
        transitionStage: vi.fn().mockRejectedValue(new Error('not stubbed')),
        incrementStage: vi.fn().mockRejectedValue(new Error('not stubbed')),
        reseedForRetry: vi.fn().mockRejectedValue(new Error('not stubbed')),
        enqueueWithIdentity: vi.fn().mockRejectedValue(new Error('not stubbed')),
    } as unknown as StateMachine;
}

interface RunnerInternals {
    playbackWaits: Map<string, { since: number; users: number }>;
    getClient(): ValkeyLike;
    readCheckpointPressure(): Promise<PlaybackPressureStatus>;
    playbackCheckpoint(runId: string, signal: AbortSignal): Promise<void>;
    abortControllers: Map<string, AbortController>;
    lastHeartbeatSuccessAt: Map<string, number>;
    stallFailed: Set<string>;
    runReleases: Map<
        string,
        { release: () => Promise<void>; job: { remove: () => Promise<void>; id?: string } }
    >;
    watchdogTrips: Map<string, (err: Error) => void>;
    runDeadlines: Map<
        string,
        {
            startedAtMs: number;
            hardMs: number;
            softMs: number;
            softWarned: boolean;
            taskId: string;
        }
    >;
    startHeartbeat(runId: string, task: TaskDefinition<unknown, unknown>): void;
    heartbeatOnce(runId: string): Promise<void>;
}

function asInternals(runner: TaskRunner): RunnerInternals {
    return runner as unknown as RunnerInternals;
}

function makeTask(
    id: string,
    timeout?: { hard?: string; soft?: string },
): TaskDefinition<unknown, unknown> {
    return {
        id,
        name: id,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        identityFor: () => 'global',
        inputSchema: { parse: (v: unknown) => v } as unknown as never,
        execute: async () => ({ success: true }),
        timeout,
    } as unknown as TaskDefinition<unknown, unknown>;
}
// Real ownership transactions/scripts are covered by real-store integration tests.
// Unit queue adapters execute their in-memory RPC directly. The durable journal
// and actual BullMQ API are exercised together in queue-write.integration.test.
vi.mock('../../../task-runtime/authority/queue-write.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../task-runtime/authority/queue-write.js')>()),
    withTaskQueueWrite: async (
        _sql: unknown,
        _authority: unknown,
        _operation: unknown,
        write: () => Promise<unknown>,
    ) => write(),
}));
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async (
        sql: postgres.Sql,
        _authority: unknown,
        mutate: (tx: postgres.Sql) => Promise<unknown>,
    ) => mutate(sql),
}));
vi.mock('./owned-write.js', () => ({
    invokeOwnedCommand: async (
        command: string[],
        client: { customCommand(command: string[]): Promise<unknown> },
    ) => client.customCommand(command),
}));

describe('TaskRunner wall-clock timeout watchdog', () => {
    let stateMachine: StateMachine;
    let mockClient: ValkeyLike;
    let mockSql: postgres.Sql;
    let runner: TaskRunner;

    beforeEach(async () => {
        // Fake timers make the per-run heartbeat `setInterval(100ms)` that
        // `startHeartbeat` schedules deterministic: it can ONLY fire when the
        // test explicitly advances time, which these tests never do — they
        // drive the watchdog by calling `heartbeatOnce` directly. Without this,
        // under full-suite load the real 100 ms interval could re-enter
        // `heartbeatOnce` concurrently with a test's manual call and race the
        // assertions (the observed 1212/1213 off-by-one flake). `Date.now()` is
        // frozen, but every back-date here is computed as `Date.now() - N` and
        // `heartbeatOnce` reads the same frozen clock, so all elapsed deltas —
        // and therefore every assertion — are unchanged.
        vi.useFakeTimers();
        stateMachine = makeMockStateMachine();
        mockClient = makeMockClient();
        mockSql = makeMockSql();
        runner = await TaskRunner.start([], {
            stateMachine,
            getSql: () => mockSql,
            getClient: () => mockClient,
            // 100 ms — small enough that the in-test declared hard caps
            // (5s/10s/10m) always exceed it. The runner no longer clamps
            // hardMs up to heartbeatIntervalMs; the wall-clock watchdog runs
            // on a dedicated sampler decoupled from the heartbeat cadence so a
            // short hard cap is honored at its true value (F85).
            heartbeatIntervalMs: 100,
        });
    });

    afterEach(() => {
        // Discards any pending heartbeat intervals scheduled by tests that
        // don't call `runner.stop()`, then restores the real clock.
        vi.useRealTimers();
    });

    it('parses declared timeout.hard and seeds the deadline map', () => {
        const internals = asInternals(runner);
        const runId = 'with-declared-hard';
        internals.abortControllers.set(runId, new AbortController());
        internals.startHeartbeat(runId, makeTask('series-sync', { hard: '10m', soft: '9m' }));

        const deadline = internals.runDeadlines.get(runId);
        expect(deadline).toBeDefined();
        expect(deadline?.hardMs).toBe(10 * 60_000);
        expect(deadline?.softMs).toBe(9 * 60_000);
        expect(deadline?.taskId).toBe('series-sync');
    });

    it('does NOT clamp a hard cap shorter than the heartbeat interval (F85)', () => {
        // heartbeatIntervalMs is 100ms here; a 10ms declared hard cap must be
        // recorded as 10ms, not rounded up to 100ms. The dedicated deadline
        // sampler — not the heartbeat tick — is what enforces it.
        const internals = asInternals(runner);
        const runId = 'sub-heartbeat-hard';
        internals.abortControllers.set(runId, new AbortController());
        internals.startHeartbeat(runId, makeTask('quick-task', { hard: '10ms' }));

        const deadline = internals.runDeadlines.get(runId);
        expect(deadline?.hardMs).toBe(10);
    });

    it('uses the 2-hour default when task declares no timeout', () => {
        const internals = asInternals(runner);
        const runId = 'no-declared-timeout';
        internals.abortControllers.set(runId, new AbortController());
        internals.startHeartbeat(runId, makeTask('no-timeout-task'));

        const deadline = internals.runDeadlines.get(runId);
        expect(deadline?.hardMs).toBe(2 * 60 * 60 * 1000);
        // Soft default is hardMs - 60s OR floor(hardMs * 0.9), whichever is larger.
        // For 2h hard: max(2h - 60s, 0.9 * 2h) = max(7140s, 6480s) = 7140s = 7_140_000ms.
        expect(deadline?.softMs).toBe(2 * 60 * 60 * 1000 - 60_000);
    });

    it('falls back to derived soft when declared soft is invalid (>= hard)', () => {
        const internals = asInternals(runner);
        const runId = 'inverted-soft';
        internals.abortControllers.set(runId, new AbortController());
        // soft >= hard is nonsense; the runner must reject and derive its own.
        internals.startHeartbeat(runId, makeTask('bad-task', { hard: '5m', soft: '10m' }));

        const deadline = internals.runDeadlines.get(runId);
        expect(deadline?.hardMs).toBe(5 * 60_000);
        // Derivation is max(hardMs - 60s, floor(hardMs * 0.9)) —
        // for 5min hard: max(240s, 270s) = 270s.
        expect(deadline?.softMs).toBe(Math.floor(5 * 60_000 * 0.9));
    });

    it('fires auto-fail when handler runtime exceeds task.timeout.hard', async () => {
        const internals = asInternals(runner);
        const runId = 'wall-clock-expired';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('short-task', { hard: '10s', soft: '8s' }));
        // Manually back-date the start so elapsed > hardMs without sleeping.
        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 11_000;
        // Heartbeat-stall guard: keep lastHeartbeatSuccessAt fresh so the OTHER
        // watchdog branch can't be the one firing.
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        expect(abort.signal.aborted).toBe(true);
        expect(stateMachine.transitionRun).toHaveBeenCalledWith(
            expect.objectContaining({
                runId,
                from: 'active',
                to: 'failed',
                extra: expect.objectContaining({
                    errorKind: 'transient',
                    errorMessage: expect.stringContaining('task.timeout.hard'),
                }),
            }),
        );
        expect(internals.stallFailed.has(runId)).toBe(true);
    });

    it('records soft-timeout warn flag without aborting when between soft and hard', async () => {
        const internals = asInternals(runner);
        const runId = 'in-soft-window';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('mid-task', { hard: '10s', soft: '5s' }));
        const deadline = internals.runDeadlines.get(runId)!;
        // 6s in: past soft (5s), before hard (10s).
        deadline.startedAtMs = Date.now() - 6_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        expect(deadline.softWarned).toBe(true);
        // Abort must NOT fire in the soft window.
        expect(abort.signal.aborted).toBe(false);
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
        expect(internals.stallFailed.has(runId)).toBe(false);
    });

    it('does nothing when within both soft and hard windows', async () => {
        const internals = asInternals(runner);
        const runId = 'healthy';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('healthy-task', { hard: '10s', soft: '5s' }));
        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 1_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        expect(deadline.softWarned).toBe(false);
        expect(abort.signal.aborted).toBe(false);
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
    });

    it('clears the deadline entry when stopHeartbeat is called', async () => {
        const internals = asInternals(runner);
        const runId = 'cleanup-check';
        internals.abortControllers.set(runId, new AbortController());
        internals.startHeartbeat(runId, makeTask('cleanup-task', { hard: '1m' }));
        expect(internals.runDeadlines.has(runId)).toBe(true);

        // stopHeartbeat is private but the wall-clock auto-fail path calls it
        // transitively via autoFailRun. We exercise it directly by triggering
        // the auto-fail with an expired deadline.
        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 61_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());
        await internals.heartbeatOnce(runId);

        expect(internals.runDeadlines.has(runId)).toBe(false);
    });

    // W1/C2 — the watchdog must release the concurrency slot AND drop the BullMQ
    // job for a permanently-wedged IN-PROCESS run. The normal `releaseConcurrent`
    // lives in processJob's `finally`, which NEVER runs for a wedged in-process
    // execute() (its promise never settles). Without the watchdog routing through
    // the registered release handle, the per-task counter + class budget token +
    // Worker slot are held for the container's lifetime — 100% capacity loss for
    // a concurrency=1 analysis task.
    it('releases the concurrency slot and removes the BullMQ job for a wedged non-isolated run (W1/C2)', async () => {
        const internals = asInternals(runner);
        const runId = 'wedged-in-process';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('music-analysis', { hard: '10s', soft: '8s' }));

        // Register the terminal-release handle exactly as processJob does once a
        // run starts: the idempotent releaseConcurrent thunk + the BullMQ job.
        const release = vi.fn().mockResolvedValue(undefined);
        const jobRemove = vi.fn().mockResolvedValue(undefined);
        internals.runReleases.set(runId, {
            release,
            job: { remove: jobRemove, id: 'job-wedged' },
        });

        // Back-date the start so the wall-clock watchdog fires on the next beat.
        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 11_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        // The run was auto-failed …
        expect(internals.stallFailed.has(runId)).toBe(true);
        expect(abort.signal.aborted).toBe(true);
        // … and BOTH concurrency resources were freed by the watchdog (the
        // finally that normally does this will never run for a wedged run).
        expect(release).toHaveBeenCalledTimes(1);
        expect(jobRemove).toHaveBeenCalledTimes(1);
    });

    // F2 — when processJob has registered the execute-race trip (the normal case
    // once an in-process run is executing), the watchdog frees the slot by FIRING
    // the trip (rejects the processor promise → BullMQ moveToFailed → slot freed),
    // NOT by job.remove() (which BullMQ rejects for an active locked job). Doing
    // both would make BullMQ log "missing key for job" worker errors.
    it('fires the watchdog-trip (not job.remove) for a wedged run whose execute race is registered (F2)', async () => {
        const internals = asInternals(runner);
        const runId = 'wedged-with-trip';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('file-library-scan', { hard: '10s', soft: '8s' }));

        const release = vi.fn().mockResolvedValue(undefined);
        const jobRemove = vi.fn().mockResolvedValue(undefined);
        internals.runReleases.set(runId, {
            release,
            job: { remove: jobRemove, id: 'job-with-trip' },
        });
        // processJob registers this once execute() starts.
        const tripReject = vi.fn();
        internals.watchdogTrips.set(runId, tripReject);

        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 11_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        expect(internals.stallFailed.has(runId)).toBe(true);
        expect(release).toHaveBeenCalledTimes(1);
        // Slot freed via the trip …
        expect(tripReject).toHaveBeenCalledTimes(1);
        const tripErr = tripReject.mock.calls[0]?.[0] as Error;
        expect(tripErr).toBeInstanceOf(Error);
        expect(tripErr.message).toContain('watchdog');
        // … and NOT via job.remove().
        expect(jobRemove).not.toHaveBeenCalled();
    });

    it('does not throw out of the watchdog when job removal fails (W1 best-effort)', async () => {
        const internals = asInternals(runner);
        const runId = 'wedged-remove-fails';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('music-analysis', { hard: '10s', soft: '8s' }));

        const release = vi.fn().mockResolvedValue(undefined);
        // job.remove() can be rejected by BullMQ when the job's lock is still
        // held (active, wedged processor). The watchdog must swallow it — the
        // stalled-check frees the slot once the lock TTL lapses.
        const jobRemove = vi.fn().mockRejectedValue(new Error('job is locked'));
        internals.runReleases.set(runId, {
            release,
            job: { remove: jobRemove, id: 'job-locked' },
        });

        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 11_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        // Must resolve, not reject — a throw here would abort the heartbeat loop.
        await expect(internals.heartbeatOnce(runId)).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledTimes(1);
        expect(jobRemove).toHaveBeenCalledTimes(1);
        expect(internals.stallFailed.has(runId)).toBe(true);
    });

    it('no-ops the watchdog release path when no run-release handle is registered (W1)', async () => {
        // A run auto-failed before its release handle was registered (e.g. wedged
        // during the brief window before processJob.set) must still auto-fail
        // cleanly without throwing on the absent handle.
        const internals = asInternals(runner);
        const runId = 'no-handle';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(runId, makeTask('music-analysis', { hard: '10s' }));
        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs = Date.now() - 11_000;
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await expect(internals.heartbeatOnce(runId)).resolves.toBeUndefined();
        expect(internals.stallFailed.has(runId)).toBe(true);
    });
    it('keeps a pressure-waiting run alive, excludes wait time, and cancels promptly', async () => {
        const internals = asInternals(runner);
        const runId = 'playback-pressure-wait';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.startHeartbeat(
            runId,
            makeTask('trickplay-generation', { hard: '10s', soft: '8s' }),
        );
        vi.spyOn(internals, 'readCheckpointPressure').mockResolvedValue(
            decidePlaybackPressure(
                [
                    {
                        cpuTranscodes: 1,
                        gpuTranscodes: 0,
                        activeSessions: 1,
                        loadRatioPerCore: 0,
                        sampledAt: Date.now(),
                    },
                ],
                1.25,
                undefined,
            ),
        );
        vi.spyOn(playbackPressure, 'acquirePlaybackCpuSlot').mockResolvedValue(null);
        const waiting = internals.playbackCheckpoint(runId, abort.signal);
        const cancelled = expect(waiting).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        const pause = internals.playbackWaits.get(runId)!;
        expect(pause).toBeDefined();
        pause.since -= 60_000;
        const deadline = internals.runDeadlines.get(runId)!;
        deadline.startedAtMs -= 61_000; // 1 second of work, 60 seconds waiting.
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());
        await internals.heartbeatOnce(runId);
        expect(internals.stallFailed.has(runId)).toBe(false);
        expect(abort.signal.aborted).toBe(false);
        abort.abort();
        await cancelled;
        expect(internals.playbackWaits.has(runId)).toBe(false);
        expect(Date.now() - deadline.startedAtMs).toBe(1000);
    });
    it('checkpoint client-resolution errors fail open rather than failing the task', async () => {
        const internals = asInternals(runner);
        vi.spyOn(internals, 'getClient').mockImplementation(() => {
            throw new Error('offline');
        });
        await expect(
            internals.playbackCheckpoint('offline-checkpoint', new AbortController().signal),
        ).resolves.toBeUndefined();
    });
    it('checkpoint waiting stops at the same 15-minute cap despite persistent pressure', async () => {
        // Route this wait through the fake clock, including the last retry at the cap.
        vi.spyOn(timersPromises, 'setTimeout').mockImplementation(
            <T = void>(ms?: number, value?: T) =>
                new Promise<T>((resolve) => {
                    setTimeout(() => resolve(value as T), ms);
                }),
        );
        const internals = asInternals(runner);
        vi.spyOn(internals, 'readCheckpointPressure').mockResolvedValue(
            decidePlaybackPressure(
                [
                    {
                        cpuTranscodes: 1,
                        gpuTranscodes: 0,
                        activeSessions: 1,
                        loadRatioPerCore: 0,
                        sampledAt: Date.now(),
                    },
                ],
                2,
            ),
        );
        vi.spyOn(playbackPressure, 'acquirePlaybackCpuSlot').mockResolvedValue(null);
        const waiting = internals.playbackCheckpoint(
            'capped-checkpoint',
            new AbortController().signal,
        );
        let finished = false;
        void waiting.then(() => {
            finished = true;
        });
        await vi.advanceTimersByTimeAsync(899_999);
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await waiting;
        expect(finished).toBe(true);
        expect(internals.playbackWaits.has('capped-checkpoint')).toBe(false);
    });
});
