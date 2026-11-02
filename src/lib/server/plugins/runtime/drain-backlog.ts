// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drain-backlog helper for sync plugins.
 *
 * Interprets the admin-facing execution mode (manual/force/catchup) into a
 * loop that fetches slices of pending work, processes each slice, and stops
 * on one of: backlog empty, abort requested, or soft time budget exceeded.
 *
 * Shared across all plugins that declare `manifest.backlog` so each plugin
 * focuses on its own slice-fetcher + slice-processor without re-implementing
 * mode logic, budget tracking, or abort plumbing.
 *
 * ## Canonical wiring pattern (for plugin authors)
 *
 * Every plugin that uses drainBacklog follows the same wiring. `drainBacklog`
 * now owns the heartbeat lifecycle and composes the soft budget into an
 * AbortSignal so plugins don't have to juggle either by hand:
 *
 * ```typescript
 * // 1. Lazy backlog snapshot — counted once, inside the first fetchSlice
 * //    call, so a force-mode onWipe has already run.
 * const initialBacklog = lazyBacklog(() => countEligibleRows(sql));
 *
 * // 2. Run counters live outside drainBacklog so the heartbeat and the
 * //    progress status line can read them.
 * let processed = 0;
 *
 * // 3. drainBacklog creates + clears the heartbeat from `heartbeat` opts
 * //    and exposes a composed abort signal (ctx.abortSignal + soft-budget
 * //    timeout) to processSlice. Plugins that care about mid-slice
 * //    pre-emption thread `signal` into long-running ops; those that ignore
 * //    it still get "stop between slices" semantics unchanged.
 * const result = await drainBacklog<Row>(ctx, {
 *     mode: resolveDrainMode(ctx.mode, logger),
 *     sliceSize: 200,
 *     onWipe: async () => { ... },
 *     idOf: (row) => row.id,
 *     fetchSlice: async (limit) => {
 *         const items = await fetchRows(sql, limit);
 *         const total = await initialBacklog();
 *         return {
 *             items,
 *             remainingHint: computeRemainingHint(total, processed, items.length)
 *         };
 *     },
 *     processSlice: async (items, signal) => {
 *         const { fetched, failed, advanced } = await doWork(items, signal);
 *         processed += items.length;
 *         return { produced: fetched, advanced };
 *     },
 *     onProgress,
 *     phase: 'Fetching metadata',
 *     heartbeat: {
 *         getTotal: () => initialBacklog.peek(),
 *         getProcessed: () => processed,
 *         getStatus: () => `Processing ${processed} items...`
 *     }
 * });
 * ```
 *
 * Plugins that need to wrap multiple drainBacklog calls inside a single
 * heartbeat (e.g. a two-phase drain) keep using `startHeartbeat` directly —
 * leave `heartbeat` unset on each drainBacklog call and manage the
 * lifecycle in the plugin's own try/finally.
 */

import type { SyncExecutionContext } from '../../tasks/sync-context-types.js';

/**
 * Structural logger surface used by the drain helpers. Intentionally narrower
 * than `LoggerInstance` so callers can pass any logger that exposes the four
 * level methods — including the SDK's `Logger` interface that native task
 * plugins receive via `ctx.logger`. Without this widening every native
 * caller has to thread a runtime cast through `resolveDrainMode` /
 * `startHeartbeat` / `drainWipe`, which buries real type errors under noise.
 *
 * The signatures use the loosest shape that both `LoggerInstance` and the SDK
 * `Logger` interface satisfy: `(message, meta?)` for every level. Drain
 * helpers never invoke the LoggerInstance-only second-arg-as-Error overload,
 * so widening here is safe.
 */
export interface DrainBacklogLogger {
    debug(message: string, meta?: object): void;
    info(message: string, meta?: object): void;
    warn(message: string, meta?: object): void;
    error(message: string, meta?: object): void;
}

/**
 * drainBacklog only reads `logger` and `abortSignal` from the caller's
 * context. `SyncExecutionContext`, `PluginContext`, and `TaskContext` all
 * satisfy this shape structurally — pass any of them directly without a shim
 * or cast. `TaskContext` has both `signal` and `abortSignal` (aliases); use
 * `abortSignal` when constructing a minimal literal.
 */
type DrainBacklogContext = {
    logger: DrainBacklogLogger;
    abortSignal: SyncExecutionContext['abortSignal'];
};

/** Values accepted from the admin task-start endpoint. */
export type DrainBacklogMode = 'manual' | 'force' | 'catchup';

/**
 * A single slice of pending work returned by the plugin-provided fetcher.
 * `T` is the plugin's own unit (e.g. season ID string, media item UUID).
 *
 * IMPORTANT: `fetchSlice` must return items in a deterministic order (e.g.
 * `ORDER BY id`). The no-progress detector uses a cheap length + joined-ids
 * signature to notice a stuck fetcher, and that comparison assumes stable
 * ordering.
 */
export interface DrainSlice<T> {
    /** Items to process in this slice */
    items: T[];
    /** Best-effort count of items still remaining after this slice (optional, used for progress reporting) */
    remainingHint?: number;
}

/**
 * Return value of the plugin-provided `processSlice` function.
 *
 * `advanced` is the key signal that distinguishes a genuinely stuck fetcher
 * (same items returned twice — likely a forgotten "mark processed" step)
 * from a transient failure (DB outage → every row in the slice threw →
 * nothing got sentineled → same slice comes back). When `advanced > 0`, the
 * drain loop knows progress IS happening even if `produced === 0`, and the
 * no-progress trip wire stays armed rather than firing a false positive.
 */
