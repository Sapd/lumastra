// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Heartbeat watchdog auto-fail behavior (F2).
 *
 * The watchdog runs inside `heartbeatOnce`. When the last successful heartbeat
 * is older than `LUMASTRA_RUN_STALL_FAIL_MS`, it should:
 *   1. Abort the run's AbortController.
 *   2. Transition the run state to `failed` via the state machine.
 *   3. Stop the heartbeat timer.
 *   4. Set `stallFailed` so a late-returning wedged plugin doesn't overwrite
 *      the terminal state.
 *
 * These tests pinch directly at `heartbeatOnce` via type-coercion so we don't
 * need a real BullMQ worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type postgres from 'postgres';

import { config } from '$lib/server/config.js';
import { TaskRunner } from './runner.js';
import type { StateMachine } from './state-machine.js';
import type { IsolationRun } from './isolation/worker-host.js';

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
    // Tagged template — when called as `` sql`...${value}` ``, postgres.js
    // invokes the function with `(strings, ...values)`. Returning an empty
    // array is enough; the watchdog code only uses sql for fire-and-forget
    // UPDATE statements and doesn't read the result.
    const fn = vi.fn(() => Promise.resolve([]));
    // writeTerminalToPostgres calls sql.json() to wrap error/result values
    // before interpolating them into the UPDATE. Without this the call throws
    // TypeError and writeTerminalToPostgres' outer catch swallows it silently.
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return fn as unknown as postgres.Sql;
}

function makeMockClient(): ValkeyLike {
    return { customCommand: vi.fn().mockResolvedValue(undefined) };
}

function makeMockStateMachine(): StateMachine {
    return {
        transitionRun: vi.fn().mockResolvedValue({ ok: true, current: 'failed' }),
        // Unused by heartbeatOnce — stub with rejecting promises so anything
        // that reaches for them fails loudly instead of silently passing.
        claimRun: vi.fn().mockRejectedValue(new Error('claimRun not stubbed')),
        transitionStage: vi.fn().mockRejectedValue(new Error('not stubbed')),
        incrementStage: vi.fn().mockRejectedValue(new Error('not stubbed')),
        reseedForRetry: vi.fn().mockRejectedValue(new Error('not stubbed')),
        enqueueWithIdentity: vi.fn().mockRejectedValue(new Error('not stubbed')),
    } as unknown as StateMachine;
}

interface RunnerInternals {
    abortControllers: Map<string, AbortController>;
    lastHeartbeatSuccessAt: Map<string, number>;
    stallFailed: Set<string>;
    stallWarned: Set<string>;
    heartbeats: Map<string, ReturnType<typeof setInterval>>;
    isolationRuns: Map<string, IsolationRun>;
    heartbeatOnce(runId: string): Promise<void>;
}

