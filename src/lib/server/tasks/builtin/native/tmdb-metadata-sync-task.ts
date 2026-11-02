// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * tmdb-metadata-sync — TMDB discovery import.
 *
 * Pulls popular / top-rated / trending movies + TV into the catalog for
 * recommendations. Wraps `TMDBMetadataSyncGenerator` from
 * `src/lib/server/ai/tmdb-metadata-sync.ts`.
 *
 * NOTE on id: the tutorial-only exemplar at `native/tmdb-metadata-sync.ts`
 * registers id `tmdb-metadata` (a demo that fetches `/movie/popular` and
 * writes nothing). This real task uses id `tmdb-metadata-sync` because that
 * is the id every caller already references (media-lifecycle.service.ts for
 * movies, /api/ai/sync-tmdb-metadata, and the sync-mdblist chain).
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { isSeries, isEpisode } from '$lib/server/utils/media-types.js';
import {
    upsertCompletedRow,
    healMisappliedFailedPermanentRows,
} from '../../../database/queries/stage-state.queries.js';
import { isFreshUnconfiguredInstall } from '../../../database/queries/onboarding.queries.js';
import { getAuthoritativeStageIds, isDiscoveryCatalogEnabled } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { TmdbApiError } from '$lib/server/providers/implementations/tmdb/client.js';
import { classifyInfraError } from '../../infra-retry.js';
import { hasRecentDeepDiscoveryListing } from '../../../database/queries/ai-sync.queries.js';

const SOFT_TIMEOUT_REASON = 'tmdb-metadata-sync soft-timeout — winding down before hard cap';

/** A deep discovery listing (every list paged to its cap) runs at most weekly. */
const DEEP_LIST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const inputSchema = z
    .object({
        maxMovies: z.number().int().min(1).max(50_000).optional(),
        maxSeries: z.number().int().min(1).max(50_000).optional(),
        minRating: z.number().min(0).max(10).optional(),
        minVotes: z.number().int().min(0).optional(),
        minPopularity: z.number().min(0).optional(),
        missingOnly: z.boolean().optional(),
        fetchDetails: z.boolean().optional(),
        /**
         * Single-item targeted sync. When provided, the discovery sweep
         * is skipped and the named media item is refreshed in place.
         * Used by the metadata-matched lifecycle hook for movies.
         */
        mediaItemId: z.string().optional(),
        force: z.boolean().optional(),
        forceChildren: z.boolean().optional(),
        /** Force a deep discovery listing on this run (otherwise weekly). */
        deepList: z.boolean().optional(),
    })
    .passthrough();

type TmdbMetadataSyncInput = z.infer<typeof inputSchema>;

interface TmdbMetadataSyncTaskResult {
    total_fetched: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    message: string;
    /** Discovery sweeps only; read by hasRecentDeepDiscoveryListing. */
    listDepth?: 'deep' | 'shallow';
}

export const tmdbMetadataSyncRealTask = defineTask<
    TmdbMetadataSyncInput,
    TmdbMetadataSyncTaskResult
