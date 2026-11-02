// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * metadata-sync + metadata-update — maintenance metadata backfill tasks.
 *
 * `metadata-sync` backfills a missing original_title via
 * MetadataUpdateGenerator (the TMDB discovery sweep belongs to
 * tmdb-metadata-sync). `metadata-update` runs
 * `syncMissingMetadata()` which fills IMDB IDs / cast / crew / keywords on
 * existing items.
 *
 * Both ids are used by the admin endpoints /api/ai/sync-metadata and
 * /api/ai/update-metadata.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
} from '../../../database/queries/stage-state.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import {
    buildProviderFilterUnsafe,
    buildMetadataProviderOrder,
} from '../../../database/queries/builders/provider-metadata.builder.js';
import { classifyInfraError } from '../../infra-retry.js';

const ADMIN_ABORT_REASON = 'Cancelled by admin';
const SOFT_TIMEOUT_REASON = 'metadata-sync soft-timeout — winding down before hard cap';

// ────────────────────────────────────────────────────────────────────────────
// metadata-sync — original_title backfill
// ────────────────────────────────────────────────────────────────────────────

const syncInputSchema = z
    .object({
        batchSize: z.number().int().min(1).max(10_000).optional(),
    })
    .passthrough();

/** Options of the discovery sweep this task no longer runs (tmdb-metadata-sync does). */
const DISCOVERY_SWEEP_OPTIONS = [
    'maxMovies',
    'maxSeries',
    'minRating',
    'minVotes',
    'minPopularity',
    'missingOnly',
    'fetchDetails',
] as const;

type MetadataSyncInput = z.infer<typeof syncInputSchema>;

export const metadataSyncTask = defineTask<MetadataSyncInput, unknown>({
    id: 'metadata-sync',
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'Fill Missing TMDB Data',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
        envOverride: 'SYNC_METADATA_INTERVAL',
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    // Singleton guard: this task spends real TMDB API quota (cost: 'api_calls')
    // for the duration of a multi-hour discovery + backfill sweep. Without
    // exclusiveWith, the scheduler's narrow double-fire window (a run that
    // completes faster than the bucket-claim TTL, combined with a failed
    // scheduler_state advance) can spawn a second concurrent 'global-catchup'
    // sweep that doubles TMDB spend for no extra coverage. identityFor is
    // mode-suffixed but stable for the scheduled entry point ('global-catchup'
    // — the scheduler always fires with `{}`, same as watch-sync-pull/push);
    // ttl exceeds the 4h hard timeout with margin. Must be a single-unit
    // duration string (SDK's exclusiveWith.ttl validator rejects compound
    // forms like '4h20m', unlike timeout.hard/soft).
    exclusiveWith: { scope: 'global', ttl: '5h' },
    // Hard timeout is 4h — far above the 5-minute fast-path threshold.
    // `maintenance` is for short housekeeping (seconds); this task occupies
    // a maintenance slot for hours, starving cache-cleanup / oauth-cleanup.
    // `bulk` is the correct class for long API-bound enrichment sweeps.
    resourceClass: 'bulk',
    inputSchema: syncInputSchema,

    // 4h hard / 235m (3h55m) soft is a realistic ceiling for a full TMDB
    // discovery sweep + original_title backfill on a 90k-item catalog.
    // The previous 30m hard timeout was hitting daily — observed 30-34
    // min runtimes for the routine sweep, with one 9.9h success when
    // the watchdog didn't fire. OSS operators on smaller libraries can
    // tune via LUMASTRA_METADATA_SYNC_HARD_TIMEOUT / _SOFT_TIMEOUT.
    //
    // Duration strings accept compound forms (e.g. '3h45m', '4h', '1w2d3h')
    // — see tasks/duration.ts (the single parser).
    timeout: { hard: '4h', soft: '235m' },
    cost: { kind: 'api_calls' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            // No discovery sweep here. This task used to run the same
            // TMDBMetadataSyncGenerator.sync() sweep that tmdb-metadata-sync
            // already runs on its own schedule — a third full-catalog detail refetch per
            // day (~9.7k TMDB requests), and running alongside the 16:15
            // tmdb-metadata-sync sweep it pushed that one past its 60m hard cap
            // (hard-failed runs record no api_calls, so that spend was invisible
            // on the cost page). What is left is the original_title backfill.
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }

            const ignored = DISCOVERY_SWEEP_OPTIONS.filter((key) => key in ctx.input);
            if (ignored.length > 0) {
                ctx.logger.warn(
                    'metadata-sync: discovery-sweep options ignored — the sweep runs in tmdb-metadata-sync',
                    { ignored },
                );
            }

            const { MetadataUpdateGenerator } = await import('../../../ai/tmdb-metadata-sync.js');
            const update = new MetadataUpdateGenerator();
            // The generator only halts via abort(); route both cancellation and
            // the soft deadline through it. A soft-deadline stop does NOT set
            // ctx.signal, so the run still completes and the next run resumes.
            ctx.signal.addEventListener('abort', () => update.abort(ADMIN_ABORT_REASON), {
                once: true,
            });
            ctx.softSignal?.addEventListener('abort', () => update.abort(SOFT_TIMEOUT_REASON), {
                once: true,
            });
            if (ctx.softSignal?.aborted) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }

            const result = await update.update({ batchSize: ctx.input.batchSize, sql: ctx.sql });

            // A graceful early stop that made progress reports `success: true`
            // with `stopReason: 'aborted'` so it stays out of the admin ⚠ chip.
            if (update.isAborted() && result.total_fetched > 0) {
                return {
                    success: true,
                    itemsProcessed: result.updated,
                    stopReason: 'aborted',
                    result,
                };
            }

            return {
                success: result.success,
                itemsProcessed: result.updated,
                result,
            };
        });
    },
});

