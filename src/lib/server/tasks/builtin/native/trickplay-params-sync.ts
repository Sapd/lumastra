// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay Params Sync — native defineTask implementation.
 *
 * Background sync that populates the trickplay_params cache table for
 * streamable media items that don't yet have trickplay parameters.
 *
 * Drain semantics (shared with intro-analyzer / music-analysis):
 *   - catchup: scheduled tick — process a single slice and return.
 *   - manual:  admin "Analyze remaining" — drain until empty or budget hits.
 *   - force:   admin "Re-generate all" — wipe cached params, then drain.
 *
 * Configuration:
 * - SYNC_TRICKPLAY_PARAMS_INTERVAL: Duration-string override for the 6h cadence
 *   (e.g. '1h', '12h').
 * - DISABLE_TRICKPLAY_PARAMS: Set to 'true' to disable (both scheduled and
 *   manual triggers). Checked at execute() entry.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import type {
    TaskContext,
    BacklogStage,
    FailedItem as SdkFailedItem,
} from '@sapd/lumastra-plugin-sdk';
import type { PluginContext } from '../../../plugins/types/base-plugin.js';
import {
    drainBacklog,
    drainWipe,
    resolveDrainMode,
    formatStopReason,
    computeRemainingHint,
    isAbortedStop,
    lazyBacklog,
} from '../../../plugins/runtime/drain-backlog.js';
import {
    getItemsWithoutTrickplayParams,
    getTrickplayBacklogCounts,
    markTrickplayItemTried,
    findCoverageTableBacklog,
    TRICKPLAY_PARAMS_PROCESSING_VERSION,
    reconcileTrickplayCoverageRows,
    resetObsoleteTrickplayCoverage,
    type ItemWithoutTrickplay,
} from '../../../database/queries/trickplay-params.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { trickplayParamsService } from '../../../services/trickplay-params.service.js';
import {
    recordFailure,
    getFailureAggregates,
    type FailureAggregateRow,
} from '../../../database/queries/plugin-failure-events.queries.js';
import { registry } from '../../registry.js';
import { classifyInfraError } from '../../infra-retry.js';
import { repairTrickplayHeights } from './trickplay-height-repair.js';

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_ID = 'trickplay-params';

// Per-run cap for measuring rows that still carry the 16:9 height guess.
const HEIGHT_REPAIR_BUDGET_MS = 8 * 60 * 1000;

// Bump whenever a provider plugin changes output shape or a new provider is
// added — clears every processing_state marker so items previously marked
// `no-provider` or `error` get one more chance. Version 2 fixes Jellyfin disk
// interval inference and distinguishes `jellyfin-disk` from generated `local`
// rows, so old ambiguous cache rows must be rebuilt. Version 3 fixes
// thumbnailCount (was hardcoded to one sheet's tile capacity — columns *
// rows — instead of the real cross-sheet total; see trickplayParamsToInfo).
// NOTE: this bump only re-admits items previously marked no-provider/error —
// items that already have a `trickplay_params` row are excluded via the
// `NOT EXISTS` clause regardless of marker version, so existing cached rows
// need an explicit wipe (admin "Re-generate all") to pick up the fix.
const PROCESSING_VERSION = TRICKPLAY_PARAMS_PROCESSING_VERSION;

// One slice per catchup tick. 200 was the previous inline batch size; held
// here so a fresh library makes visible progress per run while a single
// provider call (disk probe / Jellyfin HTTP) never dominates wall-clock.
const SLICE_SIZE = 200;

// Trickplay params land on every streamable item, so wipes can touch
// 100k+ rows on large libraries. Chunk the DELETE/UPDATE to keep row-lock
// windows short and bound the per-statement WAL/memory footprint. Matches
// the WIPE_BATCH_SIZE convention used by the music-analysis plugin.
const WIPE_BATCH_SIZE = 500;

// Cap error strings before we stamp them into processing_state JSONB.
// Provider failures can return HTML error pages or multi-KB stack traces;
// writing those verbatim bloats the per-row marker and slows every
// subsequent scan of processing_state.
const MAX_REASON_LEN = 500;

// Batch size for the "legacy-done" bulk stage_state tombstone sweep (see
// `drainLegacyDoneStageRows`). Mirrors the `pruneUntilDrained` idiom in
// `database-cleanup.ts`: bounded LIMIT per pass so a large backlog doesn't
// hold a single unbatched UPDATE...FROM's row locks against the hot
// media_item_stage_state table for the whole sweep.
const LEGACY_DONE_BATCH_SIZE = 1000;

