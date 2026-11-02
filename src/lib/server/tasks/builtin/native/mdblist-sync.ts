// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * mdblist-sync — enriches discovery items with MDBList ratings, keywords,
 * and streaming availability. Wraps `MDBListSyncGenerator` from
 * `src/lib/server/ai/`.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
} from '../../../database/queries/stage-state.queries.js';
import { findEmbeddingCoverageTableBacklog } from '../../../database/queries/embeddings.queries.js';
import { config, getAuthoritativeStageIds } from '$lib/server/config.js';
import { watchHostProviderKey, MDBLIST_KEY_RELEASE } from '../../provider-key-release.js';

const inputSchema = z
    .object({
        limit: z.number().int().min(1).max(50_000).optional(),
        mediaType: z.enum(['movie', 'tv', 'all']).optional(),
        fullRefresh: z.boolean().optional(),
        refreshAfterHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 30)
            .optional(),
    })
    .passthrough();

type MdblistSyncInput = z.infer<typeof inputSchema>;

interface MdblistSyncResult {
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
}

export const mdblistSyncTask = defineTask<MdblistSyncInput, MdblistSyncResult>({
    id: 'mdblist-sync',
    purpose: 'library',
    name: 'Enrich with MDBList',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    schedule: { every: '12h', runOnStartup: false },
    // `feedsInto` is MONITORING ONLY (admin health-probe edge) — it does NOT
    // enqueue or re-embed the downstream. Do NOT add 'library-embeddings' here
    // expecting late MDBList data to re-embed the library: that already happens
    // by a different path — storeMDBListData() → aggregateMetadataForMedia()
    // rewrites the `aggregated` provider_metadata row → its DB trigger emits
    // `metadata.changed` (gated on mdblist_keywords) → library/discovery
    // embeddings (invalidatedBy: metadata.changed) re-run. See the SDK
    // `feedsInto` docstring.
    feedsInto: ['discovery-embeddings'],

    identityFor: (input) => `tier-${input.mediaType ?? 'all'}`,
    scope: 'global',
    // Singleton guard: spends real MDBList API quota. Without exclusiveWith,
    // the scheduler's narrow double-fire window (fast-completing run + failed
    // scheduler_state advance) can spawn a second concurrent sweep for the
    // same tier, doubling MDBList spend for no extra coverage. identityFor is
    // stable per tier — the scheduled fire (`{}` input) always resolves to
    // 'tier-all', so this only collides with another 'tier-all' run; a
    // per-mediaType manual trigger uses a distinct tier identity and is
    // unaffected. ttl exceeds the 60m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '70m' },
    // Mass-enrichment — see bulk resource class.
    resourceClass: 'bulk',
    inputSchema,

    coversStages: [
        {
            id: 'mdblist-sync',
            appliesTo: ['movie', 'series'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            terminalDisposition: [
                {
                    // GLOBAL precondition: MDBList must be configured before any
                    // pending row can advance. When no API key has been entered,
                    // the execute() generator early-returns without firing any
                    // onSuccess/onSkip callback, so seeded media_item_stage_state
                    // rows for this stage would sit pending forever (dormant red
                    // backlog). On false the framework drains the whole stage to
                    // skipped_transient and retries in 12h.
                    //
                    // The check is ENV-ONLY (`config.MDBLIST_API_KEY`) on purpose
                    // — it must match what the sync can actually USE.
                    // MDBListApiService reads only `config.MDBLIST_API_KEY`
                    // (mdblist-api.ts), so a key supplied solely as a
                    // plugin_secret on the provider does NOT let the sync run;
                    // probing the secret here would return "configured" and
                    // wedge rows pending while the generator can never drain
                    // them. (The on-demand provider has its own secret path; the
                    // attention nudge separately treats secret-or-env as
                    // configured for the provider's sake.)
                    kind: 'global-guard' as const,
                    ruleId: 'mdblist-sync-provider-configured',
                    reason: 'no-mdblist-api-key-configured',
                    retryAfterMs: 12 * 60 * 60 * 1000,
                    guard: async (): Promise<boolean> => config.MDBLIST_API_KEY.trim().length > 0,
                },
                {
                    // C3 fix-round-2 (2026-09-25 security review): mirrors the
                    // 'metadata-locked' rule on the `metadata-update` stage
                    // (metadata-sync.ts) — same reasoning applies here. Without
                    // this rule a locked item's row stays `pending` forever
                    // (re-enqueued every sweep tick for a write
                    // `upsertMdblistMetadata` already refuses to make).
                    // `skipped_transient`, not `skipped_permanent`: unlock fires
                    // no invalidation event. Instead `unlockMediaItem` and
                    // `bulkSetLockMediaItems` (media-items.queries.ts) release
                    // rows skipped with this reason back to `pending` with
                    // `next_eligible_at` cleared, in the unlock statement itself.
                    // That matters here: this stage's `candidateSource`
                    // (`findEmbeddingCoverageTableBacklog`, embeddings.queries.ts)
                    // filters on `next_eligible_at IS NULL OR next_eligible_at <=
                    // now()`, so a row left parked would wait out the full
                    // `retryAfterMs` below (up to 6h) after an unlock. The window
                    // only throttles how often a still-locked row is re-stamped.
                    kind: 'predicate' as const,
                    ruleId: 'metadata-locked',
                    disposeAs: 'skipped_transient' as const,
                    reason: 'metadata-locked',
                    retryAfterMs: 6 * 60 * 60 * 1000,
                    excludes: (sql) => sql`mi.metadata_locked`,
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'fresh-mdblist-data',
                    disposeAs: 'completed' as const,
                    reason: 'mdblist-already-fresh',
                    excludes: (sql) => sql`EXISTS (
                SELECT 1 FROM provider_metadata pm
                 WHERE pm.media_id = mi.id
                   AND pm.provider = 'mdblist'
                   AND pm.metadata->>'mdblist_score' IS NOT NULL
                   AND pm.updated_at >= now() - interval '168 hours'
            )`,
                },
            ],
        },
    ],

    timeout: { hard: '60m', soft: '55m' },
    cost: { kind: 'api_calls' },

    async execute(ctx) {
        ctx.logger.info('MDBList sync started', {
            mediaType: ctx.input.mediaType ?? 'all',
            limit: ctx.input.limit,
            fullRefresh: ctx.input.fullRefresh === true,
        });
        // Optional-integration early skip: if no MDBList key is configured,
        // gracefully skip instead of running the generator (which would
        // early-return with a misleading errors:1). The global-guard above
        // drains seeded pending rows; this just avoids the noisy run record.
        // ENV-ONLY to match MDBListApiService (mdblist-api.ts), which is the
        // only key source the sync can actually use — see the guard comment.
        if (config.MDBLIST_API_KEY.trim().length === 0) {
            ctx.logger.info('MDBList sync skipped — no API key configured');
            return {
                success: true,
                itemsProcessed: 0,
                result: { processed: 0, updated: 0, skipped: 0, errors: 0 },
            };
        }
        return withApiCallSpend(ctx, async () => {
            const useCoverageTable = getAuthoritativeStageIds().has('mdblist-sync');

            const onMdblistSuccess = useCoverageTable
                ? async (mediaId: string): Promise<void> => {
                      try {
                          await upsertCompletedRow(ctx.sql as never, {
                              mediaItemId: mediaId,
                              stageId: 'mdblist-sync',
                              processingVersion: 1,
                          });
                      } catch {
                          // Non-fatal — coverage write failure must not abort sync
                      }
                  }
                : undefined;

            // Mirror callback for items the upstream batch returned `null` for
            // (MDBList has no data for them). Without tombstoning, those items
            // cycle back into the next slice every run forever — there is no
            // upstream signal that ever flips. Identity-change invalidation
            // reseeds on re-id, so this isn't a dead-end.
            const onMdblistSkip = useCoverageTable
                ? async (mediaId: string): Promise<void> => {
                      try {
                          await upsertSkippedPermanentRow(ctx.sql as never, {
                              mediaItemId: mediaId,
                              stageId: 'mdblist-sync',
                              processingVersion: 1,
                              skippedReason: 'no-data-upstream',
                          });
                      } catch {
                          // Non-fatal — next sweep tick will retry coverage write
                      }
                  }
                : undefined;

            const { MDBListSyncGenerator } = await import('../../../ai/mdblist-sync-generator.js');
            const generator = new MDBListSyncGenerator({
                sql: ctx.sql,
                limit: ctx.input.limit,
                mediaType: ctx.input.mediaType ?? 'all',
                fullRefresh: ctx.input.fullRefresh === true,
                refreshAfterHours: ctx.input.refreshAfterHours,
                // Forward the task signal so the SDK `invokeProviderBatchLookup`
                // calls inside `processBatch` cancel mid-flight when the task is
                // aborted. The generator.abort() bridge below remains as a
                // belt-and-braces cancellation path for progress polling.
                signal: ctx.signal,
                onSuccess: onMdblistSuccess,
                onSkip: onMdblistSkip,
                ...(useCoverageTable && {
                    candidateSource: (sql, limit) =>
                        findEmbeddingCoverageTableBacklog(sql, 'mdblist-sync', limit),
                    stageId: 'mdblist-sync',
                }),
            });

            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            ctx.signal.addEventListener(
                'abort',
                () => {
                    void generator.abort();
                },
                { once: true },
            );

            // Bridge generator progress polling to ctx.reportProgress.
            const progressInterval = setInterval(() => {
                const p = generator.getProgress();
                ctx.reportProgress(p.processedItems ?? 0, p.totalItems ?? 0, p.currentItem);
            }, 2000);

            try {
                const syncResult = await generator.sync();
                // Request volume is recorded by the withApiCallSpend wrapper via the
                // instrumented ctx.http / safeFetch path the mdblist provider uses
                // (per-host), so we no longer spend syncResult.requestCount here.
                //
                // Monitoring-blindness guard: the old gate (`errors.length <= 10`,
                // absolute, ignoring processed) reported success:true when a total
                // MDBList outage accumulated errors — hiding the outage from
                // alerting and the circuit breaker. A merely returned result (even
                // success:false) is invisible too: the runner records a returned run
                // as COMPLETED and reports breaker SUCCESS.
                //
                // The obvious `processed === 0` test is UNREACHABLE for the outage
                // path: when `invokeProviderBatchLookup` throws, the batch-catch
                // marks EVERY item in the failed batch processed++/skipped++, so a
                // total outage still reports processed = N (never 0). Instead gate
                // on the fallback counter: when every processed item came ONLY from
                // the batch-failure fallback (`processedViaFallback === processed`)
                // AND nothing was stored (`updated === 0`) AND errors accumulated,
                // every attempted batch failed → genuine outage. Throw transient so
                // the run fails, retries, and the breaker can trip. Genuine no-work
                // (empty/fresh backlog → 0 processed, 0 errors) and partial success
                // (updated > 0, or some batches reached upstream) return success.
                if (
                    syncResult.errors.length > 0 &&
                    syncResult.updated === 0 &&
                    syncResult.processedViaFallback === syncResult.processed
                ) {
                    // Distinguish MDBList's free-tier rate limit (self-healing, expected
                    // under normal load) from a genuine upstream outage/bug — the two
                    // need different operator responses, so the message operators see
                    // on the circuit-open alert shouldn't conflate them.
                    const isRateLimited = syncResult.errors.some((e) => /rate.?limit/i.test(e));
                    throw new TaskError({
                        message: isRateLimited
                            ? `mdblist-sync: rate limit reached (mdblist.com free-tier quota) — ` +
                              `resumes automatically once the quota window resets ` +
                              `(${syncResult.processed} item(s) deferred).`
                            : `mdblist-sync: upstream outage — every attempted batch failed ` +
                              `(${syncResult.processed} item(s) via failure-fallback, 0 updated, ` +
                              `${syncResult.errors.length} error(s)).`,
                        kind: 'transient',
                    });
                }
                ctx.logger.info('MDBList sync finished', {
                    processed: syncResult.processed,
                    updated: syncResult.updated,
                    skipped: syncResult.skipped,
                    errors: syncResult.errors.length,
                });
                return {
                    success: true,
                    itemsProcessed: syncResult.processed,
                    result: {
                        processed: syncResult.processed,
                        updated: syncResult.updated,
                        skipped: syncResult.skipped,
                        errors: syncResult.errors.length,
                    },
                };
            } catch (err) {
                if (ctx.signal.aborted) {
                    return {
                        success: false,
                        itemsProcessed: 0,
                        stopReason: 'aborted',
                    };
                }
                throw err;
            } finally {
                clearInterval(progressInterval);
            }
        });
    },
});

registry.registerTask(mdblistSyncTask);

// A key saved in Settings or the setup wizard: release the rows the guard above
// parked for 12h and start mdblist-sync and curated-lists-sync now.
watchHostProviderKey(() => config.MDBLIST_API_KEY ?? '', MDBLIST_KEY_RELEASE);
