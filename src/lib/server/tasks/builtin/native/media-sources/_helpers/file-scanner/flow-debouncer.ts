// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watcher Flow Debouncer
 *
 * Coalesces watcher-emitted "downstream flow needed" signals into a single
 * createDownstreamFlow call after a quiet window. The native watcher
 * already debounces rapid events on the same file via per-path timers in
 * WatcherLeader; this debouncer sits a layer up and dedupes ACROSS files,
 * so a bulk import of N files spawns ONE pipeline instead of N.
 *
 * Sliding window with a hard ceiling:
 *   - quietMs: each new signal resets the timer (default 30s, overridable
 *     via WATCHER_FLOW_DEBOUNCE_MS env var).
 *   - HARD_CEILING_MS (5 min, not configurable): after this much wait from
 *     the FIRST signal of a batch the flow fires regardless of incoming
 *     events. Without this an indefinite rsync would never fire.
 *
 * State is module-local on the leader replica; the watcher is leader-
 * elected via Valkey so no cross-replica coordination is needed. On
 * process restart pending signals are lost — the hourly
 * file-library-scan plugin picks up anything missed.
 */

import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('FileScannerFlowDebouncer');

/** Hard ceiling per batch. Five minutes balances "don't keep deferring
 *  forever during continuous rsync" against "don't fire prematurely
 *  during a typical bulk cp." Not env-configurable — adding a second
 *  knob for what's effectively one decision is config bloat for a
 *  problem nobody's reported. */
const HARD_CEILING_MS = 5 * 60_000;

/** Default sliding quiet window. Long enough that a typical bulk
 *  `cp` of dozens-to-hundreds of files settles within one window;
 *  short enough that a stray single-file event doesn't sit waiting
 *  forever. Overridable via WATCHER_FLOW_DEBOUNCE_MS for ops tuning. */
const DEFAULT_QUIET_MS = 30_000;

// Type alias (not interface) so this satisfies `Record<string, unknown>`
// when forwarded to createDownstreamFlow's resultData parameter — interfaces
// are considered open-ended and don't infer an index signature.
export type FlowDebouncerFlags = {
    hasNewFiles: boolean;
    hasMusicFiles: boolean;
};

export interface FlowDebouncerOptions {
    quietMs: number;
    maxMs: number;
    /**
     * Fired once per batch when the timer elapses. Receives the union
     * of flags accumulated across all signal() calls for this batch.
     * Errors inside the callback are swallowed and forwarded to
     * `onError` so a downstream queue blip doesn't kill the watcher.
     */
    onFlush: (flags: FlowDebouncerFlags) => Promise<void>;
    /** Optional logger hook called when onFlush rejects. */
    onError?: (err: unknown) => void;
}

export class DownstreamFlowDebouncer {
    private pendingHasNewFiles = false;
    private pendingHasMusicFiles = false;
    private quietTimer: ReturnType<typeof setTimeout> | null = null;
    private maxTimer: ReturnType<typeof setTimeout> | null = null;
    private batchStartedAt: number | null = null;
    private flushing = false;

    constructor(private readonly opts: FlowDebouncerOptions) {}

    /**
     * Record a signal. If no batch is in flight, starts one. Resets the
     * quiet-window timer. Idempotent: calling repeatedly with the same
     * flags accumulates the union (true OR existing).
     */
    signal(flags: FlowDebouncerFlags): void {
        if (this.batchStartedAt === null) {
            this.batchStartedAt = Date.now();
            // Arm the hard ceiling once per batch — does NOT reset on
            // subsequent signals.
            this.maxTimer = setTimeout(() => {
                void this.fire();
            }, this.opts.maxMs);
        }
        this.pendingHasNewFiles ||= flags.hasNewFiles;
        this.pendingHasMusicFiles ||= flags.hasMusicFiles;

        if (this.quietTimer !== null) clearTimeout(this.quietTimer);
        this.quietTimer = setTimeout(() => {
            void this.fire();
        }, this.opts.quietMs);
    }

    /**
     * Cancel any pending batch without firing. Used by WatcherLeader.stop()
     * — when the leader hands off to another replica we must not let our
     * timer fire a flow under a no-longer-leader process.
     */
    cancel(): void {
        if (this.quietTimer !== null) clearTimeout(this.quietTimer);
        if (this.maxTimer !== null) clearTimeout(this.maxTimer);
        this.quietTimer = null;
        this.maxTimer = null;
        this.batchStartedAt = null;
        this.pendingHasNewFiles = false;
        this.pendingHasMusicFiles = false;
    }

