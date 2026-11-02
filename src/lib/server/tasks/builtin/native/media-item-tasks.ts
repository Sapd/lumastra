// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-media-item tasks — thin wrappers covering the media-detail page
 * action surface.
 *
 *  - series-sync                 — wraps `syncSeriesWithChildren()`
 *  - chapter-sync                — wraps `syncSeriesChapters()`
 *  - image-sync                  — wraps `scanImages()`
 *  - trickplay-generation        — wraps `generateTrickplayForMediaItem()`
 *  - auto-identify-personal-media — wraps `processAutoIdentifyPersonalMedia()`
 *  - bulk-media-sync             — loops `syncSingleItem()` / `syncSeriesWithChildren()`
 *    over an admin-selected id array (the provider-hitting half of the admin
 *    media browser's bulk actions — see admin/media/bulk-sync.ts)
 */

import { classifyMediaInfraError } from '../../infra-retry.js';
import { refreshRecentlyAddedRecencyForItems } from '$lib/server/database/queries/browse.queries.js';
import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { isSeries, isEpisode, isSeason } from '$lib/server/utils/media-types.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { upsertCompletedRow } from '../../../database/queries/stage-state.queries.js';
import { config, getAuthoritativeStageIds } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { SERIES_SYNC_FRESHNESS_MINUTES } from './series-sync-freshness.js';
import type { StageSkipDisposition } from '../../run-wrapper.js';

// ──────────────────────────────────────────────────────────────────────────
// SERIES_SYNC_FRESHNESS_MINUTES: see series-sync-freshness.ts.

// series-sync — full TMDB series metadata refresh including seasons/episodes
// ──────────────────────────────────────────────────────────────────────────

const seriesSyncInputSchema = z
    .object({
        mediaItemId: z.string(),
        force: z.boolean().optional(),
        forceChildren: z.boolean().optional(),
        respectLocks: z.boolean().optional(),
        /** Explicit admin re-sync only: create children even for a not-owned series. */
        forceCreateChildren: z.boolean().optional(),
    })
    .passthrough();

/**
 * Whether series-sync can skip this series: it synced recently AND nothing new
 * appeared beneath it.
 *
 * Exported and taking `sql` explicitly so the predicate can be exercised against a
 * REAL database with real stage-row states. That is not a stylistic preference —
 * the bug this function was extracted for is invisible to any test that supplies
 * the query's result through a mocked `sql`, because the defect was in what the
 * SQL matched, not in what the caller did with the answer. The unit tests around
 * this guard did exactly that and passed throughout.
 *
 * Returns false (do the work) whenever the answer is not a confident yes —
 * no coverage row, no fresh provider metadata, or anything new below.
 */
export async function seriesSyncIsFresh(sql: postgres.Sql, mediaItemId: string): Promise<boolean> {
    const [fresh] = await sql<{ stale: boolean }[]>`

        WITH cov AS (
            -- completed_at, NOT status = 'completed'.
            --
            -- This guard runs INSIDE execute(), by which point the
            -- framework has already flipped this row to 'running' for the
            -- current run. A status test therefore matched nothing on
            -- every single invocation: the CTE came back empty, the outer
            -- WHERE EXISTS dropped all rows, fresh was undefined, and the
            -- skip branch could never be taken. The guard was inert from the
            -- day it shipped. Prod kept re-syncing SpongeBob (773 episodes)
            -- 13x/hour, flat for hours, with force=false, nothing new below
            -- it and tmdb metadata seconds old — every precondition for a
            -- skip met, and no skip possible.
            --
            -- completed_at records that some earlier run finished, and
            -- survives this run's status change. It is still NULL before the
            -- first successful sync, so a series that has never synced (or
            -- whose first run died attaching episodes) is never skipped —
            -- the false-coverage case the status test was reaching for.
            -- Re-checking invalidated_at keeps an invalidation forcing a
            -- re-sync, which is exactly when one is wanted.
            SELECT 1 FROM media_item_stage_state
             WHERE media_item_id = ${mediaItemId}
               AND stage_id = 'series-sync'
               AND completed_at IS NOT NULL
               AND (invalidated_at IS NULL OR invalidated_at <= completed_at)
        ), pm AS (
            -- The configured primary provider, not a hardcoded 'tmdb'.
            -- With the literal, a deployment whose primary is faketvdb (or
            -- anything else) got an empty CTE, never skipped, and silently
            -- ran the 44k-calls-per-week fan-out this guard exists to stop.
            SELECT updated_at FROM provider_metadata
             WHERE media_id = ${mediaItemId}
               AND provider = ${getPrimaryExternalIdProvider()}
               -- Strictly greater-than: at exactly the window boundary the
               -- row reads as NOT fresh and the sync runs. The mirror guard
               -- in catalog.service.ts uses >= at its own boundary, so a
               -- rival exactly at 300s still counts as live and the write
               -- is skipped. The asymmetry is deliberate — each picks the
               -- direction that fails safe for its own risk: redundant work
               -- here, an unwanted identity swap there. Both compare
               -- entirely inside SQL (now() against DB-written timestamps),
               -- so no app/PG clock skew enters either comparison.
               AND updated_at > now() - ${`${SERIES_SYNC_FRESHNESS_MINUTES} minutes`}::interval
             ORDER BY updated_at DESC LIMIT 1
        ), descendants AS (
            SELECT c.id, c.created_at
              FROM media_items c WHERE c.parent_id = ${mediaItemId}
            UNION ALL
            SELECT e.id, e.created_at
              FROM media_items e
              JOIN media_items sea ON e.parent_id = sea.id
             WHERE sea.parent_id = ${mediaItemId}
        )
        SELECT (
            EXISTS (
                SELECT 1 FROM descendants d, pm
                 WHERE d.created_at > pm.updated_at
            )
            OR EXISTS (
                -- media_file_items is a pure join table with no
                -- timestamps; the file's own created_at lives on
                -- media_files. That means this hatch sees a NEW file, but
                -- not an existing file RE-LINKED to an existing descendant
                -- (the join row is new, the media_files row is old). Such
                -- a re-link waits out the freshness window instead of
                -- syncing at once — bounded by SERIES_SYNC_FRESHNESS_MINUTES
                -- and self-healing, which is the right trade against adding
                -- a timestamp column to a hot join table.
                SELECT 1 FROM media_file_items mfi
                  JOIN descendants d ON d.id = mfi.media_item_id
                  JOIN media_files f ON f.id = mfi.file_id
                 CROSS JOIN pm
                 WHERE f.created_at > pm.updated_at
            )
        ) AS stale
          FROM pm
         WHERE EXISTS (SELECT 1 FROM cov)
    `;
    return fresh !== undefined && !fresh.stale;
}

export const seriesSyncTask = defineTask<z.infer<typeof seriesSyncInputSchema>, unknown>({
    id: 'series-sync',
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'Full Series Metadata Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // No schedule — admin-triggered per-item only.
    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    // Mass-enrichment / TMDB-bound. A single series-sync wedged on TMDB
    // can run for hours; routing to `bulk` keeps it from blocking the
    // user-visible io fast path. (See ResourceClass doc for the split.)
    resourceClass: 'bulk',
    inputSchema: seriesSyncInputSchema,

    coversStages: [
        {
            id: 'series-sync',
            appliesTo: ['series'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            terminalDisposition: {
                kind: 'self-terminal',
                ruleId: 'series-sync-self-terminal',
            },
        },
    ],

    timeout: { hard: '10m', soft: '9m' },
    cost: { kind: 'api_calls' },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }

            const { mediaItemId } = ctx.input;

            // D4: validate media_type before importing the service
            const [row] = await ctx.sql<{ media_type: string }[]>`
            SELECT media_type FROM media_items WHERE id = ${mediaItemId} LIMIT 1
        `;
            if (!row) {
                return { success: false, itemsProcessed: 0 };
            }
            const mt = String(row.media_type).toLowerCase();
            if (!isSeries(mt)) {
                throw new TaskError({
                    message: `series-sync requires a series item; got media_type='${row.media_type}' for id=${mediaItemId}`,
                    kind: 'permanent',
                });
            }

            // Freshness guard. A series is matched once PER EPISODE, so a single
            // scan batch fans out into one full-series sync per episode — and each
            // one re-fetches every season. SpongeBob (773 episodes, 19 seasons) drew
            // 2,130 runs and 44,580 TMDB calls in a week this way, 71% of all
            // series-sync spend. Over 24h on prod, 425 of 728 runs (58%) were a
            // repeat of a series synced less than ten minutes earlier.
            //
            // The `coverage:` idempotency key on the enqueue only collapses runs
            // that are queued SIMULTANEOUSLY; these arrive minutes apart, so the
            // dedupe never sees them. The durable answer is to ask whether the work
            // is still needed at all, which is cheap and covers every enqueue path.
            //
            // `provider_metadata.updated_at` is the signal — `fetched_at` is not,
            // it can be months stale while updated_at tracks each sync exactly.
            // The freshness window alone would delay genuinely new content, so it is
            // paired with an escape hatch: any descendant row or file CREATED since
            // that write means there is new material and the sync runs regardless.
            // Descendant `updated_at` is deliberately not used — the sync itself
            // touches children, so it would defeat its own guard.
            if (ctx.input.force !== true && ctx.input.forceChildren !== true) {
                // The stage row must ALSO say the last attempt actually succeeded.
                // `provider_metadata.updated_at` is written by STEP 1 of
                // syncSeriesWithChildrenInner (series-level metadata), BEFORE the
                // fallible children phase — so a run that dies attaching episodes has
                // already stamped the freshness signal. Without this clause the next
                // sweep 60s later would see "fresh, nothing new below" and skip,
                // returning success with itemsProcessed 0, and wrapExecute would mark
                // the stage COMPLETED — false coverage on a series whose episodes never
                // synced. That is strictly worse than the redundant work this guard
                // exists to remove.
                //
                // A missing row (legacy/non-authoritative) yields no row here and
                // therefore never skips — fail-open toward doing the work.
                //
                // The coverage clause reads `completed_at`, not `status`. See the note
                // on the cov CTE in `seriesSyncIsFresh`: a status test can never match,
                // because this runs inside execute() with the row already flipped to
                // 'running'.
                const fresh = await seriesSyncIsFresh(ctx.sql, mediaItemId);
                if (fresh) {
                    ctx.logger.info('series-sync skipped — synced recently, nothing new below it', {
                        mediaItemId,
                        freshnessMinutes: SERIES_SYNC_FRESHNESS_MINUTES,
                    });
                    return { success: true, itemsProcessed: 0 };
                }
            }

            const {
                syncSeriesWithChildren,
                SeriesSyncAbortedError,
                SeriesSyncProviderUnavailableError,
            } = await import('../../../services/metadata-sync-single.service.js');
            ctx.logger.info('series-sync starting', {
                mediaItemId,
                force: ctx.input.force === true,
                forceChildren: ctx.input.forceChildren === true,
                forceCreateChildren: ctx.input.forceCreateChildren === true,
            });

            let result: Awaited<ReturnType<typeof syncSeriesWithChildren>>;
            try {
                result = await syncSeriesWithChildren(
                    ctx.sql,
                    mediaItemId,
                    {
                        force: ctx.input.force === true,
                        respectLocks: ctx.input.respectLocks === true,
                        forceChildren: ctx.input.forceChildren === true,
                        forceCreateChildren: ctx.input.forceCreateChildren === true,
                    },
                    (event) => {
                        const total = event.totalSeasons ?? 0;
                        const processed = event.seasonsSynced + event.episodesSynced;
                        ctx.reportProgress(processed, total, event.phase);
                    },
                    ctx.signal,
                );
            } catch (err) {
                if (err instanceof SeriesSyncAbortedError) {
                    return {
                        success: false,
                        itemsProcessed: 0,
                        stopReason: 'aborted',
                    };
                }
                if (err instanceof SeriesSyncProviderUnavailableError) {
                    throw new TaskError({
                        message: err.message,
                        kind: 'transient',
                        remediation: 'operational',
                        cause: err,
                    });
                }
                throw err;
            }

            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: result.seasonsSynced + result.episodesSynced,
                    stopReason: 'aborted',
                    result,
                };
            }

            if (result.prerequisiteMissing === 'provider-identity') {
                const reason =
                    'No usable provider identity. Use Identify to match this series, then retry.';
                // The wrapper owns the fenced stage mutation and publication.
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'skipped',
                    stageDisposition: {
                        status: 'skipped_permanent',
                        reason,
                    } satisfies StageSkipDisposition,
                    result: { ...result, reason: 'no-provider-identity', message: reason },
                };
            }

            // Phantom-series terminal skip: the children-expansion phase was
            // deliberately declined because no descendant has a file (discovery /
            // catalog residue). This is NOT incomplete work — series-level
            // metadata WAS synced and children expansion is correctly deferred
            // until a file lands. Claim coverage so the stage-sweep stops
            // re-enqueuing it every cycle; identity.* invalidation (and the
            // scanner's direct afterMatched enqueue once files attach) re-runs it
            // when the picture changes. Without this, a fileless series loops
            // forever (prod: ~18k re-syncs/day for a single phantom series).
            if (result.phantomSkipped) {
                await upsertCompletedRow(ctx.sql, {
                    mediaItemId,
                    stageId: 'series-sync',
                    processingVersion: 1,
                }).catch((err: unknown) => {
                    ctx.logger.warn('series-sync: upsertCompletedRow failed (phantom skip)', {
                        mediaItemId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
                return {
                    success: true,
                    itemsProcessed: 0,
                    stopReason: 'skipped',
                    result: {
                        seasonsSynced: 0,
                        episodesSynced: 0,
                        episodesAttachFailed: 0,
                        childrenSkipped: 'not-owned',
                        message: `Series sync skipped children expansion for ${mediaItemId} — no descendant has files (phantom/discovery series); series metadata synced`,
                    },
                };
            }

            if (result.episodesAttachFailed > 0) {
                return {
                    success: false,
                    itemsProcessed: result.seasonsSynced + result.episodesSynced,
                    result: {
                        seasonsSynced: result.seasonsSynced,
                        episodesSynced: result.episodesSynced,
                        episodesAttachFailed: result.episodesAttachFailed,
                        message: `Series sync completed with ${result.episodesAttachFailed} attach failure(s) for ${mediaItemId}`,
                    },
                };
            }

            // Defensive guard: don't claim coverage if the run did no actual
            // work. Symptom that motivated this: when the runner's wall-clock
            // watchdog hard-aborts a run, `syncSeriesWithChildren` doesn't
            // necessarily honor the abort promptly — it can run for minutes
            // past the cancellation, eventually return `{seasonsSynced: 0,
            // episodesSynced: 0}`, and (without this guard) reach
            // upsertCompletedRow. The coverage row would then claim the
            // series was synced when the run was actually killed mid-flight.
            // Spotted on preprod 2026-05-22: "The League" (TMDB 31497) had
            // its series-sync row marked completed even though task_history
            // recorded the run as failed with watchdog-timeout-hard.
            //
            // Also re-check the abort signal right before the coverage
            // write — the watchdog calls abort() on the run's signal, and a
            // late post-watchdog flush should propagate that as a non-success
            // outcome rather than locking in a false coverage row.
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: result.seasonsSynced + result.episodesSynced,
                    stopReason: 'aborted',
                    result,
                };
            }
            // A season TMDB failed to deliver was not written: whatever else
            // synced, this run is not full coverage. Retry (transient), never
            // write the coverage row.
            if (result.incompleteSeasons && result.incompleteSeasons.length > 0) {
                const reason = `Series sync could not fetch season(s) ${result.incompleteSeasons.join(', ')} for ${mediaItemId} — not claiming coverage, will retry`;
                ctx.logger.warn(reason, { mediaItemId });
                return {
                    success: false,
                    itemsProcessed: result.seasonsSynced,
                    result: {
                        seasonsSynced: result.seasonsSynced,
                        episodesSynced: result.episodesSynced,
                        episodesAttachFailed: result.episodesAttachFailed,
                        message: reason,
                    },
                };
            }
            // Episodes are the unit of work — a series row with all season
            // rows but zero episode rows is functionally the same false-coverage
            // case as "The League" (partial run: first season fetched, episode
            // list calls timed out). Don't claim coverage on episodesSynced === 0
            // regardless of seasonsSynced. The original AND-zero guard missed
            // this case.
            if (result.episodesSynced === 0) {
                ctx.logger.warn('series-sync: zero episodes synced — skipping coverage write', {
                    mediaItemId,
                    seasonsSynced: result.seasonsSynced,
                });
                // ZERO seasons is a statement about the ITEM, not about this
                // run: the abort case returned above, so nothing was cancelled
                // here — TMDB simply has no children for it. Re-running asks the
                // same question and gets the same answer, which is precisely
                // what `permanent: true` is for. Without it the run wrapper
                // resets the row to `pending` with no backoff and no attempt
                // increment, and the item re-drains every drain tick forever:
                // observed on prod 2026-08-20, three items (two of them
                // mis-parsed release filenames that became series rows, e.g.
                // "[Erai-raws] … - 07 …") cycling once a MINUTE indefinitely.
                //
                // Some seasons but zero episodes is NOT permanent — that is the
                // partial run this guard was originally written for (season
                // fetched, episode list timed out), and it must keep retrying.
                //
                // Recoverable either way: a permanent row is surfaced in admin
                // with its reason, and an invalidation — content change, bumped
                // processing version — brings it back if TMDB later gains data.
                const noChildrenAtAll = result.seasonsSynced === 0;
                const reason = noChildrenAtAll
                    ? `Series sync produced no children for ${mediaItemId} — TMDB returned no seasons or episodes for it. Not retried; an invalidation will re-queue it if that changes.`
                    : `Series sync produced ${result.seasonsSynced} season(s) but zero episodes for ${mediaItemId} — partial run, not claiming coverage`;
                return {
                    success: false,
                    // Top-level `error`, not just `result.message`: the run
                    // wrapper's permanentFailureMessage() reads THIS key to fill
                    // `last_error`. Without it the three rows written off on prod
                    // recorded the bare "Task reported a permanent failure",
                    // which tells an admin that it happened and not why — the
                    // one thing the stored reason exists for.
                    ...(noChildrenAtAll
                        ? { permanent: true, error: reason, remediation: 'identity' as const }
                        : {}),
                    itemsProcessed: result.seasonsSynced,
                    result: {
                        seasonsSynced: result.seasonsSynced,
                        episodesSynced: 0,
                        episodesAttachFailed: result.episodesAttachFailed,
                        message: reason,
                    },
                };
            }

            if (result.reconciliationSkipped) {
                ctx.logger.warn('series-sync: auto-reconciliation skipped (non-fatal)', {
                    mediaItemId,
                    reason: result.reconciliationSkipped.reason,
                });
            }
            if (!ctx.signal.aborted && result.tmdbCatalog && result.tmdbCatalog.length > 0) {
                try {
                    const { applyReconciliation, recheckQuarantinedMatchesForSeries } =
                        await import('../../../services/episode-reconciliation.service.js');
                    // Routine re-sync fetched only some seasons: the catalog is
                    // partial, so reconcile only episodes OF those seasons. An
                    // episode in an unfetched season could otherwise be
                    // fuzzy-matched to a lookalike title ("Finale") in a fetched one.
                    let episodeIds: string[] | undefined;
                    if (result.fetchedSeasonNumbers) {
                        const rows = await ctx.sql<{ id: string }[]>`
                            SELECT e.id FROM media_items e
                            JOIN media_items s ON s.id = e.parent_id AND s.media_type = 'season'
                            WHERE s.parent_id = ${mediaItemId} AND e.media_type = 'episode'
                              AND s.season_number = ANY(${result.fetchedSeasonNumbers}::int[])
                        `;
                        episodeIds = rows.map((row) => row.id);
                    }
                    const r = await applyReconciliation(
                        ctx.sql,
                        mediaItemId,
                        0.9,
                        episodeIds,
                        result.tmdbCatalog,
                    );
                    if (!ctx.signal.aborted)
                        await recheckQuarantinedMatchesForSeries(
                            ctx.sql,
                            mediaItemId,
                            'series-sync',
                        );
                    if (r.updatedTitles > 0) {
                        ctx.logger.info('series-sync: auto-reconciled episode titles', {
                            mediaItemId,
                            updatedTitles: r.updatedTitles,
                        });
                    }
                } catch (err) {
                    ctx.logger.warn('series-sync: auto-reconcile failed (non-fatal)', {
                        mediaItemId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            await upsertCompletedRow(ctx.sql, {
                mediaItemId,
                stageId: 'series-sync',
                processingVersion: 1,
            }).catch((err: unknown) => {
                ctx.logger.warn('series-sync: upsertCompletedRow failed', {
                    mediaItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
            return {
                success: true,
                itemsProcessed: result.seasonsSynced + result.episodesSynced,
                result: {
                    seasonsSynced: result.seasonsSynced,
                    episodesSynced: result.episodesSynced,
                    episodesAttachFailed: result.episodesAttachFailed,
                    ...(result.reconciliationSkipped
                        ? { reconciliationSkipped: result.reconciliationSkipped }
                        : {}),
                    ...(result.childrenSkipped ? { childrenSkipped: result.childrenSkipped } : {}),
                    message: result.childrenSkipped
                        ? `Series sync completed for ${mediaItemId}; no new seasons/episodes created because the series is not owned (no files, never added to a library)`
                        : `Series sync completed for ${mediaItemId}`,
                },
            };
        });
    },
});

// ──────────────────────────────────────────────────────────────────────────
// chapter-sync — extract chapter markers via ffprobe (or Jellyfin fallback)
// ──────────────────────────────────────────────────────────────────────────

const chapterSyncInputSchema = z
    .object({
        mediaItemId: z.string(),
        /** Probe the files again, even when their chapters are already known. */
        force: z.boolean().optional(),
    })
    .passthrough();

// Give-up threshold for the "files inaccessible" retry loop. After this many
// attempts the stage parks at `failed_permanent` (dead-letter, admin-visible)
// instead of retrying every backoff window forever for a genuinely-gone file.
const CHAPTER_SYNC_INACCESSIBLE_MAX_ATTEMPTS = 6;

export const chapterSyncTask = defineTask<z.infer<typeof chapterSyncInputSchema>, unknown>({
    id: 'chapter-sync',
    purpose: 'library',
    name: 'Chapter Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, ffmpeg: true, http: true },

    // A forced re-sync gets its own identity, so it is not deduplicated into a
    // queued normal run that would then reuse the known chapters.
    identityFor: (input) => `item-${input.mediaItemId}${input.force ? '-force' : ''}`,
    scope: 'global',
    // ffprobe-bound but part of the file-fast path — see media-probe rationale.
    resourceClass: 'ingest',
    inputSchema: chapterSyncInputSchema,

    // appliesTo is series + movie — `syncSeriesChapters` (despite the name)
    // accepts a series (fans out to all episode children + their files),
    // a movie (single file), OR an episode (single file). The series + movie
    // forms are what stage-sweep enqueues; per-episode chapter-sync is
    // redundant when the series-level run already processed all episodes.
    //
    // `enqueueable: true` lets stage-sweep auto-enqueue per series/movie —
    // without it, chapter-sync only ran when explicitly invoked, which
    // nothing in the codebase actually does. 8,209 series rows were stuck
    // pending forever on preprod for this reason.
    //
    // `invalidatedBy` covers file events so a new episode file (or a
    // re-probe of an existing one) re-flips the chapter-sync row to
    // pending and the next sweep tick processes it.
    coversStages: [
        {
            id: 'chapter-sync',
            appliesTo: ['series', 'movie'] as const,
            invalidatedBy: ['file.attached', 'file.contentChanged'] as const,
            enqueueable: true,
            terminalDisposition: {
                kind: 'self-terminal',
                ruleId: 'chapter-sync-self-terminal',
            },
        },
    ],

    timeout: { hard: '10m', soft: '9m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        const { syncSeriesChapters } = await import('../../../services/chapter-sync.service.js');
        const result = await syncSeriesChapters(
            ctx.sql,
            ctx.input.mediaItemId,
            undefined, // jellyfinUserId — derived inside the service if needed
            (progress) => {
                const total = progress.totalEpisodes ?? 0;
                ctx.reportProgress(progress.episodesProcessed ?? 0, total, progress.phase);
            },
            ctx.signal,
            { force: ctx.input.force === true },
        );

        if (ctx.signal.aborted) {
            return {
                success: false,
                itemsProcessed: result.episodesProcessed,
                stopReason: 'aborted',
                result,
            };
        }

        // If any targeted episode file was present-but-unreadable this run, do
        // NOT let the stage settle as `completed`. That conflation of "no
        // chapters" with "couldn't read the file" is exactly what permanently
        // stranded "Recess" with zero chapters from 2026-06-11: chapter-sync is
        // self-terminal, so once it completed (against then-inaccessible files)
        // the stage-sweep never retried it. Throw so the run-wrapper records
        // `failed_transient` with backoff and the sweep retries — self-healing
        // the moment the files become readable. Escalate to a PERMANENT failure
        // after a cap so a genuinely-gone file dead-letters (admin-visible)
        // instead of retrying forever (cf. media-probe "attempt 637").
        if ((result.inaccessibleFiles ?? 0) > 0) {
            const [attemptRow] = await ctx.sql<{ attempt: number }[]>`
                SELECT attempt FROM media_item_stage_state
                WHERE media_item_id = ${ctx.input.mediaItemId} AND stage_id = 'chapter-sync'
            `;
            const priorAttempts = attemptRow?.attempt ?? 0;
            const giveUp = priorAttempts + 1 >= CHAPTER_SYNC_INACCESSIBLE_MAX_ATTEMPTS;
            throw new TaskError({
                message:
                    `chapter-sync: ${result.inaccessibleFiles} of ${result.episodesProcessed} ` +
                    `episode file(s) inaccessible for ${ctx.input.mediaItemId}; ` +
                    (giveUp ? 'giving up after repeated retries' : 'will retry'),
                kind: giveUp ? 'permanent' : 'transient',
            });
        }

        await upsertCompletedRow(ctx.sql, {
            mediaItemId: ctx.input.mediaItemId,
            stageId: 'chapter-sync',
            processingVersion: 1,
        }).catch((err: unknown) => {
            ctx.logger.warn('chapter-sync: upsertCompletedRow failed', {
                mediaItemId: ctx.input.mediaItemId,
                error: err instanceof Error ? err.message : String(err),
            });
        });

        // Auto-correct episode identity now that chapters exist. Chapter names are
        // the signal the content reconciliation matches against, so the moment a
        // SERIES has them, kick reconciliation-backfill for that series — a fresh
        // add then self-corrects episode titles + stills without waiting for a
        // manual "Fix Episode Titles" (this is the task's only automatic trigger).
        // Series-only (movie/episode forms have nothing to reconcile); deduped per
        // series by the backfill's identityFor; fully non-fatal.
        if ((result.episodesWithChapters ?? 0) > 0) {
            const [typeRow] = await ctx.sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${ctx.input.mediaItemId} LIMIT 1
            `;
            if (typeRow && isSeries(typeRow.media_type)) {
                try {
                    const { orchestrator } = await import('../../orchestrator.js');
                    await orchestrator.startRun(
                        'reconciliation-backfill',
                        { seriesMediaId: ctx.input.mediaItemId },
                        { trigger: { kind: 'in-process', sourceRoute: 'chapter-sync' } },
                    );
                } catch (err) {
                    ctx.logger.warn(
                        'chapter-sync: failed to enqueue reconciliation backfill (non-fatal)',
                        {
                            mediaItemId: ctx.input.mediaItemId,
                            error: err instanceof Error ? err.message : String(err),
                        },
                    );
                }
            }
        }
        return {
            success: true,
            itemsProcessed: result.episodesProcessed,
            result: {
                episodesProcessed: result.episodesProcessed,
                episodesWithChapters: result.episodesWithChapters,
                totalChapters: result.totalChapters,
                inaccessibleFiles: result.inaccessibleFiles ?? 0,
            },
        };
    },
});

// ──────────────────────────────────────────────────────────────────────────
// image-sync — scan local artwork for an item (or, when no item, sweep all)
// ──────────────────────────────────────────────────────────────────────────

const imageSyncInputSchema = z
    .object({
        mediaItemId: z.string().optional(),
        seriesMediaId: z.string().optional(),
        seasonMediaId: z.string().optional(),
        scope: z.enum(['series', 'season', 'episode']).optional(),
        mode: z.enum(['execute', 'plan']).optional(),
        // The deleted task also accepted artworkType and force; kept for
        // back-compat with old admin payloads (not used by scanImages directly).
        artworkType: z.string().optional(),
        force: z.boolean().optional(),
        extractVideo: z.boolean().optional(),
        limit: z.number().int().min(1).optional(),
    })
    .passthrough();

export const imageSyncTask = defineTask<z.infer<typeof imageSyncInputSchema>, unknown>({
    id: 'image-sync',
    purpose: 'library',
    name: 'Image Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, ffmpeg: true, http: true },

    identityFor: (input) => {
        if (input.mediaItemId) return `item-${input.mediaItemId}`;
        if (input.seasonMediaId) return `season-${input.seasonMediaId}`;
        if (input.seriesMediaId) return `series-${input.seriesMediaId}`;
        return 'global';
    },
    scope: 'global',
    // File-fast path: posters/backdrops belong to the "new item" flow.
    resourceClass: 'ingest',
    inputSchema: imageSyncInputSchema,

    coversStages: [
        {
            id: 'image-sync',
            // image-sync scans local file paths for artwork; artists/albums never
            // have media files (their posters come from artist-enrichment /
            // album-enrichment), so seeding them here only produced no-op `completed`
            // rows. Narrowed to file-bearing types.
            appliesTo: ['movie', 'series', 'episode'] as const,
            invalidatedBy: [
                'identity.assigned',
                'identity.changed',
                'identity.cleared',
                'metadata.changed',
            ] as const,
            enqueueable: true,
            terminalDisposition: {
                kind: 'self-terminal',
                ruleId: 'image-sync-self-terminal',
            },
        },
    ],

    timeout: { hard: '30m', soft: '28m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        const { scanImages } = await import('../../../services/image-scanner.service.js');

        // Image sync always targets one item. The library-wide sweep (no target)
        // was removed: it never matched an image, since each image was resolved
        // against the library root instead of its own folder, and the file
        // scanner attaches folder artwork during library scans anyway.
        if (!ctx.input.mediaItemId && !ctx.input.seasonMediaId && !ctx.input.seriesMediaId) {
            ctx.logger.info('image-sync skipped: no target item');
            return { success: true, itemsProcessed: 0, stopReason: 'skipped' };
        }

        // Derive a default scope when the caller didn't pin one.
        const scope =
            ctx.input.scope ??
            (ctx.input.mediaItemId ? 'episode' : ctx.input.seasonMediaId ? 'season' : 'series');

        // Map the anchor id onto the scope-appropriate field. The admin
        // /images/sync route always passes the target as `mediaItemId` plus an
        // explicit `scope`, but scanImages builds series/season directories only
        // from `seriesMediaId`/`seasonMediaId` — so a `scope:'series'` trigger
        // carrying only `mediaItemId` scanned NOTHING (scanned:0) and a forced
        // re-scan silently no-op'd. Route the anchor to the field the chosen
        // scope reads so a series/season re-scan actually walks the folder.
        const anchorId =
            ctx.input.mediaItemId ?? ctx.input.seriesMediaId ?? ctx.input.seasonMediaId;
        const seriesMediaId =
            ctx.input.seriesMediaId ?? (scope === 'series' ? anchorId : undefined);
        const seasonMediaId =
            ctx.input.seasonMediaId ?? (scope === 'season' ? anchorId : undefined);
        const episodeMediaId =
            scope === 'episode' ? (ctx.input.mediaItemId ?? anchorId) : undefined;

        ctx.logger.info('image-sync starting', {
            scope,
            mediaItemId: ctx.input.mediaItemId,
            mode: ctx.input.mode ?? 'execute',
        });

        const useCoverageTable = getAuthoritativeStageIds().has('image-sync');
        const onImageItemSuccess =
            useCoverageTable && !ctx.input.mediaItemId
                ? async (itemId: string): Promise<void> => {
                      await upsertCompletedRow(ctx.sql, {
                          mediaItemId: itemId,
                          stageId: 'image-sync',
                          processingVersion: 1,
                      }).catch((err: unknown) => {
                          ctx.logger.warn('image-sync sweep: upsertCompletedRow failed', {
                              mediaItemId: itemId,
                              error: err instanceof Error ? err.message : String(err),
                          });
                      });
                  }
                : undefined;

        const result = await scanImages(ctx.sql, {
            scope,
            mode: ctx.input.mode ?? 'execute',
            ...(episodeMediaId ? { mediaItemId: episodeMediaId } : {}),
            ...(seriesMediaId ? { seriesMediaId } : {}),
            ...(seasonMediaId ? { seasonMediaId } : {}),
            // scanImages checks signal between directories AND between
            // images within a directory; long scans exit promptly
            // on admin Cancel instead of continuing to scan thousands of
            // poster/backdrop files. The soft deadline (28m) stops it too: the
            // runner fires only ctx.softSignal there.
            signal: ctx.softSignal ? AbortSignal.any([ctx.signal, ctx.softSignal]) : ctx.signal,
            onProgress: (processed, total) => {
                ctx.reportProgress(processed, total);
            },
            onItemSuccess: onImageItemSuccess,
        });

        if (ctx.signal.aborted) {
            return {
                success: false,
                itemsProcessed: result.stored,
                stopReason: 'aborted',
                result,
            };
        }
        if (ctx.softSignal?.aborted) {
            // Graceful partial sweep; the next scheduled run carries on.
            return {
                success: result.errors === 0,
                itemsProcessed: result.stored,
                stopReason: 'aborted',
                result,
            };
        }

        // Video frame extraction. scanImages above only matches pre-existing
        // image FILES on disk; episode thumbnails are ffmpeg-extracted frames.
        // We write artwork_type='thumb' — the type the episode card requests
        // (getCatalogThumbUrl) and the fresh-scan video-processor writes, so a
        // regenerate overwrites any stale 'thumb' row (e.g. one left pointing at
        // a wrong file after a re-link) with a fresh segment-correct frame.
        // When the caller asks for extractVideo on a TARGETED scope, run the
        // batch extractor: it distributes timestamps across multi-episode
        // "combined" files so each segment gets its own distinct frame.
        if (ctx.input.extractVideo && !ctx.signal.aborted) {
            // anchorId derived above maps the caller's id onto the active scope.
            if (anchorId) {
                const { extractFramesBatch } =
                    await import('../../../services/video-frame-extractor.service.js');
                const batchResult = await extractFramesBatch(ctx.sql, {
                    mediaItemId: anchorId,
                    scope,
                    mode: ctx.input.mode ?? 'execute',
                    artworkType: 'thumb',
                    force: ctx.input.force ?? false,
                    onProgress: (processed, total) => {
                        ctx.reportProgress(processed, total);
                    },
                });
                ctx.logger.info('image-sync video extraction complete', {
                    scope,
                    anchorId,
                    ...batchResult,
                });
            }
        }

        if (
            ctx.input.mediaItemId &&
            result.errors === 0 &&
            getAuthoritativeStageIds().has('image-sync')
        ) {
            await upsertCompletedRow(ctx.sql, {
                mediaItemId: ctx.input.mediaItemId,
                stageId: 'image-sync',
                processingVersion: 1,
            }).catch((err: unknown) => {
                ctx.logger.warn('image-sync: upsertCompletedRow failed', {
                    mediaItemId: ctx.input.mediaItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
        return {
            success: result.errors === 0,
            itemsProcessed: result.stored,
            result,
        };
    },
});

// ──────────────────────────────────────────────────────────────────────────
// trickplay-generation — sprite-sheet generation via ffmpeg
// ──────────────────────────────────────────────────────────────────────────

/**
 * How long ONE trickplay run gives itself to start new work, kept below the
 * declared hard cap so the service reaches its own stopping point first.
 *
 * 🔴 Must stay comfortably under `timeout.hard` below. The watchdog is the
 * WORSE outcome of the two: it kills the run mid-source, discards every frame
 * extracted so far, and re-enqueues the item to start over. The service's own
 * deadline stops between sources, where finished work is already on disk.
 */
const TRICKPLAY_RUN_BUDGET_MS = 50 * 60 * 1000;

const trickplayInputSchema = z
    .object({
        mediaItemId: z.string(),
        width: z.number().int().min(64).max(1024).optional(),
        quality: z.number().int().min(1).max(100).optional(),
        intervalMs: z.number().int().min(100).optional(),
        tileWidth: z.number().int().min(1).optional(),
        tileHeight: z.number().int().min(1).optional(),
        force: z.boolean().optional(),
    })
    .passthrough();

export const trickplayGenerationTask = defineTask<z.infer<typeof trickplayInputSchema>, unknown>({
    id: 'trickplay-generation',
    // Tile publication is idempotent (existing valid tiles are reused). The
    // durable stage retry policy owns backoff/exhaustion; do not stack a second
    // BullMQ retry budget on top of it.
    retry: { attempts: 1, backoff: [30_000], retryOn: classifyMediaInfraError },
    purpose: 'library',
    name: 'Trickplay Generation',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    // `cache` carries the hardware-decode deny list across runs. Under
    // `isolation: 'worker'` this module is re-imported per run, so an
    // in-memory latch would re-probe the GPU on every single source forever.
    capabilities: { database: true, ffmpeg: true, cache: true },

    // NO schedule: this is a strictly PER-ITEM task — `mediaItemId` is required,
    // `identityFor` keys on it, and `execute()` has no global path. A global
    // `schedule` fires with empty input `{}`, which fails inputSchema validation
    // (mediaItemId missing) → startRun throws before enqueue → scheduler_state's
    // next_fire_at never advances → a permanent self-wedge + a false "schedule
    // overdue" alarm (observed on preprod: stuck since 2026-05-31 when mediaItemId
    // became required). Coverage is driven by `coversStages` + stage-sweep
    // (per-item) and event invalidation below — the daily schedule was redundant
    // with the sweep AND structurally unable to fire. See also the recently-active
    // suppression in adaptOverdueSchedules.

    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    // Run execute() in a worker thread when FEATURE_PLUGIN_WORKER_ISOLATION is
    // on (default off → unchanged in-process path). Phase 2 isolation candidate:
    // heavy ffmpeg-bound work (tens of minutes/run) on the cpu pool — exactly
    // the kind of long run a synchronous wedge would starve all cpu runs on.
    isolation: 'worker',
    resourceClass: 'cpu', // ffmpeg-bound
    // 2026-05-24: under Wave 8.5 per-task queues, this caps the trickplay
    // worker's parallel-pop and is bounded by the cpu class budget. With
    // LUMASTRA_CONCURRENCY_CPU bumped 2→4 in the same commit, trickplay can
    // claim up to 4 cpu tokens when no other cpu task is competing — 2×
    // the prior effective throughput. 41k backlog drains in ~23 days at the
    // new rate (was ~46d). Operators with bigger boxes can bump higher;
    // realistically 7-day drain requires hardware beyond the 6-core preprod
    // baseline (would need maxConcurrent ≈12 with proportional cpu budget).
    quotas: { maxConcurrent: 4 },
    inputSchema: trickplayInputSchema,

    // Coverage row per playable item. Invalidates on file-content changes
    // because the rendered sprite-sheet is byte-identical until the
    // underlying media file actually changes — metadata refreshes (re-title,
    // re-rating) do NOT trigger a regenerate. Stage-sweep enqueues per item;
    // the service short-circuits when tiles already exist on disk, so
    // seeding pending rows for the whole library is cheap on items already
    // done.
    //
    // Previous declaration used the orphan `'content'` kind which was never
    // part of the StageInvalidationKind union (type drift, pre-existing
    // bug). Replaced with the canonical file-content kind + the new event
    // names; behavior is identical.
    coversStages: [
        {
            id: 'trickplay-generation',
            appliesTo: ['movie', 'episode'] as const,
            // Eligibility: trickplay generation is switched ON, and the item has a
            // non-missing file WITH a probed video stream. Items seeded before
            // media-probe writes streams are disposed to
            // `skipped_permanent/'ineligible'` by the sweep, then healed the instant
            // the video stream lands — event-independently (self-terminal stages have
            // no other recovery, so a lost probe event used to lose them forever).
            //
            // 🔴 `TRICKPLAY_ENABLED` belongs HERE, not only in the service. It
            // defaults to FALSE, so on a stock install every video was seeded
            // eligible, swept, enqueued, and `generateTrickplayForMediaItem()`
            // early-returned `success:false` ("Trickplay generation is disabled",
            // trickplay-generator.service.ts). `success:false` without `permanent`
            // routes through `resetRunningToPending` — which deliberately leaves
            // `attempt` alone — so the row went straight back to `pending`, was
            // re-swept 60s later, and never advanced. Nothing dead-lettered and
            // nothing completed: the stage churned forever and the aggregate
            // progress bar could never reach 100% out of the box. This stage is
            // also FIRST in stage-sweep's `PER_STAGE_HEAL_ORDER`, so the sweep was
            // additionally seeding 100 fresh unrunnable rows every tick.
            //
            // The flag is read INSIDE the builder, which `runStageDisposition`
            // calls on every sweep tick, and `config.TRICKPLAY_ENABLED` is a live
            // getter over `process.env` — so flipping the switch is observed within
            // one tick, in BOTH directions, with no event and no restart. It is
            // embedded as a literal `true`/`false` fragment rather than a bind
            // parameter so the composed `NOT (…)` needs no cast to type-check in PG.
            //
            // Monotone-recoverable (the `eligibility.sql` contract): a row that is
            // ineligible only because the operator has not enabled trickplay yet
            // becomes eligible the moment they do, and the heal pass below reclaims
            // it. See `recoverWhenAdditionalReasons`.
            eligibility: {
                sql: (sql) => sql`
                    ${config.TRICKPLAY_ENABLED ? sql`true` : sql`false`}
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
                // 'trickplay-disabled' is the reason the author predicate below
                // stamps while the feature is off. Listing it here is what makes
                // enabling the feature self-healing: the sweep's event-independent
                // heal re-runs `eligibility.sql` every tick and flips exactly these
                // reasons back to `pending` once it is TRUE again. Without it the
                // rows would be stranded, because `skipped_permanent` is never
                // re-swept and no pipeline event fires for a config change.
                recoverWhenAdditionalReasons: ['no-file-linked', 'trickplay-disabled'],
            },
            // Re-enrolling a whole library after the operator turns trickplay on is
            // a one-time bulk recovery, and the default 50/tick would take ~5.5h to
            // walk 16k items. The flip only marks rows `pending`; the actual work
            // stays bounded by the sweep's MAX_ENQUEUES_PER_TICK and the cpu class
            // budget, so raising this front-loads row state, not load.
            healLimit: 500,
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
                'file.probed',
            ] as const,
            // Adding an alternate-version file (file.attached, non-first) must
            // not re-run already-generated trickplay for the whole item.
            preserveCompletedOn: ['file.attached'] as const,
            enqueueable: true,
            terminalDisposition: [
                {
                    // Feature switched off — a WHOLE-STAGE fact, but expressed as a
                    // predicate rather than a `global-guard` on purpose. A
                    // global-guard drains to `skipped_transient`, and
                    // `loadStageProgressByIds` counts `skipped_transient` as
                    // REMAINING (it retries) while counting `skipped_permanent` as
                    // `not_applicable` and excluding it from the denominator. With a
                    // guard the churn would stop but the bar still could not reach
                    // 100% on a stock install, which is half the reported bug. A
                    // disabled feature is genuinely "not applicable to this install",
                    // so `skipped_permanent` is the honest status — and it is safe
                    // here only because `eligibility.sql` above carries the same flag
                    // and reclaims these rows the moment it flips (a guard's
                    // retryAfterMs backoff would be the recovery path instead).
                    //
                    // Runs BEFORE the eligibility dispose (order is invariant in
                    // `runStageDisposition`), so rows get this specific reason rather
                    // than the generic 'ineligible' the negation would stamp — which
                    // matters because 'ineligible' is also what a missing video
                    // stream writes, and an operator reading the Ingest Map must be
                    // able to tell "you turned this off" from "this file has no
                    // video". Once these rows are `skipped_permanent` they leave
                    // SWEEPABLE_STATUSES, so the eligibility negation never
                    // re-stamps them.
                    kind: 'predicate' as const,
                    ruleId: 'trickplay-generation-disabled',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'trickplay-disabled',
                    excludes: (sql) => (config.TRICKPLAY_ENABLED ? sql`false` : sql`true`),
                },
                {
                    // Self-terminal: per-item terminal writes for every candidate (clean on
                    // preprod, 0 pending). Like trickplay-params-sync, an item-level
                    // predicate disposition would be wrong here (per-file work vs per-item
                    // coverage), so self-terminal is the correct contract. Declarative Stage Contract.
                    kind: 'self-terminal' as const,
                    ruleId: 'trickplay-generation-self-terminal',
                },
            ],
        },
    ],

    // 30m was not enough for ONE 4K source decoded in software — LOTR at a 10s
    // interval is 1368 frames, and at the measured 5.8s/frame across 4 parallel
    // spawns that is ~33 minutes. The cap was therefore unreachable by
    // construction on a GPU-less box, and an unreachable cap is not a safety
    // net: it is an infinite retry loop that holds a cpu slot forever and
    // persists nothing. Hardware decode brings the same source to ~4 minutes,
    // so in practice this ceiling is now only the software fallback's headroom.
    // A genuinely wedged run is still caught long before it by the heartbeat
    // stall watchdog (10 min), which is the watchdog that exists for wedges.
    timeout: { hard: '60m', soft: '55m' },
    cost: { kind: 'cpu_seconds' },

    async execute(ctx) {
        const { clearTrickplayReclaimSnapshot } =
            await import('../../../database/queries/file-rematch.queries.js');
        if (ctx.signal.aborted) {
            await clearTrickplayReclaimSnapshot(ctx.sql, ctx.input.mediaItemId);
            return {
                success: false,
                itemsProcessed: 0,
                stopReason: 'aborted',
                result: { generated: 0, countUnit: 'frames' },
            };
        }
        const { restoreReclaimedTrickplay } =
            await import('../../../services/trickplay-reclaim.service.js');
        // Reclaim proof/copy runs under this task's CPU/concurrency budget, never
        // under the event dispatcher's outbox transaction. Explicit overrides
        // must use the generator's own settings checks.
        if (
            !ctx.input.force &&
            ctx.input.width === undefined &&
            ctx.input.quality === undefined &&
            ctx.input.intervalMs === undefined &&
            ctx.input.tileWidth === undefined &&
            ctx.input.tileHeight === undefined &&
            (await restoreReclaimedTrickplay(ctx.sql, ctx.input.mediaItemId, 1))
        ) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { reused: true, generated: 0, countUnit: 'frames' },
            };
        }
        const { generateTrickplayForMediaItem, cacheBackedHwaccelDenyList } =
            await import('../../../services/trickplay-generator.service.js');
        // Survives the per-run worker thread, so a codec the GPU cannot decode
        // is probed once rather than once per source. Absent when the host did
        // not grant the cache capability — the run then falls back to the
        // in-run latch, which is correct, just chattier.
        const hwaccelDenyList = ctx.cache ? cacheBackedHwaccelDenyList(ctx.cache) : undefined;
        // Keep the service's own stopping point INSIDE the watchdog's cap. Being
        // killed by the watchdog throws away every frame the run had extracted
        // and re-enqueues the item from zero — the loop that had six 4K movies
        // failing every 35 minutes for a day without persisting anything. The
        // service stops between sources instead, which is the only boundary
        // where partial work has already been saved.
        const deadlineAt = Date.now() + TRICKPLAY_RUN_BUDGET_MS;
        const result = await generateTrickplayForMediaItem(ctx.sql, ctx.input.mediaItemId, {
            ...(ctx.input.width !== undefined ? { width: ctx.input.width } : {}),
            ...(ctx.input.quality !== undefined ? { quality: ctx.input.quality } : {}),
            ...(ctx.input.intervalMs !== undefined ? { intervalMs: ctx.input.intervalMs } : {}),
            ...(ctx.input.tileWidth !== undefined ? { tileWidth: ctx.input.tileWidth } : {}),
            ...(ctx.input.tileHeight !== undefined ? { tileHeight: ctx.input.tileHeight } : {}),
            force: ctx.input.force === true,
            deadlineAt,
            ...(hwaccelDenyList ? { hwaccelDenyList } : {}),
            // Service checks between episodes/sources AND passes the
            // signal into spawnFFmpegSafely so a long extraction
            // (~30+ min on 3h movies) is killed mid-pass on Cancel.
            signal: ctx.signal,
            onProgress: (processed, total) => {
                ctx.reportProgress(processed, total);
            },
        }).catch(async (error: unknown) => {
            await clearTrickplayReclaimSnapshot(ctx.sql, ctx.input.mediaItemId);
            throw error;
        });

        if (
            !result.success ||
            result.errors > 0 ||
            result.sourcesRemaining > 0 ||
            ctx.signal.aborted
        ) {
            await clearTrickplayReclaimSnapshot(ctx.sql, ctx.input.mediaItemId);
        }
        if (ctx.signal.aborted) {
            return {
                success: false,
                itemsProcessed: result.generated,
                stopReason: 'aborted',
                result: { ...result, countUnit: 'frames' },
            };
        }

        // Only zero-progress environment failures consume a failed stage
        // attempt. Preserve useful partial work; the sweep finishes the rest.
        // No message classification here: error text can contain FFmpeg paths.
        const madeProgress = result.generated > 0 || result.skipped > 0;
        if (result.errors > 0 && result.permanent !== true && !madeProgress) {
            throw new TaskError({
                kind: 'transient',
                message: result.error ?? 'Trickplay generation interrupted',
            });
        }
        if (result.errors > 0 && madeProgress) {
            ctx.logger.warn('Trickplay generation made progress with errors', {
                generated: result.generated,
                skipped: result.skipped,
                errors: result.errors,
                sourcesRemaining: result.sourcesRemaining,
                error: result.error,
            });
        }

        // Write coverage completion when the canonical stage IDs include us.
        // `generated > 0` means new tiles were rendered; `skipped > 0 &&
        // generated === 0` means tiles already existed on disk — both count
        // as covered. `errors > 0` is treated as a transient failure by
        // the durable stage policy; do not mark coverage completed in that case.
        //
        // 🔴 `sourcesRemaining > 0` is a SUCCESSFUL run that deliberately did
        // only part of the item (see the one-source-per-run note in the
        // generator). Writing coverage here would tell the sweep the item is
        // done and strand every source after the first — a 4K edition would
        // simply never get sprites. Leaving the row pending is what makes the
        // next sweep tick pick the item back up and finish it.
        if (
            result.success &&
            result.errors === 0 &&
            result.sourcesRemaining === 0 &&
            getAuthoritativeStageIds().has('trickplay-generation')
        ) {
            const { completeTrickplayGeneration } =
                await import('../../../services/trickplay-reclaim.service.js');
            await completeTrickplayGeneration(ctx.sql, ctx.input.mediaItemId, 1).catch(
                (coverageErr: unknown) => {
                    ctx.logger.warn('trickplay-generation: upsertCompletedRow failed', {
                        mediaItemId: ctx.input.mediaItemId,
                        error:
                            coverageErr instanceof Error
                                ? coverageErr.message
                                : String(coverageErr),
                    });
                    throw coverageErr;
                },
            );
        }

        // 🔴 A partial run must report `success: false`, however well it went.
        //
        // `wrapExecute` (run-wrapper.ts) auto-completes the stage row for any
        // single-`coversStages` task that does NOT return `success: false` —
        // it runs its own `markCompleted` on the way out, independently of the
        // `upsertCompletedRow` gate above. So returning `success: true` with
        // sources still to do would close the coverage row anyway, the sweep
        // would never look at the item again (it only picks up pending /
        // failed_transient / skipped_transient / obsolete), and the 4K edition
        // would silently never get sprites — the same stranded-source outcome
        // as before, minus the alarm that made it visible.
        //
        // `success: false` routes the row through `resetRunningToPending`,
        // which is exactly the disposition wanted here and deliberately leaves
        // `attempt` alone ("declining to run is not a failed attempt"), so a
        // multi-edition item cannot burn its retry budget just by being
        // multi-edition. The RUN itself is still recorded `completed` — the
        // runner only fails a run that throws — so this does not feed the
        // actionable-failure alarm.
        const partial = result.sourcesRemaining > 0;
        return {
            success: result.success && !partial,
            // 'budget' is the closest member of the SDK's stopReason union:
            // the run stopped because it had spent its allowance for this pass,
            // not because anything went wrong.
            ...(partial ? { stopReason: 'budget' as const } : {}),
            // Surfaced to the run-wrapper: an unreadable container must land
            // in `failed_permanent`, not back in `pending`. Left in `pending`
            // it re-drains on every sweep tick forever — on prod that pinned
            // both trickplay slots and stalled the stage at 98%.
            //
            // Only when the item is FULLY accounted for, though. `permanent`
            // is an item-level verdict, and the run-wrapper acts on it before
            // it looks at `success` — so reporting it while sources remain
            // untried would write off the whole item on the strength of one
            // unreadable edition, taking a perfectly good second edition down
            // with it and leaving no path back (nothing re-enqueues a
            // failed_permanent row short of `file.contentChanged`).
            //
            // The reason goes at the top level too: the run wrapper's
            // permanentFailureMessage() reads `error` there, not inside
            // `result`. Without it a written-off item stored the bare "Task
            // reported a permanent failure" and Fix matches showed "No reason
            // recorded" for an encrypted (`encv`) or VVC stream on prod.
            ...(result.permanent === true && !partial
                ? { permanent: true, ...(result.error ? { error: result.error } : {}) }
                : {}),
            itemsProcessed: result.generated,
            result: { ...result, countUnit: 'frames' },
        };
    },
});

// ──────────────────────────────────────────────────────────────────────────
// auto-identify-personal-media — bulk match unmatched personal-media items
// ──────────────────────────────────────────────────────────────────────────

const autoIdentifyInputSchema = z
    .object({
        // Fix matches → "Auto-identify selected": restrict the sweep to these
        // top-level personal-media ids. Absent = the whole unmatched library.
        mediaItemIds: z.array(z.string().guid()).max(500).optional(),
        // Fix matches → "Auto-identify" while the list is filtered: the same
        // filters the page shows (library, type, search), applied server-side
        // so the run covers exactly the listed items, however many there are.
        scope: z
            .object({
                libraryGroupId: z.string().guid().optional(),
                mediaType: z.enum(['movie', 'tv']).optional(),
                search: z.string().trim().min(1).max(200).optional(),
            })
            .strict()
            .optional(),
    })
    .passthrough();

export const autoIdentifyPersonalMediaTask = defineTask<
    z.infer<typeof autoIdentifyInputSchema>,
    unknown
>({
    id: 'auto-identify-personal-media',
    purpose: 'library',
    name: 'Find Online Matches',
    version: '1.1.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    schedule: { every: '24h', runOnStartup: false },

    identityFor: (input) => {
        const ids = (input as { mediaItemIds?: unknown }).mediaItemIds;
        // A targeted run must not collapse into (or be mistaken for) the
        // library-wide sweep's identity.
        if (Array.isArray(ids) && ids.length > 0) {
            return `items-${ids.length}-${[...ids].sort().join(',').slice(0, 180)}`;
        }
        const scope = (input as { scope?: Record<string, unknown> }).scope;
        if (scope && Object.keys(scope).length > 0) {
            // A scoped run is neither the library-wide sweep nor another scope.
            const parts = ['libraryGroupId', 'mediaType', 'search'].map((k) =>
                typeof scope[k] === 'string' ? (scope[k] as string) : '',
            );
            return `scope-${parts.join('|').slice(0, 200)}`;
        }
        return `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`;
    },
    scope: 'global',
    resourceClass: 'maintenance',
    inputSchema: autoIdentifyInputSchema,

    timeout: { hard: '30m', soft: '28m' },
    cost: { kind: 'api_calls' },

    // Singleton guard: spends real match-provider API quota (cost:
    // 'api_calls'). Without exclusiveWith, the scheduler's narrow double-fire
    // window (fast-completing run + failed scheduler_state advance) can spawn
    // a second concurrent 'global-catchup' sweep that doubles spend for no
    // extra coverage. NOTE: identityFor is mode-suffixed exactly like
    // music-popularity's pre-fix shape — a manual/force trigger still gets
    // its OWN identity ('global-manual'/'global-force') and can overlap with
    // an in-flight catchup run. That cross-mode gap is out of scope here
    // (Task 2 only touches music-popularity); this only closes the
    // same-mode (scheduled-vs-scheduled) double-fire. ttl exceeds the 30m
    // hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '40m' },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            const { processAutoIdentifyPersonalMedia } =
                await import('../../../services/auto-identify.service.js');
            const result = await processAutoIdentifyPersonalMedia({
                // Task-tier handle — keep the bulk sweep on the task pool.
                sql: ctx.sql,
                // Checked at the top of every item-loop iteration — sweeping
                // thousands of personal-media items at 300ms each was the worst
                // cancel-ignore offender before this wire-in.
                signal: ctx.signal,
                mediaItemIds: ctx.input.mediaItemIds,
                scope: ctx.input.scope,
                onProgress: (phase, matched, skipped, total) => {
                    ctx.reportProgress(matched + skipped, total, phase);
                },
            });

            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: result.matched + result.skipped,
                    stopReason: 'aborted',
                    result,
                };
            }

            // Total failure: nothing matched and at least one item failed —
            // e.g. the metadata provider is unreachable for the whole sweep.
            // The old `failed === 0 || matched > 0` condition called 999
            // failures + 1 lucky match a "success". This task has no
            // `coversStages`/`mediaItemId` (bulk, scope:'global'), so it
            // never goes through the wrapExecute per-item coverage-gating
            // path — a bare `success:false` return here is NOT surfaced to
            // the circuit breaker or task_history state (only a thrown error
            // is), so total failure must throw to be visible at all.
            if (result.failed > 0 && result.matched === 0) {
                throw new TaskError({
                    message: `auto-identify-personal-media: total failure — 0 matched across ${result.failed} failure(s) (${result.skipped} skipped)`,
                    kind: 'transient',
                });
            }

            return {
                // Now honestly reflects partial failure (some matched, some
                // failed) as success:false instead of masking it as success.
                // Since this task has no coversStages/mediaItemId, this flag
                // is purely informational — see the comment above the throw.
                success: result.failed === 0,
                itemsProcessed: result.matched + result.skipped,
                result,
            };
        });
    },
});

