// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker connection-wedge watchdog (crash-only recovery).
 *
 * Failure mode it guards against: after a prolonged Valkey partition or a
 * peer-IP change (e.g. the task-Valkey container is recreated on a new IP), the
 * worker's long-lived BullMQ/ioredis connections to the task keyspace can get
 * stuck — the process stays "running" but every BullMQ Worker emits a continuous
 * stream of `connect ETIMEDOUT` errors and NO jobs are processed, so the admin
 * "no worker is handling <class> jobs" check fires until someone restarts the
 * container by hand. (Observed in prod 2026-06-22 after a Docker network churn.)
 *
 * A naive "can I PING Valkey on a fresh connection" probe does NOT catch this:
 * during the incident, fresh `net.connect` succeeded while BullMQ's own
 * connections stayed wedged. So the only reliable signal is the real worker
 * path: **sustained connection errors from the BullMQ Workers with no job
 * processed in between.** When that persists past a threshold we `process.exit(1)`
 * so Docker's `restart: unless-stopped` brings the worker back with fresh
 * connections — a clean restart is exactly what fixes it by hand.
 *
 * The watchdog also touches a liveness file while healthy (and lets it go stale
 * during an active error streak) so a Docker healthcheck can independently
 * surface a wedge and let an autoheal sidecar act even if the exit can't fire.
 *
 * Per-scope tracking: with `FEATURE_PER_TASK_QUEUES` (default ON) the runner
 * creates one BullMQ Worker — and one underlying connection — per task, not
 * one per resource class. A single process-wide streak would let a healthy,
 * low-volume task's `recordHealthy()` silently clear a genuine wedge on a
 * completely different task's connection, indefinitely masking it (bug found
 * 2026-07-07). So the streak is tracked per `scope` (the task id in per-task
 * mode, the resource class in legacy per-class mode — i.e. whatever id
 * identifies the Worker/connection that produced the signal): `recordError`
 * only extends its own scope's streak, `recordHealthy` only clears its own
 * scope's streak, and one scope's history never affects another's.
 *
 * The `process.exit(1)` action itself stays process-wide by necessity — the
 * fix for a wedged connection is a container restart, which throws away every
 * connection in the process, not just the wedged one. So the trip condition
 * is "ANY scope's streak sustains past `thresholdMs`" — the first scope to
 * cross the line fires the (single, process-wide) exit. There is no separate
 * "process-wide recovery" path to reset every scope: `recordHealthy` already
 * clears a scope the moment its own connection proves itself, independent of
 * any other scope's state, and once tripped the process is gone (a fresh
 * process starts with an empty map on the next boot).
 */
import { writeFileSync } from 'node:fs';
import { Logger } from '$lib/server/utils/logger.js';

/** Default path the watchdog touches while healthy (for the Docker healthcheck). */
export const DEFAULT_WORKER_LIVENESS_FILE = '/tmp/lumastra-worker-alive';

/** Default sustained-error window before declaring the worker wedged. */
const DEFAULT_QUIET_MS = 30_000;
/** Default watchdog tick interval. */
const DEFAULT_CHECK_INTERVAL_MS = 15_000;

// Structurally compatible with the app's LoggerInstance (utils/logger.ts), so a
// real logger can be passed as the default without a cast.
interface WatchdogLogger {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, err?: Error, meta?: Record<string, unknown>) => void;
}

export interface ConnectionWedgeWatchdogOpts {
    /**
     * Sustained-error duration (ms) before the worker is declared wedged and the
     * process exits. `<= 0` disables the watchdog (`start()` becomes a no-op).
     */
    thresholdMs: number;
    /**
     * If no connection error has been seen for this long, the streak is treated
     * as recovered and reset (a transient blip, not a wedge). Default 30s.
     */
    quietMs?: number;
    /** Watchdog tick interval (ms). Default 15s. */
    checkIntervalMs?: number;
    /** File touched (with a timestamp) on each healthy tick; `null` disables. */
    livenessFile?: string | null;
    /** Clock injection for tests. Default `Date.now`. */
    now?: () => number;
    /** Exit injection for tests. Default `process.exit`. */
    exit?: (code: number) => void;
    /** Liveness-file writer injection for tests. Default writes the file. */
    touch?: (file: string, ts: number) => void;
    /** Logger injection for tests. */
    log?: WatchdogLogger;
}

/**
 * True when an error looks like a lost/failed Valkey TCP connection (as opposed
 * to a lock-renew loss or an application error, which are handled elsewhere).
 */
export function isConnectionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|CONNECT_TIMEOUT|ENOTFOUND|EAI_AGAIN|Connection is closed|Connection lost|Stream isn't writeable|enableOfflineQueue/i.test(
        msg,
    );
}

export class ConnectionWedgeWatchdog {
    private readonly thresholdMs: number;
    private readonly quietMs: number;
    private readonly checkIntervalMs: number;
    private readonly livenessFile: string | null;
    private readonly now: () => number;
    private readonly exit: (code: number) => void;
    private readonly touch: (file: string, ts: number) => void;
    private readonly log: WatchdogLogger;

