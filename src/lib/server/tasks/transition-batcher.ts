// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// transition-batcher.ts — ordered buffer that coalesces run-state transitions
// before flushing them to a sink. Extracted from orchestrator.ts
// (behavior-preserving) — it has no TaskOrchestrator internals.

import type { RunState } from '@sapd/lumastra-plugin-sdk';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { Logger } from '$lib/server/utils/logger.js';
import { taskTransitionBufferDroppedTotal } from './metrics.js';

const log = Logger.for('TransitionBatcher');

/** Buffered transitions above which the buffer is coalesced and trimmed. */
const DEFAULT_MAX_BUFFERED = 10_000;
/** Absolute ceiling, reachable only when terminal transitions alone overflow. */
const DEFAULT_HARD_CAP = 50_000;
/** Minimum spacing between overflow log lines during one outage. */
const OVERFLOW_LOG_INTERVAL_MS = 60_000;
/** Growth factor before another overflow pass while terminal transitions overflow. */
const OVERFLOW_REGROWTH = 1.25;

/** Trim target below a cap so the next O(n) pass is ~10 % of the cap away. */
function lowWater(cap: number): number {
    return cap - Math.max(1, Math.floor(cap * 0.1));
}

export interface TransitionBatcherLimits {
    /** Soft cap: coalesce, then drop the oldest non-terminal transitions. */
    maxBuffered?: number;
    /** Hard cap for terminal transitions that exceed the soft cap. */
    hardCap?: number;
}

const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
    'completed',
    'failed',
    'cancelled',
]);

function isTerminal(req: TransitionRequest): boolean {
    return TERMINAL_STATES.has(req.to) || TERMINAL_STATES.has(req.persistenceState ?? req.to);
}

/**
 * Merge each run's contiguous chain (`a→b`, then `b→c`) into ONE request
 * `{ from: a, to: c }`, so the sink's compare-and-set still starts from the
 * state the run actually holds. A request whose `from` does not continue the
 * run's previous request, or that follows a terminal one, stays separate:
 * terminal transitions are never folded away. The merged request carries the
 * latest request's fields (persistence state, job, origin) and the union of
 * `extra`, at the position of the chain's first request.
 */
function coalesce(buffer: TransitionRequest[]): TransitionRequest[] {
    const out: TransitionRequest[] = [];
    const chainTail = new Map<string, number>();
    for (const req of buffer) {
        const at = chainTail.get(req.runId);
        const prev = at === undefined ? undefined : out[at];
        if (at !== undefined && prev && !isTerminal(prev) && prev.to === req.from) {
            const extra = prev.extra || req.extra ? { ...prev.extra, ...req.extra } : undefined;
            out[at] = { ...req, from: prev.from, ...(extra ? { extra } : {}) };
            continue;
        }
        chainTail.set(req.runId, out.length);
        out.push(req);
    }
    return out;
}

export interface TransitionRequest {
    runId: string;
    /** Immutable producer authority retained while the event is buffered. */
    origin?: AuthorityToken;
    from: RunState;
    to: RunState;
    extra?: Record<string, string | number>;
    /** Queue identity retained for attempt validation before every replay. */
    job?: { id: string; queueName: string };
    /** A successful cancellation CAS still needs its own persistence retry. */
    persistenceState?: RunState;
}

export interface TransitionFlushResult {
    /** Original requests whose persistence has not been acknowledged. */
    unresolved: TransitionRequest[];
}

/**
 * Small ordered buffer that flushes once either:
 *   - the configured ms window has elapsed since the first enqueue, or
 *   - the buffer reaches the configured cap.
 *
 * Each flush invokes `sink` with the snapshot in arrival order. The sink runs
 * sequentially — Lua transitions are per-key atomic, so pipelining at this
 * layer would just add complexity without correctness benefits.
 */
