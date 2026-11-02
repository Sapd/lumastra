// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// reconciler.ts — 30s leader-elected sweep for orphan recovery.
//
// Plan §10.2: BullMQ QueueEvents are at-most-once on the subscriber side.
// The reconciler runs every 30s on the leader replica to catch any runs that
// slipped through:
//
//   1. Stale active/cancelling runs (heartbeat > 5 min ago): queries Postgres
//      for candidates, delegates to BootRecovery for single-rule classification.
//
//   2. Stuck waiting-children parents: delegates to OrphanSweep.run().
//
//   3. Pending-write drain: delegates to PendingWriteDrain.drain() so that the
//      5s drain timer is also triggered on demand from the sweep tick.
//
// Leader-only: the caller (TaskOrchestrator) calls start() only when it
// acquires the leader lock, and stop() when the lock is lost. The
// getIsLeader callback provides a fast-path guard inside each tick so that
// any race during start/stop is harmless.

import type postgres from 'postgres';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import { captureValkeyAuthority } from './lua/fenced.js';
import type { Queue } from 'bullmq';
import { BootRecovery } from './boot-recovery.js';
import type { StateMachine } from './state-machine.js';
import type { OrphanSweep } from './orphan-sweep.js';
import type { TaskRegistry } from './registry.js';
import type { PendingWriteDrain } from './pending-write-drain.js';
import { Logger } from '$lib/server/utils/logger.js';
import { reclaimWedgedRunningStageRows } from '$lib/server/database/queries/stage-state.queries.js';
import { FEATURE_PER_TASK_QUEUES } from '$lib/server/config.js';
import { type ValkeyLike } from './valkey-types.js';
import { beatAlive, writeHeartbeat } from './observability/heartbeat.js';
import { appendAuditEvent, pruneAuditLog } from './observability/audit-log.js';
import { readAndResetCounters } from './observability/backpressure-buffer.js';
import { maybeWriteSnapshot } from './observability/snapshot-writer.js';
import { awaitInFlightTick, LOOP_STOP_TIMEOUT_MS } from './loop-stop.js';
import {
    queryStaleCandidateIds,
    queryCancelGraceCandidateIds,
    type ResumeStarter,
} from './run-liveness-authority.js';
import { CANCEL_GRACE_MS } from './recovery-thresholds.js';
import { sweepQueueOperationJournal } from './queue-journal-janitor.js';

const log = Logger.for('Reconciler');

// Recovery thresholds live in one place (`recovery-thresholds.ts`) with an
// ordering test; `queryStaleCandidates` interpolates them into the SQL via
// `make_interval` so the constant and the query can no longer drift. Re-exported
// here for back-compat with importers (`pipeline-timeline.service.ts`).
export {
    RECONCILER_STALE_HEARTBEAT_MS,
    RECONCILER_STALE_PENDING_MS,
} from './recovery-thresholds.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SweepResult {
    orphansReclaimed: number;
    childrenSwept: number;
    pendingDrained: number;
    /**
     * `media_item_stage_state` rows reset from a dead `'running'` back
     * to `'failed_transient'` so stage-sweep can re-pick them up.
     * Non-zero values mean a worker died mid-stage and we cleaned up
     * the stranded per-item state.
     */
    wedgedStageRowsReclaimed: number;
}

// Dedicated liveness-beat cadence — well under the heartbeat TTL (5 min) so the
// reconciler can NEVER read as dead while it holds leadership and the event loop
// is responsive, even if a sweep is wedged on a slow/timed-out DB connection.
const LIVENESS_BEAT_INTERVAL_MS = 10_000;

// ── Reconciler ────────────────────────────────────────────────────────────────