export interface ProcessSliceResult {
    /**
     * Count of "results produced" — meaning is plugin-specific (e.g. number
     * of TMDB records fetched, number of popularity scores updated). Summed
     * into `DrainBacklogResult.resultsProduced` for the final summary.
     */
    produced: number;
    /**
     * Count of rows whose processing state changed this slice — either
     * successfully processed OR permanently marked failed. When this is 0
     * AND the next slice has the same signature, the fetcher is stuck and
     * drainBacklog stops with `no-progress`. When this is > 0, identical
     * signatures are treated as "try again" (the fetcher may genuinely be
     * returning the same rows because they're still eligible after a
     * partial write).
     */
    advanced: number;
}

/**
 * Heartbeat configuration folded into `drainBacklog`. Prefer this over
 * hand-rolling `startHeartbeat` — the helper installs the interval on entry
 * and clears it in its own finally, which deduplicates six identical
 * try/finally blocks across the sync plugins. Use `startHeartbeat` directly
 * only when a single heartbeat needs to span multiple `drainBacklog` calls
 * (e.g. media-probe's two-phase drain).
 */
export interface DrainBacklogHeartbeat {
    /** Snapshot denominator. Return null until the first fetchSlice has run. */
    getTotal: () => number | null;
    /** Numerator (items processed so far). */
    getProcessed: () => number;
    /** Free-form status line shown under the bar. */
    getStatus: () => string;
    /** Timer interval; defaults to 2min when unset. */
    intervalMs?: number;
}

export interface DrainBacklogOptions<T> {
    /** Admin-provided mode — decides wipe + loop semantics */
    mode: DrainBacklogMode;
    /**
     * Target slice size per iteration. Plugins should honor it as a hint —
     * e.g. fetch up to `sliceSize` unanalyzed seasons.
     */
    sliceSize: number;
    /**
     * Soft wall-clock budget (ms), measured from the moment `drainBacklog`
     * starts. Includes time spent in `onWipe`, so a slow wipe counts
     * against the loop's remaining budget — otherwise a 90-min wipe + a
     * fresh 110-min post-wipe loop would blow past BullMQ's 2h maxDuration
     * and get the job stall-killed. The loop finishes the current slice
     * and returns a partial result when exceeded. 0 disables the budget.
     * Default 110 min (matches the 2h BullMQ maxDuration minus 10min grace).
     *
     * Also composed into the signal passed to `processSlice` — plugins that
     * thread the signal into fetches/child processes get *mid-slice*
     * pre-emption in addition to the between-slices check. The composition
     * is done ONCE per drain (not per slice) so a long run doesn't leak
     * timers or listeners.
     */
    softBudgetMs?: number;
    /**
     * Called once before the first slice when `mode === 'force'`. If the
     * plugin declares `manifest.backlog.destructive` but forgot to pass
     * `onWipe`, drainBacklog logs a warning and degrades to manual drain
     * — the admin clicked "Re-analyze everything" and silently getting a
     * no-op would be confusing.
     */
    onWipe?: () => Promise<void>;
    /**
     * Fetch the next slice of unprocessed units. Return `{ items: [] }` to
     * stop the loop cleanly (backlog drained). Items MUST be returned in a
     * deterministic order — see `DrainSlice` docs.
     */
    fetchSlice: (sliceSize: number) => Promise<DrainSlice<T>>;
    /**
     * Process a single slice. `signal` is the composition of
     * `ctx.abortSignal` and (when `softBudgetMs > 0`) an
     * `AbortSignal.timeout(remainingBudget)`. Plugins that care about
     * mid-slice pre-emption should thread `signal` into long-running ops
     * (fetch, child processes, DB calls); plugins that ignore it still get
     * "stop between slices" semantics unchanged from before.
     *
     * See `ProcessSliceResult` for the semantics of `produced` vs `advanced`.
     */
    processSlice: (items: T[], signal: AbortSignal) => Promise<ProcessSliceResult>;
    /**
     * Optional progress reporter. Receives cumulative processed/total values
     * when `remainingHint` is present, otherwise just processed counts.
     */
    onProgress?: SyncExecutionContext['onProgress'];
    /** Human-readable phase label for progress reporting */
    phase?: string;
    /**
     * Cheap stable identifier extractor for the no-progress signature. When
     * omitted, drainBacklog falls back to `JSON.stringify(item)` — correct
     * but slow and prone to false-negatives when mutable fields (`updated_at`
     * etc.) drift across fetches. Every plugin row type has an obvious ID;
     * pass it explicitly.
     */
    idOf?: (item: T) => string;
    /**
     * Fold the heartbeat lifecycle into drainBacklog. When present, the
     * helper calls `startHeartbeat` on entry (sharing `onProgress`, `logger`,
     * and `phase`) and clears it in its own finally — no plugin-side
     * try/finally required. Omit when a single heartbeat must outlive this
     * drain (e.g. across multiple phases).
     */
    heartbeat?: DrainBacklogHeartbeat;
}

export interface DrainBacklogResult {
    /** Units processed across all slices */
    unitsProcessed: number;
    /** Sum of `processSlice` return values — meaning is plugin-specific */
    resultsProduced: number;
    /** Why the loop exited */
    stopReason: DrainStopReason;
    /**
     * Present only when `onWipe` threw in force mode. The error is captured,
     * the drain aborts with `stopReason: 'aborted'`, and the plugin caller
     * can choose to surface it via its SyncTaskResult. Kept optional so the
     * happy path has no `wipeError: undefined` field noise.
     */
    wipeError?: Error;
}

export type DrainStopReason = 'drained' | 'aborted' | 'budget' | 'single-slice' | 'no-progress';

const DEFAULT_SOFT_BUDGET_MS = 110 * 60 * 1000;