// ──────────────────────────────────────────────────────────────────────────
// bulk-media-sync — sync metadata for an admin-selected batch of media items
// ──────────────────────────────────────────────────────────────────────────

const BULK_SYNC_CHECKPOINT_VERSION = 1;

interface BulkSyncCheckpoint {
    v: number;
    /** Length of the id list it was saved for (a cheap identity check). */
    count: number;
    /** Index of the next item to sync. */
    next: number;
    processed: number;
    failedIds: string[];
}

const bulkSyncCheckpointSchema = z.object({
    v: z.literal(BULK_SYNC_CHECKPOINT_VERSION),
    count: z.number().int().min(1),
    next: z.number().int().min(0),
    processed: z.number().int().min(0),
    failedIds: z.array(z.string()).max(500),
});

/** The saved position when it belongs to this id list, else null. */
export function parseBulkSyncCheckpoint(
    raw: unknown,
    mediaItemIds: readonly string[],
): BulkSyncCheckpoint | null {
    const parsed = bulkSyncCheckpointSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (parsed.data.count !== mediaItemIds.length || parsed.data.next > mediaItemIds.length) {
        return null;
    }
    return parsed.data;
}

const bulkMediaSyncInputSchema = z
    .object({
        mediaItemIds: z.array(z.string()).min(1).max(500),
        includeChildren: z.boolean().optional(),
        forceChildren: z.boolean().optional(),
        respectLocks: z.boolean().optional(),
    })
    .passthrough();

