// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stage Coverage Sweeper — Phase 2 of pipeline coverage.
 *
 * Leader-only periodic task (every 60s) that drains the
 * `media_item_stage_state` backlog by enqueuing per-item runs of each
 * registered task for stages that opt in via `coversStages[].enqueueable`.
 *
 * One indexed range scan per stage replaces the ~12 hand-rolled backlog
 * predicates the legacy task suite used to keep work moving. The orchestrator's
 * identity dedup (SETNX) handles parallel paths firing for the same item —
 * eager enqueue from lifecycle events (Phase 2.2) and this sweeper can both
 * fire safely without producing duplicate runs.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { parseDurationMs } from '../../duration.js';
import {
    shouldSkipGlobalEnqueue,
    fingerprintCandidates,
    type BackoffDecision,
} from '../../global-enqueue-backoff.js';
import type { MediaItemSnapshot } from '$lib/types/pipeline.js';
import { registry } from '../../registry.js';
import { orchestrator } from '../../orchestrator.js';
import { classifyInfraError } from '../../infra-retry.js';
import {
    findSweepCandidates,
    hasSweepCandidatesForStages,
    findItemsMissingCoverage,
    findItemsMissingStageRow,
    countSweepBacklog,
    reEnrollMisSkippedStage,
    findSkippedPermanentByReasons,
    markPendingByIds,
} from '$lib/server/database/queries/stage-sweep.queries.js';
import {
    StageStateService,
    GLOBAL_IDENTITY_SENTINEL_UUID,
} from '$lib/server/services/stage-state.service.js';
import {
    runStageDisposition,
    reEnrollReopenedGates,
    ELIGIBILITY_SKIP_REASON,
    type LoadEligibilityCandidates,
} from '../../stage-disposition-runner.js';
import { stageSweepBacklog } from '../../metrics.js';
import {
    QUEUE_DEPTH_SKIP_THRESHOLD,
    classesOverDepthThreshold,
} from '../../queue-depth-throttle.js';
import { beatAlive, writeHeartbeat } from '../../observability/heartbeat.js';
import { appendAuditEvent } from '../../observability/audit-log.js';

/** Per-tick cap per stage — limits DB load and BullMQ flood per sweep. */
const PER_STAGE_LIMIT = 100;

/**
 * Per-tick cap for the self-heal phase. Bounded so the sweep tick stays
 * fast even with a large backlog of items missing coverage; the next tick
 * picks up where this one left off (chronological order is preserved by
 * `created_at ASC`).
 */
const SELF_HEAL_LIMIT = 50;

/**
 * Per-tick cap for the PER-STAGE coverage backfill, and the order it walks.
 *
 * 🔴 Separate budget from SELF_HEAL_LIMIT because this backfill is expected to
 * have real work on any install that has ever gained a stage: on prod it found
 * ~11k items each missing `trickplay-generation`, `image-sync` and
 * `integrity-file-present`. Seeding them all at once would queue that many runs in a
 * single tick, so the rate is what keeps the repair from becoming the outage.
 *
 * 🔴 Sized against the REAL gap, which is ~358k (item, stage) pairs — an order
 * of magnitude more than the ~38k first measured, because that count only
 * covered the three stages that had been looked at. `provider-artwork-backdrop`
 * and `-poster` alone hold ~200k, ~95% of their expected population, never
 * seeded when their stage-seeding migration ran. At 25/tick that is ~10 days;
 * at 100 it is ~2.5. Seeding is a single INSERT per row — the downstream WORK
 * stays governed by the sweep's own PER_STAGE_LIMIT enqueue cap and the
 * resource-class budgets, so raising this front-loads row creation, not load.
 *
 * `PER_STAGE_HEAL_ORDER` is a strict priority, not a preference: the whole
 * per-tick budget goes to the first stage that still has a gap, and later
 * stages only start once the earlier ones are drained. Trickplay leads because
 * a missing sprite sheet is the one an operator sees directly (scrubbing a
 * video with no thumbnails), and because it is the most expensive to generate —
 * starting it first means it finishes soonest. Stages not named here are healed
 * after the listed ones, in registry order.
 */
const PER_STAGE_HEAL_LIMIT = 100;
const PER_STAGE_HEAL_ORDER = ['trickplay-generation', 'image-sync', 'integrity-file-present'];

/**
 * After a stage's per-stage backfill scan comes back EMPTY, skip that stage's
 * scan for this long. `findItemsMissingStageRow` is an anti-join over every
 * active media_items row (~117k on prod, ~340 ms, ~400k buffer hits) and ran
 * for every stage on every 60 s tick — ~3.4 s of DB time a minute, and
 * almost always zero rows (prod slow log, 2026-09-24: 280 calls in 45 min,
 * none found anything). A gap only opens when a stage is newly declared or an
 * item bypasses the lifecycle hook, so a 15-minute repair latency costs
 * nothing; a stage that still HAS a gap is re-scanned every tick as before.
 * In-process state: a leader change just re-scans once.
 */
const PER_STAGE_HEAL_QUIET_MS = 15 * 60_000;
/**
 * Quiet windows that grow while a scan keeps coming back clean: 15 min after
 * the first empty result, then 30, then 60 (the cap). Prod's slow log
 * (2026-10-29/30, 30 h) still held ~2,400 `findItemsMissingStageRow` calls
 * (212 s) and ~1,600 eligibility heals (428 s) with the flat 15-minute
 * window, every one of them a safety net that found nothing. The first
 * re-check still happens after 15 minutes, any hit (or a truncated page)
 * resets the window to the start, and a restart or leader change re-scans
 * at once because the state is in-process.
 */
const QUIET_BACKOFF_MS: readonly number[] = [
    PER_STAGE_HEAL_QUIET_MS,
    2 * PER_STAGE_HEAL_QUIET_MS,
    4 * PER_STAGE_HEAL_QUIET_MS,
];
class QuietBackoff {
    private readonly until = new Map<string, number>();
    private readonly clean = new Map<string, number>();
    isQuiet(id: string): boolean {
        return (this.until.get(id) ?? 0) > Date.now();
    }
    markClean(id: string): void {
        const n = this.clean.get(id) ?? 0;
        this.until.set(id, Date.now() + QUIET_BACKOFF_MS[Math.min(n, QUIET_BACKOFF_MS.length - 1)]);
        this.clean.set(id, n + 1);
    }
    reset(id: string): void {
        this.until.delete(id);
        this.clean.delete(id);
    }
    clear(): void {
        this.until.clear();
        this.clean.clear();
    }
}
const perStageHealQuiet = new QuietBackoff();
/**
 * Same quiet window for the eligibility heal (`reEnrollMisSkippedStage`): its
 * per-stage UPDATE joins skipped_permanent rows to media_items + files and cost
 * ~530 ms per stage per tick on prod (138 calls in 45 min) while re-enrolling
 * nothing in the preceding 6 h. It is a safety net for lost invalidation events,
 * so 15 minutes of extra latency on a rare miss is the right trade.
 */