/**
 * Per-tick soft budget for catchup-mode runs. Catchup is the scheduled
 * cadence path — it MUST stay short so the BullMQ worker is free for the
 * next tick and other tasks sharing the resource class. Within that
 * 5-minute window, we loop as many slices as fit, so a 30k-item backlog
 * actually drains at a useful rate (instead of one-slice-per-6h = months).
 *
 * Tasks can still pass a larger softBudgetMs but in catchup mode it is
 * clamped down to this value — the caller's intent for "manual" budgets
 * shouldn't accidentally promote a tick into a multi-hour drain.
 */
const CATCHUP_SOFT_BUDGET_MS = 5 * 60 * 1000;

/** Values the admin task-start endpoint actually passes before coercion. */
export type IncomingDrainMode = string | undefined;

/**
 * Coerce the incoming execution mode to one of the three values `drainBacklog`
 * understands. Any unknown mode (including the legacy `'smart'`) collapses to
 * `'catchup'` — the scheduled, single-slice mode used when a plugin runs on
 * its own cadence.
 */
export function resolveDrainMode(
    mode: IncomingDrainMode,
    logger?: DrainBacklogLogger,
): DrainBacklogMode {
    if (mode === 'manual' || mode === 'force' || mode === 'catchup') {
        return mode;
    }
    if (mode) {
        logger?.debug?.(
            `Unknown sync mode '${mode}' — coercing to 'catchup' (scheduled single-slice)`,
        );
    }
    return 'catchup';
}

/**
 * Human-readable suffix for `SyncTaskResult.message` so the admin UI explains
 * why a sync finished without clearing the backlog. Returns an empty string
 * for the two happy-path outcomes:
 *   - `drained`       — manual/force drained to empty.
 *   - `single-slice`  — catchup completed its scheduled slice. Catchup runs
 *                       every tick by design; annotating each one as "single
 *                       slice — scheduled run" just adds noise to task history.
 */
export function formatStopReason(stopReason: DrainStopReason): string {
    switch (stopReason) {
        case 'drained':
        case 'single-slice':
            return '';
        case 'aborted':
            return ' (aborted)';
        case 'budget':
            return ' (soft time budget exceeded — remaining items will run on the next catchup)';
        case 'no-progress':
            return ' (no progress — fetcher returned identical slices while no rows advanced)';
    }
}

/**
 * `true` for stop reasons that should be reported as a failed run.
 *
 * Only `aborted` flips the sync's SyncTaskResult.success → false so admin
 * task history doesn't green-check cancelled jobs. `budget` and `no-progress`
 * are legitimate end-states for a single invocation — the next scheduled
 * catchup will pick up where this one left off.
 */
export function isAbortedStop(stopReason: DrainStopReason): boolean {
    return stopReason === 'aborted';
}

/**
 * Severity ordering for stop reasons, highest-priority first. Used by
 * `pickWorstStopReason` to collapse multiple phase results into a single
 * representative reason for the summary message.
 *
 * `aborted` wins everything — an admin asked for the job to stop. After
 * that, `no-progress` (likely a plugin bug) outranks `budget` (expected
 * under heavy load) which outranks `single-slice` (normal catchup) and
 * `drained` (happy path).
 */
const STOP_REASON_SEVERITY: Record<DrainStopReason, number> = {
    aborted: 4,
    'no-progress': 3,
    budget: 2,
    'single-slice': 1,
    drained: 0,
};

/**
 * Pick the most informative stop reason from a list of phase results. Used
 * by multi-phase plugins (e.g. media-probe's Phase A + Phase B) so a clean
 * Phase-B `drained` doesn't mask a Phase-A `no-progress` in the summary
 * message. Undefined entries are ignored so callers can pass results from
 * optional phases without pre-filtering.
 *
 * Returns `'drained'` for an empty / all-undefined input so the caller gets
 * a well-formed value without having to branch on null.
 */
export function pickWorstStopReason(reasons: (DrainStopReason | undefined)[]): DrainStopReason {
    let worst: DrainStopReason = 'drained';
    let worstScore = STOP_REASON_SEVERITY.drained;
    for (const r of reasons) {
        if (r === undefined) continue;
        const score = STOP_REASON_SEVERITY[r];
        if (score > worstScore) {
            worst = r;
            worstScore = score;
        }
    }
    return worst;
}

/**
 * Compute the `remainingHint` value every drain-backlog plugin derives from
 * a one-shot backlog snapshot: subtract what's already been processed plus
 * the slice drain-backlog is about to count. Clamped to ≥0 so the progress
 * hint stays well-formed even if the snapshot and the live counters race
 * (e.g. a concurrent writer added rows mid-drain).
 */
export function computeRemainingHint(
    initialBacklog: number,
    processedSoFar: number,
    sliceLength: number,
): number {
    return Math.max(0, initialBacklog - processedSoFar - sliceLength);
}

/**
 * Memoized backlog counter. `count()` runs exactly once — the first call
 * takes the snapshot, subsequent calls return the cached value. `peek()`
 * returns the cached value or `null` if no snapshot has been taken yet.
 *
 * Use inside `fetchSlice` so the snapshot happens *after* a force-mode wipe
 * has run — a pre-wipe eager snapshot would undercount in force mode because
 * the wipe restores eligibility of rows the previous run had already marked
 * done.
 */
export interface LazyBacklog {
    (): Promise<number>;
    /** Cached value, or null if not yet computed */
    peek(): number | null;
}

