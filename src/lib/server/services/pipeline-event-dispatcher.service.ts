// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pipeline event dispatcher — drains the `event_outbox` table written by
 * DB triggers (file/identity/metadata events) and the lifecycle service
 * (item.* events). Routes each event to:
 *
 *   1. `StageStateService.invalidateByEvent(mediaId, eventName)` — flips
 *      eligible stage_state rows back to `pending` and eager-enqueues.
 *   2. Registered side-effect handlers — trickplay deletion, cache
 *      invalidation, embedding regeneration kickoff, etc.
 *
 * Failure semantics: per-row consumption with exponential backoff.
 * A handler error doesn't block other rows (FOR UPDATE SKIP LOCKED) and
 * exhausting `MAX_ATTEMPTS` moves the row to `dead_letter` for admin
 * triage.
 *
 * Phase A wires the dispatcher but the feature_flags row stays 'off',
 * so the drain query returns zero rows. Phase B flips the flag and
 * traffic flows.
 */
import type postgres from 'postgres';
import {
    lockDrainableEvents,
    markEventConsumed,
    recordEventFailure,
    findAutoRequeuableDeadLetters,
    requeueDeadLetterEventsAuto,
    type EventOutboxRow,
} from '$lib/server/database/queries/event-outbox.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isTransientPgError } from '$lib/server/utils/transient-pg.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { StageStateService } from './stage-state.service.js';
import { resolveSeriesIdForItem } from '$lib/server/database/queries/manual-file-links.queries.js';
import { registry } from '$lib/server/tasks/registry.js';
import type { PipelineEventName, PipelineEventPayload } from '$lib/types/pipeline.js';
import { beatAlive, writeHeartbeat } from '$lib/server/tasks/observability/heartbeat.js';
import { appendAuditEvent } from '$lib/server/tasks/observability/audit-log.js';

const log = Logger.for('PipelineEventDispatcher');

// No-opts fallback only. The EFFECTIVE production/OSS defaults are the
// env-tunable config values OUTBOX_DRAIN_* (config.ts: 10s interval / 500 batch),
// which the orchestrator always passes — raised from these originals so a fresh
// install's initial-import event storm doesn't leave the dispatcher hours behind.
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_DRAIN_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 8;

/**
 * Transient-error auto-requeue. When an event dead-letters on a *transient*
 * infra blip — the canonical case being `write CONNECT_TIMEOUT ai-postgres:5432`
 * during pool saturation or a brief DB restart — the dispatcher requeues it
 * automatically instead of waiting for an operator. `isTransientPgError`
 * (single source of truth, shared with the runner/reconciler) decides whether a
 * row's `last_error` qualifies.
 *
 * `MAX_AUTO_REQUEUE` bounds the loop: a permanent failure that merely *looks*
 * transient (e.g. a misconfigured DB host that always connect-times-out) is
 * requeued at most this many times before being left dead-lettered for manual
 * triage — visible on the Operations spine with a working "Requeue" button.
 * `AUTO_REQUEUE_INTERVAL_MS` throttles the pass so a hot drain loop (250 ms
 * debounce during an import storm) doesn't run the requeue UPDATE every tick.
 */
const DEFAULT_MAX_AUTO_REQUEUE = 5;
const DEFAULT_AUTO_REQUEUE_INTERVAL_MS = 5 * 60_000;

/**
 * Postgres NOTIFY channel the DB triggers fire on every outbox insert
 * (see migration 16.20.0 `pg_notify('event_outbox_new', ...)`). The
 * dispatcher LISTENs on it so a queued event is drained within
 * `DEFAULT_NOTIFY_DEBOUNCE_MS` instead of waiting up to the 30 s poll.
 */
const LISTEN_CHANNEL = 'event_outbox_new';

/**
 * Wall-clock budget for a single `tick()` drain pass. The loop keeps
 * consuming rows until the outbox is empty OR this elapses, then yields
 * (re-arming itself if rows likely remain). This replaces the old fixed
 * `batchSize` cap, which capped throughput at ~`batchSize`/interval and
 * could never catch up to an import storm. Per-row transactions are kept,
 * so poison isolation is unchanged.
 */
