// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reconciliation Backfill / Remap Task (WS4)
 *
 * Re-runs the WS3 episode content matcher over EXISTING series to correct
 * historical mis-mappings. When the matcher first ran, a series may have lacked
 * chapters / a TMDB catalog / a filename signal, leaving episodes bound by fragile
 * positional (S/E) titles. This task sweeps those series again now that the
 * supporting data may have arrived and:
 *
 *   - APPLIES confident matches (>= minConfidence) — flipping the row to
 *     title_binding='identity'.
 *   - QUARANTINES low-confidence suspects into `sync_quarantine` for operator
 *     review (below-threshold / duplicate / under-confidence matches).
 *
 * Safety invariants (enforced in the matcher + apply path, not here):
 *   - NEVER overrides a metadata_locked row (admin froze it by hand).
 *   - NEVER overrides a title_binding='identity' row (a prior confident match —
 *     re-litigating trusted bindings is exactly the bug a remap must avoid).
 *
 * Idempotent + safe to re-run:
 *   - A confident match makes the row identity-bound, so the next pass skips it.
 *   - An unresolved low-confidence row re-quarantines into the SAME row (the
 *     sync_quarantine upsert keys on (provider, external_id, media_type)).
 *   - A per-series `reconcile_backfill_at` watermark (migration 16.99.0) lets a
 *     `staleOnly` drain skip series it already visited until the watermark ages
 *     out; an in-run processed Set prevents looping on never-resolving series.
 *
 * Resource class: 'maintenance' — DB reads + a bounded number of TMDB catalog
 * fetches per series (already rate-limited inside the matcher). Yields to the
 * serving path between series.
 *
 * Triggers: NOT scheduled. chapter-sync kicks it for a single series the moment
 * that series gains chapters (the one moment new matching signal reliably
 * arrives), and an operator can run it for one series (`seriesMediaId`) or a
 * full sweep (`force: true`). It used to run every 24h: on the reference
 * library that re-swept ~1,300 series a week for 12 weeks (2026-07 .. 09) and
 * applied ZERO ids and ZERO titles, while re-upserting the same ~4,600
 * unresolved quarantine rows and holding a maintenance slot ~5 min a day.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import { registry } from '../../registry.js';
import {
    backfillReconcileSeries,
    listReconcileBackfillCandidates,
    reevaluateQuarantineBacklog,
    recheckQuarantinedMatchesForSeries,
} from '$lib/server/services/episode-reconciliation.service.js';
import type postgres from 'postgres';

const logger = Logger.for('ReconciliationBackfill');

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BATCH_SIZE = 25;

const RECONCILE_CHECKPOINT_VERSION = 1;

interface ReconcileCheckpoint {
    v: number;
    /** When the operator's original sweep began (the chain's first run). */
    sweepStartedAt: string;
    totals: ReconciliationBackfillResult;
}

const reconcileCheckpointSchema = z.object({
    v: z.literal(RECONCILE_CHECKPOINT_VERSION),
    sweepStartedAt: z.string().datetime(),
    totals: z.object({
        seriesProcessed: z.number().int().min(0),
        appliedExternalIds: z.number().int().min(0),
        updatedTitles: z.number().int().min(0),
        quarantined: z.number().int().min(0),
        quarantineReevaluated: z.number().int().min(0),
        quarantineDismissedGone: z.number().int().min(0),
        quarantineReattached: z.number().int().min(0),
        quarantineFailedSeries: z.number().int().min(0).default(0),
    }),
});