export function lazyBacklog(count: () => Promise<number>): LazyBacklog {
    let cached: number | null = null;
    // Cache the in-flight Promise (not just the resolved value). Two
    // concurrent `lazy()` callers both hit this function before the first
    // `count()` resolves; caching the resolved value means both see
    // `cached === null` and each kicks off its own `count()`. Caching the
    // Promise lets both awaiters share a single underlying fetch.
    let pending: Promise<number> | null = null;
    const fn = (async (): Promise<number> => {
        if (cached !== null) return cached;
        if (pending === null) {
            pending = count().then((value) => {
                cached = value;
                return value;
            });
        }
        return pending;
    }) as LazyBacklog;
    fn.peek = (): number | null => cached;
    return fn;
}

/**
 * Rate-limit window (ms) for repeated `onProgress` failures in the heartbeat.
 * Valkey blips come in clusters; logging every failure at WARN buries
 * everything else. Programming errors (TypeError/ReferenceError) bypass this
 * and log every time so they stay visible.
 */
const HEARTBEAT_WARN_THROTTLE_MS = 60_000;

/**
 * Heartbeat interval that calls `onProgress` every `intervalMs` (default 2min)
 * so BullMQ's stall detector doesn't kill a job during a slow slice where
 * processSlice is churning but hasn't returned yet.
 *
 * Inside the timer, logger errors from `onProgress` are classified:
 *   - `TypeError` / `ReferenceError` → always logged with full stack
 *     (real bugs; no throttle).
 *   - Anything else (Valkey/Redis blips, network hiccups, pool exhaustion)
 *     → WARN rate-limited to once per `HEARTBEAT_WARN_THROTTLE_MS`.
 *
 * This matches the two failure shapes we see: transient infra + permanent
 * bugs. Without classification, a 5-minute Valkey outage spams 150 WARNs
 * while burying any real stack trace in the noise.
 *
 * Returns a handle with `clear()` to call from the plugin's `finally` block.
 */