const DEFAULT_DRAIN_BUDGET_MS = 5_000;

/**
 * Trailing-coalesce window for NOTIFY-triggered ticks. A burst of inserts
 * (e.g. a library import emitting thousands of events) collapses into one
 * tick fired this long after the first NOTIFY in the window.
 */
const DEFAULT_NOTIFY_DEBOUNCE_MS = 250;

/**
 * Paranoia backstop on iterations within one tick — the wall-clock budget
 * is the real bound; this only guards against a pathological clock/handler
 * combination that never advances time.
 */
const MAX_ITERATIONS_PER_TICK = 100_000;

/**
 * Side-effect handler. Receives the payload; returns a promise that
 * resolves on success or rejects on failure. The dispatcher catches
 * rejections and records them per-row.
 *
 * IMPORTANT: handlers run INSIDE the per-row `FOR UPDATE` transaction (unlike
 * the stage-state enqueue/pub-sub effects, which are deferred to post-commit).
 * With parallel drain (`drainConcurrency`) up to N handlers hold a task-pool
 * connection at once, so a handler MUST stay fast and DB-only — no slow network
 * I/O (HTTP, external APIs) that would pin a pool connection across the wire.
 * The one built-in handler (`media.becamePlayable` → staging-row insert) obeys
 * this; downstream HTTP delivery is a separate WebhookOutbox drain by design.
 */
export type PipelineEventHandler = (
    sql: postgres.Sql,
    payload: PipelineEventPayload,
) => Promise<void>;

/**
 * Per-event handler registry. Multiple handlers can subscribe to the
 * same event. Handlers run sequentially within a row so one slow
 * handler doesn't fan out unbounded work; if you need parallelism, do
 * it inside your handler.
 */
const handlers: Map<PipelineEventName, PipelineEventHandler[]> = new Map();

/**
 * Register a side-effect handler for an event. Idempotent on duplicate
 * registration (no-ops). The intended caller is module-load-time
 * registration in `pipeline-event-handlers.ts` — not runtime.
 */
export function registerPipelineEventHandler(
    event: PipelineEventName,
    handler: PipelineEventHandler,
): void {
    const existing = handlers.get(event) ?? [];
    if (existing.includes(handler)) return;
    handlers.set(event, [...existing, handler]);
}

/**
 * Clear all handlers — used by tests so each test starts from a clean
 * registry. Not exposed in production code.
 */
export function _clearPipelineEventHandlersForTesting(): void {
    handlers.clear();
}

export interface DispatcherOpts {
    sql: postgres.Sql;
    batchSize?: number;
    drainIntervalMs?: number;
    /** Per-tick wall-clock drain budget (ms). Default 5 s. */
    drainBudgetMs?: number;
    /**
     * Number of rows drained in PARALLEL per tick, sharded by
     * hashtext(media_item_id) so per-item ordering is preserved. Default 1
     * (serial). Each worker holds one DB connection during its per-row tx —
     * keep below the pool size.
     */
    drainConcurrency?: number;
    /** Trailing-coalesce window for NOTIFY-triggered ticks (ms). Default 250. */
    notifyDebounceMs?: number;
    /** Max times a transient dead-letter is auto-requeued before manual triage. Default 5. */
    maxAutoRequeue?: number;
    /** Throttle between transient-error auto-requeue passes (ms). Default 5 min. */
    autoRequeueIntervalMs?: number;
    /**
     * Predicate consulted before each tick. Returning false skips the
     * tick — the orchestrator passes `isCoordinator()` here (the dedicated
     * `lock:orch:coordinator` leader lock) so only one replica cluster-wide
     * drains the outbox even if multiple boot. Per-class leadership is NOT
     * a valid gate: class locks are elected independently, so with 2+ worker
     * replicas both would hold "some" class and dual-drain — SKIP LOCKED
     * would then let per-item event ordering invert across replicas.
     */
    isLeader: () => boolean;
    /** Optional StageStateService injection point (test seam). */
    stageState?: StageStateService;
}