>({
    id: 'tmdb-metadata-sync',
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'Import TMDB Discovery',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // Daily: the discovery lists barely move in 12h, and each sweep pages them.
    schedule: { every: '24h', runOnStartup: false },
    feedsInto: ['discovery-embeddings', 'library-embeddings'],

    identityFor: (input) => {
        if (input.mediaItemId) return `item-${input.mediaItemId}`;
        return 'global';
    },
    scope: 'global',
    // Singleton guard for the scheduled 'global' discovery sweep — it spends
    // real TMDB API quota. Without exclusiveWith, the scheduler's narrow
    // double-fire window (fast-completing run + failed scheduler_state
    // advance) can spawn a second concurrent 'global' sweep that doubles TMDB
    // spend for no extra coverage. Only collides with itself: per-item runs
    // (`item-<id>`) use a distinct identity and are unaffected. ttl exceeds
    // the 60m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '70m' },
    // Hard timeout is 60m — well above the 5-minute fast-path threshold.
    // Using `bulk` keeps the io pool available for user-visible ingest
    // tasks (media-probe, image-sync, chapter-sync) which must stay snappy.
    resourceClass: 'bulk',
    inputSchema,

    // appliesTo is movies-only because the per-item execute() path explicitly
    // rejects series and episodes (those use series-sync instead). Previously
    // this claimed ['movie','series','episode']; stage-state seeded coverage
    // rows for every episode in the library, the sweeper enqueued them, and
    // every single one failed with "per-item path is for movies only" — a
    // load-bearing source of bogus failed_transient noise on the Ingest Map.
    coversStages: [
        {
            id: 'tmdb-metadata-sync',
            appliesTo: ['movie'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            terminalDisposition: {
                kind: 'self-terminal',
                ruleId: 'tmdb-metadata-sync-self-terminal',
            },
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
            // Fresh-install guard: a brand new instance with zero library
            // paths and no admin account yet has no operator-expressed intent
            // to populate a catalog. Without this, the scheduled discovery
            // sweep below fills media_items with thousands of has_files=false
            // rows and spends TMDB quota before anyone has run /setup. Skip
            // cleanly (normal success, zero work) rather than throwing — this
            // is not a failure, and every scheduled run re-checks live state,
            // so the very next run proceeds normally once a library exists or
            // setup completes. Deployments that pre-configure a TMDB key to
            // warm the catalog before finishing /setup are unaffected only if
            // they've also added a library or provisioned an admin — a
            // missing TMDB key is a separate, unrelated failure mode
            // (TmdbApiError) and is not touched here.
            if (await isFreshUnconfiguredInstall(ctx.sql)) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        total_fetched: 0,
                        created: 0,
                        updated: 0,
                        skipped: 0,
                        errors: 0,
                        message: 'skipped: no libraries configured yet',
                    },
                };
            }

            // Per-item refresh path — used by the media-lifecycle "matched"
            // hook for movies. Delegates to syncSingleItem(); chooses TMDB via
            // the active primary provider.
            //
            // syncSingleItem() does not accept an AbortSignal — it's a short
            // sequential TMDB fetch + DB write (~seconds). Rather than refactor
            // the service contract, we Promise.race against ctx.signal so admin
            // Cancel returns the run promptly; the in-flight TMDB call finishes
            // server-side but cost is bounded (single fetch). Anything longer
            // (the discovery sweep below) gets the proper shouldAbort wire-in.
            if (ctx.input.mediaItemId) {
                if (ctx.signal.aborted) {
                    return {
                        success: false,
                        itemsProcessed: 0,
                        stopReason: 'aborted',
                    };
                }

                // D4: per-item path is for movies only; series use series-sync task
                const [mtRow] = await ctx.sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${ctx.input.mediaItemId} LIMIT 1
            `;
                if (!mtRow) {
                    return { success: false, itemsProcessed: 0 };
                }
                const mt = String(mtRow.media_type).toLowerCase();
                if (isSeries(mt) || isEpisode(mt)) {
                    throw new TaskError({
                        message: `tmdb-metadata-sync per-item path is for movies only; got media_type='${mtRow.media_type}' for id=${ctx.input.mediaItemId}. Use series-sync for series/episodes.`,
                        kind: 'permanent',
                    });
                }

                const { syncSingleItem } =
                    await import('../../../services/metadata-sync-single.service.js');
                // Task-tier handle — this runs inside a queued run, so it must use
                // the task pool, not the web pool. (The only native task that
                // resolves sql directly instead of via ctx.sql.)
                const { getTaskDb } = await import('../../../database/connection.js');
                const sql = getTaskDb();
                if (!sql) {
                    throw new Error('Database not available for tmdb-metadata-sync (per-item)');
                }
                ctx.logger.info('tmdb-metadata-sync per-item refresh', {
                    mediaItemId: ctx.input.mediaItemId,
                    force: ctx.input.force === true,
                });

                // Race the per-item sync against ctx.signal. On abort, surface
                // a clean stopReason instead of waiting for the sync to finish.
                const abortPromise = new Promise<'aborted'>((resolve) => {
                    if (ctx.signal.aborted) {
                        resolve('aborted');
                        return;
                    }
                    ctx.signal.addEventListener('abort', () => resolve('aborted'), {
                        once: true,
                    });
                });
                const syncPromise = syncSingleItem(sql, ctx.input.mediaItemId, {
                    force: ctx.input.force === true,
                    forceChildren: ctx.input.forceChildren === true,
                });
                // If abortPromise wins the race, syncPromise still settles
                // server-side a few seconds later. Attach a catch so any
                // post-abort rejection (TMDB 5xx mid-fetch, DB drop) doesn't
                // surface as an unhandledRejection warning (or crash under
                // --unhandled-rejections=strict). Resolutions are harmless.
                syncPromise.catch((err: unknown) => {
                    ctx.logger.debug('tmdb-metadata-sync per-item promise settled after abort', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
                let raceResult;
                try {
                    raceResult = await Promise.race([syncPromise, abortPromise]);
                } catch (err) {
                    // 404 from TMDB = the item's tmdb_id was deleted upstream
                    // (adult content cleanup / duplicate merge / privatised entry).
                    // Retrying forever is wasted RPS — mark the row
                    // skipped_permanent so it stops re-queueing. Reason string
                    // matches the convention used by Phase D + the admin UI
                    // tooltip lookup. Any caller observing a future tmdb_id
                    // change for the same media_item will re-enable the row via
                    // the identity.changed DB trigger.
                    // Prefer `instanceof` (typed, refactor-resilient) and fall
                    // back to a name check for cross-realm error duplication
                    // (e.g. a future Promise.allSettled wrapper that aggregates).
                    const isTmdb404 =
                        err instanceof TmdbApiError
                            ? err.status === 404
                            : err instanceof Error &&
                              err.name === 'TmdbApiError' &&
                              (err as Error & { status?: number | null }).status === 404;
                    if (isTmdb404) {
                        ctx.logger.info(
                            'tmdb-metadata-sync: 404 from TMDB — marking skipped_permanent',
                            {
                                mediaItemId: ctx.input.mediaItemId,
                            },
                        );
                        // ALSO clear last_run_id so the runner's wrapExecute
                        // markCompleted no-ops on its way out. wrapExecute
                        // automatically wraps single-coversStages tasks like
                        // this one — if `inner()` returns successfully it
                        // runs `UPDATE ... SET status='completed' WHERE
                        // last_run_id=${runId}`. Nulling last_run_id here
                        // makes that WHERE fail, preserving our
                        // skipped_permanent write. Without this guard, the
                        // 404 fix gets silently clobbered back to completed.
                        await sql`
                            UPDATE media_item_stage_state
                               SET status = 'skipped_permanent',
                                   skipped_reason = 'tmdb-deleted-or-private',
                                   next_eligible_at = NULL,
                                   last_run_id = NULL,
                                   updated_at = now()
                             WHERE media_item_id = ${ctx.input.mediaItemId}::uuid
                               AND stage_id = 'tmdb-metadata-sync'
                        `.catch((sqlErr: unknown) => {
                            ctx.logger.warn(
                                'Failed to mark tmdb-metadata-sync skipped_permanent on 404',
                                {
                                    mediaItemId: ctx.input.mediaItemId,
                                    error:
                                        sqlErr instanceof Error ? sqlErr.message : String(sqlErr),
                                },
                            );
                        });
                        // Return a "permanent skip" outcome so the runner
                        // marks the run terminal-without-error rather than
                        // burning retry attempts on the same dead id.
                        return {
                            success: false,
                            itemsProcessed: 0,
                            // SDK `'skipped'` stopReason — added 2026-05-22
                            // alongside the tmdb-metadata-sync 404 guard.
                            // Semantically distinct from 'no-progress'
                            // (the loop made zero forward progress this
                            // tick) — here we explicitly chose NOT to
                            // process this item and the row is now
                            // skipped_permanent so it won't reappear.
                            stopReason: 'skipped',
                            result: {
                                total_fetched: 0,
                                created: 0,
                                updated: 0,
                                skipped: 1,
                                errors: 0,
                                message: `TMDB id no longer exists (404) — marked skipped_permanent`,
                            },
                        };
                    }
                    throw err;
                }
                if (raceResult === 'aborted') {
                    return {
                        success: false,
                        itemsProcessed: 0,
                        stopReason: 'aborted',
                    };
                }
                const result = raceResult;
                await upsertCompletedRow(sql, {
                    mediaItemId: ctx.input.mediaItemId,
                    stageId: 'tmdb-metadata-sync',
                    processingVersion: 1,
                }).catch((coverageErr: unknown) => {
                    ctx.logger.warn('tmdb-metadata-sync: upsertCompletedRow failed', {
                        mediaItemId: ctx.input.mediaItemId,
                        error:
                            coverageErr instanceof Error
                                ? coverageErr.message
                                : String(coverageErr),
                    });
                });
                return {
                    success: true,
                    itemsProcessed: result.updated ? 1 : 0,
                    result: {
                        total_fetched: 1,
                        created: 0,
                        updated: result.updated ? 1 : 0,
                        skipped: result.updated ? 0 : 1,
                        errors: 0,
                        message: result.updated
                            ? `Updated fields: ${result.fieldsChanged.join(', ') || 'none'}`
                            : 'No changes needed',
                    },
                };
            }

            // Self-heal (D4 follow-up): flip stale failed_permanent rows for
            // this stage back to skipped_permanent when the item's media_type
            // is no longer eligible (currently movie-only). Rows seeded before
            // the appliesTo fix landed — every episode/series the per-item
            // path rejected with a permanent TaskError above — are stuck in
            // failed_permanent forever; the sweeper's own dispose passes
            // deliberately never touch that status. Runs on every
            // discovery-sweep-shaped invocation (scheduled daily fire OR the
            // stage-sweep global-identity enqueue, which fires whenever this
            // stage has any sweepable movie backlog) so it isn't gated behind
            // the discovery-catalog toggle below — those bad rows belong to
            // library items, not discovery-catalog ones. Cheap, idempotent,
            // best-effort: a failure here must not block the sweep itself.
            await healMisappliedFailedPermanentRows(ctx.sql, {
                stageId: 'tmdb-metadata-sync',
                eligibleMediaTypes: ['movie'],
                skippedReason: 'not-a-movie-item',
            }).catch((err: unknown) => {
                ctx.logger.warn('tmdb-metadata-sync: self-heal of misapplied rows failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });

            // Discovery-catalog gate: when no display surface can ever show
            // file-less catalog items (SHOW_UNAVAILABLE_MEDIA and the IN_SEARCH
            // variant both off, or no request path configured), the sweep below
            // would only fill media_items with invisible has_files=false rows
            // and burn TMDB quota. Skip cleanly (normal success, zero work) —
            // like the fresh-install guard above, every scheduled run re-checks
            // live config, so enabling the toggle (or configuring Jellyseerr /
            // PUBLIC_REQUESTURL) makes the very next run proceed. The per-item
            // refresh path above is NOT gated — it updates existing library
            // items and must keep running.
            if (!isDiscoveryCatalogEnabled()) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        total_fetched: 0,
                        created: 0,
                        updated: 0,
                        skipped: 0,
                        errors: 0,
                        message:
                            'skipped: unavailable-media display is disabled (nothing would show these items)',
                    },
                };
            }

            // Discovery sweep path — pulls popular/top-rated/trending lists.
            const { TMDBMetadataSyncGenerator, classifyTmdbFailure } =
                await import('../../../ai/tmdb-metadata-sync.js');
            const generator = new TMDBMetadataSyncGenerator();

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
                    generator.abort('cancelled');
                },
                { once: true },
            );
            // The soft deadline (55m) must stop the generator too. The runner only
            // fires ctx.softSignal there — ctx.signal waits for cancel or the hard
            // cap — so without this the sweep kept going and was hard-FAILED at
            // 60m: 11 of 28 scheduled runs on prod in two weeks (2026-09-24).
            // Same fix metadata-sync.ts already carries; the next run resumes.
            ctx.softSignal?.addEventListener('abort', () => generator.abort(SOFT_TIMEOUT_REASON), {
                once: true,
            });
            if (ctx.softSignal?.aborted) generator.abort(SOFT_TIMEOUT_REASON);

            const useCoverageTable = getAuthoritativeStageIds().has('tmdb-metadata-sync');
            const onTmdbSuccess = useCoverageTable
                ? async (mediaItemId: string): Promise<void> => {
                      try {
                          await upsertCompletedRow(ctx.sql, {
                              mediaItemId,
                              stageId: 'tmdb-metadata-sync',
                              processingVersion: 1,
                          });
                      } catch {
                          // Non-fatal — coverage write failure must not abort sweep
                      }
                  }
                : undefined;

            // Page every discovery list to its cap only weekly (or on request);
            // the daily sweep pages just the fronts where new titles appear.
            const listDepth: 'deep' | 'shallow' =
                ctx.input.deepList === true ||
                !(await hasRecentDeepDiscoveryListing(
                    ctx.sql,
                    new Date(Date.now() - DEEP_LIST_INTERVAL_MS),
                ))
                    ? 'deep'
                    : 'shallow';

            try {
                const result = await generator.sync({
                    listDepth,
                    maxMovies: ctx.input.maxMovies,
                    maxSeries: ctx.input.maxSeries,
                    minRating: ctx.input.minRating,
                    minVotes: ctx.input.minVotes,
                    minPopularity: ctx.input.minPopularity,
                    missingOnly: ctx.input.missingOnly,
                    fetchDetails: ctx.input.fetchDetails,
                    shouldAbort: () => ctx.signal.aborted || generator.isAborted(),
                    onProgress: (progress) => {
                        ctx.reportProgress(
                            progress.processedItems ?? 0,
                            progress.totalItems ?? 0,
                            progress.currentItem,
                        );
                    },
                    onSuccess: onTmdbSuccess,
                    sql: ctx.sql,
                });
                // Request volume is recorded by the withApiCallSpend wrapper via
                // the instrumented tmdbApi client (per-host), so we no longer spend
                // result.requestCount here — that would double-count.

                // Monitoring-blindness guard (mirrors mdblist-sync.ts): the
                // generator's `success` field is HARDCODED true unless the whole
                // sync() call throws (ai/tmdb-metadata-sync.ts) — a per-item
                // failure inside the discovery loop is caught, pushed to
                // `errors`, and the loop continues, so a total TMDB outage still
                // returns `success: true`. Blindly passing that through (the old
                // `success: result.success` below) makes a total outage look like
                // a green run — invisible to alerting AND the circuit breaker,
                // since a returned result (even one with success:false) is
                // recorded as a COMPLETED run either way. Throw a transient
                // TaskError instead so the run is marked failed, retried, and the
                // breaker can trip. Excludes the abort/soft-timeout path — a
                // cancelled sweep legitimately has 0 created/updated with some
                // errors already recorded from items attempted just before the
                // stop, and that must surface as the pre-existing 'aborted'
                // outcome (handled by the catch below), not an outage. Genuine
                // no-work (0 fetched → 0 errors) and partial success (created or
                // updated > 0) stay success.
                if (
                    result.errors > 0 &&
                    result.created === 0 &&
                    result.updated === 0 &&
                    !ctx.signal.aborted &&
                    !generator.isAborted()
                ) {
                    const failure = classifyTmdbFailure(result.lastErrorMessage);
                    throw new TaskError({
                        message:
                            failure === 'rate-limit'
                                ? `tmdb-metadata-sync: rate limit reached (TMDB API) — resumes ` +
                                  `automatically once the quota window resets ` +
                                  `(${result.errors} item(s) deferred).`
                                : failure === 'auth'
                                  ? `tmdb-metadata-sync: TMDB API key missing or invalid — check ` +
                                    `the key in settings; no metadata synced.`
                                  : `tmdb-metadata-sync: upstream outage — 0 created/updated with ` +
                                    `${result.errors} error(s) across ${result.total_fetched} fetched item(s).`,
                        kind: 'transient',
                    });
                }

                // A soft-deadline stop that made progress is a graceful partial
                // sweep, not a failure (mirrors metadata-sync.ts).
                if (generator.isAborted() && !ctx.signal.aborted) {
                    return {
                        success: true,
                        itemsProcessed: result.total_fetched,
                        stopReason: 'aborted',
                        result: {
                            total_fetched: result.total_fetched,
                            created: result.created,
                            updated: result.updated,
                            skipped: result.skipped,
                            errors: result.errors,
                            message: result.message,
                        },
                    };
                }

                return {
                    success: result.success,
                    itemsProcessed: result.total_fetched,
                    result: {
                        total_fetched: result.total_fetched,
                        created: result.created,
                        updated: result.updated,
                        skipped: result.skipped,
                        errors: result.errors,
                        message: result.message,
                        // Only a sweep that ran to completion records its depth: a
                        // soft-deadline stop (above) leaves it out, so a cut-short
                        // deep listing is retried on the next run.
                        listDepth,
                    },
                };
            } catch (err) {
                if (ctx.signal.aborted || generator.isAborted()) {
                    return {
                        // Soft deadline (not an admin cancel): a graceful stop.
                        success: !ctx.signal.aborted,
                        itemsProcessed: 0,
                        stopReason: 'aborted',
                    };
                }
                throw err;
            }
        });
    },
});

registry.registerTask(tmdbMetadataSyncRealTask);