// ────────────────────────────────────────────────────────────────────────────
// metadata-update — fill missing IMDB IDs / cast / crew / keywords / networks
// ────────────────────────────────────────────────────────────────────────────

const updateInputSchema = z
    .object({
        batchSize: z.number().int().min(1).max(10_000).optional(),
        updateEmbeddings: z.boolean().optional(),
        missingFields: z
            .array(
                z.enum([
                    'imdb_id',
                    'actors',
                    'directors',
                    'producers',
                    'writers',
                    'keywords',
                    'networks',
                ]),
            )
            .optional(),
    })
    .passthrough();

type MetadataUpdateInput = z.infer<typeof updateInputSchema>;

/**
 * No-gap `excludes` predicate for the `metadata-update` stage.
 *
 * This MUST be the EXACT negation of the candidate query's missing-fields
 * predicate in `ai/sync-missing-metadata.ts`, whose default is
 * `['imdb_id', 'actors', 'directors', 'keywords']` — FOUR fields. This comment
 * claimed three for a long time while the code said four, which is precisely the
 * gap that let keyword-only candidates be re-selected nightly and never drained.
 * `keywords` is now included in the drain below, gated on `keywords_synced_at`
 * exactly as the candidate side gates it, so a keyword-only gap resolves after one
 * pass instead of recurring forever OR being disposed unfetched. The framework
 * disposition runner appends this fragment after `AND` inside an
 * `UPDATE media_item_stage_state s ... FROM media_items mi WHERE
 * mi.id = s.media_item_id AND ... AND <excludes>` — it cannot inject the
 * candidate query's LATERAL join. So we reproduce the lateral chain
 * selection as a correlated subquery: pick the SAME single highest-priority
 * `provider_metadata` row (provider chain filter + provider-order CASE,
 * `LIMIT 1`) and assert all three default fields are present-and-non-empty.
 *
 * Faithfulness to the candidate's `conditionFragments`:
 *   - imdb_id  missing ⇔ `metadata->>'imdb_id' IS NULL`
 *   - actors   missing ⇔ `jsonb_array_length(COALESCE(metadata->'actors','[]')) = 0`
 *   - directors missing ⇔ same shape
 * A row is a candidate iff ANY of those hold; the drain therefore fires iff
 * NONE hold — i.e. imdb_id non-null AND actors non-empty AND directors
 * non-empty AND the keywords fragment satisfied, on the chain-selected row.
 * Using value-presence (not JSONB key-existence) avoids over-disposing rows
 * whose chain metadata has `"actors": []`.
 *
 * `keywords` was once omitted here on purpose, because including it wedged
 * complete-but-keyword-less rows: TMDB genuinely has no keywords for many
 * titles, so those rows would never satisfy the drain and never leave the
 * candidate set. `keywords_synced_at` dissolves that dilemma — it distinguishes
 * "we asked and the answer was none" from "we never asked" — so keywords are
 * now part of the drain, and the two predicates are true complements again.
 * Omitting it was not free: an item the sweep drained BEFORE eager processing
 * reached it had its stage disposed while its keywords were still unfetched and
 * its marker still null, so nothing would ever fetch them and browse/keywords
 * missed the title permanently. Which items that hit was decided by a race
 * between the sweep and eager processing.
 *
 * The provider filter and ORDER BY CASE come from the shared
 * provider-metadata builder (validated against the provider allowlist), so the
 * chain stays consistent with the candidate query's
 * `buildMetadataLateralJoinFragment(sql)`.
 */