    /** Force-fire any pending batch immediately. Test-only. */
    async flushNow(): Promise<void> {
        if (this.batchStartedAt === null) return;
        await this.fire();
    }

    /** True when a batch is currently being accumulated. */
    hasPending(): boolean {
        return this.batchStartedAt !== null;
    }

    private async fire(): Promise<void> {
        if (this.flushing) return; // re-entrancy guard
        if (this.batchStartedAt === null) return;

        // Snapshot + reset BEFORE awaiting onFlush so a signal arriving
        // mid-flush starts a fresh batch rather than being absorbed
        // into the in-flight one.
        const flags: FlowDebouncerFlags = {
            hasNewFiles: this.pendingHasNewFiles,
            hasMusicFiles: this.pendingHasMusicFiles,
        };
        if (this.quietTimer !== null) clearTimeout(this.quietTimer);
        if (this.maxTimer !== null) clearTimeout(this.maxTimer);
        this.quietTimer = null;
        this.maxTimer = null;
        this.batchStartedAt = null;
        this.pendingHasNewFiles = false;
        this.pendingHasMusicFiles = false;

        this.flushing = true;
        try {
            await this.opts.onFlush(flags);
        } catch (err) {
            // onError is user-supplied; if it throws we'd surface as an
            // unhandled rejection (callers do `void this.fire()`), so
            // swallow defensively. The log inside production onError can't
            // realistically throw, but this keeps the contract robust.
            try {
                this.opts.onError?.(err);
            } catch {
                /* defensive: never let a logger fault the debouncer */
            }
        } finally {
            this.flushing = false;
            // If a new batch accumulated during the flush, its quietTimer
            // may have fired and hit the re-entrancy guard — leaving the
            // batch waiting only on maxTimer (up to 5min). Reset the quiet
            // timer now so the batch fires on the quiet-window cadence
            // rather than waiting for the max ceiling.
            if (this.batchStartedAt !== null) {
                if (this.quietTimer !== null) clearTimeout(this.quietTimer);
                this.quietTimer = setTimeout(() => {
                    void this.fire();
                }, this.opts.quietMs);
            }
        }
    }
}

// =============================================================================
// Process-wide singleton + helpers
// =============================================================================
//
// Owned by this module rather than by index.ts so watcher.ts can import the
// `cancelWatcherFlowDebouncer` helper statically. Putting the singleton in
// index.ts and reaching for it from watcher.ts via dynamic import was the
// alternative — works, but introduces a runtime import on the hot stop()
// path for no good reason.

/** Reads `WATCHER_FLOW_DEBOUNCE_MS` from env. Accepts `0` (fire-on-tick)
 *  for tests and rejects only NaN / negatives. The naive
 *  `Number(env) || DEFAULT` pattern would coerce `0` to the default. */
function parseQuietMsFromEnv(): number {
    const raw = process.env.WATCHER_FLOW_DEBOUNCE_MS;
    if (raw === undefined || raw === '') return DEFAULT_QUIET_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_QUIET_MS;
}

let _singleton: DownstreamFlowDebouncer | null = null;

/** Lazy singleton — env vars are read at first call so tests can stub
 *  them and call `__resetWatcherFlowDebouncerForTests()` between cases. */
export function getWatcherFlowDebouncer(): DownstreamFlowDebouncer {
    if (_singleton === null) {
        _singleton = new DownstreamFlowDebouncer({
            quietMs: parseQuietMsFromEnv(),
            maxMs: HARD_CEILING_MS,
            onFlush: async (flags) => {
                // The downstream import pipeline is no longer wired through
                // the debouncer — flush is a no-op kept so the debouncer's
                // public shape stays stable for tests and callers.
                logger.debug('File watcher: debounce flush (no-op)', { flags });
            },
            onError: (err) => {
                logger.warn('Failed to enqueue downstream flow after debounce', {
                    error: err instanceof Error ? err.message : String(err),
                });
            },
        });
    }
    return _singleton;
}

/** Cancel any in-flight batch. Called from WatcherLeader.stop(). */
export function cancelWatcherFlowDebouncer(): void {
    _singleton?.cancel();
}

/** Test-only: reset the singleton between cases so env-stubbing takes
 *  effect on the NEXT signal. Not exported for production callers. */
export function __resetWatcherFlowDebouncerForTests(): void {
    _singleton?.cancel();
    _singleton = null;
}