export function startHeartbeat(opts: {
    onProgress: SyncExecutionContext['onProgress'];
    logger: DrainBacklogLogger;
    /**
     * Snapshot of the denominator (total eligible). When 0/null, the heartbeat
     * skips firing — avoids (0, 0) in the UI and divide-by-zero rendering.
     */
    getTotal: () => number | null;
    /** Numerator (items processed so far) */
    getProcessed: () => number;
    /** Free-form status line shown under the bar */
    getStatus: () => string;
    phase: string;
    intervalMs?: number;
}): { clear: () => void } {
    let lastWarnAt = 0;
    const interval = setInterval(() => {
        try {
            const total = opts.getTotal();
            if (!total) return;
            const processed = opts.getProcessed();
            // When the live processed counter has drifted past the snapshot
            // denominator (e.g. backlog grew mid-drain, or the snapshot was
            // taken after a few items were already in-flight), clamping with
            // Math.max(total, processed) pegs the bar at 100% while the drain
            // continues — misleading in the admin UI. Switch to a visibly
            // "in progress past the snapshot" representation: denominator
            // grows by one each tick so the bar shows slow forward motion.
            const overrun = processed > total;
            const denom = overrun ? processed + 1 : total;
            const status = overrun
                ? `finalizing ${processed} items (past initial estimate)...`
                : opts.getStatus();
            opts.onProgress?.(processed, denom, {
                currentItem: status,
                phase: opts.phase,
            });
        } catch (err) {
            // The classifier itself must never throw — if `opts.logger.warn`
            // or `.error` throws (e.g. transport failure, circular-JSON data
            // the logger tries to serialize), the uncaught error would
            // propagate out of the setInterval callback and crash the
            // worker process. Wrap the whole classifier body and swallow.
            try {
                const name = err instanceof Error ? err.name : '';
                const isProgrammingBug = name === 'TypeError' || name === 'ReferenceError';
                if (isProgrammingBug) {
                    // Real bug — bubble the full stack every time. These should
                    // be rare; if they aren't, the spam itself is a signal.
                    // Pass error fields as enumerable meta so both LoggerInstance
                    // and SDK Logger backends serialise the stack (bare Errors
                    // have non-enumerable properties → JSON.stringify yields {}).
                    const heartbeatErr = err instanceof Error ? err : new Error(String(err));
                    opts.logger.error('Heartbeat progress report threw a programming error', {
                        error: heartbeatErr.message,
                        stack: heartbeatErr.stack,
                    });
                    return;
                }
                const now = Date.now();
                if (now - lastWarnAt < HEARTBEAT_WARN_THROTTLE_MS) return;
                lastWarnAt = now;
                opts.logger.warn('Heartbeat progress report failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            } catch {
                // Swallowed intentionally — a failing logger must not take
                // down the worker. We've already lost one warn/error; the
                // next heartbeat tick will retry.
            }
        }
    }, opts.intervalMs ?? 120_000);

    return {
        clear: () => clearInterval(interval),
    };
}

/**
 * Cheap signature for slice comparison: length + every item's ID joined.
 * This is order-sensitive (different from a set hash) so plugins MUST return
 * items in a deterministic order from `fetchSlice` — otherwise the no-progress
 * detector either over-fires (random shuffle -> signatures never match -> can
 * loop forever on genuinely stuck data) or under-fires (bogus match when two
 * unrelated slices coincidentally have the same size + endpoints).
 *
 * A prior version used a `length:firstId:lastId` shortcut for slices with 3+
 * items to avoid touching every row. That collides whenever two *different*
 * slices share length + first id + last id but differ in the middle — e.g.
 * an unstable sort or a LIMIT-window displacement that rotates interior rows
 * while a stable pagination key pins the endpoints. The collision falsely
 * triggers the adjacent-slice no-progress stop and truncates a real drain.
 * Joining every ID is O(sliceSize) string work, which is cheap at the slice
 * sizes plugins actually use in production (a couple hundred items at most)
 * and removes the collision class entirely — no separate small-slice case
 * needed either.
 *
 * The signature is derived from a stable ID extracted per item via `idOf`.
 * Passing `idOf` explicitly is strongly recommended — every plugin's row
 * type has an obvious identifier field. When omitted, the fallback uses
 * `JSON.stringify(item)` which makes the signature sensitive to any mutable
 * field on the row (e.g. `updated_at`): two semantically-identical slices
 * with different timestamps compare as different, silently disabling the
 * no-progress detector.
 */
function sliceSignature<T>(items: T[], idOf: (item: T) => string): string {
    if (items.length === 0) return '0:';
    let joined = '';
    for (let i = 0; i < items.length; i++) {
        if (i > 0) joined += '|';
        joined += idOf(items[i]);
    }
    return `${items.length}:${joined}`;
}

/** Fallback ID extractor used when the caller omits `idOf`. */
function defaultIdOf<T>(item: T): string {
    if (
        item !== null &&
        typeof item === 'object' &&
        'id' in item &&
        typeof (item as { id: unknown }).id === 'string'
    ) {
        return (item as { id: string }).id;
    }
    return JSON.stringify(item);
}

/**
 * Run the drain loop for a plugin's backlog.
 *
 * Mode semantics:
 *   - `manual`: drain until empty, abort, or budget exceeded.
 *   - `force`:  run `onWipe()` first, then drain as `manual`. If `onWipe` is
 *               absent (misconfiguration), logs a warning and drains as
 *               manual — silent degradation would be confusing for an admin
 *               who just clicked "Re-analyze everything".
 *   - `catchup`: process a single slice and return. Matches the scheduler
 *     budget — each periodic run nibbles at the backlog.
 *
 * The helper never throws from the loop body — a failing `processSlice`
 * rethrows so the caller can surface the error via its SyncTaskResult.
 * An `onWipe` that throws is caught and returned as
 * `{ stopReason: 'aborted', wipeError }` so a wipe failure can't crash the
 * worker process before the heartbeat/finally cleanup runs.
 */
export async function drainBacklog<T>(
    ctx: DrainBacklogContext,
    options: DrainBacklogOptions<T>,
): Promise<DrainBacklogResult> {
    const {
        mode,
        sliceSize,
        softBudgetMs = DEFAULT_SOFT_BUDGET_MS,
        onWipe,
        fetchSlice,
        processSlice,
        onProgress,
        phase = 'Draining backlog',
        idOf,
        heartbeat,
    } = options;

    const idOfResolved: (item: T) => string = idOf ?? defaultIdOf;
    if (!idOf) {
        // Elevated from debug → warn (one-shot at drain entry, not per slice).
        // The fallback still works but a missing idOf hits `JSON.stringify`
        // on every slice's first/last row, which is slow and also blows up
        // on BigInt columns from postgres.js (`TypeError: Do not know how
        // to serialize BigInt`). Plugin authors should always pass idOf.
        ctx.logger.warn(
            'drainBacklog called without idOf — falling back to JSON.stringify. This is slow, misfires on mutable fields, and crashes on BigInt columns. Plugins should pass a stable identifier extractor.',
        );
    }

    // Own the heartbeat lifecycle when the caller opts in. Plugins that
    // need a heartbeat spanning multiple drainBacklog calls (media-probe's
    // two-phase drain) must manage startHeartbeat/clear themselves.
    const heartbeatHandle = heartbeat
        ? startHeartbeat({
              onProgress,
              logger: ctx.logger,
              phase,
              getTotal: heartbeat.getTotal,
              getProcessed: heartbeat.getProcessed,
              getStatus: heartbeat.getStatus,
              intervalMs: heartbeat.intervalMs,
          })
        : null;

    try {
        return await runDrainLoop(ctx, {
            mode,
            sliceSize,
            softBudgetMs,
            onWipe,
            fetchSlice,
            processSlice,
            onProgress,
            phase,
            idOf: idOfResolved,
        });
    } finally {
        heartbeatHandle?.clear();
    }
}

async function runDrainLoop<T>(
    ctx: DrainBacklogContext,
    options: {
        mode: DrainBacklogMode;
        sliceSize: number;
        softBudgetMs: number;
        onWipe?: () => Promise<void>;
        fetchSlice: (sliceSize: number) => Promise<DrainSlice<T>>;
        processSlice: (items: T[], signal: AbortSignal) => Promise<ProcessSliceResult>;
        onProgress?: SyncExecutionContext['onProgress'];
        phase: string;
        idOf: (item: T) => string;
    },
): Promise<DrainBacklogResult> {
    const {
        mode,
        sliceSize,
        softBudgetMs,
        onWipe,
        fetchSlice,
        processSlice,
        onProgress,
        phase,
        idOf,
    } = options;

    // Entry guard — a zero/negative/non-integer sliceSize silently turned
    // fetchSlice into a no-op-shaped call (e.g. a SQL fetcher honoring it as
    // `LIMIT 0`) and made the drain return `stopReason: 'drained'` having
    // done nothing — a caller bug masquerading as the happy "already empty"
    // path. Mirrors `drainWipe`'s identical guard on `batchSize` below: fail
    // loudly at the entry point, before `onWipe` runs, instead of landing as
    // a silent no-op.
    if (!Number.isInteger(sliceSize) || sliceSize <= 0) {
        throw new Error(`drainBacklog: sliceSize must be a positive integer (got ${sliceSize})`);
    }

    // Record the wall-clock start BEFORE onWipe so the soft budget covers
    // the entire drain including the wipe phase. A slow wipe (e.g. 90 min
    // for TMDB metadata) plus a fresh 110-min post-wipe budget would
    // otherwise blow past BullMQ's 2h maxDuration and get the job
    // stall-killed. Counting wipe time against the budget is the correct
    // behavior — otherwise the documented budget is a lie.
    const startedAt = Date.now();

    if (mode === 'force') {
        if (ctx.abortSignal.aborted) {
            return {
                unitsProcessed: 0,
                resultsProduced: 0,
                stopReason: 'aborted',
            };
        }
        if (onWipe) {
            try {
                await onWipe();
            } catch (err) {
                // Doc says drainBacklog "never throws from the loop body",
                // but onWipe is outside the loop and plugin wipes can fail
                // (DB deadlock, partial delete). Catch + surface via
                // wipeError so callers can decide how to present it in
                // their SyncTaskResult rather than crashing the worker
                // before the heartbeat/finally cleanup has run.
                const wipeError = err instanceof Error ? err : new Error(String(err));
                // Enumerate error fields as meta — same reasoning as the
                // heartbeat call site above. Bare Error in the meta slot
                // serialises to {} under the SDK Logger backend.
                ctx.logger.error('drainBacklog: onWipe threw — aborting drain with wipeError', {
                    error: wipeError.message,
                    stack: wipeError.stack,
                });
                return {
                    unitsProcessed: 0,
                    resultsProduced: 0,
                    stopReason: 'aborted',
                    wipeError,
                };
            }
        } else {
            ctx.logger.warn(
                "drainBacklog called with mode='force' but no onWipe provided — drain will proceed as if 'manual'. If the plugin declares manifest.backlog.destructive, this is a wiring bug.",
            );
        }
        if (ctx.abortSignal.aborted) {
            return {
                unitsProcessed: 0,
                resultsProduced: 0,
                stopReason: 'aborted',
            };
        }
    }

    let unitsProcessed = 0;
    let resultsProduced = 0;
    // Count slices processed for back-compat 'single-slice' detection.
    // Independent of unitsProcessed accumulation so future changes to how
    // we count units (e.g. counting `advanced` not `items.length`) don't
    // silently break the success classifiers in fribb / mal-anime-id-enrichment.
    let slicesProcessed = 0;
    // Track cumulative advance so a loop returning new items every slice but
    // advancing nothing can still break early. Without this, the
    // signature-equality guard misses the case where fetcher rotates items.
    let cumulativeAdvanced = 0;
    // Highest `total` reported so progress callbacks never go backwards
    // when `remainingHint` shrinks faster than `unitsProcessed` grows
    // (admin UI progress bars assume monotonic non-decreasing totals).
    let lastReportedTotal = 0;
    // Signature of the previous slice's items — if `fetchSlice` returns the
    // same items twice in a row AND the previous slice had no state advance,
    // the plugin's fetcher isn't moving past processed items (e.g. forgot to
    // mark them analyzed). Break instead of spinning until the budget expires.
    //
    // If the previous slice had advance > 0 but the same signature, it means
    // the rows are still eligible after a partial write — legitimate retry
    // state, not a stuck fetcher. Keep looping.
    let lastSliceSignature: string | null = null;
    let lastSliceAdvanced = 0;

    // Catchup ticks run on a tight per-tick budget so they don't monopolize
    // the worker, but still loop multiple slices when the backlog is large.
    // Manual/force runs honor the caller's budget (default 110min).
    //
    // Catchup-mode contract: softBudgetMs is CAPPED at CATCHUP_SOFT_BUDGET_MS
    // here. A caller-passed value of 0 (which means "disabled" in
    // manual/force) is treated as "use the catchup default" — catchup must
    // stay bounded so it never blocks the next tick or peer tasks sharing
    // the resource class. Non-finite values fall back to the cap.
    const isCatchupMode = mode === 'catchup';
    const sanitizedBudget = Number.isFinite(softBudgetMs) && softBudgetMs > 0 ? softBudgetMs : 0;
    const effectiveSoftBudgetMs = isCatchupMode
        ? Math.min(
              sanitizedBudget > 0 ? sanitizedBudget : CATCHUP_SOFT_BUDGET_MS,
              CATCHUP_SOFT_BUDGET_MS,
          )
        : sanitizedBudget;

    const budgetExceeded = (): boolean =>
        effectiveSoftBudgetMs > 0 && Date.now() - startedAt >= effectiveSoftBudgetMs;

    // Compose the per-slice signal ONCE per drain rather than per iteration.
    //
    // The previous implementation called `AbortSignal.any([ctx.abortSignal,
    // AbortSignal.timeout(remaining)])` inside the while-loop, creating a
    // fresh composed signal (and a fresh setTimeout) per slice. Each
    // composed signal retains its timer until it fires OR GC collects it,
    // AND attaches a "forward abort" listener to ctx.abortSignal that
    // stays attached until the composed signal is GC'd. On a long drain
    // (10k slices) this leaked 10k active timers + 10k listeners hanging
    // off the caller's AbortSignal — a real resource problem.
    //
    // Instead: one internal AbortController, one setTimeout for the soft
    // budget, one ctx.abortSignal listener. The finally block clears the
    // timer and removes the listener.
    const composed: ComposedSignal = createComposedSignal(
        ctx.abortSignal,
        effectiveSoftBudgetMs > 0 ? effectiveSoftBudgetMs : null,
    );

    try {
        while (true) {
            if (ctx.abortSignal.aborted) {
                return {
                    unitsProcessed,
                    resultsProduced,
                    stopReason: 'aborted',
                };
            }

            const slice = await fetchSlice(sliceSize);
            if (slice.items.length === 0) {
                return {
                    unitsProcessed,
                    resultsProduced,
                    stopReason: 'drained',
                };
            }

            const signature = sliceSignature(slice.items, idOf);
            if (
                lastSliceSignature !== null &&
                signature === lastSliceSignature &&
                // NaN !== 0 would silently disable the no-progress detector.
                // Negative advanced values (plugin arithmetic bug) likewise
                // should not prevent the guard from firing. Treat anything
                // that is non-finite or non-positive as "no advance".
                (lastSliceAdvanced <= 0 || !Number.isFinite(lastSliceAdvanced))
            ) {
                return {
                    unitsProcessed,
                    resultsProduced,
                    stopReason: 'no-progress',
                };
            }
            lastSliceSignature = signature;

            const outcome = await processSlice(slice.items, composed.signal);
            resultsProduced += outcome.produced;
            unitsProcessed += slice.items.length;
            lastSliceAdvanced = outcome.advanced;
            slicesProcessed += 1;
            if (Number.isFinite(outcome.advanced) && outcome.advanced > 0) {
                cumulativeAdvanced += outcome.advanced;
            }

            // Multi-slice no-progress safety net: a loop that processes many
            // distinct slices but never advances any of them is wasting the
            // budget. The per-slice signature guard above only catches
            // identical/repeated inputs; this catches the rotating-items
            // pattern (unstable sort, LIMIT-window displacement) where every
            // fetch looks "new" by signature but nothing ever advances.
            //
            // Applies in EVERY mode, not just catchup. It used to be
            // catchup-only, but manual/force runs with softBudgetMs: 0 (the
            // documented escape hatch — see DrainBacklogOptions.softBudgetMs)
            // had no engine-level bound on this pattern at all and could spin
            // until the process was killed.
            //
            // The slice threshold differs by mode:
            //   - catchup (3 slices): its per-tick budget is already tight
            //     (CATCHUP_SOFT_BUDGET_MS = 5 min) — a stuck fetcher should
            //     surface fast so the next tick isn't wasted the same way.
            //   - manual/force (5 slices): these are long, operator-triggered
            //     drains that can legitimately have a slow start — e.g. the
            //     first few slices spend their `advanced` budget on
            //     rate-limit backoff or rows that are eligible but fail
            //     validation before any row-level state change lands. A
            //     3-slice threshold there risks aborting a drain that would
            //     have started advancing on slice 4 or 5; 5 gives it more
            //     room while still being a hard, finite bound (unlike the
            //     old catchup-only check, which was infinite in these modes).
            //
            // Either threshold only matters while cumulativeAdvanced stays
            // at 0 — the moment ANY slice advances so much as one row, this
            // branch can never fire again for the rest of the run, so a run
            // that makes real progress is unaffected regardless of mode.
            const noProgressSliceThreshold = isCatchupMode ? 3 : 5;
            if (slicesProcessed >= noProgressSliceThreshold && cumulativeAdvanced === 0) {
                return {
                    unitsProcessed,
                    resultsProduced,
                    stopReason: 'no-progress',
                };
            }

            if (onProgress) {
                const rawTotal =
                    slice.remainingHint !== undefined
                        ? unitsProcessed + slice.remainingHint
                        : unitsProcessed;
                // Clamp to monotonic non-decreasing so admin progress bars
                // never appear to move backwards across slices.
                const total = Math.max(lastReportedTotal, rawTotal);
                lastReportedTotal = total;
                onProgress(unitsProcessed, total, { phase });
            }

            if (budgetExceeded()) {
                // Catchup mode reaches this when its 5-min per-tick budget
                // elapses with backlog still remaining. Use 'single-slice'
                // (back-compat with success classifiers in fribb / mal
                // anime-id-enrichment) when exactly one slice ran, else
                // 'budget' so the admin UI shows the time-budget reason.
                const isCatchupSingle = isCatchupMode && slicesProcessed === 1;
                return {
                    unitsProcessed,
                    resultsProduced,
                    stopReason: isCatchupSingle ? 'single-slice' : 'budget',
                };
            }
        }
    } finally {
        composed.dispose();
    }
}

/**
 * A disposable abort signal composed from a caller-provided signal plus an
 * optional soft-budget timer. Created once per drain; `signal` is reused
 * across every slice. Call `dispose()` in a finally block to release the
 * timer and the forward-abort listener.
 */
interface ComposedSignal {
    /**
     * The signal handed to `processSlice`. When `softBudgetMs` was null,
     * this is the caller's signal returned as-is — no composition, no
     * listener attached, and `dispose()` is a no-op. Otherwise it's the
     * signal of an internal AbortController that aborts when *either* the
     * caller's signal aborts OR the soft budget elapses.
     */
    signal: AbortSignal;
    /**
     * Release every resource this composition allocated: clearTimeout the
     * budget timer, and remove the "forward abort" listener from the
     * caller's signal. Safe to call multiple times.
     */
    dispose: () => void;
}

/**
 * Build a single composed abort signal shared across every slice of a
 * drain. Exported as a named helper (rather than inlined) so the
 * listener/timer lifecycle is easy to reason about in one place.
 *
 * Behaviour:
 *   - `softBudgetMs === null` → returns the caller's signal unchanged
 *     (contract-preserving: `softBudgetMs === 0` in drainBacklog disables
 *     the budget and `processSlice` observes `ctx.abortSignal` directly).
 *   - `softBudgetMs > 0`      → creates an internal AbortController that
 *     aborts on *either* the caller's abort OR the soft-budget timer,
 *     whichever fires first. `dispose()` releases both.
 */
function createComposedSignal(
    callerSignal: AbortSignal,
    softBudgetMs: number | null,
): ComposedSignal {
    if (softBudgetMs === null) {
        return {
            signal: callerSignal,
            dispose: () => {
                /* no-op */
            },
        };
    }

    const controller = new AbortController();

    // Forward a pre-existing abort immediately so processSlice never sees
    // a stale non-aborted signal.
    if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
        return {
            signal: controller.signal,
            dispose: () => {
                /* no-op — nothing to release */
            },
        };
    }

    const onCallerAbort = (): void => {
        controller.abort(callerSignal.reason);
    };
    // `{ once: true }` lets the runtime drop the listener after firing
    // without us having to manually removeEventListener in that path. The
    // dispose path below still removes it in the happy path (drain
    // completed before abort) so ctx.abortSignal doesn't accumulate dead
    // listeners across repeated drains on the same caller signal.
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });

    const budgetTimer = setTimeout(() => {
        controller.abort(new DOMException('drainBacklog: soft budget elapsed', 'TimeoutError'));
    }, softBudgetMs);
    // Detach the timer from the event loop so it doesn't keep the process
    // alive past the drain.
    if (typeof budgetTimer === 'object' && budgetTimer !== null && 'unref' in budgetTimer) {
        (budgetTimer as { unref: () => void }).unref();
    }

    let disposed = false;
    return {
        signal: controller.signal,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(budgetTimer);
            callerSignal.removeEventListener('abort', onCallerAbort);
        },
    };
}