function buildNoGapMetadataExcludes(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    // Both helpers validate provider names against the allowlist before
    // interpolation (assertSafeProviderName); no untrusted input reaches SQL.
    const providerFilter = sql.unsafe(buildProviderFilterUnsafe());
    const providerOrder = sql.unsafe(buildMetadataProviderOrder());
    return sql`mi.media_type IN ('movie', 'tv') AND EXISTS (
        SELECT 1 FROM (
            SELECT metadata
              FROM provider_metadata
             WHERE media_id = mi.id AND ${providerFilter}
             ORDER BY ${providerOrder}
             LIMIT 1
        ) pm
        WHERE pm.metadata->>'imdb_id' IS NOT NULL
          AND jsonb_array_length(COALESCE(pm.metadata->'actors', '[]'::jsonb)) > 0
          AND jsonb_array_length(COALESCE(pm.metadata->'directors', '[]'::jsonb)) > 0
          -- Exact negation of the candidate's keywords fragment: candidate iff
          -- (marker IS NULL AND some keyword gap), so drain iff
          -- (marker IS NOT NULL OR no keyword gap).
          AND (
              pm.metadata->'keywords_synced_at' IS NOT NULL
              OR (
                  jsonb_array_length(COALESCE(pm.metadata->'keywords', '[]'::jsonb)) > 0
                  AND jsonb_array_length(COALESCE(pm.metadata->'tmdb_keyword_ids', '[]'::jsonb)) > 0
                  AND jsonb_array_length(COALESCE(pm.metadata->'keyword_slugs', '[]'::jsonb)) > 0
              )
          )
    )`;
}