/** The saved sweep, or null to start a fresh one. */
export function parseReconcileCheckpoint(raw: unknown): ReconcileCheckpoint | null {
    const parsed = reconcileCheckpointSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
const DEFAULT_MIN_CONFIDENCE = 0.9;
const DEFAULT_QUARANTINE_FLOOR = 0.5;
/** A series reconciled within this window is "fresh" and skipped by a stale drain. */
const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/**
 * Hard ceiling on series processed in a single run. A forced (staleOnly=false)
 * drain has no watermark to fall behind, so under concurrent ingest writing fresh
 * has_files=true TV series the candidate query can keep surfacing new rows every
 * page — the loop would otherwise run until the 6h hard timeout. Capping the sweep
 * bounds each run; newly-eligible series are picked up by the next full run
 * (or an explicit re-trigger). Generous enough that a normal full sweep completes
 * in one run.
 */
const MAX_SERIES_PER_RUN = 5000;

/**
 * Default cap on unresolved quarantine rows the self-draining re-evaluation
 * pass examines per run (see `reevaluateQuarantineBacklog`). Bounds the extra
 * cost a full drain pays revisiting series purely for their stuck
 * quarantine rows, independent of MAX_SERIES_PER_RUN above.
 */
const DEFAULT_QUARANTINE_REEVAL_CAP = 500;

// =============================================================================
// Schema / types
// =============================================================================

const inputSchema = z.object({
    /** Process only this specific series (admin one-shot mode). */
    seriesMediaId: z.string().optional(),
    /** Max series to fetch per drain page. Default: 25. */
    batchSize: z.number().int().positive().max(1000).optional(),
    /**
     * Floor for AUTO-APPLYING a content match, clamped to [0.5, 1]. Below this a
     * candidate is quarantined (or skipped) rather than applied. Default 0.9.
     */
    minConfidence: z.number().min(0).max(1).optional(),
    /**
     * Minimum candidate score to bother quarantining; matches scoring below this
     * are treated as noise and skipped entirely. Default 0.5.
     */
    quarantineFloor: z.number().min(0).max(1).optional(),
    /**
     * When true (default), only sweep series whose `reconcile_backfill_at`
     * watermark is NULL or older than the stale window. When false / `force`,
     * sweep every eligible series.
     */
    staleOnly: z.boolean().optional(),
    /** Alias for `staleOnly: false` — re-sweep every eligible series. */
    force: z.boolean().optional(),
    /**
     * Max unresolved quarantine rows the self-draining re-evaluation pass
     * examines this run (clamped to [1, 1000]). Default 500. Set to 0 to skip
     * the pass entirely for this run.
     */
    quarantineReevalCap: z.number().int().min(0).max(1000).optional(),
});

type ReconciliationBackfillInput = z.infer<typeof inputSchema>;

interface ReconciliationBackfillResult {
    seriesProcessed: number;
    appliedExternalIds: number;
    updatedTitles: number;
    quarantined: number;
    /** Unresolved quarantine rows examined by the re-evaluation pass. */
    quarantineReevaluated: number;
    /** Of those, resolved 'dismissed' because their episode row no longer exists. */
    quarantineDismissedGone: number;
    /** Of those, resolved 'reattached' by a fresh off-cadence series re-match. */
    quarantineReattached: number;
    /** Failed series retain their warnings and are retried next traversal. */
    quarantineFailedSeries: number;
}

// =============================================================================
// Task definition
// =============================================================================

export const reconciliationBackfillTask = defineTask<
    ReconciliationBackfillInput,
    ReconciliationBackfillResult
>({
    id: 'reconciliation-backfill',
    purpose: 'repair',
    confirmBeforeRun: true,
    name: 'Episode Reconciliation Backfill',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, cache: true },

    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: (input) => input.seriesMediaId ?? 'global',

    // Service/operator-triggered only — see "Triggers" in the module docblock.
    // manualOnly keeps the boot trigger-coverage audit from flagging it as an
    // orphan.
    manualOnly: true,
    // A manual full sweep runs for hours. Safe to resume (see "Idempotent +
    // safe to re-run" above). Every processed series gets its watermark
    // stamped, so a resumed sweep — default or forced — continues with the
    // series not stamped since the ORIGINAL sweep began (checkpoint below).
    // chapter-sync's per-series kicks are in-process, not manual, and are
    // never resumed.
    resumeAfterRestart: true,

    inputSchema,

    timeout: { hard: '6h', soft: '5h' },

    async execute(ctx): Promise<{
        success: boolean;
        itemsProcessed: number;
        result: ReconciliationBackfillResult;
        message?: string;
        stopReason?: 'aborted';
    }> {
        const { sql: rawSql, signal, reportProgress, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        const input = ctx.input as ReconciliationBackfillInput;
        const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
        const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
        const quarantineFloor = input.quarantineFloor ?? DEFAULT_QUARANTINE_FLOOR;
        const force = input.force ?? false;
        // Resumed after a restart: skip what the interrupted sweep(s) already
        // stamped, even for a forced sweep, and carry the counts forward.
        const saved = input.seriesMediaId
            ? null
            : parseReconcileCheckpoint(await ctx.checkpoint?.load());
        const sweepStartedAt = saved ? new Date(saved.sweepStartedAt) : new Date();
        const staleOnly = saved ? true : force ? false : (input.staleOnly ?? true);

        const totals: ReconciliationBackfillResult = saved
            ? { ...saved.totals }
            : {
                  seriesProcessed: 0,
                  appliedExternalIds: 0,
                  updatedTitles: 0,
                  quarantined: 0,
                  quarantineReevaluated: 0,
                  quarantineDismissedGone: 0,
                  quarantineReattached: 0,
                  quarantineFailedSeries: 0,
              };

        // ── Single-series mode ──────────────────────────────────────────────
        if (input.seriesMediaId) {
            ctxLogger.info('Reconciliation backfill: single-series mode', {
                seriesMediaId: input.seriesMediaId,
                minConfidence,
            });
            const res = await backfillReconcileSeries(sql, input.seriesMediaId, {
                minConfidence,
                quarantineFloor,
                actor: 'reconciliation-backfill',
            });
            if (!signal.aborted) {
                const cleanup = await recheckQuarantinedMatchesForSeries(
                    sql,
                    input.seriesMediaId,
                    'reconciliation-backfill',
                );
                totals.quarantineReevaluated = cleanup.examined;
                totals.quarantineReattached = cleanup.resolved;
            }
            totals.seriesProcessed = 1;
            totals.appliedExternalIds = res.appliedExternalIds;
            totals.updatedTitles = res.updatedTitles;
            totals.quarantined = res.quarantined;
            const message = `Reconciled series ${input.seriesMediaId}: ${res.updatedTitles} titles, ${res.appliedExternalIds} ids, ${res.quarantined} quarantined`;
            ctxLogger.info(message);
            return { success: true, itemsProcessed: 1, result: totals, message };
        }

        // ── Drain loop ──────────────────────────────────────────────────────
        // A never-resolving series keeps its 'position' rows (no confident match)
        // and so re-appears on every page even after its watermark is stamped only
        // when staleOnly=false. Track processed ids in-run to guarantee progress.
        const processedIds = new Set<string>();
        // A resumed sweep keeps the ORIGINAL window, frozen at the original
        // start: forced = everything not stamped since it began; default = the
        // usual 7-day staleness as of then. Series done since are stamped
        // after sweepStartedAt, so both exclude them.
        const staleBefore = saved
            ? force
                ? sweepStartedAt
                : new Date(sweepStartedAt.getTime() - STALE_WINDOW_MS)
            : new Date(Date.now() - STALE_WINDOW_MS);
        let ceilingReached = false;
        let drainComplete = false;

        ctxLogger.info('Reconciliation backfill: drain loop starting', {
            batchSize,
            staleOnly,
            force,
            minConfidence,
            quarantineFloor,
            maxSeriesPerRun: MAX_SERIES_PER_RUN,
        });

        while (!signal.aborted) {
            const candidates = await listReconcileBackfillCandidates(sql, {
                limit: batchSize,
                staleOnly,
                staleBefore,
            });

            const pending = candidates.filter((c) => !processedIds.has(c.seriesMediaId));
            if (pending.length === 0) {
                ctxLogger.info('Reconciliation backfill: drain complete', totals);
                drainComplete = true;
                break;
            }

            for (let i = 0; i < pending.length; i++) {
                if (signal.aborted) break;

                // Hard ceiling: bound a forced/full drain so concurrent ingest
                // surfacing fresh candidates can't keep the loop alive to the 6h
                // hard timeout. The next full run resumes from the watermark.
                if (totals.seriesProcessed >= MAX_SERIES_PER_RUN) {
                    ceilingReached = true;
                    break;
                }

                const candidate = pending[i];
                processedIds.add(candidate.seriesMediaId);

                try {
                    const res = await backfillReconcileSeries(sql, candidate.seriesMediaId, {
                        minConfidence,
                        quarantineFloor,
                        actor: 'reconciliation-backfill',
                    });
                    totals.seriesProcessed++;
                    totals.appliedExternalIds += res.appliedExternalIds;
                    totals.updatedTitles += res.updatedTitles;
                    totals.quarantined += res.quarantined;
                } catch (err) {
                    // One bad series must not abort the whole drain.
                    logger.warn('Reconciliation backfill failed for series (skipping)', {
                        seriesMediaId: candidate.seriesMediaId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }

                // Monotonic progress: numerator grows; denominator extends as pages load.
                const done = totals.seriesProcessed;
                const remainingInPage = pending.length - (i + 1);
                reportProgress(done, done + remainingInPage, candidate.seriesMediaId);

                // Yield to the event loop so the serving path is never starved.
                await new Promise<void>((resolve) => setImmediate(resolve));
            }

            // After each batch: every processed series is stamped, so the
            // start time and the counts are all a resume needs.
            await ctx.checkpoint?.save({
                v: RECONCILE_CHECKPOINT_VERSION,
                sweepStartedAt: sweepStartedAt.toISOString(),
                totals: { ...totals },
            } satisfies ReconcileCheckpoint);

            if (ceilingReached) {
                drainComplete = true;
                ctxLogger.warn(
                    'Reconciliation backfill: per-run series ceiling reached; ending sweep early',
                    {
                        seriesProcessed: totals.seriesProcessed,
                        maxSeriesPerRun: MAX_SERIES_PER_RUN,
                    },
                );
                break;
            }

            ctxLogger.info('Reconciliation backfill: batch complete', totals);
        }

        // ── Self-draining quarantine re-evaluation ──────────────────────────
        // Revisits unresolved reconcile-backfill quarantine rows independent of
        // the drain loop above (which only re-matches series whose watermark is
        // stale): dismisses rows whose episode is gone, and re-matches the
        // series behind any still-live row so a newly-confident match doesn't
        // have to wait out the 7-day stale window. See
        // episode-reconciliation.service.ts#reevaluateQuarantineBacklog.
        const quarantineReevalCap = input.quarantineReevalCap ?? DEFAULT_QUARANTINE_REEVAL_CAP;
        if (quarantineReevalCap > 0 && !signal.aborted) {
            try {
                const cursorKey = 'v1:quarantine-reeval:cursor';
                const after = (await ctx.cache?.get<string>(cursorKey)) ?? undefined;
                const reeval = await reevaluateQuarantineBacklog(sql, {
                    cap: quarantineReevalCap,
                    actor: 'reconciliation-backfill',
                    after,
                });
                if (reeval.continuation)
                    await ctx.cache?.set(cursorKey, reeval.continuation, 30 * 24 * 60 * 60 * 1000);
                else await ctx.cache?.del(cursorKey);
                totals.quarantineReevaluated = reeval.rowsExamined;
                totals.quarantineDismissedGone = reeval.dismissedGone;
                totals.quarantineReattached = reeval.reattached;
                totals.quarantineFailedSeries = reeval.failedSeries ?? 0;
                ctxLogger.info(
                    reeval.failedSeries
                        ? 'Reconciliation backfill: partial quarantine re-evaluation; failed warnings retained for next traversal'
                        : 'Reconciliation backfill: quarantine re-evaluation complete',
                    reeval,
                );
            } catch (err) {
                // Non-fatal: the drain's own results are already valid regardless.
                logger.warn(
                    'Reconciliation backfill: quarantine re-evaluation failed (non-fatal)',
                    {
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        }

        const ceilingNote = ceilingReached
            ? ` (per-run ceiling ${MAX_SERIES_PER_RUN} reached; remaining series resume next run)`
            : '';
        const message = `Reconciliation backfill: ${totals.seriesProcessed} series, ${totals.updatedTitles} titles, ${totals.appliedExternalIds} ids, ${totals.quarantined} quarantined${ceilingNote}; quarantine re-eval: ${totals.quarantineReevaluated} examined, ${totals.quarantineReattached} reattached, ${totals.quarantineDismissedGone} dismissed, ${totals.quarantineFailedSeries} series failed (warnings retained for next traversal)`;
        ctxLogger.info(message);
        // Stopped by cancel or a shutdown before the drain finished: say so, so
        // a sweep cut short is not recorded as finished (and can be resumed
        // after a restart). An abort that only skipped the quarantine
        // re-evaluation still counts as a finished sweep.
        if (signal.aborted && !drainComplete) {
            return {
                success: false,
                itemsProcessed: totals.seriesProcessed,
                result: totals,
                message,
                stopReason: 'aborted',
            };
        }
        return {
            success: true,
            itemsProcessed: totals.seriesProcessed,
            result: totals,
            message,
        };
    },
});

// Self-register into the singleton registry (mirrors profile-backfill.ts).
registry.registerTask(reconciliationBackfillTask);