// Runaway guard on the number of batches per execute() call — caps the sweep
// at LEGACY_DONE_BATCH_SIZE * LEGACY_DONE_MAX_PASSES rows/run so a pathological
// backlog can't turn this into an unbounded loop; the remainder drains on the
// next scheduled/manual run.
const LEGACY_DONE_MAX_PASSES = 1_000;

// ============================================================================
// Schemas / types
// ============================================================================

/** Stage skip reason while `DISABLE_TRICKPLAY_PARAMS` is set; reclaimed when cleared. */
export const TRICKPLAY_PARAMS_DISABLED_REASON = 'trickplay-params-disabled';

const inputSchema = z.object({}).passthrough();

type TrickplayInput = z.infer<typeof inputSchema>;

interface TrickplayResult {
    synced: number;
    errors: number;
    skipped: number;
}

// ============================================================================
// Task definition
// ============================================================================

export const trickplayParamsSyncTask = defineTask<TrickplayInput, TrickplayResult>({
    id: 'trickplay-params-sync',
    purpose: 'library',
    name: 'Trickplay Params Sync',
    version: '2.0.0',
    processingVersion: PROCESSING_VERSION,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '6h',
        runOnStartup: false,
        envOverride: 'SYNC_TRICKPLAY_PARAMS_INTERVAL',
    },

    // MODE-INDEPENDENT, and paired with exclusiveWith below — see
    // music-popularity.ts for the long form. The orchestrator's SETNX mutex key
    // is `identityKey(taskId, identityFor(input))`, so exclusiveWith inherits
    // whatever this returns: a mode-suffixed identity would hand catchup,
    // manual and force each their own key and collapse only same-mode re-fires.
    // catchup, manual and force are the same work at different depths here, so
    // single-flight across all three is the correct semantics.
    identityFor: () => 'global',
    scope: 'global',
    // Singleton guard. `force` drops the stored trickplay params, and without this it could run
    // CONCURRENTLY with an in-flight catchup or manual pass — deleting rows
    // that pass is mid-write. The derived data is recomputable, so the damage
    // is wasted work and a transient hole rather than permanent loss, but the
    // wipe racing its own writer is not a state worth allowing. ttl >= the
    // task's hard timeout, per the SDK rule.
    exclusiveWith: { scope: 'global', ttl: '40m' },
    // File-fast path — extracts duration/sprite-params from new files.
    resourceClass: 'ingest',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Deletes the derived trickplay_params rows so they are recomputed. Does not delete generated tiles.
    supportsForceRun: true,

    inputSchema,

    coversStages: [
        {
            id: 'trickplay-params-sync',
            appliesTo: ['movie', 'episode'] as const,
            // Eligibility: a non-missing file WITH a probed video stream. Previously a
            // `has_file && has_video` predicate with NO recovery rail (a pre-probe seed
            // skip was unrecoverable — latent M2-class); the unified contract gives it
            // the SQL eligibility + event-independent heal for free.
            //
            // `DISABLE_TRICKPLAY_PARAMS` leads the fragment (live getter, read per
            // call): execute() early-returns while it is set, so without it every
            // seeded row stayed `pending` forever — counted as backlog, found by
            // stage-sweep every tick, never enqueued. Clearing the flag lets the
            // heal reclaim the rows the disabled predicate below parked (up to
            // PER_STAGE_HEAL_QUIET_MS, 15 min, later: the heal goes quiet after
            // ticks that reclaim nothing).
            eligibility: {
                sql: (sql) => sql`
                    ${config.DISABLE_TRICKPLAY_PARAMS ? sql`false` : sql`true`}
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                         WHERE mfi.media_item_id = mi.id AND NOT mf.is_missing
                    )
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                          JOIN media_streams ms ON ms.file_id = mf.id
                         WHERE mfi.media_item_id = mi.id
                           AND NOT mf.is_missing
                           AND ms.stream_type = 'video'
                    )
                `,
                recoverWhenAdditionalReasons: [TRICKPLAY_PARAMS_DISABLED_REASON],
            },
            // Turning the switch back on re-enrols the whole library through the
            // heal; the default 50 rows per tick would take hours on a large one.
            healLimit: 500,
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
            ] as const,
            enqueueable: true,
            // Coverage rows are per item, while real work is per linked file.
            // An item-level completion predicate would certify an unprocessed
            // alternate. The task reconciles the row only after all current
            // linked files have params or terminal current-version markers.
            // This stage remains opt-in for authoritative coverage reads.
            terminalDisposition: [
                {
                    // Switched off by the operator. A predicate, not a global-guard:
                    // a guard drains to `skipped_transient`, which progress counts as
                    // REMAINING. An ITEM-level skip is right here (unlike a
                    // 'completed' predicate, see above): while the task is off no
                    // file of the item gets params. Reclaimed by the heal once the
                    // flag is cleared.
                    kind: 'predicate' as const,
                    ruleId: 'trickplay-params-enabled',
                    disposeAs: 'skipped_permanent' as const,
                    reason: TRICKPLAY_PARAMS_DISABLED_REASON,
                    excludes: (sql) => (config.DISABLE_TRICKPLAY_PARAMS ? sql`true` : sql`false`),
                },
                {
                    kind: 'self-terminal' as const,
                    ruleId: 'trickplay-params-self-terminal',
                },
            ],
        },
    ],

    timeout: { hard: '30m', soft: '25m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        if (config.DISABLE_TRICKPLAY_PARAMS) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { synced: 0, errors: 0, skipped: 0 },
            };
        }

        const { sql, signal, reportProgress, runId } = ctx;
        // Cast SDK Logger → PluginContext['logger'] (structurally compatible;
        // the SDK Logger interface is a strict subset of LoggerInstance).
        const logger = ctx.logger as unknown as PluginContext['logger'];
        const rawInput = (ctx.input as Record<string, unknown>) ?? {};
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';
        const startTime = Date.now();

        const drainMode = resolveDrainMode(mode, logger);
        const useCoverageTable = getAuthoritativeStageIds().has('trickplay-params-sync');

        // Obsolete rows have no source witness in legacy params or markers.
        // Reopen their linked files before ordinary terminal reconciliation.
        try {
            let reset = 0;
            for (let pass = 0; pass < LEGACY_DONE_MAX_PASSES && !signal.aborted; pass++) {
                const count = await resetObsoleteTrickplayCoverage(
                    sql,
                    LEGACY_DONE_BATCH_SIZE,
                    PROCESSING_VERSION,
                );
                reset += count;
                if (count < LEGACY_DONE_BATCH_SIZE) break;
            }
            if (reset > 0) logger.info('Reopened obsolete trickplay coverage', { count: reset });
        } catch (resetErr) {
            logger.warn('trickplay-params-sync obsolete reset failed (non-fatal)', {
                error: resetErr instanceof Error ? resetErr.message : String(resetErr),
            });
        }

        // Reconcile historical pending stage rows before fetching.
        // The sweep reads the current linked-file set as one group, so one
        // sibling's params or marker never closes another's runnable work.
        try {
            const count = await drainLegacyDoneStageRows(sql, signal);
            if (count > 0) {
                logger.info('Reconciled terminal trickplay-params-sync stage rows', {
                    count,
                });
            }
        } catch (drainErr) {
            logger.warn('trickplay-params-sync coverage reconciliation failed (non-fatal)', {
                error: drainErr instanceof Error ? drainErr.message : String(drainErr),
            });
        }

        // Rows stored before providers reported the thumbnail height carry a
        // 16:9 guess. Measure them from their sheets; bounded so the drain
        // below keeps most of the run. Force mode wipes every row anyway.
        if (drainMode !== 'force') {
            try {
                const repair = await repairTrickplayHeights(sql, {
                    budgetMs: HEIGHT_REPAIR_BUDGET_MS,
                    signal,
                });
                if (repair.measured > 0 || repair.unmeasurable > 0) {
                    logger.info('Measured trickplay thumbnail heights', repair);
                }
            } catch (repairErr) {
                logger.warn('trickplay height repair failed (non-fatal)', {
                    error: repairErr instanceof Error ? repairErr.message : String(repairErr),
                });
            }
        }

        let synced = 0;
        let errors = 0;
        let skipped = 0;

        // Lazy snapshot — `initialBacklog()` fires inside the first
        // fetchSlice call so in force mode the count reflects the post-wipe
        // state (all rows re-eligible). The force branch re-adds already-
        // analyzed / ineligible / failed buckets back to `remaining`
        // because the wipe clears the markers those buckets depend on.
        const initialBacklog = lazyBacklog(async () => {
            const counts = await getTrickplayBacklogCounts(sql, PROCESSING_VERSION);
            return drainMode === 'force'
                ? counts.analyzed + counts.remaining + counts.ineligible + counts.failed
                : counts.remaining;
        });

        const onProgress = (processed: number, total: number, meta?: Record<string, unknown>) => {
            reportProgress(processed, total, meta?.currentItem as string | undefined);
        };

        try {
            const result = await drainBacklog<ItemWithoutTrickplay>(
                { logger, abortSignal: signal },
                {
                    mode: drainMode,
                    // The drain's own default budget is 110 min, but this task is
                    // killed by the run watchdog at timeout.hard (30m) — a manual
                    // drain would be marked FAILED mid-slice instead of stopping
                    // cleanly. Finish under that cap so the run ends as
                    // stopReason 'budget' and the remainder rolls to the next catchup.
                    // Less whatever the height repair above already used.
                    softBudgetMs: Math.max(60_000, 25 * 60 * 1000 - (Date.now() - startTime)),
                    sliceSize: SLICE_SIZE,
                    onWipe: () => wipeTrickplayParams(sql, logger, signal),
                    idOf: (row) => `${row.id}-${row.fileId}`,
                    fetchSlice: async (limit) => {
                        const items =
                            useCoverageTable && drainMode !== 'force'
                                ? await findCoverageTableBacklog(
                                      sql,
                                      'trickplay-params-sync',
                                      limit,
                                      PROCESSING_VERSION,
                                  )
                                : await getItemsWithoutTrickplayParams(
                                      sql,
                                      limit,
                                      PROCESSING_VERSION,
                                  );
                        // Remaining hint derived from the lazy snapshot so the
                        // progress bar counts down smoothly. Includes all outcomes
                        // (synced + errors + skipped) so the math mirrors what
                        // drain's unitsProcessed counter will reach.
                        const total = await initialBacklog();
                        return {
                            items,
                            remainingHint: computeRemainingHint(
                                total,
                                synced + errors + skipped,
                                items.length,
                            ),
                        };
                    },
                    processSlice: async (items, sliceSignal) => {
                        const outcome = await processSlice(sql, items, logger, sliceSignal, runId);
                        synced += outcome.synced;
                        errors += outcome.errors;
                        skipped += outcome.skipped;
                        // Advance accounting: success paths that wrote a
                        // trickplay_params row always count. Skipped/error
                        // paths credit advance ONLY if the marker write
                        // landed — a failed marker means the row stays
                        // eligible for the next slice and the no-progress
                        // detector must see a genuine advance==0 to fire.
                        return {
                            produced: outcome.synced,
                            advanced: outcome.synced + outcome.advancedMarkers,
                        };
                    },
                    onProgress,
                    phase: 'Fetching trickplay params',
                    // Heartbeat — keeps BullMQ stall detection quiet when a
                    // slow provider (e.g. remote Jellyfin, cold disk cache)
                    // chews through large items.
                    heartbeat: {
                        getTotal: () => initialBacklog.peek(),
                        getProcessed: () => synced,
                        getStatus: () =>
                            `Fetching params... (${synced} done, ${errors} errors, ${skipped} skipped)`,
                    },
                },
            );

            const duration = Date.now() - startTime;
            void duration;
            const totalTouched = synced + errors + skipped;
            const success = !isAbortedStop(result.stopReason);

            if (totalTouched === 0) {
                return {
                    success,
                    itemsProcessed: 0,
                    result: { synced, errors, skipped },
                };
            }

            const suffix = formatStopReason(result.stopReason);
            void suffix;

            return {
                success,
                itemsProcessed: synced,
                result: { synced, errors, skipped },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(
                'Trickplay params sync failed',
                error instanceof Error ? error : undefined,
            );
            throw new Error(message, { cause: error });
        }
    },

    backlog: {
        unitLabel: 'file links',
        sliceSize: 1,
        softBudget: '1m',
        idOf: (row) => {
            const r = row as { id?: string; fileId?: string } | null | undefined;
            return r?.id && r?.fileId ? `${r.id}-${r.fileId}` : String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const counts = await getTrickplayBacklogCounts(ctx.sql, PROCESSING_VERSION);
            const stages: BacklogStage[] = [];
            if (counts.remaining > 0) {
                stages.push({
                    id: 'remaining',
                    label: 'Remaining',
                    count: counts.remaining,
                });
            }
            if ((counts.failed ?? 0) > 0) {
                stages.push({
                    id: 'failed',
                    label: 'Failed',
                    count: counts.failed ?? 0,
                });
            }
            if (counts.ineligible > 0) {
                stages.push({
                    id: 'ineligible',
                    label: 'Ineligible',
                    count: counts.ineligible,
                });
            }
            return stages;
        },
        async wipe(ctx: TaskContext): Promise<void> {
            const logger = ctx.logger as unknown as PluginContext['logger'];
            await wipeTrickplayParams(ctx.sql, logger, ctx.signal);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    failures: {
        async list(
            ctx: TaskContext,
            opts: { limit: number; offset: number },
        ): Promise<{ items: SdkFailedItem[]; total: number }> {
            const logger = ctx.logger as unknown as PluginContext['logger'];
            const res = await listFailedItems(ctx.sql, logger, opts);
            return {
                items: res.items.map((item) => ({
                    id: item.id,
                    label: item.label,
                    reason: item.reason,
                    detectedAt: item.detectedAt,
                    subtitle: item.subtitle,
                    firstSeen: item.firstSeen,
                    failureCount: item.failureCount,
                    lastSeen: item.lastSeen,
                })),
                total: res.total,
            };
        },
        async retry(ctx: TaskContext, itemId: string): Promise<void> {
            const logger = ctx.logger as unknown as PluginContext['logger'];
            const result = await retryOneTrickplayItem(
                { sql: ctx.sql, logger, abortSignal: ctx.signal },
                itemId,
                ctx.runId,
            );
            if (!result.success) {
                throw new Error(result.reason ?? `Retry for item '${itemId}' did not succeed`);
            }
        },
    },
});