export class Reconciler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private livenessTimer: ReturnType<typeof setInterval> | null = null;
    /** The sweep currently running, if any. stop() waits for it. */
    private inFlight: Promise<void> | null = null;
    /** Set by stop(); a tick that fires after it does not start a sweep. */
    private stopped = false;
    /** Aborts the in-flight tick's sweep between steps (stop / leadership loss). */
    private sweepAbort: AbortController | null = null;
    private readonly bootRecovery: BootRecovery;
    private readonly writeAuthority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly stateMachine: Pick<StateMachine, 'transitionRun'>,
        private readonly getClient: () => Promise<ValkeyLike>,
        private readonly getQueue: (taskId: string) => Queue | undefined,
        private readonly orphanSweep: OrphanSweep,
        private readonly pendingWriteDrain: PendingWriteDrain,
        private readonly getIsLeader: () => boolean,
        /**
         * Wave 8.5 — when on, the aging-sweep is skipped: per-task queues give
         * every task its own pop loop, so the head-of-line starvation the
         * aging-sweep worked around can no longer happen. Defaults to the
         * config flag; test-overridable.
         */
        private readonly perTaskQueues: boolean = FEATURE_PER_TASK_QUEUES,
        // #01 Phase 0: terminal-event emitter, threaded into the reconciler's
        // BootRecovery so runs reclaimed by the BACKGROUND sweep (not just at
        // boot) also emit the CloudEvent + webhook. Optional → tests omit it.
        emitTerminal?: (
            taskId: string,
            runId: string,
            to: 'completed' | 'failed' | 'cancelled',
            extra?: Record<string, string | number>,
            authority?: AuthorityToken,
        ) => Promise<void>,
        // Slice 3 §4.4 — per-class queue-depth probe for the trend snapshot
        // writer (piggybacked on this tick). Optional → tests omit it.
        private readonly getQueueDepths?: () => Promise<
            Record<
                string,
                {
                    waiting: number;
                    active: number;
                    delayed: number;
                    paused: boolean;
                }
            >
        >,
        // Force-finalize a run wedged in 'cancelling' past CANCEL_GRACE_MS,
        // regardless of heartbeat freshness. Wired by the orchestrator to
        // `HardKill.execute` (terminal write + BullMQ job removal + Valkey DEL),
        // which is the only path that finalizes a still-beating zombie without
        // the wedged worker's cooperation. Optional → tests/legacy omit it (the
        // cancel-grace sweep is then skipped).
        private readonly forceFinalizeCancelling?: (
            runId: string,
            authority?: AuthorityToken,
        ) => Promise<void>,
        // Resume-after-restart starter (run-resume.ts) for interrupted manual
        // runs reclaimed by the background sweep. Optional → never resumes.
        resumeRun?: ResumeStarter,
        // The orchestrator's registry, so the sweep classifies runs against
        // the same task set as recoverOnBoot (and a test-injected registry is
        // honoured). Optional → the module registry, as before.
        registry?: TaskRegistry,
        authority?: AuthorityToken,
    ) {
        this.writeAuthority = captureValkeyAuthority(authority);
        this.bootRecovery = new BootRecovery(
            sql,
            stateMachine,
            getClient,
            getQueue,
            registry,
            undefined,
            emitTerminal,
            // F42: durability — the background sweep's BootRecovery reuses the
            // reconciler's pending-write drain so a transient Postgres error on
            // the reclaim UPDATE is enqueued for replay instead of being lost
            // until the next tick.
            pendingWriteDrain,
            resumeRun,
            this.writeAuthority,
        );
    }

    // -- start / stop ----------------------------------------------------------

    /**
     * Start the leader-elected 30s sweep. Called by the orchestrator when it
     * acquires leader lock. Idempotent — calling twice has no effect.
     */
    start(intervalMs: number = 30_000): void {
        if (this.timer) return;
        this.stopped = false;
        const safeInterval = Math.max(5_000, intervalMs);
        this.timer = setInterval(() => {
            void this.tick();
        }, safeInterval);
        if (typeof this.timer.unref === 'function') this.timer.unref();

        // DECOUPLED LIVENESS BEAT (OSS-readiness): write the reconciler's heartbeat
        // from a dedicated, cheap timer that is INDEPENDENT of the sweep work.
        // tick() never overlaps sweeps (one in flight at a time), so a
        // sweepOnce() wedged on a slow/timed-out Postgres connection (the
        // `CONNECT_TIMEOUT ai-postgres` observed under cold-start load) blocks
        // EVERY subsequent tick's beatAlive — after the 5-min TTL the heartbeat
        // lapses and flaps a false-CRITICAL "reconciler isn't reporting in" while
        // the leader is in fact alive, just waiting on the DB. This timer keeps the
        // liveness beat flowing regardless of whether a sweep is in-flight or
        // wedged. Leader-gated via the same fast-path bool tick() uses, so a
        // non-leader can't keep the key warm and mask a real "no leader" outage.
        const liveness = (): void => {
            if (this.getIsLeader()) void beatAlive('reconciler');
        };
        this.livenessTimer = setInterval(liveness, LIVENESS_BEAT_INTERVAL_MS);
        if (typeof this.livenessTimer.unref === 'function') this.livenessTimer.unref();
        liveness(); // immediate beat on leader acquisition

        log.info('Reconciler started', { intervalMs: safeInterval });
        // Fire one tick immediately so stale runs from a previously-crashed
        // leader are reclaimed within seconds of leader-acquisition rather
        // than waiting the full 30s interval. Important on rolling deploys
        // and crash-loop recovery: without this, the new leader leaves a
        // 30s window where runs from the dead leader's instance_id stay in
        // 'active' state — long enough for an admin watching the runs page
        // to see stuck activity and re-trigger work.
        void this.tick().catch((err: unknown) => {
            log.warn('Reconciler initial tick threw', {
                err: err instanceof Error ? err.message : String(err),
            });
        });
    }

    /**
     * Stop scheduling sweeps and wait (bounded) for the one in flight. Resolves
     * true once no sweep is running, false if the wait timed out. The caller
     * holds the coordinator lock until this settles so a successor cannot start
     * a sweep that overlaps ours.
     */
    stop(timeoutMs: number = LOOP_STOP_TIMEOUT_MS): Promise<boolean> {
        this.stopped = true;
        this.sweepAbort?.abort();
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.livenessTimer) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = null;
        }
        return awaitInFlightTick('reconciler', this.inFlight, timeoutMs);
    }

    // -- sweep -----------------------------------------------------------------

    /**
     * One sweep tick — exposed publicly for testing and on-demand invocation.
     */
    async sweepOnce(options: { signal?: AbortSignal } = {}): Promise<SweepResult> {
        const signal = options.signal;
        // A tick-driven sweep stops before its next mutating step once it is
        // aborted (stop) or this instance is no longer the coordinator: a
        // successor may already be sweeping. A sweep called without a signal
        // (tests, on-demand) runs to completion.
        const result: SweepResult = {
            orphansReclaimed: 0,
            childrenSwept: 0,
            pendingDrained: 0,
            wedgedStageRowsReclaimed: 0,
        };
        const aborted = (step: string): boolean => {
            if (!signal) return false;
            if (!signal.aborted && this.getIsLeader()) return false;
            log.info('Reconciler sweep aborted before a mutating step', { step });
            return true;
        };
        // OSS-readiness: write a liveness beat at the START of the tick, not only
        // via emitObservability at the end. On a large/busy install a single sweep
        // (stale-candidate scan + boot recovery + waiting-children drain over a
        // huge backlog) can run long enough that the end-of-tick beat slips past
        // the heartbeat TTL — flapping a false-CRITICAL "reconciler has no
        // heartbeat" while the leader is in fact reconciling. The detailed
        // end-of-tick beat (emitObservability) still lands with the SweepResult.
        await beatAlive('reconciler');

        // 1. Stale active/cancelling runs (5-minute heartbeat threshold).
        //    BootRecovery.run() queries Postgres for stale candidates internally.
        //    We use runForCandidates to target only the 5-min threshold (boot
        //    recovery uses 2-min; we want 5-min here for the background sweep).
        if (aborted('stale-runs')) return result;
        let orphansReclaimed = 0;
        try {
            const stale = await this.queryStaleCandidates();
            if (stale.length > 0 && !aborted('stale-runs')) {
                const report = await this.bootRecovery.runForCandidates(stale);
                orphansReclaimed = report.reclaimed;
                if (orphansReclaimed > 0) {
                    log.info('Reconciler: reclaimed stale runs', {
                        count: orphansReclaimed,
                    });
                }
            }
        } catch (err) {
            log.warn('Reconciler: stale-run sweep failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        // 1a. Cancel-grace force-finalize. A run wedged in 'cancelling' past the
        //     grace (cancel_requested_at, NOT heartbeat) is force-finalized via
        //     the hard-kill path. This catches the lock-loss zombie the
        //     stale-heartbeat reclaim in step 1 CANNOT: that worker keeps beating
        //     its heartbeat (independent setInterval) so it never looks stale, and
        //     its Valkey hash stays present so `isOrphan` protects it — yet it
        //     will never reach a terminal state on its own until its 2h wall-clock
        //     cap. The hard-kill bypasses both guards. Skipped when no finalizer
        //     was wired (tests / legacy).
        result.orphansReclaimed = orphansReclaimed;
        if (aborted('cancel-grace')) return result;
        if (this.forceFinalizeCancelling) {
            try {
                const stuck = await queryCancelGraceCandidateIds(this.sql, CANCEL_GRACE_MS);
                let finalized = 0;
                for (const runId of stuck) {
                    if (aborted('cancel-grace')) return result;
                    try {
                        await this.forceFinalizeCancelling(runId, this.writeAuthority);
                        finalized++;
                    } catch (err) {
                        log.warn('Reconciler: cancel-grace finalize failed', {
                            runId,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
                if (finalized > 0) {
                    log.info('Reconciler: force-finalized runs wedged in cancelling', {
                        count: finalized,
                        graceMs: CANCEL_GRACE_MS,
                    });
                }
            } catch (err) {
                log.warn('Reconciler: cancel-grace sweep failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // 1b. Reconcile leaked maxConcurrent counters. A runner SIGKILL'd
        //     mid-run skips its DECR and leaks +1 on `task:active-count:<task>`
        //     forever; once the leak hits the task's maxConcurrent ceiling
        //     every future job fails "maxConcurrent reached" and the task
        //     wedges. Boot-recovery only swept these at process start (and the
        //     old all-or-nothing guard skipped the sweep whenever any task was
        //     active) — so leaks never self-healed on a busy cluster. Running
        //     the per-task DB-authoritative reconcile here heals them within a
        //     tick.
        if (aborted('active-counters')) return result;
        try {
            await this.bootRecovery.sweepStaleCounters();
        } catch (err) {
            log.warn('Reconciler: active-counter reconcile failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        // 2. Stuck waiting-children parents.
        if (aborted('waiting-children')) return result;
        let childrenSwept = 0;
        try {
            const result = await this.orphanSweep.run();
            childrenSwept = result.swept;
        } catch (err) {
            log.warn('Reconciler: orphan sweep failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        result.childrenSwept = childrenSwept;
        // 3. Pending-write drain (flush any offline writes to Postgres).
        if (aborted('pending-write-drain')) return result;
        let pendingDrained = 0;
        try {
            const result = await this.pendingWriteDrain.drain();
            pendingDrained = result.drained;
        } catch (err) {
            log.warn('Reconciler: pending-write drain failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        // 3a. Queue-operation journal: pending-row gauges, stale unmanaged
        //     leftovers removed, stale managed rows only logged. Never throws.
        result.pendingDrained = pendingDrained;
        if (aborted('queue-operation-journal')) return result;
        await sweepQueueOperationJournal(this.sql);

        // 4. Wedged-running media_item_stage_state rows. Boot-recovery
        //    and the stale-active reclaim above only touch task_history;
        //    when a worker dies between markRunning and the terminal
        //    write, the per-item stage_state row stays at 'running'
        //    forever and stage-sweep skips it. Reset such rows to
        //    'failed_transient' so the next stage-sweep tick re-enqueues
        //    them. Only acts on rows older than 10 min whose owning run
        //    is no longer active in task_history — never races a live
        //    worker.
        if (aborted('wedged-stage-rows')) return result;
        let wedgedStageRowsReclaimed = 0;
        try {
            wedgedStageRowsReclaimed = await withExistingTaskWrite(
                this.sql,
                this.writeAuthority,
                async (tx) => reclaimWedgedRunningStageRows(tx as postgres.Sql),
            );
            if (wedgedStageRowsReclaimed > 0) {
                log.info('Reconciler: reclaimed wedged-running stage_state rows', {
                    count: wedgedStageRowsReclaimed,
                });
            }
        } catch (err) {
            log.warn('Reconciler: wedged stage-state sweep failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        result.wedgedStageRowsReclaimed = wedgedStageRowsReclaimed;
        if (aborted('observability')) return result;
        await this.emitObservability(result);
        return result;
    }

    /**
     * Best-effort observability emission piggybacked on every sweep tick
     * (leader-gated, 30s). Four jobs, each independently guarded so none can
     * break the tick:
     *   1. Subsystem heartbeat (detail = SweepResult).
     *   2. Audit row when this sweep reclaimed anything.
     *   3. Backpressure rollup — read-and-reset the Valkey counters and write
     *      ONE audit row if any were non-zero (no per-event Postgres).
     *   4. 30-day prune of audit_log (source='subsystem') + boot_recovery_log + 90-day prune of audit_log (source='admin').
     */
    private async emitObservability(result: SweepResult): Promise<void> {
        // 1. Heartbeat. Leader-gated subsystem → only the leader keeps it fresh;
        //    if no leader, the key expires (correctly surfacing "stalled").
        await writeHeartbeat('reconciler', {
            status: 'ok',
            detail: { ...result },
        });

        // 2. Reclaim audit row.
        if (result.orphansReclaimed > 0 || result.wedgedStageRowsReclaimed > 0) {
            await appendAuditEvent({
                category: 'reconciler',
                action: 'orphans-reclaimed',
                severity: 'warn',
                summary:
                    `Reconciler reclaimed ${result.orphansReclaimed} orphan(s)` +
                    (result.wedgedStageRowsReclaimed > 0
                        ? ` and ${result.wedgedStageRowsReclaimed} wedged stage row(s)`
                        : ''),
                detail: { ...result },
            });
        }

        // 3. Backpressure rollup.
        try {
            const counters = await readAndResetCounters();
            if (counters.length > 0) {
                const total = counters.reduce((acc, c) => acc + c.count, 0);
                const classes = [...new Set(counters.map((c) => c.resourceClass))].join(', ');
                await appendAuditEvent({
                    category: 'backpressure',
                    action: 'backpressure-shed',
                    severity: 'warn',
                    summary: `Backpressure acted on ${total} job(s) across ${classes} in the last window.`,
                    // `total` is surfaced as a top-level numeric field so the
                    // Slice 3 systemic panel can SUM it over a window without
                    // unpacking the per-class `counters` array.
                    detail: { total, counters },
                });
            }
        } catch (err) {
            log.warn('Reconciler: backpressure rollup failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        // 4. Prune (30 days).
        await pruneAuditLog();

        // 5. Trend snapshot (Slice 3 §4.4) — coarse-cadence (~5 min, guarded in
        //    the writer), best-effort. Only when a queue-depth probe was wired.
        if (this.getQueueDepths) {
            await maybeWriteSnapshot(this.sql, {
                getQueueDepths: this.getQueueDepths,
            });
        }
    }

    // -- private ---------------------------------------------------------------

    private tick(): Promise<void> {
        if (this.stopped || !this.getIsLeader()) return Promise.resolve();
        if (this.inFlight) return Promise.resolve();
        const abort = new AbortController();
        this.sweepAbort = abort;
        this.inFlight = this.sweepOnce({ signal: abort.signal })
            .then(
                () => undefined,
                (err: unknown) => {
                    log.error(
                        'Reconciler tick failed',
                        err instanceof Error ? err : new Error(String(err)),
                    );
                },
            )
            .finally(() => {
                this.inFlight = null;
                if (this.sweepAbort === abort) this.sweepAbort = null;
            });
        return this.inFlight;
    }

    private async queryStaleCandidates(): Promise<string[]> {
        return queryStaleCandidateIds(this.sql);
    }

    /**
     * Test-only accessor for queryStaleCandidates. Allows integration tests to
     * exercise the real SQL threshold logic without loosening production
     * visibility. Named with a leading underscore to signal it is not part of
     * the public API.
     *
     * @internal
     */
    _queryStaleCandidatesForTest(): Promise<string[]> {
        return this.queryStaleCandidates();
    }
}