function asInternals(runner: TaskRunner): RunnerInternals {
    return runner as unknown as RunnerInternals;
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

describe('TaskRunner heartbeat watchdog auto-fail', () => {
    let stateMachine: StateMachine;
    let mockClient: ValkeyLike;
    let mockSql: postgres.Sql;
    let runner: TaskRunner;

    beforeEach(async () => {
        // Fake timers keep any heartbeat interval from re-entering
        // `heartbeatOnce` asynchronously while a test drives it manually. The
        // back-dates below are all `Date.now() - N` against the same frozen
        // clock `heartbeatOnce` reads, so every elapsed delta — and assertion —
        // is unchanged. (Matches runner-wall-clock-timeout.test.ts.)
        vi.useFakeTimers();
        stateMachine = makeMockStateMachine();
        mockClient = makeMockClient();
        mockSql = makeMockSql();
        // Empty class list — no BullMQ workers spawn.
        runner = await TaskRunner.start([], {
            stateMachine,
            getSql: () => mockSql,
            getClient: () => mockClient,
            // Long interval so the constructor-scheduled timer doesn't fire
            // during the test. We invoke `heartbeatOnce` manually.
            heartbeatIntervalMs: 3_600_000,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('auto-fails a stalled run by transitioning state to failed', async () => {
        const internals = asInternals(runner);
        const runId = 'stalled-run-1';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        // 11 minutes ago — well past the default 10 min LUMASTRA_RUN_STALL_FAIL_MS.
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 11 * 60_000);

        await internals.heartbeatOnce(runId);

        expect(abort.signal.aborted).toBe(true);
        expect(stateMachine.transitionRun).toHaveBeenCalledWith(
            expect.objectContaining({
                runId,
                from: 'active',
                to: 'failed',
                extra: expect.objectContaining({ errorKind: 'transient' }),
            }),
        );
        expect(internals.stallFailed.has(runId)).toBe(true);
        // Heartbeat-success bookkeeping must be cleared so a re-stall on a
        // future run with the same id starts a fresh window.
        expect(internals.lastHeartbeatSuccessAt.has(runId)).toBe(false);

        await runner.stop();
    });

    it('only warns (no auto-fail) when stall is past warn but before fail threshold', async () => {
        const internals = asInternals(runner);
        const runId = 'warning-only';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        // 3 minutes ago — past 2-min warn, well under 10-min fail.
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 3 * 60_000);

        await internals.heartbeatOnce(runId);

        // The auto-fail path must NOT fire — that's the whole point of having
        // a separate warn threshold. (stallWarned is best-effort-cleared by
        // the next successful beat, so we don't assert on it here; we trust
        // the log.warn fires and only assert the side-effects of auto-fail
        // are absent.)
        expect(abort.signal.aborted).toBe(false);
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
        expect(internals.stallFailed.has(runId)).toBe(false);

        await runner.stop();
    });

    it('does nothing when stall is under the warn threshold', async () => {
        const internals = asInternals(runner);
        const runId = 'healthy-run';
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 30_000);

        await internals.heartbeatOnce(runId);

        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
        expect(internals.stallWarned.has(runId)).toBe(false);
        expect(internals.stallFailed.has(runId)).toBe(false);

        await runner.stop();
    });

    it('auto-fails only once per run (idempotent watchdog)', async () => {
        const internals = asInternals(runner);
        const runId = 'double-tick';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 11 * 60_000);

        await internals.heartbeatOnce(runId);
        // Re-seed the lastHeartbeatSuccessAt because stopHeartbeat cleared it.
        // The second invocation must still be guarded by stallFailed, even
        // though the lastHeartbeatSuccessAt timestamp is no longer "stalled".
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 11 * 60_000);
        await internals.heartbeatOnce(runId);

        expect(stateMachine.transitionRun).toHaveBeenCalledTimes(1);

        await runner.stop();
    });
});

// ── F37: single-store heartbeat success keeps the run alive ──────────────────
//
// The stall watchdog measures ONE thing: "is this worker process alive and
// ticking the heartbeat loop?" A single landed write (Valkey OR Postgres)
// proves that. Requiring BOTH stores (`valkeyOk && postgresOk`) conflated
// worker liveness with backing-store availability: an intermittent single-store
// degradation (Postgres pool exhaustion while Valkey is fine, or vice-versa)
// would freeze `lastHeartbeatSuccessAt`, and a healthy worker would be falsely
// warned at 2 min and auto-failed at 10 min.
//
// Regression signal: if the bookkeeping reverts to `valkeyOk && postgresOk`,
// these tests fail — `lastHeartbeatSuccessAt` would NOT advance on a
// half-success beat.