registry.registerTask(trickplayParamsSyncTask);

// ============================================================================
// listFailedItems
// ============================================================================

interface FailedItemResult {
    id: string;
    label: string;
    reason: string;
    detectedAt: null;
    subtitle?: string;
    firstSeen?: string;
    failureCount?: number;
    lastSeen?: string;
    taskRunId?: number;
}

interface ListResult {
    total: number;
    items: FailedItemResult[];
}

async function listFailedItems(
    sql: postgres.Sql,
    logger: PluginContext['logger'],
    { limit, offset }: { limit: number; offset: number },
): Promise<ListResult> {
    const clampedLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);

    // Predicate mirrors getTrickplayBacklogCounts `failed` bucket exactly:
    //   per-file granularity (JOIN media_file_items), media_type active movies/
    //   episodes, NOT has_params, marker_version >= PROCESSING_VERSION,
    //   marker_status = 'error'. Per-file granularity is required so the
    //   drilldown count matches the backlog count on items with multiple files.
    const [{ count }] = await sql<[{ count: number }]>`
        SELECT COUNT(*)::int AS count
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id,
             jsonb_each(COALESCE(mi.processing_state, '{}'::jsonb)) AS entry(key, value)
        WHERE mi.media_type = ANY(ARRAY['movie', 'episode'])
          AND mi.status = 'active'
          AND entry.key = 'trickplay-params:' || mfi.file_id::text
          AND (entry.value ->> 'version')::int >= ${PROCESSING_VERSION}
          AND entry.value ->> 'status' = 'error'
          AND NOT EXISTS (
              SELECT 1 FROM trickplay_params tp
              WHERE tp.media_item_id = mi.id
                AND tp.file_id = mfi.file_id
          )
    `;

    const rows = await sql<
        Array<{
            item_id: string;
            file_id: string;
            title: string;
            marker_key: string;
            marker_reason: string | null;
            audit_run_job_id: string | null;
            task_history_id: number | null;
        }>
    >`
        SELECT
            mi.id AS item_id,
            mfi.file_id::text AS file_id,
            mi.title,
            entry.key AS marker_key,
            entry.value ->> 'reason' AS marker_reason,
            entry.value ->> 'audit_run_job_id' AS audit_run_job_id,
            th.id AS task_history_id
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id,
             jsonb_each(COALESCE(mi.processing_state, '{}'::jsonb)) AS entry(key, value)
        LEFT JOIN (
            SELECT id, task_id FROM task_history
            UNION ALL
            SELECT original_id AS id, task_id FROM task_history_archive
            WHERE original_id IS NOT NULL
        ) th ON th.task_id = (entry.value ->> 'audit_run_job_id')
        WHERE mi.media_type = ANY(ARRAY['movie', 'episode'])
          AND mi.status = 'active'
          AND entry.key = 'trickplay-params:' || mfi.file_id::text
          AND (entry.value ->> 'version')::int >= ${PROCESSING_VERSION}
          AND entry.value ->> 'status' = 'error'
          AND NOT EXISTS (
              SELECT 1 FROM trickplay_params tp
              WHERE tp.media_item_id = mi.id
                AND tp.file_id = mfi.file_id
          )
        ORDER BY mi.id ASC, mfi.file_id ASC
        LIMIT ${clampedLimit} OFFSET ${safeOffset}
    `;

    const itemKeys = rows.map((r) => `${r.item_id}|${r.file_id}`);
    let aggregates = new Map<string, FailureAggregateRow>();
    try {
        aggregates = await getFailureAggregates(sql, PLUGIN_ID, itemKeys);
    } catch (err) {
        logger.warn(
            'listFailedItems aggregate fetch failed — serving list without timeline counts',
            { error: err instanceof Error ? err.message : String(err) },
        );
    }

    return {
        total: count,
        items: rows.map((r) => {
            const itemKey = `${r.item_id}|${r.file_id}`;
            const agg = aggregates.get(itemKey);
            return {
                id: itemKey,
                label: r.title,
                reason: (r.marker_reason ?? 'Trickplay failed').slice(0, MAX_REASON_LEN),
                detectedAt: null,
                taskRunId: r.task_history_id ?? undefined,
                ...(agg && {
                    firstSeen: agg.first_seen.toISOString(),
                    failureCount: agg.failure_count,
                    lastSeen: agg.last_seen.toISOString(),
                }),
            };
        }),
    };
}