export const bulkMediaSyncTask = defineTask<z.infer<typeof bulkMediaSyncInputSchema>, unknown>({
    id: 'bulk-media-sync',
    purpose: 'library',
    name: 'Bulk Metadata Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    // No schedule — admin-triggered only, from the bulk action bar.
    manualOnly: true,
    // A large selection runs for hours. Safe to resume: a forced re-sync of
    // an item gives the same result. The checkpoint (position in the id list)
    // keeps a resumed run from repeating items — and their TMDB calls.
    resumeAfterRestart: true,
    identityFor: (input) => `batch-${input.mediaItemIds.length}-${Date.now()}`,
    scope: 'global',
    // Same reasoning as series-sync: TMDB-bound and can run long for a large
    // selection, so it belongs on the bulk pool rather than the io fast path.
    resourceClass: 'bulk',
    inputSchema: bulkMediaSyncInputSchema,

    // No coversStages — this task processes an ad hoc id array, not a single
    // subject the stage-coverage system can key on (same shape as
    // auto-identify-personal-media above).
    timeout: { hard: '6h', soft: '5h' },
    cost: { kind: 'api_calls' },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            const { mediaItemIds, includeChildren, forceChildren } = ctx.input;
            // Resumed after a restart: continue at the saved position, with
            // the counts the interrupted run had reached. Ignored unless it
            // matches this id list.
            const saved = parseBulkSyncCheckpoint(await ctx.checkpoint?.load(), mediaItemIds);
            const failedIds: string[] = saved ? [...saved.failedIds] : [];
            let processed = saved?.processed ?? 0;

            const { syncSingleItem, syncSeriesWithChildren } =
                await import('../../../services/metadata-sync-single.service.js');

            // Saved after every item that reached a final outcome (synced,
            // rejected, or genuinely failed) — never for one the abort cut
            // short, so a resumed run re-does exactly that item.
            const saveCheckpoint = async (next: number): Promise<void> => {
                await ctx.checkpoint?.save({
                    v: BULK_SYNC_CHECKPOINT_VERSION,
                    count: mediaItemIds.length,
                    next,
                    processed,
                    failedIds,
                } satisfies BulkSyncCheckpoint);
            };

            for (const [index, mediaItemId] of mediaItemIds.entries()) {
                if (saved && index < saved.next) continue;
                if (ctx.signal.aborted) break;
                try {
                    const [row] = await ctx.sql<{ media_type: string }[]>`
                        SELECT media_type FROM media_items WHERE id = ${mediaItemId}
                    `;
                    if (!row) {
                        failedIds.push(mediaItemId);
                        await saveCheckpoint(index + 1);
                        continue;
                    }
                    // Episodes/seasons can't be synced directly — same gate as
                    // the single-item endpoint (admin/media/[id]/sync.ts).
                    if (isEpisode(row.media_type) || isSeason(row.media_type)) {
                        failedIds.push(mediaItemId);
                        await saveCheckpoint(index + 1);
                        continue;
                    }

                    if (includeChildren && isSeries(row.media_type)) {
                        await syncSeriesWithChildren(
                            ctx.sql,
                            mediaItemId,
                            { force: true, forceChildren: forceChildren === true },
                            undefined,
                            ctx.signal,
                        );
                        // The series sync honours the signal and may have
                        // stopped part-way: not a finished item.
                        if (ctx.signal.aborted) break;
                    } else {
                        // Not signal-aware: when it returns, the item is done
                        // even if the abort fired meanwhile.
                        await syncSingleItem(ctx.sql, mediaItemId, { force: true });
                    }
                    processed++;
                } catch {
                    // Cut short by cancel/shutdown: not a sync failure.
                    if (ctx.signal.aborted) break;
                    failedIds.push(mediaItemId);
                }
                ctx.reportProgress(processed + failedIds.length, mediaItemIds.length, mediaItemId);
                await saveCheckpoint(index + 1);
            }

            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: processed,
                    stopReason: 'aborted',
                    failedIds,
                };
            }

            // Total failure: nothing synced and at least one item failed. This
            // task has no coversStages/mediaItemId (bulk, scope:'global'), so
            // it never goes through wrapExecute's per-item coverage-gating
            // path — a bare success:false return is not surfaced to the
            // circuit breaker or task_history state (only a thrown error is),
            // so total failure must throw to be visible at all. Same reasoning
            // as auto-identify-personal-media above.
            if (failedIds.length > 0 && processed === 0) {
                throw new TaskError({
                    message: `bulk-media-sync: total failure — 0 synced across ${failedIds.length} failure(s)`,
                    kind: 'transient',
                });
            }

            return {
                success: failedIds.length === 0,
                itemsProcessed: processed,
                failedIds,
            };
        });
    },
});

