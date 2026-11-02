// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Scheduler — interval-based task firing, replaces the 3044-line queue/scheduler.ts.
//
// Per-replica setInterval fires tasks whose next_fire_at <= now. Multi-replica
// fairness is enforced via Valkey SETNX on lock:scheduler:<taskId>:<bucket>.
// Only the replica that claims the lock fires startRun for that bucket.
//
// Boot replay: catchUpAtBoot() checks last_fired_at against the task interval.
// If a full interval has passed since last fire, one catch-up cycle is fired.

import { markLoopTick } from './loop-progress.js';
import type postgres from 'postgres';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import type { TaskRegistry } from './registry.js';
import type { StartRunResult } from './orchestrator.js';
import {
    getSchedulerState,
    upsertSchedulerState,
    seedSchedulerStateIfAbsent,
    listAllTaskTriggers,
    setNextFireAt,
    type StoredTaskTriggers,
} from './scheduler-state.js';
import type { TaskTrigger } from '$lib/schemas/task-definition.schema.js';
import { computeNextFireAt, hasStartupTrigger, isTimed } from './triggers.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { adaptLogger } from './plugin-context.js';
import { parseDurationMs } from './duration.js';
import { type ValkeyLike } from './valkey-types.js';
import { beatAlive, writeHeartbeat } from './observability/heartbeat.js';

const log = Logger.for('Scheduler');

// Duration parsing now lives in the canonical `./duration.ts` (single source of
// truth shared with orchestrator + runner). Re-exported so existing importers
// (e.g. routes/api/v1/tasks) keep resolving `parseDurationMs` from here.
export { parseDurationMs };

/**
 * A schedule override named `*_HOURS` / `*_MINUTES` / `*_DAYS` is a NUMBER in
 * the settings schema (e.g. SYNC_CURATED_LISTS_HOURS = 6). parseDurationMs
 * needs a unit, so a bare "6" used to be rejected and the task silently kept
 * its declared interval. Give a bare number the unit its name promises.
 */
export function unitForBareNumber(overrideName: string, raw: string): string {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) return raw;
    if (overrideName.endsWith('_HOURS')) return `${value}h`;
    if (overrideName.endsWith('_MINUTES')) return `${value}m`;
    if (overrideName.endsWith('_DAYS')) return `${value}d`;
    return raw;
}

/**
 * Resolve the interval of a task's DEFAULT schedule — used only when the
 * operator has set no triggers (`task_triggers`, spec 2026-09-27 Part 2; see
 * `maybeFireByTriggers`).
 *
 * Precedence: operator triggers (handled before this is reached) →
 * `schedule.envOverride` (deploy-time knob) → `schedule.every` (declared). A
 * missing/unparsable env value falls through to the declared cadence, so a
 * bad value can never brick the task's firing.
 */
function resolveInterval(task: TaskDefinition): number | null {
    const sched = task.schedule;
    if (!sched) return null;

    if (sched.envOverride) {
        // process.env also carries values saved in the admin UI (the config
        // service mirrors them), so this follows a saved setting per tick.
        const raw = process.env[sched.envOverride];
        if (raw) {
            const override = parseDurationMs(unitForBareNumber(sched.envOverride, raw));
            if (override !== null) return override;
        }
    }
    return parseDurationMs(sched.every);
}

/**
 * Operator triggers the scheduler can act on. A set whose every timed trigger
 * is unreadable (and that has no startup trigger) would leave the task never
 * firing; fall back to the default schedule for it instead, loudly — the same
 * "a bad value can never brick firing" rule `resolveInterval` follows.
 */
function triggersUsable(triggers: readonly TaskTrigger[], taskId: string): boolean {
    if (hasStartupTrigger(triggers)) return true;
    if (computeNextFireAt(triggers, Date.now(), null) !== null) return true;
    log.warn('Task triggers unreadable — using the default schedule', { taskId });
    return false;
}

// ── Orchestrator interface (minimal) ─────────────────────────────────────────

export interface SchedulerOrchestrator {
    startRun(
        taskId: string,
        input: unknown,
        opts?: {
            trigger?: { kind: string; by?: string };
            idempotencyKey?: string;
        },
    ): Promise<StartRunResult>;
}