export class PipelineEventDispatcher {
    private timer: ReturnType<typeof setInterval> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private listenSub: { unlisten: () => Promise<void> } | null = null;
    private running = false;
    // Set by stop(); distinct from `timer === null` because tick() is also
    // invoked directly (tests / on-demand) without ever calling start().
    private stopped = false;
    private readonly stageState: StageStateService;
    private readonly batchSize: number;
    private readonly drainIntervalMs: number;
    private readonly drainBudgetMs: number;
    private readonly drainConcurrency: number;
    private readonly notifyDebounceMs: number;
    private readonly maxAutoRequeue: number;
    private readonly autoRequeueIntervalMs: number;
    /** Epoch ms of the last auto-requeue pass; throttles it off the hot drain loop. */
    private lastAutoRequeueAt = 0;
    private readonly isLeader: () => boolean;

    constructor(private readonly opts: DispatcherOpts) {
        this.stageState = opts.stageState ?? new StageStateService(opts.sql, registry);
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
        this.drainIntervalMs = opts.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
        // Sanitize tunables: a non-finite/negative value (e.g. from a bad env
        // parse) would otherwise make `Date.now() >= deadline` never trip and
        // let one tick run to the MAX_ITERATIONS cap without yielding.
        this.drainBudgetMs =
            Number.isFinite(opts.drainBudgetMs) && (opts.drainBudgetMs as number) >= 0
                ? (opts.drainBudgetMs as number)
                : DEFAULT_DRAIN_BUDGET_MS;
        // Clamp to >= 1: a bad env parse (0/NaN/negative) must not silently
        // spawn zero workers (a tick that drains nothing) — fall back to serial.
        this.drainConcurrency =
            Number.isFinite(opts.drainConcurrency) && (opts.drainConcurrency as number) >= 1
                ? Math.trunc(opts.drainConcurrency as number)
                : 1;
        this.notifyDebounceMs =
            Number.isFinite(opts.notifyDebounceMs) && (opts.notifyDebounceMs as number) >= 0
                ? (opts.notifyDebounceMs as number)
                : DEFAULT_NOTIFY_DEBOUNCE_MS;
        this.maxAutoRequeue =
            Number.isFinite(opts.maxAutoRequeue) && (opts.maxAutoRequeue as number) >= 0
                ? Math.trunc(opts.maxAutoRequeue as number)
                : DEFAULT_MAX_AUTO_REQUEUE;
        this.autoRequeueIntervalMs =
            Number.isFinite(opts.autoRequeueIntervalMs) &&
            (opts.autoRequeueIntervalMs as number) >= 0
                ? (opts.autoRequeueIntervalMs as number)
                : DEFAULT_AUTO_REQUEUE_INTERVAL_MS;
        this.isLeader = opts.isLeader;
    }

    start(): void {
        if (this.timer) return;
        this.stopped = false; // reset for a restart after stop()
        this.timer = setInterval(() => {
            void this.tick();
        }, this.drainIntervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        // LISTEN for outbox inserts so events drain within ~debounce ms
        // instead of waiting up to the 30 s interval. The interval remains a
        // missed-NOTIFY fallback (a dropped LISTEN connection, etc.).
        this.startListening();
        // Fire one tick immediately so events queued during boot land
        // before the first interval elapses.
        void this.tick().catch((err: unknown) => {
            log.warn('Dispatcher initial tick threw', {
                err: err instanceof Error ? err.message : String(err),
            });
        });
        log.info('PipelineEventDispatcher started', {
            batchSize: this.batchSize,
            drainIntervalMs: this.drainIntervalMs,
            drainBudgetMs: this.drainBudgetMs,
            drainConcurrency: this.drainConcurrency,
        });
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.listenSub) {
            const sub = this.listenSub;
            this.listenSub = null;
            void sub.unlisten().catch(() => {
                /* connection may already be torn down — best effort */
            });
        }
    }