// ============================================================================
// retryItem
// ============================================================================

/**
 * Admin-initiated retry for a single (media_item, file) trickplay pair.
 *
 * Mirrors the slice loop's per-file body: call
 * trickplayParamsService.getParams and route the outcome through the same
 * markTrickplayItemTried helper so the processing_state marker stays in a
 * shape listFailedItems / backlog counts recognize.
 *
 * Success is derived from whether a trickplay_params row now exists for
 * the pair — that's the predicate listFailedItems joins against, so the
 * row will naturally leave the failed bucket.
 */
async function retryOneTrickplayItem(
    ctx: {
        sql: postgres.Sql;
        logger: PluginContext['logger'];
        abortSignal: AbortSignal;
    },
    itemId: string,
    jobId?: string,
): Promise<{ success: boolean; reason?: string }> {
    // Composite id: `${mediaItemId}|${fileId}`
    const parts = itemId.split('|');
    if (parts.length !== 2) {
        return {
            success: false,
            reason: 'Invalid trickplay item id (expected mediaId|fileId)',
        };
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(parts[0]) || !uuidRe.test(parts[1])) {
        return { success: false, reason: 'Invalid UUID in trickplay item id' };
    }
    const [mediaId, fileId] = parts;

    const { sql, logger } = ctx;

    // Look up the (item, file) pair. Mirror the slice's JOIN — jellyfinId is
    // pulled via external_ids so the service has the provider-native hint
    // when DB-first misses. Also pull prior `audit_run_job_id` off the
    // existing trickplay-params:${fileId} marker so a retry that still
    // fails preserves the Phase D "Run #X →" link rather than overwriting
    // it with a synthetic retry jobId that has no task_history row.
    const [row] = await sql<
        Array<{
            id: string;
            file_id: string;
            jellyfin_id: string | null;
            prior_audit_job_id: string | null;
        }>
    >`
        SELECT
            mi.id,
            mfi.file_id,
            ei.external_id AS jellyfin_id,
            (mi.processing_state -> ('trickplay-params:' || mfi.file_id::text) ->> 'audit_run_job_id') AS prior_audit_job_id
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
        WHERE mi.id = ${mediaId}::uuid
          AND mfi.file_id = ${fileId}::uuid
          AND mi.status = 'active'
        LIMIT 1
    `;
    if (!row) {
        return { success: false, reason: 'Item/file pair not found' };
    }
    const auditJobId = row.prior_audit_job_id ?? undefined;
    void jobId;

    try {
        const result = await trickplayParamsService.getParams(
            row.id,
            row.jellyfin_id ?? undefined,
            { signal: ctx.abortSignal, fileId: row.file_id },
        );

        if (result) {
            return { success: true };
        }

        // No provider coverage — write the same marker the slice would.
        // `no-provider` is a terminal NON-failed state: listFailedItems'
        // predicate filters on status='error', so this write drops the
        // row out of the failed bucket. Return success so the UI removes
        // the row — returning failure here would leave a stale row visible
        // until the next full reload, contradicting the actual DB state.
        await markTrickplayItemTried(
            sql,
            row.id,
            row.file_id,
            PROCESSING_VERSION,
            'no-provider',
            'null-result',
            MAX_REASON_LEN,
        );
        return { success: true };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('Trickplay retry failed', {
            mediaId: row.id,
            fileId: row.file_id,
            error: reason,
        });
        // Best-effort marker write — if this itself throws (DB blip on
        // top of the original service error) we still want to return a
        // clean RetryItemResult to the endpoint rather than bubbling a
        // second error that obscures the first.
        try {
            const markerOk = await markTrickplayItemTried(
                sql,
                row.id,
                row.file_id,
                PROCESSING_VERSION,
                'error',
                reason,
                MAX_REASON_LEN,
                auditJobId,
            );
            if (markerOk) {
                await recordFailure(
                    sql,
                    PLUGIN_ID,
                    `${row.id}|${row.file_id}`,
                    reason,
                    auditJobId ?? null,
                );
            }
        } catch (markErr) {
            logger.warn('markTrickplayItemTried failed during retry', {
                mediaId: row.id,
                fileId: row.file_id,
                error: markErr instanceof Error ? markErr.message : String(markErr),
            });
        }
        return { success: false, reason: reason.slice(0, MAX_REASON_LEN) };
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Bulk-reconcile item-level stage rows against all currently linked files.
 *
 * LIMIT-batched (mirrors the `pruneUntilDrained` idiom in
 * `database-cleanup.ts`): each pass selects up to `LEGACY_DONE_BATCH_SIZE`
 * eligible `media_item_id`s into a CTE, then updates only those rows. A
 * single unbatched `UPDATE ... FROM media_items` with no LIMIT would hold
 * row locks against `media_item_stage_state` — a hot table other stages
 * write to constantly — for the duration of the whole sweep on a big
 * backlog; batching bounds each lock window to one pass. The predicate is
 * self-clearing (a row's `status` moves out of the sweepable set), so a plain
 * LIMIT-per-pass loop converges without needing to track a cursor or
 * pre-fetch a stable ID set.
 *
 * Loops until a pass updates fewer than a full batch (drained) or hits
 * `LEGACY_DONE_MAX_PASSES` (runaway guard — remainder drains next run) or
 * the abort signal fires between passes.
 */
async function drainLegacyDoneStageRows(
    sql: postgres.Sql,
    abortSignal: AbortSignal,
): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < LEGACY_DONE_MAX_PASSES; pass++) {
        if (abortSignal.aborted) break;

        const count = await reconcileTrickplayCoverageRows(
            sql,
            PROCESSING_VERSION,
            LEGACY_DONE_BATCH_SIZE,
        );
        total += count;
        if (count < LEGACY_DONE_BATCH_SIZE) break;
    }
    return total;
}

interface SliceOutcome {
    synced: number;
    errors: number;
    skipped: number;
    /**
     * Count of marker writes that landed this slice (no-provider / error
     * statuses). The success path doesn't need a marker — a
     * trickplay_params row drops it out of the predicate — so `synced`
     * always counts as advanced. Only the skipped/error paths route
     * through `markTrickplayItemTried` and can fail independently.
     */
    advancedMarkers: number;
}

/**
 * Process one slice of items: call the trickplay service (DB-first; on miss
 * queries the active provider plugin) for each item and tally outcomes.
 *
 * Items whose provider returns null are marked `no-provider` so subsequent
 * drains skip them — otherwise the first 200 uncacheable items trigger
 * drain's no-progress detector and the loop exits before reaching healthy
 * older rows. Thrown errors are marked `error` for the same reason; retry
 * on PROCESSING_VERSION bump. Marker writes go through
 * `markTrickplayItemTried` in the query module, which returns a boolean so
 * the drain can withhold `advanced` credit when the DB write itself failed.
 */
async function processSlice(
    sql: postgres.Sql,
    items: ItemWithoutTrickplay[],
    logger: PluginContext['logger'],
    abortSignal: AbortSignal,
    jobId: string,
): Promise<SliceOutcome> {
    let synced = 0;
    let errors = 0;
    let skipped = 0;
    let advancedMarkers = 0;

    for (const item of items) {
        if (abortSignal.aborted) break;

        try {
            const result = await trickplayParamsService.getParams(
                item.id,
                item.jellyfinId ?? undefined,
                { signal: abortSignal, fileId: item.fileId },
            );
            if (result) {
                synced++;
                try {
                    await reconcileTrickplayCoverageRows(sql, PROCESSING_VERSION, 1, item.id);
                } catch {
                    // Non-fatal — the next sweep tick can reconcile the mirror.
                }
            } else {
                skipped++;
                const ok = await markTrickplayItemTried(
                    sql,
                    item.id,
                    item.fileId,
                    PROCESSING_VERSION,
                    'no-provider',
                    'null-result',
                    MAX_REASON_LEN,
                );
                if (ok) {
                    advancedMarkers++;
                    try {
                        await reconcileTrickplayCoverageRows(sql, PROCESSING_VERSION, 1, item.id);
                    } catch {
                        // Non-fatal — the next sweep tick can reconcile the mirror.
                    }
                } else {
                    logger.warn('Failed to mark no-provider item', {
                        itemId: item.id,
                    });
                }
            }
        } catch (err) {
            logger.warn('Failed to sync trickplay params', {
                itemId: item.id,
                error: err instanceof Error ? err.message : String(err),
            });
            errors++;
            const errorReason = err instanceof Error ? err.message : 'provider-threw';
            const ok = await markTrickplayItemTried(
                sql,
                item.id,
                item.fileId,
                PROCESSING_VERSION,
                'error',
                errorReason,
                MAX_REASON_LEN,
                jobId,
            );
            if (ok) {
                advancedMarkers++;
                try {
                    await reconcileTrickplayCoverageRows(sql, PROCESSING_VERSION, 1, item.id);
                } catch {
                    // Keep the provider error and let the next sweep reconcile.
                }
                await recordFailure(
                    sql,
                    PLUGIN_ID,
                    `${item.id}|${item.fileId}`,
                    errorReason,
                    jobId ?? null,
                );
            } else {
                logger.warn('Failed to mark errored item', {
                    itemId: item.id,
                });
            }
        }
    }

    return { synced, errors, skipped, advancedMarkers };
}

/**
 * Delete every row from trickplay_params AND clear the processing_state
 * marker on media_items. Both are rebuildable by re-running the sync so a
 * full wipe is safe.
 *
 * The batch is atomic: a single CTE DELETEs from trickplay_params AND the
 * same statement UPDATEs media_items.processing_state in one server round-
 * trip. Either the whole batch lands or none of it — an abort or crash
 * between statements cannot leave orphan processing_state markers whose
 * trickplay_params rows were already deleted (the previous two-phase
 * implementation had exactly that failure mode).
 *
 * The union of distinct media_item_ids across the current batch's deleted
 * rows plus any items that have a stale marker but no params row (rare: a
 * previous crash mid-wipe) goes through the UPDATE, so the loop converges
 * even if the two tables started out of sync.
 */
async function wipeTrickplayParams(
    sql: postgres.Sql,
    logger: PluginContext['logger'],
    abortSignal: AbortSignal,
): Promise<void> {
    await drainWipe({
        abortSignal,
        batchSize: WIPE_BATCH_SIZE,
        fetchBatch: async (limit) => {
            // Fetch media_item_ids that need cleanup. Union two sources:
            //   1) items with at least one trickplay_params row (the normal
            //      case — delete params + clear marker in one tx)
            //   2) items that have a stale marker but no params row (e.g.
            //      leftover from a crashed two-phase wipe before this
            //      migration). Fetching both lets the atomic batch converge
            //      on a bad starting state in one pass.
            const rows = await sql<{ media_item_id: string }[]>`
                (
                    SELECT DISTINCT tp.media_item_id
                    FROM trickplay_params tp
                    LIMIT ${limit}
                )
                UNION
                (
                    SELECT mi.id AS media_item_id
                    FROM media_items mi
                    WHERE jsonb_typeof(mi.processing_state) = 'object'
                      AND EXISTS (
                        SELECT 1
                        FROM jsonb_object_keys(mi.processing_state) AS marker(key)
                        WHERE marker.key = 'trickplay-params'
                           OR marker.key LIKE 'trickplay-params:%'
                    )
                      AND NOT EXISTS (
                          SELECT 1 FROM trickplay_params tp
                          WHERE tp.media_item_id = mi.id
                      )
                    LIMIT ${limit}
                )
                LIMIT ${limit}
            `;
            return rows.map((r) => r.media_item_id);
        },
        wipeBatch: async (ids) => {
            // Atomic CTE: DELETE + UPDATE + single SELECT in one statement.
            // postgres.js sends this as one round-trip so PostgreSQL runs
            // both data-modifying steps inside the same implicit transaction
            // — either both writes commit or both roll back. That closes the
            // window where the previous two-phase wipe could leave orphan
            // processing_state markers when aborted mid-loop.
            const [row] = await sql<{ affected: number }[]>`
                WITH deleted AS (
                    DELETE FROM trickplay_params
                    WHERE media_item_id = ANY(${ids})
                    RETURNING media_item_id
                ),
                cleared AS (
                    UPDATE media_items mi
                    SET processing_state = COALESCE(
                            (
                                SELECT jsonb_object_agg(e.key, e.value)
                                FROM jsonb_each(
                                    COALESCE(mi.processing_state, '{}'::jsonb)
                                ) AS e(key, value)
                                WHERE e.key <> 'trickplay-params'
                                  AND e.key NOT LIKE 'trickplay-params:%'
                            ),
                            '{}'::jsonb
                        ),
                        updated_at = NOW()
                    WHERE mi.id = ANY(${ids})
                      AND jsonb_typeof(mi.processing_state) = 'object'
                      AND EXISTS (
                        SELECT 1
                        FROM jsonb_object_keys(mi.processing_state) AS marker(key)
                        WHERE marker.key = 'trickplay-params'
                           OR marker.key LIKE 'trickplay-params:%'
                      )
                    RETURNING mi.id
                )
                SELECT COUNT(DISTINCT v.id)::int AS affected
                FROM (
                    SELECT media_item_id AS id FROM deleted
                    UNION
                    SELECT id FROM cleared
                ) v
            `;
            return row?.affected ?? 0;
        },
        logger,
        label: 'Trickplay params',
    });
}