export class TransitionBatcher {
    private buffer: TransitionRequest[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushing = false;
    private stopped = false;
    // The currently in-flight `flush()` call's promise, if any. `stop()` needs
    // this to await the sink that's already running before it can safely
    // drain whatever arrived *during* that sink — otherwise events enqueued
    // while a flush is in flight are stranded (flush() below returns
    // immediately when `flushing` is true, and the in-flight flush's finally
    // block skips re-arming the timer once `stopped` is set).
    private inFlight: Promise<void> | null = null;
    private stopPending: Promise<void> | undefined;
    private strictStopRequested = false;
    private lastFailure: unknown;
    private failureStreak = 0;
    private readonly maxBuffered: number;
    private readonly hardCap: number;
    private lastOverflowLogAt = Number.NEGATIVE_INFINITY;
    private droppedSinceLog = 0;
    private nextOverflowPassAt = 0;
    private overflowPasses = 0;

    constructor(
        private readonly windowMs: number,
        private readonly maxBatch: number,
        private readonly sink: (
            batch: TransitionRequest[],
        ) => Promise<void | TransitionFlushResult>,
        limits: TransitionBatcherLimits = {},
    ) {
        this.maxBuffered = Math.max(2, limits.maxBuffered ?? DEFAULT_MAX_BUFFERED);
        this.hardCap = Math.max(this.maxBuffered, limits.hardCap ?? DEFAULT_HARD_CAP);
    }

    enqueue(req: TransitionRequest): void {
        if (this.stopped) return;
        this.buffer.push(req);
        this.enforceCap();
        if (this.lastFailure !== undefined && this.timer) return;
        if (this.buffer.length >= this.maxBatch) {
            void this.flush();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(() => void this.flush(), this.windowMs);
            if (typeof this.timer.unref === 'function') this.timer.unref();
        }
    }

    isQuiescent(): boolean {
        return this.buffer.length === 0 && !this.flushing;
    }

    pendingCount(): number {
        return this.buffer.length;
    }

    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.flushing) return;
        if (this.buffer.length === 0) return;
        this.flushing = true;
        const batch = this.buffer;
        this.buffer = [];
        const run = (async () => {
            let unresolved: TransitionRequest[] = batch;
            try {
                const result = await this.sink(batch);
                unresolved = result?.unresolved ?? [];
                this.lastFailure = unresolved.length
                    ? new Error('Transition persistence remains unacknowledged')
                    : undefined;
            } catch (err) {
                this.lastFailure = err;
                log.error('TransitionBatcher sink failed', err as Error, {
                    count: batch.length,
                });
            } finally {
                // Older unresolved work stays ahead of arrivals during the sink.
                // Do not replay requests the sink already acknowledged.
                this.buffer = [...unresolved, ...this.buffer];
                this.enforceCap();
                this.flushing = false;
                this.inFlight = null;
                this.failureStreak = unresolved.length > 0 ? this.failureStreak + 1 : 0;
                // Retained work retries without waiting for unrelated events.
                // Back off from one second to thirty seconds during an outage;
                // arrivals cannot bypass that delay and turn it into a hot loop.
                if (this.buffer.length > 0 && !this.stopped) {
                    if (this.timer) clearTimeout(this.timer);
                    const delay =
                        unresolved.length > 0
                            ? Math.min(
                                  30_000,
                                  Math.max(1_000, this.windowMs) *
                                      2 ** Math.min(this.failureStreak - 1, 5),
                              )
                            : this.windowMs;
                    this.timer = setTimeout(() => void this.flush(), delay);
                    if (typeof this.timer.unref === 'function') this.timer.unref();
                }
            }
        })();
        this.inFlight = run;
        await run;
    }

    /**
     * Bound the buffer during a persistence outage: coalesce first, then drop
     * the oldest non-terminal transitions (counted, rate-limited warn). Terminal
     * transitions are kept past the soft cap with an error log, and dropped
     * oldest-first only beyond the hard cap, each drop counted and logged.
     *
     * Amortised: a pass trims to a low-water mark below the cap, and when only
     * terminal transitions overflow, the next pass waits until the buffer has
     * grown by OVERFLOW_REGROWTH. A pass is O(n); enqueues stay O(1) amortised.
     */
    private enforceCap(): void {
        const length = this.buffer.length;
        if (length <= this.maxBuffered) return;
        if (length < this.nextOverflowPassAt && length <= this.hardCap) return;
        this.overflowPasses++;
        this.buffer = coalesce(this.buffer);
        if (this.buffer.length > this.maxBuffered) {
            let excess = this.buffer.length - lowWater(this.maxBuffered);
            let droppedNonTerminal = 0;
            this.buffer = this.buffer.filter((req) => {
                if (excess === 0 || isTerminal(req)) return true;
                excess--;
                droppedNonTerminal++;
                return false;
            });
            if (droppedNonTerminal > 0) {
                taskTransitionBufferDroppedTotal.inc({ kind: 'non_terminal' }, droppedNonTerminal);
                this.droppedSinceLog += droppedNonTerminal;
            }
        }
        if (this.buffer.length > this.hardCap) {
            const keep = lowWater(this.hardCap);
            const droppedTerminal = this.buffer.slice(0, this.buffer.length - keep);
            this.buffer = this.buffer.slice(this.buffer.length - keep);
            taskTransitionBufferDroppedTotal.inc({ kind: 'terminal' }, droppedTerminal.length);
            log.error(
                'TransitionBatcher hard cap exceeded; dropped oldest terminal transitions',
                undefined,
                {
                    dropped: droppedTerminal.length,
                    hardCap: this.hardCap,
                    runIds: droppedTerminal.slice(0, 20).map((req) => req.runId),
                },
            );
        }
        this.nextOverflowPassAt =
            this.buffer.length > this.maxBuffered
                ? Math.ceil(this.buffer.length * OVERFLOW_REGROWTH)
                : 0;
        const now = Date.now();
        if (now - this.lastOverflowLogAt < OVERFLOW_LOG_INTERVAL_MS) return;
        this.lastOverflowLogAt = now;
        if (this.buffer.length > this.maxBuffered)
            log.error('TransitionBatcher terminal transitions exceed the buffer cap', undefined, {
                buffered: this.buffer.length,
                maxBuffered: this.maxBuffered,
                hardCap: this.hardCap,
            });
        if (this.droppedSinceLog > 0) {
            log.warn(
                'TransitionBatcher buffer cap reached; dropped oldest non-terminal transitions',
                {
                    dropped: this.droppedSinceLog,
                    maxBuffered: this.maxBuffered,
                },
            );
            this.droppedSinceLog = 0;
        }
    }

    /** Overflow passes run so far (each is O(buffer)); exposed for bounds tests. */
    overflowPassCount(): number {
        return this.overflowPasses;
    }

    stop(options: { strict?: boolean } = {}): Promise<void> {
        this.strictStopRequested ||= options.strict ?? false;
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.stopPending ??= this.drainAtStop().finally(() => {
            this.stopPending = undefined;
        });
        return this.stopPending;
    }

    private async drainAtStop(): Promise<void> {
        await this.inFlight;
        // Each explicit stop gets a fresh bounded retry budget. Failure retains
        // the original requests so a later strict cleanup can recover.
        for (let attempt = 0; this.buffer.length > 0 && attempt < 2; attempt++) {
            await this.flush();
        }
        if (this.strictStopRequested && this.buffer.length > 0)
            throw new Error('UNKNOWN: terminal transition persistence is incomplete', {
                cause: this.lastFailure,
            });
    }
}