// ---------------------------------------------------------------------------
// library-folder-detach — retire the files of a deleted library folder
// ---------------------------------------------------------------------------

const libraryFolderDetachInputSchema = z
    .object({
        // The deleted folder's path (absolute). Every media_files row at or
        // below it is retired.
        path: z.string().startsWith('/').min(2),
    })
    .strict();

const DETACH_BATCH = 200;

export const libraryFolderDetachTask = defineTask<
    z.infer<typeof libraryFolderDetachInputSchema>,
    unknown
>({
    id: 'library-folder-detach',
    purpose: 'library',
    name: 'Detach Deleted Library Folder',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    // Started by DELETE of a library folder (library-folder.service.ts).
    manualOnly: true,
    // Idempotent: every batch re-reads what is still attached, so a resumed
    // run simply continues.
    resumeAfterRestart: true,
    identityFor: (input) => `folder-${input.path}`,
    scope: 'global',
    resourceClass: 'maintenance',
    inputSchema: libraryFolderDetachInputSchema,
    timeout: { hard: '6h', soft: '5h' },

    async execute(ctx) {
        const { path } = ctx.input;
        const { deleteStaleMediaFile } =
            await import('../../../database/queries/media-files.queries.js');
        const { getAllLibraryPaths } =
            await import('../../../database/queries/library-paths.queries.js');

        let detached = 0;
        const [{ n: total }] = await ctx.sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM media_files
            WHERE file_path = ${path} OR starts_with(file_path, ${path} || '/')
        `;
        for (;;) {
            if (ctx.signal.aborted) {
                return { success: false, itemsProcessed: detached, stopReason: 'aborted' };
            }
            // The folder (or one around it) was added again since the delete:
            // its files are live library files again, not leftovers.
            const covering = (await getAllLibraryPaths(ctx.sql)).some(
                (row) =>
                    row.path === path ||
                    path.startsWith(`${row.path}/`) ||
                    row.path.startsWith(`${path}/`),
            );
            if (covering) {
                ctx.logger.info('Folder was added to a library again; leaving its files', {
                    path,
                    detached,
                });
                return {
                    success: true,
                    itemsProcessed: detached,
                    stopReason: 'skipped',
                    result: { folderReAdded: true },
                };
            }
            const batch = await ctx.sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files
                WHERE file_path = ${path} OR starts_with(file_path, ${path} || '/')
                ORDER BY file_path
                LIMIT ${DETACH_BATCH}
            `;
            if (batch.length === 0) break;
            let progressed = 0;
            const detachedItemIds: string[] = [];
            for (const { file_path } of batch) {
                if (ctx.signal.aborted) break;
                // The scanner's own path for a file that vanished from disk:
                // file rows removed, items left without files dismissed (user
                // data kept), has_files recomputed.
                const { deleted, affectedItemIds } = await deleteStaleMediaFile(ctx.sql, file_path);
                if (deleted) {
                    detached++;
                    progressed++;
                    detachedItemIds.push(...(affectedItemIds ?? []));
                }
                ctx.reportProgress(detached, Math.max(total, detached), 'detaching');
            }
            // One scoped recency refresh per batch for the titles that lost files.
            try {
                await refreshRecentlyAddedRecencyForItems(ctx.sql, detachedItemIds);
            } catch (err) {
                ctx.logger.warn('library-folder-detach: recency refresh failed (non-fatal)', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            // Nothing in a full batch could be removed: stop instead of looping.
            if (progressed === 0 && !ctx.signal.aborted) {
                throw new TaskError({
                    message: `library-folder-detach: ${batch.length} file row(s) under ${path} could not be removed`,
                    kind: 'transient',
                });
            }
        }
        return { success: true, itemsProcessed: detached };
    },
});

registry.registerTask(seriesSyncTask);
registry.registerTask(chapterSyncTask);
registry.registerTask(imageSyncTask);
registry.registerTask(trickplayGenerationTask);
registry.registerTask(autoIdentifyPersonalMediaTask);
registry.registerTask(bulkMediaSyncTask);
registry.registerTask(libraryFolderDetachTask);