/**
 * Stages whose eligibility heal is planned with hash joins (see
 * reEnrollMisSkippedStage). Measured on prod 2026-09-29: 30-50% faster for
 * these cheap per-row fragments, while fragments with correlated EXISTS walks
 * (e.g. mal-anime-id-enrichment, ~25 ms -> ~1.5 s) get much slower. The hint
 * changes the plan only, never which rows are re-enrolled.
 */
const HEAL_HASH_JOIN_STAGES: ReadonlySet<string> = new Set([
    'media-probe-a',
    'media-probe-b',
    'trickplay-generation',
    'trickplay-params-sync',
    'provider-artwork-poster',
    'provider-artwork-backdrop',
]);

/**
 * Stages whose eligibility heal evaluates the fragment as a join filter (see
 * reEnrollMisSkippedStage `lateFilter`). Measured on prod 2026-10-13, inner
 * SELECT, best of 3: acoustid-fingerprint 'recording-mbid-from-tags' gate
 * 401 -> 166 ms, its main heal 544 -> 446 ms (1.5 s in the prod log, where the
 * default plan drives from all 147k tracks), lumastra-intro-analyzer:visual
 * 253 -> 157 ms. Worse for music-analysis, sonic-embedding-backfill and
 * provider-artwork-season-poster, so it stays opt-in. Never changes which rows
 * are re-enrolled. Not combined with HEAL_HASH_JOIN_STAGES (slower together).
 */
const HEAL_LATE_FILTER_STAGES: ReadonlySet<string> = new Set([
    'acoustid-fingerprint',
    'lumastra-intro-analyzer:visual',
]);

// The two plan shapes are measured slower together; a stage gets one or neither.
for (const id of HEAL_LATE_FILTER_STAGES) {
    if (HEAL_HASH_JOIN_STAGES.has(id)) {
        throw new Error(
            `stage-sweep: ${id} is in both HEAL_HASH_JOIN_STAGES and HEAL_LATE_FILTER_STAGES`,
        );
    }
}

const eligibilityHealQuiet = new QuietBackoff();
/**
 * Same quiet window for the whole-catalog self-heal (`findItemsMissingCoverage`,
 * "items with NO stage row at all"). It is the same anti-join shape — ~112k
 * active rows walked and probed, ~420 ms, ~390k buffer hits — and prod's slow
 * log (2026-09-26) showed it 366 times in 3.6 h, every one returning zero rows:
 * every item is seeded by the lifecycle hook. Keyed on the covered media-type
 * set, so a newly covered type (a stage registered after startup) is scanned
 * on the next tick rather than after the window.
 */
let selfHealQuiet: { key: string; until: number } = { key: '', until: 0 };

/** Test hook: forget which stages last scanned clean. */
export function resetPerStageHealQuiet(): void {
    perStageHealQuiet.clear();
    eligibilityHealQuiet.clear();
    selfHealQuiet = { key: '', until: 0 };
}

/**
 * Per-worker rotating offset (D1 fairness): each sweep tick starts the
 * enqueue loop at a different task so the per-tick enqueue budget isn't always
 * spent on the same head-of-registry stages, starving the tail for the whole
 * ingest window. In-process counter — resets on restart, which is fine (the
 * point is rotation across consecutive ticks, not durable state).
 */
let sweepStartOffset = 0;

/**
 * Hard cap on total enqueues per tick across ALL stages. Defensive backstop:
 * even if every stage is healthy and every resource class is well under its
 * cap, one tick should not push more than this many fresh jobs into BullMQ.
 * Prevents a stage-state bulk-insert migration from immediately translating
 * to a 100k+ BullMQ enqueue storm in a single 60s window — the next tick
 * picks up the rest. Tuned against the preprod incident where a migration
 * burst-enqueued ~135k jobs and OOM'd Valkey.
 */
export const MAX_ENQUEUES_PER_TICK = 500;

/**
 * Stages that decide whether a fresh install looks alive.
 *
 * On a cold library every stage is eligible at once, so artwork competes for
 * the same 500-enqueue budget as trickplay previews, embeddings and intro
 * analysis — work that is individually far slower and vastly more numerous
 * (one preview job per FILE). The observable result is a library of grey
 * placeholder cards for the first hour while the budget goes to work nobody
 * can see yet.
 *
 * Deliberately NOT implemented as a priority sort. The rotation below
 * (`sweepStartOffset`, D1) exists because a fixed order starved the tail for
 * the whole ingest window, and sorting these to the front would reintroduce
 * exactly that. This is a RESERVATION instead: everything else may spend down
 * to `MAX_ENQUEUES_PER_TICK - FIRST_IMPRESSION_RESERVE`, leaving the remainder
 * spendable only by these stages. Nothing is starved — the tail still gets
 * 350/tick and its rotation turn — but artwork can never be crowded out
 * entirely by a preview backlog.
 *
 * `image-sync` covers the Jellyfin-sourced path, `provider-artwork-*` the
 * TMDB-sourced one; both land the same visible poster.
 */
export const FIRST_IMPRESSION_STAGES: ReadonlySet<string> = new Set([
    'image-sync',
    'provider-artwork-poster',
    'provider-artwork-backdrop',
    'provider-artwork-season-poster',
]);

/** Slice of the per-tick budget only {@link FIRST_IMPRESSION_STAGES} may spend. */
export const FIRST_IMPRESSION_RESERVE = 150;

/**
 * How many enqueues this stage may spend in the current tick.
 *
 * Exported so the test exercises THIS function rather than re-deriving the
 * arithmetic — a mirrored copy in a test cannot fail when the real rule
 * changes, which is how the operatorActionable cap in health-invariants
 * shipped with no test that it did anything.
 *
 * `reserveActive` is a parameter, not a constant: the reserve applies only
 * while a first-impression stage actually has work. Budget reserved for
 * stages with nothing to do is not redistributed — it is burned.
 */
export function stageEnqueueCap(stageId: string, reserveActive: boolean): number {
    const reserved =
        reserveActive && !FIRST_IMPRESSION_STAGES.has(stageId) ? FIRST_IMPRESSION_RESERVE : 0;
    return MAX_ENQUEUES_PER_TICK - reserved;
}

// Queue-depth skip thresholds + the over-threshold derivation now live in the
// shared `queue-depth-throttle.ts` module so the eager-enqueue fast path
// (StageStateService.eagerEnqueueForStages) backs off on the SAME thresholds —
// the two can't drift. Imported at the top of this file.

/**
 * Hard wall-clock budget for ONE sweep run. Derived from this task's own
 * `schedule.every` (60s) as `floor(every_ms * 0.65)`, so the invariant
 * budget < schedule.every is enforced in code, not by a hand-tuned constant.
 *
 * At 60s schedule: floor(60_000 * 0.65) = 39_000 ms (~39 s). Bounding the
 * run to less than the schedule interval means at most one run is active at a
 * time; the backlog still drains because task rotation covers remaining stages
 * on the next tick.
 */
