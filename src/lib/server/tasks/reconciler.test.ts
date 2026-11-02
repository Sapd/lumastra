// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for reconciler.ts.
 * Postgres, Valkey, BootRecovery, OrphanSweep, and PendingWriteDrain are mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import type { Queue } from 'bullmq';
import { Reconciler, type SweepResult } from './reconciler.js';
import type { StateMachine } from './state-machine.js';
import type { OrphanSweep } from './orphan-sweep.js';
import type { PendingWriteDrain } from './pending-write-drain.js';
import { beatAlive } from './observability/heartbeat.js';

// Heartbeat writes are best-effort Valkey no-ops in tests; mock so we can spy on
// the dedicated liveness beat.
vi.mock('./observability/heartbeat.js', () => ({
    beatAlive: vi.fn().mockResolvedValue(undefined),
    writeHeartbeat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// BootRecovery is instantiated inside Reconciler — we mock the module.
vi.mock('./boot-recovery.js', () => {
    return {
        BootRecovery: vi.fn(function () {
            return {
                run: vi.fn(async () => ({
                    inspected: 0,
                    reclaimed: 0,
                    runIds: [],
                })),
                runForCandidates: vi.fn(async () => ({
                    inspected: 0,
                    reclaimed: 0,
                    runIds: [],
                })),
                sweepStaleCounters: vi.fn(async () => {}),
            };
        }),
    };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSql(
    staleRows: { id: string }[] = [],
    cancelGraceRows: { id: string }[] = [],
): postgres.Sql {
    // Route by query text so the cancel-grace sweep can be tested in isolation
    // from the stale-heartbeat sweep — the cancel-grace query is the only one
    // that references `cancel_requested_at`.
    const fn = vi.fn(async (strings?: TemplateStringsArray) => {
        const text = strings ? Array.from(strings).join(' ') : '';
        return text.includes('cancel_requested_at') ? cancelGraceRows : staleRows;
    }) as unknown as postgres.Sql;
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    (fn as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
    return fn;
}

function makeStateMachine(): Pick<StateMachine, 'transitionRun'> {
    return { transitionRun: vi.fn(async () => ({ ok: true as const })) };
}

function makeClient() {
    return {
        customCommand: vi.fn(async () => null),
    };
}

function makeOrphanSweep(swept = 0): OrphanSweep {
    return {
        run: vi.fn(async () => ({ swept, queuesScanned: 1 })),
    } as unknown as OrphanSweep;
}

function makePendingDrain(drained = 0): PendingWriteDrain {
    return {
        drain: vi.fn(async () => ({ drained, remaining: 0 })),
        start: vi.fn(),
        stop: vi.fn(),
        enqueue: vi.fn(async () => {}),
    } as unknown as PendingWriteDrain;
}

function makeReconciler(opts: {
    staleRows?: { id: string }[];
    cancelGraceRows?: { id: string }[];
    orphanSwept?: number;
    pendingDrained?: number;
    isLeader?: boolean;
    isLeaderFn?: () => boolean;
    perTaskQueues?: boolean;
    forceFinalize?: (runId: string) => Promise<void>;
}): {
    reconciler: Reconciler;
    sql: postgres.Sql;
    orphanSweep: OrphanSweep;
    pendingDrain: PendingWriteDrain;
    client: ReturnType<typeof makeClient>;
} {
    const sql = makeSql(opts.staleRows ?? [], opts.cancelGraceRows ?? []);
    const sm = makeStateMachine();
    const client = makeClient();
    const orphanSweep = makeOrphanSweep(opts.orphanSwept ?? 0);
    const pendingDrain = makePendingDrain(opts.pendingDrained ?? 0);
    const isLeader = opts.isLeader ?? true;

    const reconciler = new Reconciler(
        sql,
        sm,
        async () =>
            client as unknown as {
                customCommand: (cmd: string[]) => Promise<unknown>;
            },
        (_taskId: string): Queue | undefined => undefined,
        orphanSweep,
        pendingDrain,
        opts.isLeaderFn ?? (() => isLeader),
        opts.perTaskQueues ?? false,
        undefined, // emitTerminal
        undefined, // getQueueDepths
        opts.forceFinalize, // cancel-grace force-finalizer
    );

    return { reconciler, sql, orphanSweep, pendingDrain, client };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Reconciler', () => {
    describe('decoupled liveness beat', () => {
        it('beats on its own ~10s cadence, independent of the 30s sweep', async () => {
            vi.useFakeTimers();
            try {
                const beat = vi.mocked(beatAlive);
                beat.mockClear();
                const { reconciler } = makeReconciler({ isLeader: true });
                reconciler.start(30_000);
                // Immediate synchronous beat on leader acquisition.
                expect(beat).toHaveBeenCalledWith('reconciler');
                // Settle the immediate tick + the first liveness beat (t=10s).
                await vi.advanceTimersByTimeAsync(10_000);
                // Advance to t=20s: the 30s SWEEP timer has NOT fired and the
                // immediate tick is long done, so any beat now is from the
                // dedicated liveness timer ALONE — this is the decoupling.
                beat.mockClear();
                await vi.advanceTimersByTimeAsync(10_000);
                expect(beat).toHaveBeenCalledWith('reconciler');
                // stop() clears the liveness timer — no further beats.
                reconciler.stop();
                beat.mockClear();
                await vi.advanceTimersByTimeAsync(60_000);
                expect(beat).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not beat while not the leader (must not mask a no-leader outage)', async () => {
            vi.useFakeTimers();
            try {
                const beat = vi.mocked(beatAlive);
                beat.mockClear();
                const { reconciler } = makeReconciler({ isLeader: false });
                reconciler.start(30_000);
                await vi.advanceTimersByTimeAsync(60_000);
                expect(beat).not.toHaveBeenCalled();
                reconciler.stop();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('sweepOnce', () => {
        it('with no stale runs returns zero orphansReclaimed', async () => {
            const { reconciler } = makeReconciler({ staleRows: [] });
            const result = await reconciler.sweepOnce();
            expect(result.orphansReclaimed).toBe(0);
        });

        it('delegates orphan sweep and reports childrenSwept', async () => {
            const { reconciler } = makeReconciler({ orphanSwept: 3 });
            const result = await reconciler.sweepOnce();
            expect(result.childrenSwept).toBe(3);
        });

        it('delegates pending drain and reports pendingDrained', async () => {
            const { reconciler } = makeReconciler({ pendingDrained: 7 });
            const result = await reconciler.sweepOnce();
            expect(result.pendingDrained).toBe(7);
        });

        it('invokes orphanSweep.run()', async () => {
            const { reconciler, orphanSweep } = makeReconciler({});
            await reconciler.sweepOnce();
            expect(orphanSweep.run).toHaveBeenCalledTimes(1);
        });

        it('invokes pendingWriteDrain.drain()', async () => {
            const { reconciler, pendingDrain } = makeReconciler({});
            await reconciler.sweepOnce();
            expect(pendingDrain.drain).toHaveBeenCalledTimes(1);
        });

        it('with stale rows calls BootRecovery.runForCandidates', async () => {
            // Import the mock to inspect calls.
            const { BootRecovery } = await import('./boot-recovery.js');
            const mockRunForCandidates = vi.fn(async () => ({
                inspected: 2,
                reclaimed: 2,
                runIds: ['run_a', 'run_b'],
            }));
            // sweepStaleCounters MUST be on the mock: sweepOnce() calls it
            // unconditionally (reconciler.ts step 1b). Omitting it throws a
            // TypeError that the surrounding try/catch swallows, which would
            // pass this test while silently breaking the counter-reconcile
            // wiring — so we both stub it and assert it ran.
            const mockSweepStaleCounters = vi.fn(async () => {});
            (BootRecovery as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
                return {
                    runForCandidates: mockRunForCandidates,
                    sweepStaleCounters: mockSweepStaleCounters,
                };
            });

            const { reconciler } = makeReconciler({
                staleRows: [{ id: 'run_a' }, { id: 'run_b' }],
            });

            const result = await reconciler.sweepOnce();
            expect(mockRunForCandidates).toHaveBeenCalledWith(['run_a', 'run_b']);
            expect(mockSweepStaleCounters).toHaveBeenCalledTimes(1);
            expect(result.orphansReclaimed).toBe(2);
        });

        it('survives orphanSweep.run() throwing', async () => {
            const { reconciler, orphanSweep } = makeReconciler({});
            (orphanSweep.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error('redis down'),
            );
            const result = await reconciler.sweepOnce();
            expect(result.childrenSwept).toBe(0);
        });

        it('survives pendingDrain.drain() throwing', async () => {
            const { reconciler, pendingDrain } = makeReconciler({});
            (pendingDrain.drain as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error('pg down'),
            );
            const result = await reconciler.sweepOnce();
            expect(result.pendingDrained).toBe(0);
        });

        // ── Cancel-grace force-finalize (Fix C) ──────────────────────────────
        it('force-finalizes each cancel-grace candidate via the finalizer', async () => {
            const finalized: string[] = [];
            const forceFinalize = vi.fn(async (runId: string) => {
                finalized.push(runId);
            });
            // Cancel-grace rows are routed ONLY to the cancel_requested_at query;
            // staleRows is empty so the finalize calls can't leak from the
            // stale-heartbeat sweep.
            const { reconciler } = makeReconciler({
                staleRows: [],
                cancelGraceRows: [{ id: 'run_cg1' }, { id: 'run_cg2' }],
                forceFinalize,
            });
            await reconciler.sweepOnce();
            expect(forceFinalize).toHaveBeenCalledWith('run_cg1', undefined);
            expect(forceFinalize).toHaveBeenCalledWith('run_cg2', undefined);
            expect(finalized).toEqual(['run_cg1', 'run_cg2']);
        });

        it('does NOT force-finalize stale-heartbeat candidates (only cancel-grace rows)', async () => {
            // Stale rows present but NO cancel-grace rows → finalizer must never fire.
            const forceFinalize = vi.fn(async () => {});
            const { reconciler } = makeReconciler({
                staleRows: [{ id: 'run_stale' }],
                cancelGraceRows: [],
                forceFinalize,
            });
            await reconciler.sweepOnce();
            expect(forceFinalize).not.toHaveBeenCalled();
        });

        it('skips the cancel-grace sweep entirely when no finalizer is wired', async () => {
            // No forceFinalize → the sweep block is gated off; sweepOnce must
            // still complete normally (this is the legacy/test construction).
            const { reconciler } = makeReconciler({ staleRows: [{ id: 'run_x' }] });
            await expect(reconciler.sweepOnce()).resolves.toBeDefined();
        });

        it('survives a forceFinalize that throws and still finalizes the rest', async () => {
            const forceFinalize = vi.fn(async (runId: string) => {
                if (runId === 'run_bad') throw new Error('hard-kill failed');
            });
            const { reconciler } = makeReconciler({
                staleRows: [],
                cancelGraceRows: [{ id: 'run_bad' }, { id: 'run_ok' }],
                forceFinalize,
            });
            const result = await reconciler.sweepOnce();
            // One throwing candidate must not abort the loop or the whole tick.
            expect(forceFinalize).toHaveBeenCalledWith('run_ok', undefined);
            expect(result).toBeDefined();
        });

        // The aging-sweep dead branch (the `!perTaskQueues` block) was deleted
        // in Consolidation #1. The `perTaskQueues` parameter is kept on the
        // Reconciler for constructor signature compatibility but is no longer
        // used for aging-sweep branching — `sweepOnce` always takes the
        // consolidated path. No agedJobsBumped field exists on SweepResult.
    });

    describe('tick overlap guard', () => {
        it('does not invoke sweepOnce a second time when a sweep is already running', async () => {
            vi.useFakeTimers();
            const { reconciler } = makeReconciler({ isLeader: true });

            // Make sweepOnce hang so the first tick never releases `running`.
            let resolveSweep!: () => void;
            const hangingSweep = new Promise<void>((res) => {
                resolveSweep = res;
            });
            const sweepSpy = vi
                .spyOn(reconciler, 'sweepOnce')
                .mockReturnValue(hangingSweep as unknown as Promise<SweepResult>);

            // Start the reconciler so tick() is callable; bypass the interval.
            reconciler.start(60_000);

            // The immediate tick fired by start() runs synchronously up to the
            // hanging sweepOnce, acquiring `running`. Flush microtasks to settle it.
            await Promise.resolve();
            await Promise.resolve();

            // The immediate tick is now in-flight (sweepOnce hanging).
            expect(sweepSpy).toHaveBeenCalledTimes(1);

            // A second scheduled tick fires while the first is still running.
            // Advance by one full interval period — NOT runAllTimers, which would
            // loop forever on the recurring setInterval.
            await vi.advanceTimersByTimeAsync(60_000);

            // sweepOnce must still be 1 — the second tick saw `running = true` and returned early.
            expect(sweepSpy).toHaveBeenCalledTimes(1);

            // Unblock so the test can clean up.
            resolveSweep();
            reconciler.stop();
            vi.useRealTimers();
        });
    });

    describe('stop waits for the in-flight sweep', () => {
        it('does not resolve until the running sweep finishes, and starts no new one', async () => {
            const { reconciler } = makeReconciler({ isLeader: true });
            let resolveSweep!: () => void;
            const hangingSweep = new Promise<void>((res) => {
                resolveSweep = res;
            });
            const sweepSpy = vi
                .spyOn(reconciler, 'sweepOnce')
                .mockReturnValue(hangingSweep as unknown as Promise<SweepResult>);
            reconciler.start(60_000);
            expect(sweepSpy).toHaveBeenCalledTimes(1);

            let stopped: boolean | undefined;
            const stopping = reconciler.stop().then((settled) => {
                stopped = settled;
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(stopped).toBeUndefined();

            resolveSweep();
            await stopping;
            expect(stopped).toBe(true);
            expect(sweepSpy).toHaveBeenCalledTimes(1);
        });

        it('gives up after the timeout and reports the sweep as still running', async () => {
            const { reconciler } = makeReconciler({ isLeader: true });
            vi.spyOn(reconciler, 'sweepOnce').mockReturnValue(
                new Promise<never>(() => {}) as unknown as Promise<SweepResult>,
            );
            reconciler.start(60_000);
            await expect(reconciler.stop(20)).resolves.toBe(false);
        });

        it('aborts a tick-driven sweep before its next mutating step once leadership is lost', async () => {
            let leader = true;
            const forceFinalize = vi.fn(async () => {
                leader = false; // coordinator lost while finalizing the first run
            });
            const { reconciler, orphanSweep } = makeReconciler({
                cancelGraceRows: [{ id: 'run_a' }, { id: 'run_b' }],
                forceFinalize,
                isLeaderFn: () => leader,
            });
            reconciler.start(60_000);
            await vi.waitFor(() => expect(forceFinalize).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 20));
            await reconciler.stop();
            expect(forceFinalize).toHaveBeenCalledTimes(1);
            expect(forceFinalize).toHaveBeenCalledWith('run_a', undefined);
            expect(orphanSweep.run).not.toHaveBeenCalled();
        });

        it('aborts the in-flight sweep on stop()', async () => {
            let release!: () => void;
            const blocked = new Promise<void>((resolve) => {
                release = resolve;
            });
            const forceFinalize = vi.fn(async () => {
                await blocked;
            });
            const { reconciler, orphanSweep } = makeReconciler({
                cancelGraceRows: [{ id: 'run_a' }, { id: 'run_b' }],
                forceFinalize,
                isLeader: true,
            });
            reconciler.start(60_000);
            await vi.waitFor(() => expect(forceFinalize).toHaveBeenCalledTimes(1));
            const stopping = reconciler.stop();
            release();
            await expect(stopping).resolves.toBe(true);
            expect(forceFinalize).toHaveBeenCalledTimes(1);
            expect(orphanSweep.run).not.toHaveBeenCalled();
        });

        it('an on-demand sweep without a signal still runs every step', async () => {
            const forceFinalize = vi.fn(async () => {});
            const { reconciler, orphanSweep } = makeReconciler({
                cancelGraceRows: [{ id: 'run_a' }, { id: 'run_b' }],
                forceFinalize,
                isLeader: false,
            });
            await reconciler.sweepOnce();
            expect(forceFinalize).toHaveBeenCalledTimes(2);
            expect(orphanSweep.run).toHaveBeenCalled();
        });

        it('resolves immediately when idle', async () => {
            const { reconciler } = makeReconciler({ isLeader: false });
            reconciler.start(60_000);
            await expect(reconciler.stop()).resolves.toBe(true);
        });
    });

    describe('leader gate', () => {
        it('start schedules interval; stop clears it', async () => {
            vi.useFakeTimers();
            const { reconciler } = makeReconciler({ isLeader: true });
            const sweepSpy = vi.spyOn(reconciler, 'sweepOnce').mockResolvedValue({
                orphansReclaimed: 0,
                childrenSwept: 0,
                pendingDrained: 0,
                wedgedStageRowsReclaimed: 0,
            });

            // `start()` fires one immediate tick to reclaim runs left over by
            // a previously-crashed leader, then schedules the interval (clamped
            // to a ≥5s floor). So after one interval period we expect 2 calls:
            // immediate + 1 scheduled.
            reconciler.start(5_000);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(sweepSpy).toHaveBeenCalledTimes(2);

            reconciler.stop();
            await vi.advanceTimersByTimeAsync(2_000);
            expect(sweepSpy).toHaveBeenCalledTimes(2); // no additional calls after stop

            vi.useRealTimers();
        });

        it('tick is a no-op when getIsLeader returns false', async () => {
            vi.useFakeTimers();
            const { reconciler } = makeReconciler({ isLeader: false });
            const sweepSpy = vi.spyOn(reconciler, 'sweepOnce');

            reconciler.start(500);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(sweepSpy).not.toHaveBeenCalled();

            reconciler.stop();
            vi.useRealTimers();
        });

        it('start is idempotent', () => {
            const { reconciler } = makeReconciler({});
            reconciler.start(30_000);
            reconciler.start(30_000); // second call no-ops
            reconciler.stop();
        });
    });
});

// Keep behavior fixtures independent of the SQL boundary; recovery-fencing.integration
// exercises the real transactions and ownership rejection.
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async <T>(
        sql: import('postgres').Sql,
        _authority: unknown,
        mutate: (tx: import('postgres').Sql) => Promise<T>,
    ): Promise<T> => mutate(sql),
}));

vi.mock('./lua/fenced.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lua/fenced.js')>();
    return {
        ...actual,
        invokeFencedValkey: async (
            source: string,
            keys: string[],
            args: (string | number)[],
            client: { customCommand(cmd: string[]): Promise<unknown> },
        ): Promise<unknown> =>
            client.customCommand(
                source === "return redis.call('DEL', KEYS[1])"
                    ? ['DEL', ...keys]
                    : ['EVAL', source, String(keys.length), ...keys, ...args.map(String)],
            ),
    };
});