/**
 * Options for `drainWipe` — the batched companion to `drainBacklog` used by
 * `wipeProcessedData` implementations. Every destructive sync plugin has to
 * delete "all its stuff" in bounded batches so a single transaction doesn't
 * blow out autovacuum or hold locks for minutes. This helper factors out
 * the while-loop that five plugins hand-rolled with subtly different
 * termination conditions.
 */
export interface DrainWipeOptions {
    /** Abort signal — checked before each fetchBatch call */
    abortSignal: AbortSignal;
    /** Batch size hint passed to fetchBatch */
    batchSize: number;
    /**
     * Return the IDs to wipe in the next batch. Return `[]` to signal
     * "nothing left" — drainWipe exits cleanly and returns the cumulative
     * count. IDs should be fetched with LIMIT `batchSize` and in a stable
     * order so the loop makes progress on each iteration.
     */
    fetchBatch: (limit: number) => Promise<string[]>;
    /**
     * Atomically wipe the given IDs and return the row count affected.
     *
     * CRITICAL: `wipeBatch` MUST be a single statement or a wrapping
     * transaction. If the wipe involves deleting AND clearing sentinel
     * markers (e.g. processing_state rows), both must succeed or both must
     * roll back — otherwise an abort mid-batch leaves orphan markers that
     * make the rows permanently invisible to the next drain pass.
     */
    wipeBatch: (ids: string[]) => Promise<number>;
    logger: DrainBacklogLogger;
    /** Human label for progress logs (e.g. "TMDB metadata", "intro markers") */
    label: string;
}