// ── Scheduler class ───────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 10_000;
const MAX_CLAIM_TTL_MS = 30_000;
/** How long one "server started" counts for an `On startup` trigger across replicas. */
const STARTUP_CLAIM_TTL_MS = 10 * 60_000;

export class Scheduler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    /**
     * Set to true only in `stop()`. Distinct from `!running` because the
     * scheduler starts life with `running === false` and stays there until
     * `start()` is called — including in tests that drive `tick()` directly.
     * The race-window guards must only act after a real shutdown was
     * requested, not before a first `start()`.
     */
    private shutdownRequested = false;
    private tickInProgress: Promise<void> | null = null;
    /**
     * AbortControllers for any in-flight `dynamicSchedule` loaders, so
     * `Scheduler.stop()` can cancel a slow DB query that would otherwise
     * keep the tick loop alive past shutdown.
     */
    private readonly inflightLoaders = new Set<AbortController>();

    constructor(
        private readonly registry: TaskRegistry,
        private readonly orchestrator: SchedulerOrchestrator,
        private readonly sql: postgres.Sql,
        private readonly getClient: () => Promise<ValkeyLike>,
    ) {}

    private upgradeSuspended = false;

    /** Reversible local dispatch gate; persisted administrator pauses stay intact. */
    suspendForUpgrade(): () => void {
        const previous = this.upgradeSuspended;
        this.upgradeSuspended = true;
        return (): void => {
            if (!this.shutdownRequested) this.upgradeSuspended = previous;
        };
    }

    isUpgradeQuiescent(): boolean {
        return this.tickInProgress === null;
    }

    /**
     * Start the scheduler loop. Returns immediately; loop ticks every 10s.
     */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        log.info('Scheduler started');
        this.timer = setInterval(() => {
            // If the previous tick is still running we skip this one — overlapping
            // ticks would double-fire the per-bucket claim attempt and obscure
            // shutdown semantics (stop() only awaits the latest tick).
            void this.tick().catch((err: unknown) => {
                log.error('Scheduler tick threw', err as Error);
            });
        }, TICK_INTERVAL_MS);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    /**
     * Stop the loop. Awaits the current tick if one is in progress.
     */
    async stop(): Promise<void> {
        this.running = false;
        this.shutdownRequested = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        // Abort any in-flight dynamicSchedule loaders so a slow query
        // doesn't extend shutdown indefinitely. Snapshot first to avoid
        // mutating the set while iterating; each loader's `finally` block
        // removes its own controller on resolution/abort.
        for (const ctrl of [...this.inflightLoaders]) {
            ctrl.abort();
        }
        if (this.tickInProgress) {
            await this.tickInProgress.catch(() => {});
            this.tickInProgress = null;
        }
        log.info('Scheduler stopped');
    }

    /**
     * One tick: walk all scheduled tasks, fire if next_fire_at <= now and claim succeeds.
     *
     * Reentrancy-guarded: if a previous tick is still running this returns the
     * same in-flight promise so callers see "still going" instead of stacking
     * overlapping invocations.
     */
    async tick(): Promise<void> {
        if (this.upgradeSuspended) return;
        if (this.tickInProgress) return this.tickInProgress;
        this.tickInProgress = this.tickInner().finally(() => {
            this.tickInProgress = null;
        });
        return this.tickInProgress;
    }

    /**
     * Fires accumulated within the current tick — reset at the top of each
     * tickInner and reported as the heartbeat `firedCount` detail. Incremented by
     * the fire paths (maybeFireTask / maybeFireDynamicScheduledTask) so the
     * heartbeat reflects how much the scheduler actually did this cycle.
     */
    private firesThisTick = 0;

    private async tickInner(): Promise<void> {
        const now = Date.now();
        const allTasks = this.registry.getAllTasks();
        this.firesThisTick = 0;
        await beatAlive('scheduler'); // liveness at tick-start
        markLoopTick('scheduler');

        const triggersByTask = await this.loadTriggers();
        for (const task of allTasks) {
            if (task.schedule) {
                const triggers = triggersByTask?.get(task.id)?.triggers;
                if (triggers && triggers.length > 0 && triggersUsable(triggers, task.id)) {
                    await this.maybeFireByTriggers(task, now, triggers);
                } else {
                    await this.maybeFireTask(task, now);
                }
            } else if (task.dynamicSchedule) {
                await this.maybeFireDynamicScheduledTask(task, now);
            }
        }

        // Observability heartbeat (best-effort, never throws into the tick).
        // Scheduler runs on every replica (not leader-gated) so this key stays
        // fresh fleet-wide; instanceId shows the last writer.
        await writeHeartbeat('scheduler', {
            status: 'ok',
            detail: { firedCount: this.firesThisTick, missedCatchUp: 0 },
        });
    }

    /**
     * On boot, check for missed cycles and fire once per missed task.
     * Fires at most one catch-up cycle per task, not the full backlog.
     */
    async catchUpAtBoot(): Promise<void> {
        const now = Date.now();
        const scheduledTasks = this.registry.getAllTasks().filter((t) => t.schedule);
        log.info('Scheduler boot catch-up starting', {
            taskCount: scheduledTasks.length,
        });
        const triggersByTask = await this.loadTriggers();

        for (const task of scheduledTasks) {
            const triggers = triggersByTask?.get(task.id)?.triggers;
            if (triggers && triggers.length > 0 && triggersUsable(triggers, task.id)) {
                await this.bootWithTriggers(task, now, triggers);
                continue;
            }
            const interval = resolveInterval(task);
            if (!interval) continue;

            try {
                const state = await getSchedulerState(this.sql, task.id);
                if (!state) {
                    // No state row yet. This happens on a fresh DB or the
                    // very first deploy of a new task. Only fire immediately
                    // if the task explicitly opted into runOnStartup;
                    // otherwise the steady-state tick loop will pick it up
                    // at the next bucket boundary. Without this guard, every
                    // scheduled task fires simultaneously on a fresh deploy
                    // (including heavy backlog drains).
                    if (task.schedule?.runOnStartup === true) {
                        // No state row → seed one (bucket-aligned nextFireAt)
                        // BEFORE firing so the catch-up idempotency key anchors on
                        // shared state instead of the per-replica bucket fallback.
                        // Two clock-skewed replicas booting together compute
                        // independent local anchors when `now` straddles a bucket
                        // boundary; a blind last-writer-wins upsert would let each
                        // fire on its OWN anchor → different `sched:<id>:<anchor>`
                        // keys the DB partial-unique index can't collapse → double
                        // fire. Seed-if-absent + read-back makes both replicas
                        // converge on the PERSISTED anchor (whichever insert won),
                        // and fireCatchUp derives the key from that shared value.
                        const localAnchor = Math.floor(now / interval) * interval;
                        const seeded = await seedSchedulerStateIfAbsent(this.sql, {
                            taskId: task.id,
                            lastFiredAt: null,
                            nextFireAt: new Date(localAnchor),
                            paused: false,
                            pausedBy: null,
                            pausedAt: null,
                        });
                        // A concurrent replica may have already fired+advanced the
                        // row (nextFireAt in the future) or paused it; honour the
                        // persisted state instead of blindly firing our cycle.
                        if (seeded.paused) continue;
                        if (seeded.nextFireAt.getTime() > now) continue;
                        await this.fireCatchUp(task, now, interval, seeded.nextFireAt.getTime());
                    }
                    continue;
                }
                if (state.paused) continue;

                // A row exists but lastFiredAt may be null (e.g. paused-before-
                // first-fire then resumed, or hand-written rows). Treating null
                // as epoch-zero means missedBy is always positive, which would
                // fire every such task on boot regardless of intent. Honour
                // runOnStartup for null lastFiredAt the same as the !state path.
                if (!state.lastFiredAt) {
                    if (task.schedule?.runOnStartup === true) {
                        await this.fireCatchUp(task, now, interval, state.nextFireAt.getTime());
                    }
                    continue;
                }

                const missedBy = now - state.lastFiredAt.getTime() - interval;
                if (missedBy > 0) {
                    log.info('Scheduler catch-up: missed cycle', {
                        taskId: task.id,
                        missedByMs: missedBy,
                    });
                    await this.fireCatchUp(task, now, interval, state.nextFireAt.getTime());
                }
            } catch (err) {
                log.error('Scheduler catch-up failed', err as Error, {
                    taskId: task.id,
                });
            }
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * All operator triggers, once per tick. A failed read returns null and
     * every task falls back to its default schedule for this tick — the same
     * "a lookup failure can never brick firing" rule the old override had.
     */
    private async loadTriggers(): Promise<Map<string, StoredTaskTriggers> | null> {
        try {
            return await listAllTaskTriggers(this.sql);
        } catch (err) {
            log.warn('Task trigger lookup failed — using default schedules this tick', {
                err: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }

    /**
     * Fire a task that has operator triggers (spec 2026-09-27 Part 2).
     *
     * Same claim → fire → advance order and the same `sched:<id>:<nextFireAt>`
     * idempotency key as `maybeFireTask`, so every crash/skew argument written
     * there holds here too. What differs is only "when is it next": the
     * earliest upcoming instant over the task's timed triggers
     * (`computeNextFireAt`), instead of `now + interval`. The claim lock is
     * keyed on that instant rather than on an interval bucket, since a
     * daily/weekly trigger has no fixed bucket.
     */
    private async maybeFireByTriggers(
        task: TaskDefinition,
        now: number,
        triggers: readonly TaskTrigger[],
    ): Promise<void> {
        if (!triggers.some(isTimed)) return; // startup-only: fires at boot, never on a tick
        try {
            const state = await getSchedulerState(this.sql, task.id);
            if (state?.paused) return;
            if (!state) {
                // Never scheduled yet: seed the first instant and wait for it.
                const first = computeNextFireAt(triggers, now, null);
                if (first !== null) await setNextFireAt(this.sql, task.id, new Date(first));
                return;
            }
            const nextFireAt = state.nextFireAt.getTime();
            if (nextFireAt > now) return;

            const claimed = await this.claimForDispatch(
                `lock:scheduler:${task.id}:at:${nextFireAt}`,
                MAX_CLAIM_TTL_MS,
            );
            if (!claimed) return;

            await this.orchestrator.startRun(
                task.id,
                {},
                {
                    trigger: { kind: 'scheduled' },
                    idempotencyKey: `sched:${task.id}:${nextFireAt}`,
                },
            );

            const following = computeNextFireAt(triggers, now, now);
            await upsertSchedulerState(this.sql, {
                taskId: task.id,
                lastFiredAt: new Date(now),
                // `following` is non-null: at least one timed trigger exists.
                nextFireAt: new Date(following ?? now + 86_400_000),
                paused: false,
                pausedBy: null,
                pausedAt: null,
            });
            this.firesThisTick++;
            log.info('Scheduler fired task (trigger)', { taskId: task.id });
        } catch (err) {
            log.error('Scheduler trigger fire failed', err as Error, { taskId: task.id });
        }
    }

    /**
     * Boot handling for a task with operator triggers.
     *
     * - An `On startup` trigger fires once now. The claim lock outlives a
     *   rolling restart (10 min), so replicas coming up one after another
     *   start it once, not once each.
     * - `next_fire_at` is recomputed from now: a daily/weekly time missed
     *   while the server was down is SKIPPED and its next occurrence applies
     *   (matching Jellyfin behaviour), while an interval trigger
     *   keeps today's catch-up (it is due at lastFired + every, which may be
     *   in the past, and the first tick fires it).
     */
    private async bootWithTriggers(
        task: TaskDefinition,
        now: number,
        triggers: readonly TaskTrigger[],
    ): Promise<void> {
        try {
            const state = await getSchedulerState(this.sql, task.id);
            if (state?.paused) return;
            let lastFired = state?.lastFiredAt?.getTime() ?? null;

            if (hasStartupTrigger(triggers)) {
                // One lock with a TTL, not an epoch-aligned bucket: restarts
                // that straddle a bucket boundary must not both fire.
                const claimed = await this.claimForDispatch(
                    `lock:scheduler:${task.id}:startup`,
                    STARTUP_CLAIM_TTL_MS,
                );
                if (this.upgradeSuspended) {
                    // Never keep a startup claim we will not fire: it would block
                    // the startup run until STARTUP_CLAIM_TTL_MS.
                    if (claimed) await this.releaseClaim(`lock:scheduler:${task.id}:startup`);
                    return;
                }
                if (claimed) {
                    await this.orchestrator.startRun(
                        task.id,
                        {},
                        {
                            trigger: { kind: 'scheduled' },
                            idempotencyKey: `sched:${task.id}:startup:${now}`,
                        },
                    );
                    lastFired = now;
                    log.info('Scheduler fired task (startup trigger)', { taskId: task.id });
                }
            }

            const next = computeNextFireAt(triggers, now, lastFired);
            if (next === null) return;
            if (lastFired === now) {
                await upsertSchedulerState(this.sql, {
                    taskId: task.id,
                    lastFiredAt: new Date(now),
                    nextFireAt: new Date(next),
                    paused: false,
                    pausedBy: null,
                    pausedAt: null,
                });
            } else {
                await setNextFireAt(this.sql, task.id, new Date(next));
            }
        } catch (err) {
            log.error('Scheduler boot (triggers) failed', err as Error, { taskId: task.id });
        }
    }

    private async maybeFireTask(task: TaskDefinition, now: number): Promise<void> {
        const interval = resolveInterval(task);
        if (!interval) return;

        try {
            const state = await getSchedulerState(this.sql, task.id);
            if (state?.paused) return;

            let nextFireAt: number;
            if (state) {
                nextFireAt = state.nextFireAt.getTime();
            } else if (task.schedule?.runOnStartup === true) {
                // No state row + runOnStartup → fire now, but ANCHOR the fire on
                // a bucket-aligned nextFireAt and SEED the scheduler_state row
                // before firing so the idempotency key derives from shared state.
                // Using the raw per-replica `now` as the anchor let two
                // clock-skewed replicas compute different `sched:<id>:<now>` keys
                // and double-fire this first cycle. Even a bucket-aligned LOCAL
                // anchor diverges when two replicas straddle a bucket boundary,
                // so a blind upsert isn't enough: seed-if-absent + read-back so
                // both replicas converge on the PERSISTED anchor (whichever insert
                // won) and build the identical `sched:<id>:<anchor>` key below,
                // which the DB partial-unique index then collapses. lastFiredAt
                // stays null so a startRun throw leaves the cycle un-consumed (the
                // next tick reads the seeded row and retries with the same key).
                const localAnchor = Math.floor(now / interval) * interval;
                const seeded = await seedSchedulerStateIfAbsent(this.sql, {
                    taskId: task.id,
                    lastFiredAt: null,
                    nextFireAt: new Date(localAnchor),
                    paused: false,
                    pausedBy: null,
                    pausedAt: null,
                });
                // If a concurrent replica already seeded+paused, don't fire.
                if (seeded.paused) return;
                // Converge on the persisted anchor. If that replica already fired
                // and advanced next_fire_at into the future, the `nextFireAt > now`
                // guard below turns this into a no-op — no duplicate fire.
                nextFireAt = seeded.nextFireAt.getTime();
            } else {
                // No state row and NOT runOnStartup. catchUpAtBoot deliberately
                // SKIPS such a task to avoid every scheduled task — including heavy
                // backlog drains — firing simultaneously on a fresh deploy. But the
                // old `?? now` default fired it on the very next ~10s tick anyway,
                // defeating that guard (the fresh-install thundering herd). Seed
                // next_fire_at at the next bucket boundary and wait: a later tick
                // reads the row and fires then. One write per never-before-seen
                // task; afterwards the row exists and this branch is not taken.
                const nextBoundary = (Math.floor(now / interval) + 1) * interval;
                await upsertSchedulerState(this.sql, {
                    taskId: task.id,
                    lastFiredAt: null,
                    nextFireAt: new Date(nextBoundary),
                    paused: false,
                    pausedBy: null,
                    pausedAt: null,
                });
                return;
            }
            if (nextFireAt > now) return;

            const bucket = Math.floor(now / interval);
            const claimKey = `lock:scheduler:${task.id}:${bucket}`;
            const claimTtlMs = Math.max(Math.min(interval - 1_000, MAX_CLAIM_TTL_MS), 1_000);
            const claimed = await this.claimForDispatch(claimKey, claimTtlMs);
            if (!claimed) return;

            // Fire FIRST, advance scheduler_state only after startRun returns.
            //
            // Why this order (reversed from the original upsert-first design):
            // startRun throws on backpressure / circuit-open / quota-exceeded —
            // all NORMAL operating conditions, not crashes, and all of which
            // throw BEFORE any run row is enqueued. Advancing next_fire_at
            // before the fire meant such a throw silently burned the cycle:
            // last_fired_at moved forward as if the task had run, nothing was
            // enqueued, and the miss stayed invisible until the next interval.
            // Firing first means a throw leaves next_fire_at unadvanced, so the
            // next tick (once the bucket lock TTL elapses) retries the cycle.
            //
            // Crash-safety (the property the old order protected): a crash
            // between claiming the bucket and startRun no longer double-fires,
            // because the idempotency key below is anchored on `nextFireAt`
            // (shared DB state) and DB-deduped via the partial unique index
            // task_history_idempotency_key_unique. A replica re-firing the
            // un-advanced cycle reuses the same key and collapses onto the
            // in-flight run instead of starting a second one.
            //
            // NARROW RESIDUAL WINDOW: the partial unique index only covers
            // non-terminal rows (state IN pending/active/cancelling). If (a) the
            // fired run COMPLETES faster than the ~30s bucket-claim TTL AND (b)
            // the state-advance below failed / the process crashed before it, a
            // retry within the same bucket sees no non-terminal row and fires a
            // SECOND run. Harmless for idempotent maintenance tasks; for a
            // scheduled task with external side effects (API spend, webhooks),
            // declare `exclusiveWith` — its identity SETNX TTL is floored at the
            // interval, so it dedups across completion too.
            //
            // Skew-immune dedup: the per-bucket Valkey claim lock above does NOT
            // dedup across replicas whose clocks straddle a bucket boundary —
            // they compute DIFFERENT buckets, claim DIFFERENT lock keys, and
            // both fire. Anchoring the key on `nextFireAt` (identical on every
            // replica) collapses that duplicate too. The bucket is intentionally
            // NOT part of the key for that reason.
            await this.orchestrator.startRun(
                task.id,
                {},
                {
                    trigger: { kind: 'scheduled' },
                    idempotencyKey: `sched:${task.id}:${nextFireAt}`,
                },
            );

            // startRun returned (enqueued, or deduped onto an in-flight run):
            // the cycle fired, so advance next_fire_at. If startRun THREW we
            // never reach here — next_fire_at stays put and the next tick retries.
            await upsertSchedulerState(this.sql, {
                taskId: task.id,
                lastFiredAt: new Date(now),
                nextFireAt: new Date(now + interval),
                paused: false,
                pausedBy: null,
                pausedAt: null,
            });

            this.firesThisTick++;
            log.info('Scheduler fired task', { taskId: task.id, bucket });
        } catch (err) {
            log.error('Scheduler tick failed', err as Error, {
                taskId: task.id,
            });
        }
    }

    /**
     * Fire a `dynamicSchedule` task. The loader returns the rows that are due
     * to fire RIGHT NOW (it parses cron / interval / lastRunAt itself); the
     * scheduler just enforces multi-replica fairness on the sweep call AND
     * deduplicates per-row firings within their cron bucket via idempotency
     * keys.
     *
     * Two-level locking:
     *  1. Sweep lock (`lock:scheduler-dynamic:<taskId>:<sweepBucket>`) — only
     *     one replica calls `loader()` per sweep cycle, avoiding N×DB load
     *     across N replicas.
     *  2. Per-row idempotency key (`dyn-sched:<taskId>:<rowId>:<bucket>`) —
     *     the orchestrator's identity SETNX collapses concurrent runs even
     *     if two sweeps end up firing the same row.
     */
    private async maybeFireDynamicScheduledTask(task: TaskDefinition, now: number): Promise<void> {
        const ds = task.dynamicSchedule;
        if (!ds) return;

        // Resolve sweep interval, honour env override
        const sweepEvery = ds.envOverride
            ? (process.env[ds.envOverride] ?? ds.sweepEvery ?? '5m')
            : (ds.sweepEvery ?? '5m');
        const sweepIntervalMs = parseDurationMs(sweepEvery);
        if (sweepIntervalMs === null) {
            log.warn('dynamicSchedule.sweepEvery invalid — skipping sweep', {
                taskId: task.id,
                sweepEvery,
            });
            return;
        }

        const sweepBucket = Math.floor(now / sweepIntervalMs);
        const sweepClaimKey = `lock:scheduler-dynamic:${task.id}:${sweepBucket}`;
        const claimTtlMs = Math.max(Math.min(sweepIntervalMs - 1_000, MAX_CLAIM_TTL_MS), 1_000);
        const claimed = await this.claimForDispatch(sweepClaimKey, claimTtlMs);
        if (!claimed) return;

        // Loader controller — tracked in `inflightLoaders` so
        // `Scheduler.stop()` can abort a slow query during shutdown.
        // Also race the loader against `claimTtlMs` so a hung loader
        // (DB lock / network stall / deadlock) doesn't block the tick
        // loop forever via the `tickInProgress` reentrancy guard.
        const controller = new AbortController();
        this.inflightLoaders.add(controller);
        // Race window: stop() may have iterated the inflightLoaders
        // snapshot before our `add()` above. If shutdown was already
        // requested, abort our own controller before awaiting the loader.
        // Guarded on `shutdownRequested` (not `!running`) because the
        // running flag is also false in tests that drive `tick()` directly
        // without calling `start()`.
        if (this.shutdownRequested) {
            controller.abort();
        }

        let entries: Array<{ rowId: string; bucket: string; input: unknown }>;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        try {
            const loaderPromise = ds.loader({
                sql: this.sql,
                logger: adaptLogger(log),
                signal: controller.signal,
                now: new Date(now),
            });
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`dynamicSchedule loader timed out after ${claimTtlMs}ms`));
                }, claimTtlMs);
            });
            entries = (await Promise.race([loaderPromise, timeoutPromise])) as Array<{
                rowId: string;
                bucket: string;
                input: unknown;
            }>;
        } catch (err) {
            log.error('dynamicSchedule loader threw', err as Error, {
                taskId: task.id,
            });
            return;
        } finally {
            if (timeoutHandle !== null) clearTimeout(timeoutHandle);
            this.inflightLoaders.delete(controller);
        }

        if (!Array.isArray(entries)) {
            // Loader returned something other than an array — common author
            // mistake is `{ entries: [...] }` instead of `[...]`. Warn loudly
            // so the contract bug surfaces rather than silently producing
            // zero fires.
            log.warn('dynamicSchedule loader did not return an array — skipping', {
                taskId: task.id,
                returnedType: typeof entries,
            });
            return;
        }
        if (entries.length === 0) return;

        let firedInSweep = 0;
        log.info('dynamicSchedule sweep firing', {
            taskId: task.id,
            dueRows: entries.length,
            sweepBucket,
        });

        for (const entry of entries) {
            // Per-iteration shutdown check: Scheduler.stop() aborts the
            // controller (via inflightLoaders); break the firing loop
            // immediately rather than draining all remaining rows.
            if (controller.signal.aborted) {
                log.info('dynamicSchedule firing cancelled mid-batch by shutdown', {
                    taskId: task.id,
                    firedSoFar: entries.indexOf(entry),
                });
                break;
            }
            if (!entry || typeof entry.rowId !== 'string' || typeof entry.bucket !== 'string') {
                log.warn('dynamicSchedule loader returned malformed entry — skipping', {
                    taskId: task.id,
                    entry: entry as unknown,
                });
                continue;
            }
            if (this.upgradeSuspended) {
                // Nothing fired yet: hand the sweep back so the next tick after
                // the upgrade re-runs it. After a fire, keep the claim — a
                // re-sweep could double-fire rows whose runs already finished.
                if (firedInSweep === 0) await this.releaseClaim(sweepClaimKey);
                return;
            }
            try {
                await this.orchestrator.startRun(task.id, entry.input, {
                    trigger: { kind: 'scheduled' },
                    idempotencyKey: `dyn-sched:${task.id}:${entry.rowId}:${entry.bucket}`,
                });
                firedInSweep++;
                this.firesThisTick++;
            } catch (err) {
                log.error('dynamicSchedule fire failed', err as Error, {
                    taskId: task.id,
                    rowId: entry.rowId,
                });
            }
        }
    }

    private async fireCatchUp(
        task: TaskDefinition,
        now: number,
        interval: number,
        scheduledFireAtMs: number | null,
    ): Promise<void> {
        // Use the SAME bucket key as the regular tick. Two distinct keys
        // (:catchup vs :<bucket>) used to allow a double-fire race on first
        // boot: catchUpAtBoot and tick could both claim and fire the same
        // never-fired task. Sharing the bucket key makes them mutually
        // exclusive — whichever path runs first wins the bucket, the other
        // becomes a no-op.
        const bucket = Math.floor(now / interval);
        const claimKey = `lock:scheduler:${task.id}:${bucket}`;
        const claimTtlMs = Math.max(Math.min(interval - 1_000, MAX_CLAIM_TTL_MS), 1_000);
        const claimed = await this.claimForDispatch(claimKey, claimTtlMs);
        if (!claimed) return;

        // Anchor the idempotency key on the MISSED scheduled fire time
        // (state.nextFireAt) when we have it, so the key is IDENTICAL to the
        // one the steady-state tick would produce for the same un-advanced
        // cycle (`maybeFireTask` uses `sched:<id>:<nextFireAt>`). This matters
        // because fire-before-state ordering means a crash between this
        // startRun and the upsert leaves next_fire_at un-advanced — a later
        // tick (possibly on another replica, after the bucket lock TTL) then
        // re-fires the same cycle, and a MATCHING key lets the DB partial
        // unique index collapse it onto the in-flight catch-up run rather than
        // starting a duplicate. Sharing the key also makes two replicas'
        // concurrent boot catch-ups skew-immune (they read the same
        // next_fire_at from shared DB state). When there is no state row
        // (first-ever runOnStartup fire) there is no scheduled time to anchor
        // on, so we fall back to the per-bucket catch-up key.
        const idempotencyKey =
            scheduledFireAtMs !== null
                ? `sched:${task.id}:${scheduledFireAtMs}`
                : `sched:${task.id}:catchup:${bucket}`;

        try {
            // Fire FIRST, advance scheduler_state only on success — same
            // ordering rationale as maybeFireTask: a startRun throw
            // (backpressure / circuit-open / quota) must leave next_fire_at
            // unadvanced so the missed cycle is retried, not silently burned.
            await this.orchestrator.startRun(
                task.id,
                {},
                {
                    trigger: { kind: 'scheduled' },
                    idempotencyKey,
                },
            );
            await upsertSchedulerState(this.sql, {
                taskId: task.id,
                lastFiredAt: new Date(now),
                nextFireAt: new Date(now + interval),
                paused: false,
                pausedBy: null,
                pausedAt: null,
            });
            log.info('Scheduler catch-up fired', { taskId: task.id });
        } catch (err) {
            log.error('Scheduler catch-up fire failed', err as Error, {
                taskId: task.id,
            });
        }
    }

    /**
     * Claim a fire slot only while dispatch is allowed. The upgrade gate is read
     * before claiming, and a claim won while the gate closed is handed back, so
     * a suspension never burns a bucket the next tick after resume must fire.
     * Callers must not await between a `true` result and startRun.
     */
    private async claimForDispatch(key: string, ttlMs: number): Promise<boolean> {
        if (this.upgradeSuspended) return false;
        const claimed = await this.tryClaim(key, ttlMs);
        if (!claimed) return false;
        if (!this.upgradeSuspended) return true;
        await this.releaseClaim(key);
        return false;
    }

    /** Compare-and-delete: never removes a claim another replica holds. */
    private async releaseClaim(key: string): Promise<void> {
        try {
            const client = await this.getClient();
            await client.customCommand([
                'EVAL',
                "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
                '1',
                key,
                config.INSTANCE_ID,
            ]);
        } catch (err) {
            // The claim's TTL still expires it; the cycle is only delayed.
            log.warn('Scheduler claim release failed', {
                key,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async tryClaim(key: string, ttlMs: number): Promise<boolean> {
        try {
            const client = await this.getClient();
            const result = await client.customCommand([
                'SET',
                key,
                config.INSTANCE_ID,
                'NX',
                'PX',
                String(Math.round(ttlMs)),
            ]);
            return result === 'OK';
        } catch (err) {
            log.warn('Scheduler claim failed', {
                key,
                err: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }
}