    /**
     * Per-scope error streaks. Keyed by task id (per-task-queue mode) or
     * resource class (legacy per-class mode) — whichever identifies the
     * Worker/connection that produced the signal. Bounded by the size of the
     * task registry (a few dozen entries): a scope is only ever present while
     * it has an unresolved streak — `recordHealthy` and the quiet-window
     * recovery path in `check()` both delete it, so the map never grows past
     * "currently erroring scopes".
     */
    private readonly streaks = new Map<string, { streakStartedAt: number; lastErrorAt: number }>();
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Set once we have exited, so a queued tick can't double-fire. */
    private exited = false;

    constructor(opts: ConnectionWedgeWatchdogOpts) {
        this.thresholdMs = opts.thresholdMs;
        this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
        this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
        this.livenessFile =
            opts.livenessFile === undefined ? DEFAULT_WORKER_LIVENESS_FILE : opts.livenessFile;
        this.now = opts.now ?? Date.now;
        this.exit = opts.exit ?? ((code: number) => process.exit(code));
        this.touch =
            opts.touch ??
            ((file, ts) => {
                // Best-effort: a failed liveness write must never crash the worker.
                try {
                    writeFileSync(file, `${ts}\n`);
                } catch {
                    /* ignore */
                }
            });
        this.log = opts.log ?? Logger.for('ConnectionWatchdog');
    }

    /** Whether the watchdog is enabled (threshold configured). */
    get enabled(): boolean {
        return this.thresholdMs > 0;
    }

    /**
     * Record a BullMQ Worker `error` for `scope` (task id, or resource class in
     * legacy per-class mode). Only connection errors start/extend that scope's
     * streak; other scopes are untouched.
     */
    recordError(scope: string, err: unknown): void {
        if (!this.enabled || this.exited) return;
        if (!isConnectionError(err)) return;
        const now = this.now();
        const existing = this.streaks.get(scope);
        if (!existing) {
            this.streaks.set(scope, { streakStartedAt: now, lastErrorAt: now });
            // Per scope and so ~90 lines per Valkey restart: the one warning per outage
            // comes from queue-outage.ts; the wedge exit below is logged at error level.
            this.log.debug?.('Worker connection-error streak started — watching for a wedge', {
                scope,
                thresholdMs: this.thresholdMs,
            });
            return;
        }
        existing.lastErrorAt = now;
    }

    /**
     * Record proof `scope`'s worker path is alive — a job was actually
     * delivered/processed through BullMQ on that scope's connection. This is
     * the ONLY reliable recovery signal for that scope: it means the
     * task-Valkey connection works end-to-end (unlike a fresh PING or the
     * run-heartbeat, which rides a different connection). Clears ONLY this
     * scope's streak — a healthy scope never masks a wedge on another one.
     */
    recordHealthy(scope: string): void {
        if (this.streaks.delete(scope)) {
            this.log.debug?.('Worker connection recovered (job processed) — clearing wedge streak', {
                scope,
            });
        }
    }

    /** Start the periodic check. No-op when disabled. */
    start(): void {
        if (!this.enabled || this.timer) return;
        // Touch immediately so the healthcheck file exists from boot, not only
        // after the first tick — avoids a spurious "unhealthy" mark on a slow
        // worker boot that runs past the container's start_period.
        if (this.livenessFile) this.touch(this.livenessFile, this.now());
        this.timer = setInterval(() => this.check(), this.checkIntervalMs);
        // Don't keep the event loop alive solely for the watchdog.
        this.timer.unref?.();
        this.log.info('Worker connection-wedge watchdog started', {
            thresholdMs: this.thresholdMs,
            checkIntervalMs: this.checkIntervalMs,
        });
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Exposed for tests; also the interval body. */
    check(): void {
        if (this.exited) return;
        const now = this.now();

        // Trip condition is process-wide by necessity — the recovery action
        // (process.exit) throws away every connection in the process, not just
        // the wedged scope's — so the FIRST scope to sustain past threshold
        // fires it. Deleting the CURRENT entry mid-iteration (recovered-scope
        // branch below) is well-defined for `Map` iteration and doesn't skip
        // any remaining entries.
        let anyActiveStreak = false;
        for (const [scope, state] of this.streaks) {
            // Errors must be BOTH sustained (streak age >= threshold) AND still
            // ongoing (last error within the quiet window). Requiring both means
            // neither a single stale error nor a misconfigured quietMs can
            // false-exit, while a continuous error stream (the real wedge) does.
            const errorsOngoing = now - state.lastErrorAt <= this.quietMs;
            if (errorsOngoing && now - state.streakStartedAt >= this.thresholdMs) {
                this.exited = true;
                this.stop();
                this.log.error(
                    'Worker task-Valkey connection wedged — exiting for a clean restart',
                    undefined,
                    {
                        scope,
                        wedgedForMs: now - state.streakStartedAt,
                        thresholdMs: this.thresholdMs,
                    },
                );
                this.exit(1);
                return;
            }
            if (errorsOngoing) {
                // Active streak, under threshold: not healthy yet. Let the
                // liveness file go stale so the Docker healthcheck can act as an
                // independent backstop if the exit path is ever blocked.
                anyActiveStreak = true;
                continue;
            }
            // Errors stopped for this scope → recovered transient blip.
            this.log.debug?.('Worker connection-error streak cleared (errors stopped)', { scope });
            this.streaks.delete(scope);
        }

        if (anyActiveStreak) return;

        // Healthy (no active wedge on any scope): refresh the liveness file for
        // the healthcheck.
        if (this.livenessFile) this.touch(this.livenessFile, now);
    }
}
