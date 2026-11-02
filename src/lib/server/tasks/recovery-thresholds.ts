// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single source of truth for the orphan/stale-run recovery thresholds.
 *
 * Three independent subsystems decide "this run's worker is dead, reclaim it",
 * each on a different clock, and they MUST stay ordered:
 *
 *   BOOT_STALE_HEARTBEAT_MS   (2 min)  — boot-recovery one-shot at startup
 *        <  RECONCILER_STALE_HEARTBEAT_MS (5 min) — 30s background sweep
 *             <  LUMASTRA_RUN_STALL_FAIL_MS (10 min) — runner's own watchdog
 *
 * The ordering is load-bearing: the runner's watchdog (10 min) must be the LAST
 * line so that, for a run on a still-live worker, the worker gets the longest
 * possible chance to self-terminate before any external reclaimer writes a
 * terminal row — two terminal writes to the same run are only "correct by
 * coincidence" (each is idempotency-guarded separately). Boot (2 min) is the
 * MOST aggressive because at startup the previous process is provably gone, so
 * any run still `active` is provably orphaned. The reconciler (5 min) sits
 * between: it runs continuously against a live cluster, so it allows more grace
 * than boot to avoid racing a healthy run whose heartbeat briefly lagged.
 *
 * These were hardcoded as `INTERVAL '2 minutes'` / `INTERVAL '5 minutes'` SQL
 * literals in three files (boot-recovery, reconciler) plus a parallel
 * `RECONCILER_STALE_HEARTBEAT_MS` constant kept in lock-step "by comment".
 * Centralising them here — interpolated into the SQL via `make_interval` — means
 * a future tuning pass (these have already been re-tuned twice after preprod
 * incidents) edits one place, and `recovery-thresholds.test.ts` fails loudly if
 * anyone inverts the ordering.
 */

/** boot-recovery: an `active`/`cancelling`/`pending` run older than this at
 *  startup is reclaimed (the previous process is provably gone). */
export const BOOT_STALE_HEARTBEAT_MS = 2 * 60 * 1000;

/** reconciler background sweep: an `active`/`cancelling` run whose heartbeat is
 *  older than this is presumed worker-dead and reclaimed. Imported by
 *  `pipeline-timeline.service.ts` for the matching "worker-dead" UI signal so
 *  diagnosis and enforcement cannot drift. */
export const RECONCILER_STALE_HEARTBEAT_MS = 5 * 60 * 1000;

/** reconciler background sweep: a `pending` run never flipped `active` (HSET /
 *  enqueue crash at startRun) older than this is reclaimed. Shorter than the
 *  active threshold because a pending row has no heartbeat to wait on. */
export const RECONCILER_STALE_PENDING_MS = 3 * 60 * 1000;

/**
 * Cancel-grace: a run that has been in `cancelling` longer than this (measured
 * from `task_history.cancel_requested_at`, NOT heartbeat) is force-finalized by
 * the reconciler via the hard-kill path, REGARDLESS of heartbeat freshness.
 *
 * This is a DIFFERENT clock from the stale-heartbeat thresholds above — it is
 * NOT part of their ordering invariant. The heartbeat thresholds answer "is the
 * worker dead?"; once a cancel has been requested, that question is moot: a run
 * that hasn't reached a terminal state within the grace IS wedged, whether or
 * not its heartbeat is still ticking (the lock-loss zombie keeps beating). The
 * grace is generous enough for a cooperative handler to wind down (finish an
 * in-flight subprocess and observe the abort between work items), but bounded so
 * a wedged cancel can never sit "Stopping…" indefinitely. Operator-driven hard
 * cancels ("Force stop") escalate much faster via their own hard-kill timers
 * (orchestrator) — this is the autonomous backstop that needs no operator. */
export const CANCEL_GRACE_MS = 3 * 60 * 1000;