/**
 * Iterate `fetchBatch` + `wipeBatch` until the fetcher returns an empty
 * batch, abort fires, or we detect genuine disagreement between the fetcher
 * and the wiper (defensive short-circuit).
 *
 * Returns the total number of rows wiped across all batches.
 *
 * ### Zero-wipe handling
 *
 * When `wipeBatch` returns `0` despite `fetchBatch` producing IDs, there are
 * two plausible causes:
 *
 *   1. A concurrent wipe (e.g. two admins clicked "Wipe" within a second of
 *      each other) beat us to those rows. Re-fetching picks up whatever is
 *      still eligible and lets us keep draining. Without this retry, the
 *      slower wipe sees `wiped === 0` on its very first batch and exits,
 *      leaving the backlog only partially wiped.
 *   2. The fetcher and wiper keys are out of sync — wiping the same set
 *      again would also return 0. A single retry that also comes back
 *      empty is enough to distinguish case (1) from case (2): in case (1)
 *      the fetcher returns a different/empty batch, in case (2) it loops.
 *      Bail after the retry with a warning rather than spinning.
 */
export async function drainWipe(opts: DrainWipeOptions): Promise<number> {
    const { abortSignal, batchSize, fetchBatch, wipeBatch, logger, label } = opts;

    // Entry guard — a zero/negative batchSize silently turned fetchBatch
    // into a no-op (postgres LIMIT 0) and made the drain return 0 while
    // leaving the real backlog intact. Force a loud failure at the entry
    // point so the bug doesn't land as a silent success.
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error(`drainWipe: batchSize must be a positive integer (got ${batchSize})`);
    }

    let total = 0;

    while (!abortSignal.aborted) {
        const ids = await fetchBatch(batchSize);
        if (ids.length === 0) {
            logger.info(`${label} wipe complete (${total} row(s))`);
            return total;
        }
        const wiped = await wipeBatch(ids);
        total += wiped;
        if (wiped === 0) {
            // Retry ONCE before bailing. If a concurrent wipe grabbed
            // those rows, the next fetch will see a different (or empty)
            // batch and the loop resumes. If the second fetch is also
            // non-empty AND the second wipe also reports 0, we've got a
            // genuine key mismatch and should stop to avoid spinning.
            logger.warn(
                `${label} wipe: fetchBatch returned ${ids.length} ids but wipeBatch affected 0 rows — retrying once in case a concurrent wipe beat us`,
                { total },
            );
            if (abortSignal.aborted) break;
            const retryIds = await fetchBatch(batchSize);
            if (retryIds.length === 0) {
                logger.info(`${label} wipe complete after concurrent-race retry (${total} row(s))`);
                return total;
            }
            const retryWiped = await wipeBatch(retryIds);
            total += retryWiped;
            if (retryWiped === 0) {
                logger.warn(
                    `${label} wipe: retry also wiped 0 rows — fetcher/wiper keys out of sync, stopping to avoid infinite loop`,
                    { total, retryIdsLength: retryIds.length },
                );
                return total;
            }
            // Retry made progress — fall through and keep draining.
        }
    }

    logger.warn(`${label} wipe aborted after ${total} row(s)`);
    return total;
}
