// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BullMQ lock-loss zombie reaction (Fix A).
 *
 * When BullMQ emits a Worker `error` ("could not renew lock for job <jobId>")
 * the worker has lost the job's lock — it no longer owns the job, but its
 * processor promise keeps running as a zombie whose independent heartbeat
 * setInterval keeps beating, so no stale-heartbeat liveness guard ever reclaims
 * it. `maybeReactToLockLoss` must:
 *   1. Recognise the lock-loss message and return true (so the caller suppresses
 *      the unthrottled warn — BullMQ re-emits this continuously and flooded
 *      stdout to 186 GB once).
 *   2. NOT act on a single transient blip (below threshold).
 *   3. Auto-fail the run once the loss is SUSTAINED (≥ threshold within window),
 *      reusing the stall-watchdog machinery (abort + transitionRun + stallFailed).
 *   4. Drive a 'cancelling' run to 'cancelled' (not 'failed').
 *   5. Never act on an untracked or already-finalized run.
 *
 * These tests pinch `maybeReactToLockLoss` directly via type-coercion so we
 * don't need a real BullMQ worker. Mirrors runner-stall-watchdog.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

import { config } from '$lib/server/config.js';
import { TaskRunner } from './runner.js';
import type { StateMachine } from './state-machine.js';

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
    const fn = vi.fn(() => Promise.resolve([]));
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return fn as unknown as postgres.Sql;
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
    abortControllers: Map<string, AbortController>;
    stallFailed: Set<string>;
    lockLostHits: Map<string, { count: number; lastAt: number }>;
    maybeReactToLockLoss(err: unknown): boolean;
}

function asInternals(runner: TaskRunner): RunnerInternals {
    return runner as unknown as RunnerInternals;
}

function lockLostError(runId: string): Error {
    return new Error(`could not renew lock for job music-analysis~~global-catchup#${runId}`);
}

// Flush the fire-and-forget autoFailRun chain (void this.autoFailRun(...)).
async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
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

describe('TaskRunner BullMQ lock-loss reaction (Fix A)', () => {
    let stateMachine: StateMachine;
    let mockClient: ValkeyLike;
    let mockSql: postgres.Sql;
    let runner: TaskRunner;

    beforeEach(async () => {
        stateMachine = makeMockStateMachine();
        mockClient = makeMockClient();
        mockSql = makeMockSql();
        runner = await TaskRunner.start([], {
            stateMachine,
            getSql: () => mockSql,
            getClient: () => mockClient,
            heartbeatIntervalMs: 3_600_000,
        });
    });

    afterEach(async () => {
        await runner.stop();
    });

    it('returns true for a lock-loss message (so the caller suppresses the flood)', () => {
        const internals = asInternals(runner);
        expect(internals.maybeReactToLockLoss(lockLostError('run_unknown'))).toBe(true);
    });

    it('returns false for an unrelated worker error (generic warn still logs)', () => {
        const internals = asInternals(runner);
        expect(internals.maybeReactToLockLoss(new Error('ECONNRESET'))).toBe(false);
    });

    it('does NOT auto-fail on a single transient lock-loss blip', async () => {
        const internals = asInternals(runner);
        const runId = 'run_blip';
        internals.abortControllers.set(runId, new AbortController());

        internals.maybeReactToLockLoss(lockLostError(runId));
        await flush();

        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
        expect(internals.stallFailed.has(runId)).toBe(false);
    });

    it('auto-fails a tracked run after sustained lock-loss (>= threshold)', async () => {
        const internals = asInternals(runner);
        const runId = 'run_zombie';
        const abort = new AbortController();
        internals.abortControllers.set(runId, abort);

        // Threshold is 3 consecutive failures within the reset window.
        internals.maybeReactToLockLoss(lockLostError(runId));
        internals.maybeReactToLockLoss(lockLostError(runId));
        internals.maybeReactToLockLoss(lockLostError(runId));
        await flush();

        expect(abort.signal.aborted).toBe(true);
        expect(stateMachine.transitionRun).toHaveBeenCalledWith(
            expect.objectContaining({ runId, from: 'active', to: 'failed' }),
        );
        expect(internals.stallFailed.has(runId)).toBe(true);
    });

    it('drives a cancelling run to cancelled (not failed) on sustained lock-loss', async () => {
        const internals = asInternals(runner);
        const runId = 'run_cancelling_zombie';
        internals.abortControllers.set(runId, new AbortController());

        // active→failed rejected (run is already 'cancelling'); fallback
        // cancelling→cancelled accepted — exactly the prod scenario.
        let call = 0;
        vi.mocked(stateMachine.transitionRun).mockImplementation(async () => {
            call++;
            if (call === 1) return { ok: false, current: 'cancelling', error: 'mismatch' };
            return { ok: true, current: 'cancelled' };
        });

        for (let i = 0; i < 3; i++) internals.maybeReactToLockLoss(lockLostError(runId));
        await flush();

        const calls = vi.mocked(stateMachine.transitionRun).mock.calls;
        expect(calls[0][0]).toMatchObject({ from: 'active', to: 'failed' });
        expect(calls[1][0]).toMatchObject({ from: 'cancelling', to: 'cancelled' });
    });

    it('never acts on an untracked run (not in abortControllers)', async () => {
        const internals = asInternals(runner);
        for (let i = 0; i < 5; i++) internals.maybeReactToLockLoss(lockLostError('run_not_ours'));
        await flush();
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
    });

    it('resets the episode counter on an NTP backward step (no premature auto-fail)', async () => {
        const internals = asInternals(runner);
        const runId = 'run_clockskew';
        internals.abortControllers.set(runId, new AbortController());
        // Seed a near-threshold entry whose lastAt is in the FUTURE (clock just
        // stepped back). A naive `now - lastAt > reset` stays false and would let
        // the stale count survive and trip on the next hit.
        internals.lockLostHits.set(runId, { count: 2, lastAt: Date.now() + 60_000 });

        internals.maybeReactToLockLoss(lockLostError(runId));
        await flush();

        // The backward step must reset to a fresh episode (count 1), NOT auto-fail.
        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
        expect(internals.lockLostHits.get(runId)?.count).toBe(1);
    });

    it('does not re-finalize a run already marked stallFailed', async () => {
        const internals = asInternals(runner);
        const runId = 'run_already_failed';
        internals.abortControllers.set(runId, new AbortController());
        internals.stallFailed.add(runId);

        for (let i = 0; i < 5; i++) internals.maybeReactToLockLoss(lockLostError(runId));
        await flush();

        expect(stateMachine.transitionRun).not.toHaveBeenCalled();
    });
});