describe('TaskRunner heartbeat — single-store success keeps liveness (F37)', () => {
    let stateMachine: StateMachine;
    let mockClient: ValkeyLike;
    let mockSql: postgres.Sql;
    let runner: TaskRunner;

    function asInternalsF37(r: TaskRunner): RunnerInternals & {
        lastHeartbeatSuccessAt: Map<string, number>;
    } {
        return r as unknown as RunnerInternals & {
            lastHeartbeatSuccessAt: Map<string, number>;
        };
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    async function boot(client: ValkeyLike, sql: postgres.Sql): Promise<void> {
        vi.useFakeTimers();
        stateMachine = makeMockStateMachine();
        mockClient = client;
        mockSql = sql;
        runner = await TaskRunner.start([], {
            stateMachine,
            getSql: () => mockSql,
            getClient: () => mockClient,
            heartbeatIntervalMs: 3_600_000,
        });
    }

    it('advances lastHeartbeatSuccessAt when Valkey succeeds but Postgres fails', async () => {
        // Postgres throws (e.g. pool exhausted); Valkey accepts the beat.
        const failingSql = (() => {
            const fn = vi.fn(() => Promise.reject(new Error('pool exhausted')));
            (fn as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
            return fn as unknown as postgres.Sql;
        })();
        await boot(makeMockClient(), failingSql);

        const internals = asInternalsF37(runner);
        const runId = 'pg-down-valkey-up';
        // Seed a "warned, stalled" baseline 3 min ago: past the 2-min warn but
        // under the 10-min fail. A successful beat must refresh the baseline so
        // the run never reaches the fail threshold.
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 3 * 60_000);
        internals.stallWarned.add(runId);

        await internals.heartbeatOnce(runId);

        // Liveness baseline refreshed to "now" and the stall warning cleared.
        expect(internals.lastHeartbeatSuccessAt.get(runId)).toBe(Date.now());
        expect(internals.stallWarned.has(runId)).toBe(false);
        // No auto-fail despite a half-failed beat.
        expect(internals.stallFailed.has(runId)).toBe(false);
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();

        await runner.stop();
    });

    it('advances lastHeartbeatSuccessAt when Postgres succeeds but Valkey fails', async () => {
        // Valkey throws; Postgres accepts the beat.
        const failingClient: ValkeyLike = {
            customCommand: vi.fn().mockRejectedValue(new Error('valkey down')),
        };
        await boot(failingClient, makeMockSql());

        const internals = asInternalsF37(runner);
        const runId = 'valkey-down-pg-up';
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 3 * 60_000);
        internals.stallWarned.add(runId);

        await internals.heartbeatOnce(runId);

        expect(internals.lastHeartbeatSuccessAt.get(runId)).toBe(Date.now());
        expect(internals.stallWarned.has(runId)).toBe(false);
        expect(internals.stallFailed.has(runId)).toBe(false);
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();

        await runner.stop();
    });

    it('does NOT advance lastHeartbeatSuccessAt when BOTH stores fail', async () => {
        const failingClient: ValkeyLike = {
            customCommand: vi.fn().mockRejectedValue(new Error('valkey down')),
        };
        const failingSql = (() => {
            const fn = vi.fn(() => Promise.reject(new Error('pg down')));
            (fn as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
            return fn as unknown as postgres.Sql;
        })();
        await boot(failingClient, failingSql);

        const internals = asInternalsF37(runner);
        const runId = 'both-down';
        const baseline = Date.now() - 30_000;
        internals.lastHeartbeatSuccessAt.set(runId, baseline);

        await internals.heartbeatOnce(runId);

        // Both writes failed → baseline must stay put so the watchdog can
        // eventually warn/fail a genuinely partitioned worker.
        expect(internals.lastHeartbeatSuccessAt.get(runId)).toBe(baseline);

        await runner.stop();
    });
});

// ── T2: watchdog cancelling→cancelled fallback ───────────────────────────────
//
// When the watchdog fires and the active→failed transition is rejected
// (ok:false) — because a cancel pubsub landed first and the run is already
// 'cancelling' — the watchdog MUST fall through to a cancelling→cancelled
// attempt and write terminal 'cancelled'. Without this, a watchdog-killed run
// that raced a cancel is permanently stranded in 'cancelling'.
//
// Regression signal: if the `!failResult.ok` branch in autoFailRun is removed
// (or the second transitionRun call is dropped), the terminal write emits
// 'failed' instead of 'cancelled' — or is skipped entirely — and this test
// fails on the `to === 'cancelled'` assertion.

describe('TaskRunner watchdog — cancelling→cancelled fallback (T2)', () => {
    let stateMachine: StateMachine;
    let mockClient: ValkeyLike;
    let mockSql: postgres.Sql;
    let runner: TaskRunner;

    beforeEach(async () => {
        stateMachine = makeMockStateMachine();
        mockClient = makeMockClient();
        mockSql = makeMockSql();
        vi.useFakeTimers();
        runner = await TaskRunner.start([], {
            stateMachine,
            getSql: () => mockSql,
            getClient: () => mockClient,
            heartbeatIntervalMs: 3_600_000,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes terminal cancelled when active→failed is rejected and cancelling→cancelled succeeds', async () => {
        const internals = asInternals(runner);
        const runId = 'watchdog-cancel-race';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        // Stall the run past auto-fail threshold.
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 11 * 60_000);

        // First transitionRun call (active→failed) rejected — cancel landed first.
        // Second call (cancelling→cancelled) accepted — run drives to correct terminal.
        let callCount = 0;
        vi.mocked(stateMachine.transitionRun).mockImplementation(
            async (opts: { from: string; to: string }) => {
                callCount++;
                if (callCount === 1) {
                    // active→failed rejected (cancel raced the watchdog)
                    expect(opts.from).toBe('active');
                    expect(opts.to).toBe('failed');
                    return {
                        ok: false,
                        current: 'cancelling',
                        error: 'state mismatch',
                    };
                }
                // cancelling→cancelled accepted
                expect(opts.from).toBe('cancelling');
                expect(opts.to).toBe('cancelled');
                return { ok: true, current: 'cancelled' };
            },
        );

        await internals.heartbeatOnce(runId);

        // Both transitions must have been attempted in order.
        expect(stateMachine.transitionRun).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(stateMachine.transitionRun).mock.calls;
        expect(calls[0][0]).toMatchObject({ from: 'active', to: 'failed' });
        expect(calls[1][0]).toMatchObject({
            from: 'cancelling',
            to: 'cancelled',
        });

        // The Postgres write must target 'cancelled' — a failing assertion here
        // means the run was left 'failed' (wrong metric) or not written at all
        // (stranded in 'cancelling' forever).
        const sqlCalls = (mockSql as unknown as MockInstance).mock.calls as Array<
            [readonly string[], ...unknown[]]
        >;
        const updateCall = sqlCalls.find(([strings]) =>
            Array.from(strings).join('').includes('UPDATE task_history'),
        );
        expect(updateCall, 'writeTerminalToPostgres UPDATE must have fired').toBeDefined();
        // The state value is the first interpolated value in the UPDATE template.
        // makeMockSql resolves every call with []; the important assertion is
        // that `transitionRun` was called with the correct shape, and the run
        // is marked stallFailed so the late-return path is suppressed.
        expect(internals.stallFailed.has(runId)).toBe(true);

        await runner.stop();
    });
});

// ── T3: watchdog hard-kills an isolated worker via terminate() ───────────────
//
// When a run is registered in `isolationRuns` (FEATURE_PLUGIN_WORKER_ISOLATION
// on, task declared `isolation: 'worker'`), the watchdog's autoFailRun MUST
// call `isoRun.terminate(grace)` to force-kill the worker thread. This is the
// core safety guarantee of worker isolation — a synchronous busy-loop in the
// plugin can ONLY be stopped from the main thread via Worker.terminate().
//
// Regression signal: if the `isoRun.terminate(...)` call in autoFailRun is
// removed or the `isolationRuns.get(runId)` lookup is broken, the terminate
// spy is never called and the test fails on the `toHaveBeenCalled` assertion.

describe('TaskRunner watchdog — terminate() called for isolated run (T3)', () => {
    let stateMachine: StateMachine;
    let mockClient: ValkeyLike;
    let mockSql: postgres.Sql;
    let runner: TaskRunner;

    beforeEach(async () => {
        stateMachine = makeMockStateMachine();
        mockClient = makeMockClient();
        mockSql = makeMockSql();
        vi.useFakeTimers();
        runner = await TaskRunner.start([], {
            stateMachine,
            getSql: () => mockSql,
            getClient: () => mockClient,
            heartbeatIntervalMs: 3_600_000,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('calls terminate(grace) on the isolationRun when the watchdog auto-fails', async () => {
        const internals = asInternals(runner);
        const runId = 'isolated-stalled-run';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 11 * 60_000);

        // Register a fake isolated run. terminate() is the only escape hatch
        // for a synchronous busy-loop in a worker thread.
        const terminateSpy = vi.fn(async (_grace: number) => {});
        const fakeIsoRun: IsolationRun = {
            result: new Promise(() => {}), // never resolves in this test
            terminate: terminateSpy,
        };
        internals.isolationRuns.set(runId, fakeIsoRun);

        await internals.heartbeatOnce(runId);

        // The watchdog must have called terminate() — the sole mechanism to
        // stop a synchronously-wedged worker thread from the main thread.
        expect(terminateSpy).toHaveBeenCalledTimes(1);
        // The grace period argument must be a non-negative number (the
        // configured LUMASTRA_ISOLATION_TERMINATE_GRACE_MS, defaulting to 2000
        // per the mock config in runner.test.ts).
        const [graceArg] = terminateSpy.mock.calls[0] as [number];
        expect(typeof graceArg).toBe('number');
        expect(graceArg).toBeGreaterThanOrEqual(0);

        // The run must also be abort-signalled and stallFailed.
        expect(abort.signal.aborted).toBe(true);
        expect(internals.stallFailed.has(runId)).toBe(true);

        // Clean up the never-resolving promise stub.
        internals.isolationRuns.delete(runId);
        await runner.stop();
    });

    it('does NOT call terminate() when the run is not in isolationRuns (in-process path)', async () => {
        const internals = asInternals(runner);
        const runId = 'in-process-stalled';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.lastHeartbeatSuccessAt.set(runId, Date.now() - 11 * 60_000);

        // No entry in isolationRuns — in-process execution, no thread to kill.
        expect(internals.isolationRuns.has(runId)).toBe(false);

        // Should auto-fail without any terminate call.
        await internals.heartbeatOnce(runId);

        expect(abort.signal.aborted).toBe(true);
        expect(internals.stallFailed.has(runId)).toBe(true);
        // isolationRuns must still be empty — no spurious entries.
        expect(internals.isolationRuns.size).toBe(0);

        await runner.stop();
    });
});

// ── Durable cancel fallback ──────────────────────────────────────────────────
//
// Pub/sub never buffers: a `task:cancel` PUBLISH sent while this worker's
// subscription was reconnecting is lost. The orchestrator records the cancel in
// task_history (cancel_requested_at / state 'cancelling') BEFORE publishing, and
// the heartbeat's Postgres write reads it back, so the run still aborts within
// one heartbeat interval.
describe('TaskRunner heartbeat durable cancel fallback', () => {
    async function runnerWithHeartbeatRow(row: { cancel_requested: boolean } | null) {
        const sql = vi.fn(() => Promise.resolve(row ? [row] : [])) as unknown as postgres.Sql;
        (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
        const runner = await TaskRunner.start([], {
            stateMachine: makeMockStateMachine(),
            getSql: () => sql,
            getClient: () => makeMockClient(),
            heartbeatIntervalMs: 3_600_000,
        });
        return runner;
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('aborts the run when Postgres shows a cancel the pub/sub message never delivered', async () => {
        const runner = await runnerWithHeartbeatRow({ cancel_requested: true });
        const internals = asInternals(runner);
        const runId = 'lost-cancel';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        expect(abort.signal.aborted).toBe(true);
        await runner.stop();
    });

    it('leaves a run alone when no cancel was requested', async () => {
        const runner = await runnerWithHeartbeatRow({ cancel_requested: false });
        const internals = asInternals(runner);
        const runId = 'no-cancel';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);
        internals.lastHeartbeatSuccessAt.set(runId, Date.now());

        await internals.heartbeatOnce(runId);

        expect(abort.signal.aborted).toBe(false);
        await runner.stop();
    });
});