export const metadataUpdateTask = defineTask<MetadataUpdateInput, unknown>({
    id: 'metadata-update',
    purpose: 'library',
    name: 'Update Existing Metadata',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // No schedule — admin-triggered only (per the deleted queue convention).
    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    // Hard timeout is 60m — above the 5-minute fast-path threshold.
    // Moved from `maintenance` to `bulk` so short housekeeping tasks
    // (cache-cleanup, oauth-cleanup) are not starved.
    resourceClass: 'bulk',
    inputSchema: updateInputSchema,

    // Coverage applies to top-level catalog items only — movies and series.
    // The underlying `syncMissingMetadata` SQL filters on
    // `mi.media_type IN ('movie', 'tv')`, so seeding episode stage rows for
    // this stage results in 94k+ pending rows that never drain (observed on
    // preprod 2026-05-29: episode backlog dwarfed movie/series backlog and
    // inflated the admin ETA from real ~9h to fake 4 days). Episode-level
    // metadata is a separate feature — when added, give it its own stage.
    // Invalidated by `identity` because a re-identification produces a
    // different TMDB row and therefore different cast/crew/keywords.
    coversStages: [
        {
            id: 'metadata-update',
            appliesTo: ['movie', 'series'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            terminalDisposition: [
                {
                    // C3 fix-round-2 (2026-09-25 security review): a locked item is
                    // filtered out of syncMissingMetadata's own candidate SQL (it
                    // never matches `mi.metadata_locked = false`), so without this
                    // rule its `completeItem()` never runs and the row stays
                    // `pending` forever — re-enqueued every sweep tick for a write
                    // that can never land, and tripping the stuck-pending health
                    // signal. Placed FIRST in the array so a locked item that also
                    // matches `no-primary-external-id` still lands here: the
                    // `skipped_transient` write sets `next_eligible_at` into the
                    // future, and the L4 guard on the later `skipped_permanent`
                    // rule then refuses to re-stamp it this same pass (see
                    // `stage-disposition-runner.ts`'s `runPredicate`). L4 only
                    // guards `skipped_transient`/`skipped_permanent` re-stamping —
                    // it does NOT protect this row from every later rule in the
                    // array. `no-gap-metadata` below (`disposeAs: 'completed'`) has
                    // no L4 check at all and CAN still dispose this same row to
                    // `completed` in the same pass if its own `excludes` also
                    // match (i.e. the item already has every metadata field
                    // present). That is harmless: a locked item whose metadata is
                    // already complete correctly ends up `completed` either way.
                    //
                    // `skipped_transient`, not `skipped_permanent`: unlocking sets
                    // no invalidation event (no `metadata.changed`-on-lock trigger,
                    // and this stage doesn't listen for `metadata.changed` anyway),
                    // so a `skipped_permanent` row would stay stranded even after
                    // unlock. `skipped_transient` self-heals instead — the
                    // candidate SQL in `sync-missing-metadata.ts` already treats
                    // `skipped_transient` the same as `pending` (no
                    // `next_eligible_at` check there), so the very next time this
                    // task actually runs against an unlocked item, it is picked up
                    // and processed normally. The retry window below only throttles
                    // how often the DISPOSITION itself re-stamps a still-locked row;
                    // it does not gate reprocessing once unlocked. (The unlock
                    // queries also release this row to `pending` directly — see
                    // `unlockMediaItem` in media-items.queries.ts.)
                    kind: 'predicate',
                    ruleId: 'metadata-locked',
                    disposeAs: 'skipped_transient',
                    reason: 'metadata-locked',
                    retryAfterMs: 6 * 60 * 60 * 1000,
                    excludes: (sql) => sql`mi.metadata_locked`,
                },
                {
                    kind: 'predicate',
                    ruleId: 'no-gap-metadata',
                    disposeAs: 'completed',
                    reason: 'all-metadata-fields-present',
                    excludes: buildNoGapMetadataExcludes,
                },
                {
                    kind: 'predicate',
                    ruleId: 'no-primary-external-id',
                    disposeAs: 'skipped_permanent',
                    reason: 'no-primary-external-id',
                    excludes: (sql) => sql`mi.media_type IN ('movie', 'tv') AND NOT EXISTS (
                    SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id
                      AND ei.provider = 'tmdb' AND ei.media_type = mi.media_type
                )`,
                },
            ],
        },
    ],

    timeout: { hard: '60m', soft: '55m' },
    cost: { kind: 'api_calls' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            const { syncMissingMetadata } = await import('../../../ai/sync-missing-metadata.js');
            const useCoverageTable = getAuthoritativeStageIds().has('metadata-update');
            const onItemSuccess = useCoverageTable
                ? async (mediaId: string): Promise<void> => {
                      try {
                          await upsertCompletedRow(ctx.sql, {
                              mediaItemId: mediaId,
                              stageId: 'metadata-update',
                              processingVersion: 1,
                          });
                      } catch {
                          // Non-fatal — coverage write failure must not abort sync
                      }
                  }
                : undefined;
            const onItemNotFound = useCoverageTable
                ? async (mediaId: string): Promise<void> => {
                      await upsertSkippedPermanentRow(ctx.sql, {
                          mediaItemId: mediaId,
                          stageId: 'metadata-update',
                          processingVersion: metadataUpdateTask.processingVersion,
                          skippedReason: 'provider-id-not-found',
                      });
                  }
                : undefined;
            const result = await syncMissingMetadata({
                batchSize: ctx.input.batchSize,
                updateEmbeddings: ctx.input.updateEmbeddings,
                missingFields: ctx.input.missingFields,
                // Pass the task's abort signal through. The sync loop now
                // checks it at each batch boundary so a watchdog timeout
                // releases the worker promptly instead of running until the
                // current item finishes. Defaults to 4 in-flight items per
                // batch (capped to TMDB's 50 req/sec budget by the inner
                // 100 ms throttle); operators can dial back to 1 via env
                // override if their TMDB tier is lower.
                signal: ctx.signal,
                onProgress: (processed, total, currentItem) => {
                    if (ctx.signal.aborted) {
                        throw new Error(ADMIN_ABORT_REASON);
                    }
                    ctx.reportProgress(processed, total, currentItem);
                },
                onItemSuccess,
                onItemNotFound,
                sql: ctx.sql,
            });

            return {
                success: result.success,
                itemsProcessed: result.updated_count,
                result,
            };
        });
    },
});

registry.registerTask(metadataSyncTask);
registry.registerTask(metadataUpdateTask);