// Single source for the sweep interval — used BOTH for the schedule.every below
// and to derive the wall-clock budget, so the `budget < schedule.every` invariant
// can't drift (changing the interval changes the budget in lockstep).
const STAGE_SWEEP_SCHEDULE_EVERY = '60s';
const STAGE_SWEEP_SCHEDULE_EVERY_MS = parseDurationMs(STAGE_SWEEP_SCHEDULE_EVERY) ?? 60_000;
const STAGE_SWEEP_WALLCLOCK_BUDGET_MS = Math.floor(STAGE_SWEEP_SCHEDULE_EVERY_MS * 0.65);

/** Warn when a single stage tick takes longer than this (ms). */
const TICK_WARN_MS = 500;

const inputSchema = z.object({}).passthrough();

type StageSweepInput = z.infer<typeof inputSchema>;

interface StageSweepResult {
    stagesScanned: number;
    candidatesFound: number;
    enqueued: number;
    deduped: number;
    failed: number;
    failedCount: number;
    /** Items found with zero coverage rows (self-heal candidates this tick). */
    selfHealFound: number;
    /** Items the self-heal phase successfully seeded coverage for this tick. */
    selfHealSeeded: number;
    /** File-backed items re-enrolled into library-embeddings after a wrong skipped_permanent. */
    selfHealReEnrolled: number;
    /** Rows seeded by the per-stage coverage backfill this tick. */
    stageHealSeeded: number;
    /** Which stage the per-stage backfill worked on this tick, if any. */
    stageHealStage: string | null;
    /** Stages skipped because their resource class was past the backpressure threshold. */
    stagesSkippedBackpressure: number;
    /**
     * Stages held back so first-impression (artwork) stages keep a slice of the
     * tick. Only ever non-zero while those stages actually have work — the
     * reserve is use-it-or-lose-it.
     */
    stagesSkippedReserve: number;
    /** Global-identity stages skipped because the previous run drained nothing. */
    stagesSkippedBackoff: number;
    /** True when this tick stopped enqueueing because it hit MAX_ENQUEUES_PER_TICK. */
    hitGlobalEnqueueCap: boolean;
    /** True when this tick stopped early on the wall-clock budget (resumes next tick). */
    hitWallclockBudget: boolean;
    message: string;
}

/** A child task's open circuit rejects admission before it creates a run. */
function isChildCircuitRejection(error: unknown, taskId: string): boolean {
    return (
        error instanceof TaskError &&
        error.message.startsWith(`Circuit breaker is `) &&
        error.message.includes(` for task ${taskId}:`)
    );
}