    /**
     * Subscribe to the outbox NOTIFY channel. postgres.js reserves a
     * dedicated connection for the subscription. Failure is non-fatal —
     * the interval poll still drains, just at 30 s latency. We do not gate
     * the LISTEN itself on leadership (cheap idle connection); the
     * scheduled tick is leader-gated below and `tick()` re-checks anyway.
     */
    private startListening(): void {
        try {
            void this.opts.sql
                .listen(LISTEN_CHANNEL, () => this.scheduleDebouncedTick())
                .then((sub) => {
                    // If stop() ran while the LISTEN was still resolving, the
                    // subscription would never be unlistened (stop() already
                    // passed its null check) — unlisten it now so the
                    // connection isn't leaked.
                    if (this.stopped) {
                        void sub.unlisten().catch(() => {});
                        return;
                    }
                    this.listenSub = sub;
                    log.info('PipelineEventDispatcher LISTENing', {
                        channel: LISTEN_CHANNEL,
                    });
                })
                .catch((err: unknown) => {
                    log.warn('Dispatcher LISTEN failed; relying on interval poll', {
                        channel: LISTEN_CHANNEL,
                        err: err instanceof Error ? err.message : String(err),
                    });
                });
        } catch (err) {
            // sql.listen() throwing synchronously must not abort start().
            log.warn('Dispatcher LISTEN setup threw; relying on interval poll', {
                channel: LISTEN_CHANNEL,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Coalesce a burst of NOTIFYs into a single near-future tick. The
     * `debounceTimer` guard means concurrent NOTIFYs within the window
     * (or while a drain is in flight) collapse to one scheduled tick.
     * Leader-gated as a fast path so non-leaders don't spin timers; the
     * interval fallback still covers a leadership flip.
     */
    private scheduleDebouncedTick(): void {
        if (this.debounceTimer) return;
        if (!this.isLeader()) return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.tick().catch((err: unknown) => {
                log.warn('Dispatcher NOTIFY-triggered tick threw', {
                    err: err instanceof Error ? err.message : String(err),
                });
            });
        }, this.notifyDebounceMs);
        if (typeof this.debounceTimer.unref === 'function') this.debounceTimer.unref();
    }

    /**
     * One drain pass. Reentrant — concurrent ticks skip via `running`.
     * Exposed for tests + on-demand invocation by the orchestrator.
     *
     * Each row is processed in its OWN short transaction so a slow handler
     * cannot hold the FOR UPDATE row lock across other work in the batch.
     * Without that scope, a 30 s BullMQ enqueue would keep up to
     * `batchSize` rows invisible to all replicas for the full duration —
     * and a process restart mid-batch would lose every row's progress.
     * Per-row tx limits the blast radius to one event.
     */
    async tick(): Promise<{ drained: number; deadLettered: number }> {
        if (!this.isLeader()) return { drained: 0, deadLettered: 0 };
        if (this.running) return { drained: 0, deadLettered: 0 };
        this.running = true;
        // Leader confirmed (isLeader guard above) — liveness beat before the drain loop.
        await beatAlive('event-dispatcher');
        // Recover transient dead-letters before draining: a row resurrected here
        // flips to `pending` and is picked up by this same tick's drain loop, so
        // an event parked by a `CONNECT_TIMEOUT` blip self-heals as soon as the DB
        // is reachable again. Throttled + best-effort; never blocks the drain.
        await this.maybeAutoRequeueTransientDeadLetters();
        // True only when the loop stops because the wall-clock budget elapsed
        // (rows likely remain) — drives the self-rearm in `finally`. Stays
        // false on empty-drain and on error, so neither re-arms (an errored
        // tick is retried by the 30 s interval, not a 250 ms hot loop).
        let budgetBounded = false;
        try {
            let drained = 0;
            let deadLettered = 0;
            // Drain until the outbox is empty OR the wall-clock budget elapses.
            // Each iteration opens its own transaction via `processOneRow`, so
            // poison isolation is per-row. When `lockDrainableEvents` returns
            // 0 rows the shard is drained; otherwise we keep going so a large
            // backlog (import storm) drains continuously instead of
            // `batchSize`-per-interval. The budget bounds how long we hold the
            // event loop / pool connections before yielding.
            //
            // With `drainConcurrency > 1` we run that loop in N parallel workers,
            // each pinned to one `hashtext(media_item_id)` shard. Because an item
            // always hashes to the same shard, every event for a given item is
            // drained by ONE worker in `id` order — so per-item ordering
            // (created→…→deleted) is byte-for-byte the serial order, while
            // distinct items drain concurrently. The serial drain (~1 event per
            // DB round-trip) can't keep up with a full-library scan burst; this
            // gives ~N× throughput.
            const deadline = Date.now() + this.drainBudgetMs;
            const concurrency = this.drainConcurrency;
            // A worker returns `true` when it stopped with its shard likely
            // NON-empty (budget/iteration cap) so the tick re-arms; `false` when
            // it drained its shard clean or was told to stop.
            const runWorker = async (shardIndex: number): Promise<boolean> => {
                const shard =
                    concurrency > 1 ? { index: shardIndex, total: concurrency } : undefined;
                for (let i = 0; i < MAX_ITERATIONS_PER_TICK; i++) {
                    const outcome = await this.processOneRow(shard);
                    if (outcome === 'empty') return false; // this shard is drained
                    // `++` is a synchronous read-modify-write with no await
                    // between, so concurrent workers on the single JS thread
                    // never lose an increment.
                    if (outcome === 'success') drained++;
                    else if (outcome === 'dead-letter') deadLettered++;
                    // Abort an in-flight drain promptly on shutdown rather than
                    // running to budget/empty. Uses the `stopped` flag (not
                    // `timer`) because tick() is also invoked directly when the
                    // dispatcher was never started (tests / on-demand).
                    if (this.stopped) return false;
                    if (Date.now() >= deadline) return true; // budget hit, backlog likely remains
                }
                return true; // hit the iteration backstop → assume backlog remains
            };
            // allSettled (not Promise.all) so a worker that throws — the lock or
            // out-of-band backoff query failing with the DB unreachable — never
            // orphans the other workers to keep mutating state after this tick
            // returns.
            const settled = await Promise.allSettled(
                Array.from({ length: concurrency }, (_, i) => runWorker(i)),
            );
            // Re-arm iff a HEALTHY worker stopped on the budget with backlog left.
            // Crucially this is OR-ed over the *fulfilled* workers only: a single
            // rejected worker (a transient blip on one shard) must NOT suppress
            // the re-arm of the shards that are fine — otherwise one hiccup drops
            // the whole drain back to the 30 s poll mid-burst, reintroducing the
            // "days behind" backlog this parallelism exists to prevent.
            budgetBounded = settled.some((r) => r.status === 'fulfilled' && r.value === true);
            const rejections = settled.filter(
                (r): r is PromiseRejectedResult => r.status === 'rejected',
            );
            if (rejections.length > 0) {
                // A worker threw only when a lock/backoff query failed with the DB
                // unreachable. Skip the healthy-path heartbeat/audit writes (as the
                // serial catch did) but keep the re-arm decision above so intact
                // shards keep draining, and report the progress workers durably
                // committed before failing (an accurate partial count — the events
                // are consumed regardless of this return value). Log ALL failures,
                // not just the first, so a fleet-wide DB blip isn't undercounted.
                log.warn('Dispatcher tick worker(s) failed', {
                    failed: rejections.length,
                    of: concurrency,
                    firstErr:
                        rejections[0].reason instanceof Error
                            ? rejections[0].reason.message
                            : String(rejections[0].reason),
                });
                return { drained, deadLettered };
            }

            // Observability (Slice 0): heartbeat + audit row on dead-letter.
            // Leader-gated subsystem — only the leader reaches here (isLeader
            // guard above), so this one global key is kept fresh by the leader.
            // Both best-effort.
            await writeHeartbeat('event-dispatcher', {
                status: 'ok',
                detail: { drained, deadLettered },
            });
            if (deadLettered > 0) {
                await appendAuditEvent({
                    category: 'dispatcher',
                    action: 'event-dead-lettered',
                    severity: 'error',
                    summary: `Pipeline dispatcher dead-lettered ${deadLettered} event(s).`,
                    detail: { drained, deadLettered },
                });
            }

            return { drained, deadLettered };
        } catch (err) {
            log.warn('Dispatcher tick failed', {
                err: err instanceof Error ? err.message : String(err),
            });
            return { drained: 0, deadLettered: 0 };
        } finally {
            this.running = false;
            // Budget elapsed with rows likely remaining → re-arm a near-future
            // tick so a large backlog drains in budget-sized chunks (yielding
            // the pool connection between them) instead of waiting 30 s. Gate
            // on `stopped` (not `timer`) so the backlog continues for both the
            // interval-driven and on-demand callers, but never re-arms after
            // stop(). The re-arm timer is unref'd, so it won't hold the process.
            if (budgetBounded && !this.stopped) {
                this.scheduleDebouncedTick();
            }
        }
    }

    /**
     * Transient-error auto-recovery pass. Selects dead-lettered rows still under
     * their per-row auto-requeue budget, keeps only those whose `last_error` the
     * shared classifier deems transient (connect timeout, conn reset, etc.), and
     * requeues them — incrementing `auto_requeue_count` so a permanent failure
     * that merely looks transient can't loop forever (it parks for manual triage
     * once the budget is spent).
     *
     * Throttled to `autoRequeueIntervalMs` so the 250 ms NOTIFY-debounced hot
     * loop doesn't run the requeue query every tick. Fully best-effort: any
     * failure (e.g. the DB still unreachable) is logged and swallowed so the
     * drain proceeds — the next tick retries.
     */
    private async maybeAutoRequeueTransientDeadLetters(): Promise<void> {
        if (this.maxAutoRequeue <= 0) return;
        const nowMs = Date.now();
        if (nowMs - this.lastAutoRequeueAt < this.autoRequeueIntervalMs) return;
        this.lastAutoRequeueAt = nowMs;
        try {
            const candidates = await findAutoRequeuableDeadLetters(
                this.opts.sql,
                this.maxAutoRequeue,
            );
            const transientIds = candidates
                .filter((c) => c.last_error != null && isTransientPgError(new Error(c.last_error)))
                .map((c) => c.id);
            if (transientIds.length === 0) return;
            const requeued = await requeueDeadLetterEventsAuto(this.opts.sql, transientIds);
            if (requeued > 0) {
                log.info('Auto-requeued transient dead-letter events', {
                    requeued,
                    maxAutoRequeue: this.maxAutoRequeue,
                });
                await appendAuditEvent({
                    category: 'dispatcher',
                    action: 'event-auto-requeued',
                    severity: 'warn',
                    summary: `Auto-requeued ${requeued} transient dead-letter event(s).`,
                    detail: { requeued, maxAutoRequeue: this.maxAutoRequeue },
                });
            }
        } catch (err) {
            log.warn('Transient dead-letter auto-requeue pass failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Lock and process exactly one drainable row in a single transaction.
     * Returns `'empty'` when nothing's drainable (caller breaks out of the
     * tick loop). The transaction commits after either `markEventConsumed`
     * or `recordEventFailure`, releasing the FOR UPDATE row lock.
     *
     * Crucially, the BullMQ enqueue + Valkey pub/sub triggered by the
     * stage_state flip are NOT run inside this transaction. Holding the
     * `FOR UPDATE` outbox-row lock across that network I/O serialized the
     * whole outbox behind one slow enqueue (SQL-C5 / F39). Instead they are
     * collected into `deferred` and flushed AFTER the tx commits, so the row
     * lock is released first. If the tx rolls back (e.g. a stage_state write
     * throws before the consume decision), the effects are discarded — they
     * only ever fire for a committed pass.
     */
    private async processOneRow(shard?: {
        index: number;
        total: number;
    }): Promise<'success' | 'retry' | 'dead-letter' | 'empty'> {
        const deferred: Array<() => Promise<void>> = [];
        const sink = {
            push: (effect: () => Promise<void>) => deferred.push(effect),
        };

        // Captured inside the tx so the post-rollback recovery path below knows
        // which row to back off. Without it, a tx that fails AFTER locking the
        // row (commit error, or `recordEventFailure` itself throwing) would
        // roll back leaving `attempts`/`next_retry_at` untouched — the next
        // tick re-locks the same row immediately and the dispatcher burns 100%
        // of its ticks hot-retrying one poison row (F41).
        let lockedRow: EventOutboxRow | null = null;

        let outcome: 'success' | 'retry' | 'dead-letter' | 'empty';
        try {
            outcome = await withTx(this.opts.sql, async (txSql: postgres.Sql) => {
                const rows = await lockDrainableEvents(txSql, 1, shard);
                if (rows.length === 0) return 'empty' as const;
                lockedRow = rows[0];
                return this.handleRow(txSql, rows[0], sink);
            });
        } catch (err) {
            // The per-row transaction rolled back as a whole — either the
            // lock/seed/flip failed before `handleRow`'s own catch could run,
            // or `recordEventFailure` (inside that catch) itself threw, or the
            // COMMIT failed. Anything queued in `deferred` belongs to an
            // aborted tx and must NOT fire. If we managed to lock a row, record
            // its failure in a FRESH transaction so it gets backoff instead of
            // being hot-retried on the next tick. If we never locked a row
            // (the failure was the lock query itself), there is nothing to back
            // off — re-throw so the tick's own catch surfaces it.
            const msg = err instanceof Error ? err.message : String(err);
            if (lockedRow === null) {
                throw err;
            }
            const row: EventOutboxRow = lockedRow;
            log.warn('Event row transaction failed; recording backoff out-of-band', {
                id: row.id,
                event: row.event_name,
                mediaItemId: row.media_item_id,
                attempts: row.attempts,
                err: msg,
            });
            try {
                const failureResult = await recordEventFailure(this.opts.sql, {
                    id: row.id,
                    errorMessage: msg,
                    maxAttempts: MAX_ATTEMPTS,
                });
                return failureResult.deadLettered ? 'dead-letter' : 'retry';
            } catch (recordErr) {
                // Even the out-of-band backoff write failed (DB likely still
                // unreachable). Surface to the tick loop, which logs and stops
                // this pass; the 30 s interval retries once the DB recovers.
                // The row keeps its current (un-backed-off) state, but a fully
                // unreachable DB means no tick makes progress anyway, so there
                // is no hot loop — the loop yields between ticks.
                log.warn('Out-of-band backoff write also failed', {
                    id: row.id,
                    err: recordErr instanceof Error ? recordErr.message : String(recordErr),
                });
                throw err;
            }
        }

        // Tx has committed (or the row was empty). Run the deferred side
        // effects now, outside the FOR UPDATE transaction. Each is
        // independently best-effort: the DB consume/flip is already durable,
        // so a transient Valkey/BullMQ failure here must not fail the row
        // (which would re-flip + re-fire on retry). The stage-state effects
        // already swallow their own publish errors; this catch is a backstop
        // for the enqueue effect and any future side-effect handler.
        for (const effect of deferred) {
            try {
                await effect();
            } catch (err) {
                log.warn('Deferred dispatcher side effect failed (post-commit)', {
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return outcome;
    }

    private async handleRow(
        sql: postgres.Sql,
        row: EventOutboxRow,
        deferred: { push: (effect: () => Promise<void>) => void },
    ): Promise<'success' | 'retry' | 'dead-letter'> {
        try {
            // 1. Seed-or-invalidate stage_state rows.
            //
            //    `item.created` / `item.reclaimed` describe items that have NO
            //    coverage rows yet — `invalidateByEvent` only flips EXISTING
            //    rows back to `pending`, so it is a no-op for them. For those
            //    events we must SEED coverage from the live registry instead
            //    (F15/F22). `seedRowsForCreate` is idempotent (ON CONFLICT DO
            //    NOTHING), so a duplicate emit (e.g. the app-side
            //    `afterCreated` hook racing the DB trigger) is harmless.
            //
            //    All other events flip existing coverage rows. The per-row tx
            //    handle is passed so the seed/UPDATE commits atomically with
            //    `markEventConsumed` below. The BullMQ enqueue + Valkey pub/sub
            //    those flips trigger are handed to `deferred` so they run AFTER
            //    the tx commits (outside the FOR UPDATE lock) — see
            //    processOneRow.
            if (row.event_name === 'item.created' || row.event_name === 'item.reclaimed') {
                await this.stageState.seedRowsForCreate(row.media_item_id, sql, deferred);
            } else if (row.event_name === 'item.dismissed' || row.event_name === 'item.deleted') {
                // The item is leaving the pipeline — DELETE its coverage rows
                // rather than flip them back to `pending`. No stage declares
                // interest in `item.dismissed`/`item.deleted`, so routing them
                // through `invalidateByEvent` would be a silent no-op and the
                // coverage rows would linger (F46). This makes a direct
                // `UPDATE media_items SET is_dismissed = true` (which fires the
                // 16.33.0 trigger) clean up coverage even when it bypasses
                // `MediaLifecycleService.afterDismissed()`. Idempotent: a
                // second emit just deletes zero rows.
                await this.stageState.deleteRowsForItem(row.media_item_id, sql, deferred);
            } else {
                await this.stageState.invalidateByEvent(
                    row.media_item_id,
                    row.event_name,
                    sql,
                    deferred,
                    row.id,
                );
                if (
                    row.event_name === 'file.attached' ||
                    row.event_name === 'file.contentChanged'
                ) {
                    const seriesId = await resolveSeriesIdForItem(sql, row.media_item_id);
                    if (seriesId && seriesId !== row.media_item_id) {
                        await this.stageState.invalidateByEvent(
                            seriesId,
                            row.event_name,
                            sql,
                            deferred,
                            row.id,
                            ['chapter-sync'],
                        );
                    }
                }
            }

            // 2. Run registered side-effect handlers sequentially.
            const evtHandlers = handlers.get(row.event_name) ?? [];
            for (const h of evtHandlers) {
                await h(sql, row.payload);
            }

            await markEventConsumed(sql, row.id);
            return 'success';
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn('Event handler failed', {
                id: row.id,
                event: row.event_name,
                mediaItemId: row.media_item_id,
                attempts: row.attempts,
                err: msg,
            });
            const failureResult = await recordEventFailure(sql, {
                id: row.id,
                errorMessage: msg,
                maxAttempts: MAX_ATTEMPTS,
            });
            if (failureResult.deadLettered) {
                log.error(
                    'Event moved to dead-letter after max attempts',
                    err instanceof Error ? err : new Error(msg),
                    {
                        id: row.id,
                        event: row.event_name,
                        mediaItemId: row.media_item_id,
                        attempts: failureResult.nextAttempts,
                    },
                );
                return 'dead-letter';
            }
            return 'retry';
        }
    }
}

let _dispatcher: PipelineEventDispatcher | null = null;

export function getPipelineEventDispatcher(opts: DispatcherOpts): PipelineEventDispatcher {
    if (!_dispatcher) {
        _dispatcher = new PipelineEventDispatcher(opts);
    }
    return _dispatcher;
}

export function _resetPipelineEventDispatcherForTesting(): void {
    if (_dispatcher) {
        _dispatcher.stop();
    }
    _dispatcher = null;
}