export const stageSweepTask = defineTask<StageSweepInput, StageSweepResult>({
    id: 'stage-sweep',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Stage Coverage Sweeper',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',

    capabilities: { database: true },

    schedule: {
        every: STAGE_SWEEP_SCHEDULE_EVERY,
        // runOnStartup: true ensures the first tick (and its start beatAlive) fires
        // within seconds of boot, so the health surface never shows alive:false for
        // up to 60 s on every restart.
        runOnStartup: true,
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema,

    timeout: { hard: '5m', soft: '4m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { logger, sql, signal, softSignal } = ctx;

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted',
                result: {
                    stagesScanned: 0,
                    candidatesFound: 0,
                    enqueued: 0,
                    deduped: 0,
                    failed: 0,
                    failedCount: 0,
                    selfHealFound: 0,
                    selfHealSeeded: 0,
                    selfHealReEnrolled: 0,
                    stageHealSeeded: 0,
                    stageHealStage: null,
                    stagesSkippedBackpressure: 0,
                    stagesSkippedReserve: 0,
                    stagesSkippedBackoff: 0,
                    hitGlobalEnqueueCap: false,
                    hitWallclockBudget: false,
                    message: 'Aborted before start',
                },
            };
        }

        // OSS-readiness: prove liveness at the START of the sweep, not only on
        // completion (the rich end-of-run heartbeat below still carries the
        // SweepResult). On a large library a full pass can be slow or hit the
        // hard timeout; without an early beat the health surface shows a
        // false-CRITICAL "stage-sweep has no heartbeat" while the sweep is in
        // fact running. A slow-but-working sweep must not read as dead.
        await beatAlive('stage-sweep');

        let stagesScanned = 0;
        let candidatesFound = 0;
        let enqueued = 0;
        let deduped = 0;
        let failed = 0;
        let childCircuitRejections = 0;
        let selfHealFound = 0;
        let selfHealSeeded = 0;
        let stageHealSeeded = 0;
        let stageHealStage: string | null = null;
        let selfHealReEnrolled = 0;
        let stagesSkippedBackpressure = 0;
        let stagesSkippedBackoff = 0;
        // Global-identity tasks already enqueued this tick (one run covers all their stages).
        const globalTasksEnqueuedThisTick = new Set<string>();
        let hitGlobalEnqueueCap = false;
        let hitWallclockBudget = false;
        // Bound the whole run under the identity-dedup TTL (see
        // STAGE_SWEEP_WALLCLOCK_BUDGET_MS) so concurrent sweeps can't pile up.
        const sweepDeadline = Date.now() + STAGE_SWEEP_WALLCLOCK_BUDGET_MS;

        // Shared budget guard for the self-heal + eligibility-heal phases
        // below (both ran on ONLY `signal.aborted` before this fix, ignoring
        // `softSignal` and `sweepDeadline` — on a large library either phase
        // could blow past the soft timeout straight into the 5-minute hard
        // kill the wall-clock budget exists to avoid). Mirrors the main
        // rotation loop's bookkeeping (`hitWallclockBudget`) so a bail here
        // reads the same way in the tick's result/health surface as a bail in
        // the main loop.
        const healBudgetExceeded = (): boolean => {
            if (signal.aborted || softSignal?.aborted) return true;
            if (Date.now() > sweepDeadline) {
                hitWallclockBudget = true;
                return true;
            }
            return false;
        };

        const tasks = registry.getAllTasks();

        // Snapshot queue depths up-front so per-stage skip decisions all use a
        // consistent view. Refreshing per-stage would let stage A's enqueues
        // bias the depth seen by stage B mid-tick. Empty map (e.g. when the
        // orchestrator isn't initialized in this process yet) means
        // "no backpressure info, proceed normally".
        let queueDepths: Awaited<ReturnType<typeof orchestrator.getQueueDepths>> = {} as Awaited<
            ReturnType<typeof orchestrator.getQueueDepths>
        >;
        try {
            queueDepths = await orchestrator.getQueueDepths();
        } catch (err) {
            // WARN, not DEBUG: this tick is running unthrottled and the
            // post-migration cascade that motivated the throttle would
            // happily refill Valkey if it fired during such a window.
            // Operators correlating a fresh OOM with the throttle should
            // see this in their normal log search.
            logger.warn(
                'stage-sweep: queue depth snapshot unavailable; proceeding WITHOUT throttle',
                {
                    error: err instanceof Error ? err.message : String(err),
                },
            );
        }
        // Same elevation when the orchestrator returned no class entries
        // (e.g. cold-start before workers attached). Without this, a
        // worker-only or web-only replica running stage-sweep skips the
        // throttle silently.
        if (Object.keys(queueDepths).length === 0) {
            logger.warn(
                'stage-sweep: no per-class queue depths available; proceeding WITHOUT throttle this tick',
            );
        }
        const overThresholdClasses = classesOverDepthThreshold(queueDepths);
        for (const cls of overThresholdClasses) {
            const counts = queueDepths[cls as keyof typeof queueDepths];
            logger.warn('stage-sweep: backpressure — skipping resource class this tick', {
                cls,
                depth: (counts?.waiting ?? 0) + (counts?.delayed ?? 0),
                threshold: QUEUE_DEPTH_SKIP_THRESHOLD[cls],
            });
        }

        // -----------------------------------------------------------------
        // SELF-HEAL PHASE — items that should have coverage rows but don't.
        //
        // Compensates for code paths that create media_items without firing
        // MediaLifecycleService.afterCreated (TMDB discovery sync, Jellyfin
        // watch-sync upserts, search-result auto-import, etc.). Migration
        // 16.7.0 reseeded historical rows; this phase is the ongoing
        // ratchet so newly-orphaned items get coverage within one minute.
        //
        // Bounded to SELF_HEAL_LIMIT per tick — at 158k items the
        // `media_items.media_type = ANY(...) + NOT EXISTS (idx_stage_state_item)`
        // plan keeps the find query cheap; the seed step is the dominant
        // cost (one transaction per item creates ~15 stage rows).
        // -----------------------------------------------------------------
        if (!healBudgetExceeded()) {
            const coveredTypes = new Set<string>();
            for (const t of tasks) {
                const stages = t.coversStages;
                if (!stages) continue;
                for (const stage of stages) {
                    for (const mt of stage.appliesTo) {
                        // Stage declarations use canonical 'series'; the DB
                        // media_items.media_type column stores legacy 'tv'.
                        // Mirror the translation done in
                        // StageStateService.loadItemSnapshot.
                        coveredTypes.add(mt === 'series' ? 'tv' : mt);
                    }
                }
            }

            const coveredKey = Array.from(coveredTypes).sort().join(',');
            const selfHealResting =
                selfHealQuiet.key === coveredKey && selfHealQuiet.until > Date.now();
            if (coveredTypes.size > 0 && !selfHealResting) {
                try {
                    const missing = await findItemsMissingCoverage(
                        sql,
                        Array.from(coveredTypes),
                        SELF_HEAL_LIMIT,
                    );
                    selfHealFound = missing.length;
                    selfHealQuiet =
                        missing.length === 0
                            ? { key: coveredKey, until: Date.now() + PER_STAGE_HEAL_QUIET_MS }
                            : { key: '', until: 0 };

                    if (missing.length > 0 && !healBudgetExceeded()) {
                        const stageService = new StageStateService(sql, registry);
                        // Seed every missing item's coverage rows in ONE
                        // transaction instead of opening a fresh tx per item.
                        // SELF_HEAL_LIMIT (50) bounds the batch, so the whole
                        // tick holds one task-pool connection for the INSERTs.
                        try {
                            selfHealSeeded = await stageService.seedRowsForBatch(
                                missing.map((item) => item.id),
                            );
                        } catch (err) {
                            logger.warn('stage-sweep: self-heal seedRowsForBatch failed', {
                                found: selfHealFound,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                        logger.info('stage-sweep self-heal', {
                            found: selfHealFound,
                            seeded: selfHealSeeded,
                        });
                    }
                } catch (err) {
                    logger.warn('stage-sweep: self-heal query failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            // -----------------------------------------------------------------
            // PER-STAGE coverage backfill.
            //
            // 🔴 The gap the self-heal above cannot see. It asks "does this item
            // have ANY stage row" — the right question only for an item the
            // lifecycle hook missed entirely. An item holding rows for fifteen
            // stages and missing the sixteenth satisfies that NOT EXISTS and is
            // skipped forever.
            //
            // That shape is the common one, because seeding writes rows for
            // whatever the registry held AT THAT MOMENT: any stage whose
            // coverage was declared after an item was seeded is absent for it
            // permanently. On prod, ~10,900 items seeded during a four-day
            // window in June 2026 carried media-probe/params-sync/intro-analyzer
            // rows but none for trickplay, image-sync or integrity — 11,186
            // items with no trickplay coverage while the sweep reported a clean
            // backlog the entire time. An item with no row is not "pending", it
            // is invisible, so nothing anywhere raised a hand.
            // -----------------------------------------------------------------
            if (!healBudgetExceeded()) {
                // 🔴 NOT filtered on `enqueueable`. A non-enqueueable stage
                // still needs its row — `integrity-file-present` is explicitly
                // non-enqueueable and is seeded `skipped_permanent` for admin
                // visibility, so a missing row is just as invisible there as
                // anywhere else. Filtering it out would have left 11,238 prod
                // items uncovered while the stage sat third in the priority
                // list, reading as though it were handled.
                const healable = tasks.flatMap((t) =>
                    (t.coversStages ?? []).map((stage) => ({ stage, taskId: t.id })),
                );
                const rank = (id: string): number => {
                    const i = PER_STAGE_HEAL_ORDER.indexOf(id);
                    return i === -1 ? PER_STAGE_HEAL_ORDER.length : i;
                };
                healable.sort((a, b) => rank(a.stage.id) - rank(b.stage.id));

                for (const { stage } of healable) {
                    if (healBudgetExceeded()) break;
                    if (perStageHealQuiet.isQuiet(stage.id)) continue;
                    try {
                        const missing = await findItemsMissingStageRow(
                            sql,
                            stage.id,
                            // 🔴 Declarations say 'series'; media_items.media_type
                            // stores legacy 'tv'. Passing appliesTo raw makes the
                            // query match nothing for series-scoped stages, so
                            // they never heal and never complain. Same
                            // translation the self-heal above does.
                            stage.appliesTo.map((t) => (t === 'series' ? 'tv' : t)),
                            PER_STAGE_HEAL_LIMIT,
                        );
                        if (missing.length === 0) {
                            perStageHealQuiet.markClean(stage.id);
                            continue;
                        }
                        perStageHealQuiet.reset(stage.id);
                        const stageService = new StageStateService(sql, registry);
                        const seeded = await stageService.seedStageRowForBatch(
                            stage.id,
                            missing.map((m) => m.id),
                            // This phase SEEDS for visibility; it does not
                            // dispatch. The main sweep loop below runs in this
                            // same tick and already queries pending rows for
                            // enqueueable stages, so it picks these up exactly
                            // once. Leaving the seed-time eager enqueue on made
                            // it twice — the eager call and the sweep both fired
                            // the same (stage, item) with the same idempotency
                            // key.
                            { eagerEnqueue: false },
                        );
                        // 🔴 No progress ⇒ do NOT hold the tick. The query has no
                        // offset, so a page that seeds nothing is re-selected
                        // identically next tick; breaking here would retry the
                        // same 25 items forever and starve every lower-priority
                        // stage. Fall through instead, and say so.
                        if (seeded === 0) {
                            logger.warn('stage-sweep: per-stage backfill made no progress', {
                                stage_id: stage.id,
                                found: missing.length,
                            });
                            continue;
                        }
                        stageHealSeeded = seeded;
                        stageHealStage = stage.id;
                        logger.info('stage-sweep per-stage coverage backfill', {
                            stage_id: stage.id,
                            found: missing.length,
                            seeded,
                        });
                        // Strict priority: spend the whole tick on the
                        // highest-ranked stage that still has a gap.
                        break;
                    } catch (err) {
                        logger.warn('stage-sweep: per-stage backfill failed', {
                            stage_id: stage.id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }

            // Event-INDEPENDENT eligibility heal: for every enqueueable stage that
            // declares an `eligibility` block, flip rows wrongly stuck
            // `skipped_permanent/'ineligible'` back to `pending` wherever the
            // stage's eligibility is now TRUE — e.g. media-probe wrote streams
            // after a pre-probe seed, via a path whose invalidation event was lost
            // (dispatcher lag / leaderless window) or never emitted. Native stages
            // (`eligibility.sql`) heal via one bulk UPDATE; external plugins
            // (`eligibility.appliesTo` only) re-evaluate the TS predicate per row
            // over a bounded page. Only matches recoverable rows, so each call is a
            // no-op once drained; bounded per stage by its healLimit (default
            // SELF_HEAL_LIMIT). A failing stage heal never aborts the others.
            let healStageService: StageStateService | null = null;
            for (const task of tasks) {
                if (healBudgetExceeded()) break;
                const stages = task.coversStages;
                if (!stages) continue;
                let bailedOnBudget = false;
                for (const stage of stages) {
                    if (healBudgetExceeded()) {
                        bailedOnBudget = true;
                        break;
                    }
                    const elig = stage.eligibility;
                    // Skip stages with no eligibility block, and — importantly —
                    // non-enqueueable stages: flipping their rows to `pending`
                    // would strand them, since the sweep only enqueues enqueueable
                    // stages.
                    if (!elig || stage.enqueueable !== true) continue;
                    if (!elig.sql && !elig.appliesTo) continue;
                    if (eligibilityHealQuiet.isQuiet(stage.id)) continue;
                    // Reasons the heal reclaims: this stage's own skip reason
                    // (default 'ineligible') plus any migration-window legacy
                    // reasons. healLimit 0/negative would disable or error the
                    // LIMIT — clamp to SELF_HEAL_LIMIT.
                    const reasons = [
                        elig.skipReason ?? ELIGIBILITY_SKIP_REASON,
                        ...(elig.recoverWhenAdditionalReasons ?? []),
                    ];
                    const limit =
                        typeof stage.healLimit === 'number' && stage.healLimit > 0
                            ? stage.healLimit
                            : SELF_HEAL_LIMIT;
                    try {
                        let reEnrolled = 0;
                        // A page cut short by the tick budget proves nothing about
                        // the rest of it, so it must not start the quiet window.
                        let healTruncated = false;
                        if (elig.sql) {
                            // Native bulk heal — one UPDATE over the positive fragment.
                            reEnrolled = await reEnrollMisSkippedStage(sql, {
                                stageId: stage.id,
                                eligibleWhere: elig.sql(sql),
                                reasons,
                                limit,
                                hashJoin: HEAL_HASH_JOIN_STAGES.has(stage.id),
                                lateFilter: HEAL_LATE_FILTER_STAGES.has(stage.id),
                            });
                            // Gate re-label: a row skipped by a gate that has since
                            // opened, while ANOTHER gate keeps it ineligible, goes back
                            // to `pending` and is re-stamped at once with the reason
                            // that is true now. See reEnrollReopenedGates.
                            reEnrolled += await reEnrollReopenedGates(
                                sql,
                                stage,
                                limit,
                                { sql, logger },
                                {
                                    hashJoin: HEAL_HASH_JOIN_STAGES.has(stage.id),
                                    lateFilter: HEAL_LATE_FILTER_STAGES.has(stage.id),
                                },
                            );
                        } else if (elig.appliesTo) {
                            // External per-row heal — re-evaluate the TS predicate over
                            // a bounded skipped_permanent page; flip the now-true ones.
                            healStageService ??= new StageStateService(sql, registry);
                            const candidates = await findSkippedPermanentByReasons(
                                sql,
                                stage.id,
                                reasons,
                                limit,
                            );
                            const nowEligible: string[] = [];
                            for (const c of candidates) {
                                // Same budget the outer loops honor — an external
                                // eligibility predicate can page through a large
                                // `healLimit`, each row costing a DB round-trip.
                                if (healBudgetExceeded()) {
                                    healTruncated = true;
                                    break;
                                }
                                const snap = await healStageService.loadItemSnapshot(
                                    c.media_item_id,
                                );
                                if (!snap) continue;
                                try {
                                    if (elig.appliesTo(snap)) nowEligible.push(c.media_item_id);
                                } catch {
                                    // A throwing external predicate must not flip the row.
                                }
                            }
                            reEnrolled = await markPendingByIds(sql, stage.id, nowEligible);
                        }
                        if (reEnrolled === 0 && !healTruncated) {
                            eligibilityHealQuiet.markClean(stage.id);
                        } else {
                            eligibilityHealQuiet.reset(stage.id);
                        }
                        if (reEnrolled > 0) {
                            selfHealReEnrolled += reEnrolled;
                            logger.info('stage-sweep: re-enrolled mis-skipped rows', {
                                stage: stage.id,
                                reEnrolled,
                            });
                        }
                    } catch (err) {
                        logger.warn('stage-sweep: eligibility heal failed', {
                            stage: stage.id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
                if (bailedOnBudget) break;
            }
        }

        // Rotate the starting task per tick (D1 fairness) — see sweepStartOffset.
        const rotatedTasks =
            tasks.length > 0
                ? (() => {
                      const off = sweepStartOffset % tasks.length;
                      sweepStartOffset++;
                      return [...tasks.slice(off), ...tasks.slice(0, off)];
                  })()
                : tasks;
        // USE-IT-OR-LOSE-IT: reserving budget for stages with nothing to do does
        // not redistribute it, it BURNS it. Once artwork is backfilled and only
        // previews/embeddings remain, the four first-impression stages find no
        // candidates, every other stage stops at 350, and 150 of the 500-job
        // budget goes unspent on every tick forever — a permanent ~30% cut to
        // sweeper throughput, invisible because `enqueued` never reaches the cap
        // that logs it. One indexed existence probe per tick decides instead.
        let reserveActive: boolean;
        try {
            reserveActive = await hasSweepCandidatesForStages(sql, [...FIRST_IMPRESSION_STAGES]);
        } catch (err) {
            // Fail OPEN — a probe failure must not silently cap the sweeper.
            logger.warn('stage-sweep: first-impression probe failed; reserve disabled this tick', {
                error: err instanceof Error ? err.message : String(err),
            });
            reserveActive = false;
        }
        let stagesSkippedReserve = 0;

        // Lazily created only if an external (appliesTo-only) eligibility stage is
        // encountered in the dispose pass — native stages dispose via bulk SQL and
        // never need a snapshot loader.
        let disposeStageService: StageStateService | null = null;
        // Periodic mid-run heartbeat: the heartbeat TTL (≈3 min for a 60s interval)
        // is shorter than the 5-min hard timeout, so on a large install the key can
        // expire mid-sweep → false-CRITICAL. Refresh every ~60 s of wall-clock time.
        let lastMidBeatAt = Date.now();
        for (const task of rotatedTasks) {
            // Refresh the liveness key mid-loop so a long-running sweep on a big
            // library doesn't let the TTL lapse before writeHeartbeat fires at the end.
            const nowMs = Date.now();
            if (nowMs - lastMidBeatAt >= 60_000) {
                lastMidBeatAt = nowMs;
                void beatAlive('stage-sweep'); // best-effort, swallows errors
            }
            // OSS-readiness: bail GRACEFULLY at the soft timeout (4m) rather than
            // running into the 5m hard timeout. On a large library the per-tick
            // sweep over tens of thousands of sweepable rows can exceed 5m; a
            // hard-timeout writes a 'Handler runtime exceeded' failure that the
            // health surface counts as an actionable CRITICAL — even though the
            // sweep is bounded + resumable (the next tick continues where this
            // left off via task rotation). softSignal fires at `timeout.soft`
            // so we return the partial result as success instead.
            if (signal.aborted || softSignal?.aborted) break;
            // PRIMARY bound: stop well before the soft/hard timeout so the run
            // finishes inside the 60s identity-dedup TTL and a second sweep can't
            // spawn on top of it (the maintenance-class pile-up root cause). The
            // next tick resumes the remaining stages via rotation (`nowMs` was
            // sampled at the top of this iteration).
            if (nowMs > sweepDeadline) {
                hitWallclockBudget = true;
                break;
            }
            const stages = task.coversStages;
            if (!stages || stages.length === 0) continue;

            // Backpressure (H1 fix): if this task's resource class is past its skip
            // threshold, skip ENQUEUEING its stages this tick — but STILL run their
            // dispositions (author terminalDisposition + eligibility dispose), which
            // are pure DB drains (no enqueue). The old code `continue`d past the whole
            // stage list here, which ALSO skipped the dispositions — so an unconfigured
            // integration's `global-guard` / an ineligible row would never drain while
            // its class was backpressured, feeding the very queue depth that kept the
            // class over threshold (a self-sustaining backpressure loop). Now it is a
            // flag, mirroring the MAX_ENQUEUES_PER_TICK design below.
            const taskClass = task.resourceClass ?? 'io';
            const classOverThreshold = overThresholdClasses.has(taskClass);

            for (const stage of stages) {
                if (signal.aborted) break;
                // Refresh liveness inside the INNER loop too: a single task with
                // many stages (or one slow stage) can run >60s between outer-loop
                // iterations, which would otherwise lapse the heartbeat TTL
                // mid-iteration (review fix).
                if (Date.now() - lastMidBeatAt >= 60_000) {
                    lastMidBeatAt = Date.now();
                    void beatAlive('stage-sweep');
                }
                // Declarative Stage Contract — single pre-enqueue pass: run the
                // stage's declared `terminalDisposition` variants (author pass)
                // followed by the eligibility dispose pass, both in one call to
                // `runStageDisposition`. Dispositions are pure DB drains (no
                // enqueue), so they must keep running for the whole stage list
                // every tick even once the enqueue budget is spent — otherwise the
                // fixed registry order starves the tail stages' dispositions for
                // the entire ingest window (D1). Guarded so a disposition failure
                // never aborts the sweep. Author variants fire BEFORE the
                // eligibility pass (order invariant enforced inside the runner).
                if (
                    stage.terminalDisposition !== undefined ||
                    (stage.eligibility !== undefined && stage.eligibility.skipAutoDispose !== true)
                ) {
                    try {
                        const loadCandidates: LoadEligibilityCandidates = async (stageId, lim) => {
                            disposeStageService ??= new StageStateService(sql, registry);
                            const cands = await findSweepCandidates(sql, stageId, lim);
                            const out: { mediaItemId: string; snapshot: MediaItemSnapshot }[] = [];
                            for (const c of cands) {
                                const snap = await disposeStageService.loadItemSnapshot(
                                    c.media_item_id,
                                );
                                if (snap)
                                    out.push({ mediaItemId: c.media_item_id, snapshot: snap });
                            }
                            return out;
                        };
                        const rowsDisposed = await runStageDisposition(
                            sql,
                            stage,
                            { sql, logger },
                            { loadCandidates, limit: PER_STAGE_LIMIT },
                        );
                        if (rowsDisposed > 0) {
                            logger.info('stage-sweep: disposition drained rows', {
                                stage_id: stage.id,
                                rows_disposed: rowsDisposed,
                            });
                        }
                    } catch (err) {
                        logger.warn('stage-sweep: disposition failed', {
                            stageId: stage.id,
                            taskId: task.id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                // Scheduled scanners also need eligibility disposal, but their work
                // stays owned by their own schedule rather than per-item enqueue.
                if (stage.enqueueable !== true) continue;

                // Backpressure (H1): dispositions above have run; now skip the ENQUEUE
                // for this stage if its class is over the queue-depth threshold. (Per
                // stage, not per task, so the dispositions kept draining above.)
                if (classOverThreshold) {
                    stagesSkippedBackpressure++;
                    continue;
                }

                // Enqueue budget (D1): once the per-tick global cap is hit, stop
                // ENQUEUEING for the rest of the tick — but keep running the
                // dispositions above (a flag, not a `break`, so the tail isn't
                // starved). After a bulk-insert migration this is what keeps a
                // single 60s window from burst-enqueueing 100k+ jobs.
                // Everything that is not a first-impression stage stops at the
                // reserved boundary, so artwork keeps a slice of every tick even
                // while a preview/embedding backlog is spending the rest. The
                // hard cap is unchanged for both — this only ever LOWERS what
                // the non-reserved majority may spend, never raises the total.
                const stageCap = stageEnqueueCap(stage.id, reserveActive);
                if (enqueued >= stageCap) {
                    if (stageCap < MAX_ENQUEUES_PER_TICK && enqueued < MAX_ENQUEUES_PER_TICK) {
                        // Held back FOR artwork, not out of budget. Counted so
                        // the difference is visible in the run result rather
                        // than looking like an idle tick.
                        stagesSkippedReserve++;
                    } else if (!hitGlobalEnqueueCap) {
                        hitGlobalEnqueueCap = true;
                        logger.warn(
                            'stage-sweep: global enqueue cap hit — dispositions still run, enqueue deferred to next tick',
                            { cap: MAX_ENQUEUES_PER_TICK, enqueuedSoFar: enqueued },
                        );
                    }
                    continue;
                }

                stagesScanned++;
                const tickStart = Date.now();

                let candidates: Awaited<ReturnType<typeof findSweepCandidates>>;
                try {
                    candidates = await findSweepCandidates(sql, stage.id, PER_STAGE_LIMIT);
                } catch (err) {
                    failed++;
                    logger.warn('stage-sweep: query failed', {
                        stageId: stage.id,
                        taskId: task.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                let stageEnqueued = 0;
                // A property, not a local: no-useless-assignment misreads `++` before `continue`.
                const stageCounts = { deduped: 0 };

                candidatesFound += candidates.length;

                // Detect global-identity tasks: identityFor returns a constant
                // regardless of input. For those, the sweeper should enqueue
                // ONCE per tick (any candidate suffices) — otherwise each
                // candidate enqueues its own run that re-drains the whole
                // backlog, amplifying work N× (e.g. 100 candidates → 100
                // full-library embedding runs).
                //
                // M4 fix: detect via a SENTINEL-UUID comparison instead of
                // comparing two real candidates, so the SINGLE-candidate case is
                // covered too. With exactly one backlogged item, the old
                // `>= 2` guard fell through to the per-item path and enqueued
                // `coverage:${stage.id}:${mediaItemId}` while eagerEnqueue used
                // `coverage:${stage.id}:global` — different keys, so BullMQ didn't
                // dedupe and a wasted duplicate global run fired every tick. The
                // sentinel (a UUID no real item has) yields the same identity as a
                // real candidate iff identityFor ignores mediaItemId (= global).
                let isGlobalIdentity = false;
                if (candidates.length >= 1) {
                    try {
                        const idReal = task.identityFor({
                            mediaItemId: candidates[0].media_item_id,
                        });
                        const idSentinel = task.identityFor({
                            mediaItemId: GLOBAL_IDENTITY_SENTINEL_UUID,
                        });
                        isGlobalIdentity = idReal === idSentinel;
                    } catch {
                        // If identityFor throws on a bare {mediaItemId} input,
                        // treat as per-item — the task's inputSchema will reject
                        // the call and surface a normal failure.
                        isGlobalIdentity = false;
                    }
                }

                if (isGlobalIdentity) {
                    // A global-identity run drains every stage its task covers, so a
                    // second enqueue for another stage of the same task in this tick
                    // (media-probe-a then -b, keyed per stage) only starts a
                    // concurrent run that re-probes the same new files. The first
                    // run's phase for the other stage covers its candidates; a stage
                    // that still has rows afterwards is picked up next tick.
                    if (globalTasksEnqueuedThisTick.has(task.id)) {
                        deduped++;
                        stageCounts.deduped++;
                        continue;
                    }
                    // Non-progress backoff: a global run that completes without
                    // shrinking the backlog gets re-enqueued on the very next
                    // tick (exclusiveWith releases on terminal; the idempotency
                    // key ignores terminal runs), so a stage whose rows can never
                    // clear loops every 60s forever. mdblist-sync did exactly
                    // that: 1,037 runs/day against a 12h schedule, exhausting its
                    // API quota. Fail-open — see global-enqueue-backoff.ts.
                    let backoff: BackoffDecision = { skip: false, level: 0 };
                    try {
                        backoff = await shouldSkipGlobalEnqueue({
                            taskId: task.id,
                            stageId: stage.id,
                            backlog: await countSweepBacklog(sql, stage.id),
                            fingerprint: fingerprintCandidates(
                                candidates.map((c) => c.media_item_id),
                            ),
                            scheduleEveryMs: parseDurationMs(task.schedule?.every),
                        });
                    } catch (err) {
                        logger.warn('stage-sweep: backoff check failed — allowing enqueue', {
                            stageId: stage.id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                    if (backoff.skip) {
                        stagesSkippedBackoff++;
                        logger.info('stage-sweep: global enqueue backed off (no progress)', {
                            stage_id: stage.id,
                            task_id: task.id,
                            level: backoff.level,
                            retry_in_ms: backoff.retryInMs,
                        });
                        continue;
                    }

                    // One sweep enqueue, no mediaItemId. The task's own backlog
                    // scan drains everything. Aligned with the eager-enqueue
                    // key scheme so both paths dedupe against each other.
                    try {
                        const result = await orchestrator.startRun(
                            task.id,
                            {},
                            {
                                trigger: {
                                    kind: 'scheduled',
                                    sourceRoute: 'stage-sweep',
                                },
                                idempotencyKey: `coverage:${stage.id}:global`,
                            },
                        );
                        globalTasksEnqueuedThisTick.add(task.id);
                        if (result.deduped) {
                            deduped++;
                            stageCounts.deduped++;
                        } else {
                            enqueued++;
                            stageEnqueued++;
                        }
                    } catch (err) {
                        failed++;
                        if (isChildCircuitRejection(err, task.id)) childCircuitRejections++;
                        logger.warn('stage-sweep: global-identity startRun failed', {
                            stageId: stage.id,
                            taskId: task.id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                } else {
                    for (const candidate of candidates) {
                        if (signal.aborted) break;
                        try {
                            const result = await orchestrator.startRun(
                                task.id,
                                { mediaItemId: candidate.media_item_id },
                                {
                                    // 'sweeper' is not a TriggerKind in the SDK union;
                                    // 'scheduled' is the closest match (this run was
                                    // itself fired by the scheduler). The sourceRoute
                                    // disambiguates from a normal cron-triggered run.
                                    trigger: {
                                        kind: 'scheduled',
                                        sourceRoute: 'stage-sweep',
                                    },
                                    // Same `coverage:` prefix as eager-enqueue so the
                                    // two paths dedupe against each other within the
                                    // 24h identity window.
                                    idempotencyKey: `coverage:${stage.id}:${candidate.media_item_id}`,
                                },
                            );
                            if (result.deduped) {
                                deduped++;
                                stageCounts.deduped++;
                            } else {
                                enqueued++;
                                stageEnqueued++;
                            }
                        } catch (err) {
                            failed++;
                            if (isChildCircuitRejection(err, task.id)) childCircuitRejections++;
                            // Permanent failures here typically mean the task's
                            // inputSchema rejected `mediaItemId` (which should have
                            // been caught by the `enqueueable: true` review when the
                            // flag was set). Log loudly so a misconfiguration shows
                            // up in the next sweep iteration.
                            logger.warn('stage-sweep: startRun failed', {
                                stageId: stage.id,
                                taskId: task.id,
                                mediaItemId: candidate.media_item_id,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                }

                const tickMs = Date.now() - tickStart;

                // Per-stage INFO log — suppressed when everything is zero to
                // avoid spamming logs on quiet ticks.
                const stageCandidates = candidates.length;
                const stageSkipped = stageCandidates - stageEnqueued - stageCounts.deduped;
                if (stageCandidates > 0 || stageEnqueued > 0 || stageSkipped > 0) {
                    logger.info('stage-sweep: tick', {
                        stage_id: stage.id,
                        candidates_found: stageCandidates,
                        enqueued: stageEnqueued,
                        skipped_due_to_dedup: stageCounts.deduped,
                    });
                }

                if (tickMs > TICK_WARN_MS) {
                    logger.warn('stage-sweep: slow tick', {
                        stage_id: stage.id,
                        tick_ms: tickMs,
                    });
                }

                // Update the Prometheus gauge with the full backlog (not just the
                // capped slice returned by findSweepCandidates). Use the page-
                // fullness as a proxy: if the page was NOT full, the candidates
                // we returned ARE the full backlog — skip the COUNT to reduce
                // query pressure. Only run COUNT when the page might have more
                // rows behind it.
                const pageFull = candidates.length === PER_STAGE_LIMIT;
                if (pageFull) {
                    void countSweepBacklog(sql, stage.id)
                        .then((n) => stageSweepBacklog.set({ stage_id: stage.id }, n))
                        .catch((err: unknown) => {
                            logger.warn('stage-sweep: backlog count failed', {
                                stage_id: stage.id,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        });
                } else {
                    stageSweepBacklog.set({ stage_id: stage.id }, candidates.length);
                }
            }
        }

        const backpressureSuffix =
            stagesSkippedBackpressure > 0 || hitGlobalEnqueueCap
                ? `; backpressure-skipped ${stagesSkippedBackpressure} stage(s)` +
                  (hitGlobalEnqueueCap ? `; hit global enqueue cap ${MAX_ENQUEUES_PER_TICK}` : '')
                : '';
        const budgetSuffix = hitWallclockBudget
            ? `; wall-clock budget (${STAGE_SWEEP_WALLCLOCK_BUDGET_MS}ms) hit — remaining stages resume next tick`
            : '';
        const message =
            `scanned ${stagesScanned} stage(s); found ${candidatesFound} candidate(s); ` +
            `enqueued ${enqueued}; deduped ${deduped}; failed ${failed}; ` +
            `self-heal seeded ${selfHealSeeded}/${selfHealFound}` +
            (stageHealStage ? `; backfilled ${stageHealSeeded} ${stageHealStage} row(s)` : '') +
            `${backpressureSuffix}${budgetSuffix}`;
        if (
            candidatesFound > 0 ||
            failed > 0 ||
            selfHealFound > 0 ||
            // Without this the backfill is silent on exactly the ticks where
            // it is the only thing that happened.
            stageHealSeeded > 0 ||
            stagesSkippedBackpressure > 0 ||
            hitGlobalEnqueueCap
        ) {
            logger.info(message);
        }

        // A sweep is "failed" only when EVERY attempted enqueue failed — partial
        // failures (e.g. one bad task amid many good ones) are normal noise and
        // shouldn't mark the entire scheduled run as failed.
        // A child circuit's admission gate is doing its job; failing this
        // scheduled sweep for that rejection opens the sweep's OWN circuit and
        // stops unrelated stages. Deduped runs are also successful admissions.
        // Keep child rejections in `failed` for the heartbeat and audit warning.
        const allFailed =
            failed > childCircuitRejections &&
            candidatesFound > 0 &&
            enqueued === 0 &&
            deduped === 0;

        const sweepResult: StageSweepResult = {
            stagesScanned,
            candidatesFound,
            enqueued,
            deduped,
            failed,
            failedCount: failed,
            selfHealFound,
            selfHealSeeded,
            selfHealReEnrolled,
            stageHealSeeded,
            stageHealStage,
            stagesSkippedBackpressure,
            stagesSkippedReserve,
            stagesSkippedBackoff,
            hitGlobalEnqueueCap,
            hitWallclockBudget,
            message,
        };

        // Observability (Slice 0): heartbeat carries the typed result verbatim;
        // an audit row records the notable outcomes. Both best-effort.
        //
        // `allFailed` (every attempted enqueue failed this tick) must show as
        // 'degraded', not 'ok' — otherwise the health surface reads the tick
        // as healthy even though NOTHING got enqueued. Written before the
        // throw below so the heartbeat/audit trail always lands even though
        // the run itself is about to be marked failed.
        await writeHeartbeat('stage-sweep', {
            status: hitGlobalEnqueueCap || allFailed ? 'degraded' : 'ok',
            detail: { ...sweepResult },
        });
        if (hitGlobalEnqueueCap || failed > 0) {
            // `stage-sweep-capped` is the RECOVERY-classified action name the
            // repeated-recovery adapter (adapters.ts RECOVERY_AUDIT_ACTIONS)
            // watches for a genuine "something keeps re-wedging" signal —
            // reserve it for an actual hitGlobalEnqueueCap tick (the per-tick
            // MAX_ENQUEUES_PER_TICK budget genuinely exhausted). A bare
            // per-item enqueue failure (failed > 0, cap NOT hit) is routine —
            // e.g. a rate-limited/exclusiveWith-guarded task rejecting a
            // sweep-triggered startRun while its own backlog drain is already
            // active — and firing on nearly every tick previously
            // false-promoted this into a repeated-recovery warning (~1440/day
            // for a task whose backlog just takes many ticks to drain). Use a
            // distinct action name so the event still lands in the audit log
            // / /admin/system/health activity feed, but the repeated-recovery
            // watch (which filters on the exact action string) no longer
            // counts it.
            await appendAuditEvent({
                category: 'stage-sweep',
                action: hitGlobalEnqueueCap ? 'stage-sweep-capped' : 'stage-sweep-enqueue-failed',
                severity: hitGlobalEnqueueCap ? 'warn' : 'error',
                summary: allFailed
                    ? `Stage-sweep: every enqueue attempt failed (${failed}/${candidatesFound} candidates).`
                    : hitGlobalEnqueueCap
                      ? `Stage-sweep hit the global enqueue cap; enqueued ${enqueued}, ${failed} failed.`
                      : `Stage-sweep had ${failed} enqueue failure(s).`,
                detail: { ...sweepResult },
            });
        }

        // A sweep where EVERY attempted enqueue failed must not be recorded as
        // 'completed' with a credited breaker success. Returning `{success:
        // false}` here used to be silently ignored — the runner only inspects
        // the return value for shape/typing, never for a `success: false`
        // sentinel; any non-throwing return is treated as a completed run and
        // the circuit breaker is credited a success. Throwing a transient
        // TaskError is the only way to make the runner mark this run failed,
        // retry it, and let the breaker see the failure. Must be the LAST
        // thing this execute() does — the heartbeat/audit writes above have
        // already landed, and nothing downstream reads a return value once we
        // throw.
        if (allFailed) {
            throw new TaskError({
                message:
                    `stage-sweep: every enqueue attempt failed this tick ` +
                    `(${failed} failed / ${candidatesFound} candidates found; 0 enqueued)`,
                kind: 'transient',
            });
        }

        return {
            success: true,
            itemsProcessed: enqueued + selfHealSeeded + selfHealReEnrolled + stageHealSeeded,
            result: sweepResult,
        };
    },
});

registry.registerTask(stageSweepTask);
