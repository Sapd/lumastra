// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * metadata-translations-sync — per-language display translations backfill.
 *
 * Part of the multilingual-media-metadata feature (Task 6). Two tasks live
 * in this one file because they share the same stage id and helpers:
 *
 *  - `metadata-translations-sync` (stage task): per-item backfill of
 *    `media_item_translations` rows for `config.METADATA_ADDITIONAL_LANGUAGES`.
 *    Movies: one detail call. Series: series row + per-language per-season
 *    episode fetches. Drained automatically by `stage-sweep` via
 *    `coversStages` + `enqueueable: true` — this task does NOT implement its
 *    own `backlog: { compute }` drain loop. Every real coversStages-driven
 *    per-item task in this codebase (series-sync, chapter-sync, image-sync,
 *    trickplay-generation, tmdb-metadata-sync's per-item path,
 *    metadata-update) follows this same shape with no `backlog` block; the
 *    `backlog: { stages, compute }` pattern shown in `library-embeddings.ts`
 *    is an SDK tutorial demo (`demo: true`) with a stubbed `compute()` — no
 *    production task actually drains `media_item_stage_state` through it.
 *    stage-sweep (`stage-sweep.ts`) is the real drain: it calls
 *    `findSweepCandidates(sql, 'metadata-translations-sync', limit)` and
 *    `orchestrator.startRun('metadata-translations-sync', { mediaItemId })`
 *    per pending row on its own 60s cycle.
 *
 *  - `metadata-translations-seed` (one-shot/scheduled admin task): seeds
 *    stage rows for existing items (a brand-new stage has zero rows — see
 *    `reEnrollCompletedStageForReset`'s doc comment) and un-skips
 *    'translations-disabled' rows. Re-enrolling COMPLETED rows (the
 *    add-a-language-later re-fetch) happens only when the caller passes
 *    `{ reEnroll: true }` — the settings-save hook does; the daily schedule
 *    does NOT (it would re-fetch the entire completed catalog from TMDB
 *    every 24h). Env-var-only language changes (bypassing the settings UI)
 *    therefore get new/missing items daily but need the UI-save hook or a
 *    manual `{ reEnroll: true }` trigger to re-translate completed items.
 *    Pattern: `embedding-reset.ts`, but with a `schedule: { every: '24h' }`
 *    fallback instead of `manualOnly` (the brief's "manualOnly … but WITH
 *    schedule" is contradictory — manualOnly means never-scheduled).
 *
 * Media-type casing note (see CLAUDE.md "Critical: Media Type Case
 * Consistency"): `coversStages[].appliesTo` uses the SDK's `SdkMediaType`
 * enum, which spells the TV branch `'series'` (matching `series-sync`'s
 * `appliesTo: ['series']`). Raw SQL against `media_items.media_type` (the
 * seed task's INSERT, and `resolveMediaTmdb`'s lookup) uses the DB's actual
 * stored value `'tv'`. Both are used correctly below — do not swap them.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { config } from '$lib/server/config.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/client.js';
import { collectTmdbTranslations } from '$lib/server/services/tmdb-translations-collect.js';
import { upsertMediaTranslations } from '$lib/server/database/queries/media-translations.queries.js';
import {
    findEpisodeDataByPosition,
    findEpisodeDataByProviderEpisodeId,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    upsertCompletedRow,
    reEnrollCompletedStageForReset,
} from '$lib/server/database/queries/stage-state.queries.js';
import { classifyInfraError } from '../../infra-retry.js';

const STAGE_ID = 'metadata-translations-sync';

// ──────────────────────────────────────────────────────────────────────────
// Shared: per-item sync
// ──────────────────────────────────────────────────────────────────────────

/**
 * Structural subset of `TMDBApiService` this module needs. Lets tests inject
 * a plain mock object instead of constructing a real `TMDBApiService`.
 */
export interface TranslationsApi {
    getMovieDetails(tmdbId: number): Promise<unknown>;
    getTVShowDetails(tmdbId: number): Promise<unknown>;
    getSeasonEpisodesInLanguage(
        tmdbId: number,
        seasonNumber: number,
        language: string,
        opts?: { throwOnError?: boolean },
    ): Promise<
        {
            id: number;
            name: string;
            overview: string | null;
            episodeNumber: number;
            seasonNumber: number;
        }[]
    >;
}

export type SyncTranslationsDisposition = 'completed' | 'skipped_permanent';

export interface SyncTranslationsOutcome {
    disposition: SyncTranslationsDisposition;
    /** Present only when disposition === 'skipped_permanent'. */
    reason?: string;
    /** Count of (series/movie + episode) translation rows written. */
    itemsProcessed: number;
}

/** Inter-call throttle between direct `tmdbApi` season fetches (spec §4.2) —
 * these calls bypass the provider-invocation 4rps token bucket (`ctx.dep()`),
 * so this task applies its own simple delay. The TMDB circuit breaker
 * (`getBreaker('tmdb')`) still applies regardless, inside the client. */
const SEASON_FETCH_THROTTLE_MS = 250;

/**
 * Per-item translations sync — exported for unit testing.
 *
 * Resolves disposition only; does NOT write to `media_item_stage_state`
 * itself (the caller, `execute()`, owns the stage-row write so it can apply
 * the `last_run_id = NULL` guard against the runner's auto-complete — see
 * `tmdb-metadata-sync-task.ts:253-269`).
 *
 * - `languages` empty → `skipped_permanent` / `'translations-disabled'`
 *   (checked BEFORE any DB/TMDB call — an install with the feature off must
 *   not pay a query for every backlog item).
 * - No resolvable TMDB id → `skipped_permanent` / `'no-primary-external-id'`.
 * - Movie: one `getMovieDetails` call → `collectTmdbTranslations` → upsert.
 * - Series: same for the series row, then for each admin language × each
 *   season in the series detail's `seasons` array, a per-language season
 *   fetch with `throwOnError: true` — a fetch failure PROPAGATES (thrown,
 *   not swallowed) so normal stage-state failed_transient/failed_permanent
 *   retry semantics apply instead of silently completing with missing data
 *   (spec §8). Episodes are mapped back to local `media_items` rows by TMDB
 *   episode **id** (`findEpisodeDataByProviderEpisodeId` → `external_ids`) —
 *   the same identity the main metadata sync attaches episodes with — with
 *   `findEpisodeDataByPosition` only as a fallback for episodes carrying no
 *   per-episode tmdb id locally (see the bug note on the loop below).
 *   Episodes that resolve to no local row are skipped (a TMDB-side episode
 *   our library never synced).
 * - Anything else (unexpected media_type on the resolved row) →
 *   `skipped_permanent` / `'unsupported-media-type'` — defensive; `appliesTo`
 *   already restricts what stage-sweep enqueues.
 */
export async function syncTranslationsForItem(
    sql: postgres.Sql,
    api: TranslationsApi,
    mediaItemId: string,
    languages: string[],
    logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<SyncTranslationsOutcome> {
    if (languages.length === 0) {
        return {
            disposition: 'skipped_permanent',
            reason: 'translations-disabled',
            itemsProcessed: 0,
        };
    }

    // Dynamic import: matches the convention every other coversStages task in
    // this directory uses for `metadata-sync-single.service.ts` (series-sync,
    // tmdb-metadata-sync-task) — that service pulls in a large transitive
    // graph (catalog service, provider registry, all three metadata
    // providers' series-children helpers) that a task module should not eat
    // at boot/module-eval time.
    const { resolveMediaTmdb } =
        await import('$lib/server/services/metadata-sync-single.service.js');
    const resolved = await resolveMediaTmdb(sql, mediaItemId);
    if (!resolved) {
        return {
            disposition: 'skipped_permanent',
            reason: 'no-primary-external-id',
            itemsProcessed: 0,
        };
    }

    const { tmdbId, current } = resolved;

    if (isMovie(current.media_type)) {
        const details = await api.getMovieDetails(tmdbId);
        const inputs = collectTmdbTranslations(details, languages);
        const itemsProcessed = await upsertMediaTranslations(sql, mediaItemId, inputs);
        return { disposition: 'completed', itemsProcessed };
    }

    if (!isSeries(current.media_type)) {
        return {
            disposition: 'skipped_permanent',
            reason: 'unsupported-media-type',
            itemsProcessed: 0,
        };
    }

    // Series: series-row translations first, then per-language per-season
    // episode translations.
    const seriesDetails = (await api.getTVShowDetails(tmdbId)) as {
        seasons?: Array<{ season_number: number }>;
    };
    let itemsProcessed = await upsertMediaTranslations(
        sql,
        mediaItemId,
        collectTmdbTranslations(seriesDetails, languages),
    );

    const seasonNumbers = (seriesDetails.seasons ?? []).map((s) => s.season_number);
    let isFirstSeasonFetch = true;
    for (const language of languages) {
        for (const seasonNumber of seasonNumbers) {
            if (!isFirstSeasonFetch) {
                await new Promise((resolve) => setTimeout(resolve, SEASON_FETCH_THROTTLE_MS));
            }
            isFirstSeasonFetch = false;

            // throwOnError: true — propagate so stage-state retry semantics
            // apply (spec §8); the client's default swallow-to-`[]` would
            // otherwise mark this item completed with missing translations.
            // EXCEPT a season-level 404: TMDB simply not having this season
            // (our numbering has a season the provider entry lacks — common
            // right after a re-identify to a different-shaped series) is not
            // transient and must not dead-letter the WHOLE item's
            // translations; skip the season and translate the rest. Observed
            // on prod 2026-07-15: a re-identified series bounced back into
            // needs-re-identification forever because one local season
            // 404'd on every retry.
            let episodes: Awaited<ReturnType<typeof api.getSeasonEpisodesInLanguage>>;
            try {
                episodes = await api.getSeasonEpisodesInLanguage(tmdbId, seasonNumber, language, {
                    throwOnError: true,
                });
            } catch (err) {
                const status = (err as { status?: number | null })?.status;
                if (status === 404) {
                    logger?.warn('Season not on TMDB — skipping its translations', {
                        tmdbId,
                        seasonNumber,
                        language,
                    });
                    continue;
                }
                throw err;
            }
            for (const episode of episodes) {
                // Match by TMDB episode ID, not by (season, episode) position
                // (bug fixed here). Position matching silently attaches the
                // wrong language title whenever TMDB's *current* numbering
                // diverges from what we stored — TMDB re-numbers older shows
                // (Recess S2: our physical ep22 "Principal for a Day" is TMDB's
                // current ep24, so the ep22 German fetch "Haarige Zeiten" landed
                // on the wrong episode) — and `findEpisodeDataByPosition` is
                // ALSO wrong the other way when a custom/absolute ordering
                // override is active, because it then matches TMDB's *standard*
                // position against our *display* (`eo.order_episode_number`)
                // number, which is a different physical episode. The per-episode
                // `external_id` is the only identity stable under both, and it's
                // the same key `metadata-sync-single.service.ts` attaches
                // episodes with. Fall back to positional matching only for
                // episodes that carry no local tmdb id (never id-attached).
                //
                // Guard the id itself: a malformed/zero/absent TMDB episode id
                // (`String(undefined)` etc.) can't match anything, so skip the
                // id lookup entirely and go straight to the fallback rather
                // than burning a guaranteed-miss query on bad provider data.
                const tmdbEpisodeId =
                    Number.isInteger(episode.id) && episode.id > 0 ? String(episode.id) : null;
                let episodeData = tmdbEpisodeId
                    ? await findEpisodeDataByProviderEpisodeId(
                          sql,
                          mediaItemId,
                          'tmdb',
                          tmdbEpisodeId,
                      )
                    : null;
                if (!episodeData) {
                    // Positional fallback == the pre-fix matching, which is the
                    // one vulnerable to TMDB re-numbering / ordering overrides.
                    // It only runs for episodes with no usable local tmdb id, but
                    // LOG when it actually resolves a row so a recurrence of the
                    // title mis-attach bug class stays visible to operators
                    // instead of silently regressing.
                    episodeData = await findEpisodeDataByPosition(
                        sql,
                        mediaItemId,
                        seasonNumber,
                        episode.episodeNumber,
                    );
                    if (episodeData) {
                        logger?.warn(
                            'metadata-translations-sync: episode resolved via positional fallback (no tmdb-id match) — title attach may be mis-ordered if TMDB re-numbered this season',
                            {
                                mediaItemId,
                                seasonNumber,
                                tmdbEpisodeNumber: episode.episodeNumber,
                                tmdbEpisodeId: episode.id,
                                resolvedEpisodeId: episodeData.id,
                                language,
                            },
                        );
                    }
                }
                if (!episodeData) continue;
                itemsProcessed += await upsertMediaTranslations(sql, episodeData.id, [
                    { language, title: episode.name, overview: episode.overview },
                ]);
            }
        }
    }

    return { disposition: 'completed', itemsProcessed };
}

/** Hand-rolled disposition write — mirrors `tmdb-metadata-sync-task.ts:253-269`
 * in spirit (both need to survive `wrapExecute`'s auto-`markCompleted` on the
 * way out — see the `last_run_id = NULL` note below).
 *
 * UPSERT, not UPDATE-only (bug fixed here): `wrapExecute` (the runner's
 * single-coversStages wrapper) DOES seed/claim a `media_item_stage_state` row
 * via `upsertRunningRow` — a real INSERT-or-UPDATE — before calling
 * `execute()`, including when NO row previously existed for
 * `(mediaItemId, stageId)`. So on the normal runner dispatch path a row is
 * already guaranteed to exist (owned by `runId`, status `'running'`) by the
 * time this function runs. But `execute()`'s body — and therefore this
 * writer — is also reachable directly (unit tests via `runTask`, and any
 * future caller that constructs its own `TaskContext` without going through
 * `wrapExecute`, per the "never hand-roll a TaskContext" footgun documented
 * in `tasks/CLAUDE.md`). In THAT case an UPDATE-only write silently affects
 * zero rows and leaves nothing behind — the lazy-fill hook in `media-id.ts`
 * only checks "does a row exist" before re-enqueueing, so a permanently
 * untranslatable item would be re-enqueued and re-skipped forever. INSERT
 * ... ON CONFLICT DO UPDATE closes that gap unconditionally, while staying
 * correct for the guaranteed-row path (mirrors `upsertCompletedRow`'s
 * INSERT-or-UPDATE shape in stage-state.queries.ts).
 *
 * ON CONFLICT guard — deliberately WIDER than `upsertSkippedPermanentRow`'s
 * `WHERE status IN (...)` list, which excludes `'running'` on purpose (see
 * that function's doc comment). Excluding `'running'` here would silently
 * no-op on the NORMAL path, because `wrapExecute` always leaves the row in
 * `'running'` (owned by `runId`) immediately before `execute()`'s body runs.
 * So the guard allows the UPDATE when the row is in any pre-terminal /
 * already-skipped status (same list `upsertSkippedPermanentRow` uses) OR
 * when it's `'running'` under OUR OWN `runId` — exactly the state
 * `wrapExecute` leaves it in. A `'running'` row owned by a genuinely
 * DIFFERENT (concurrent) run is left untouched, matching the "keep, don't
 * clobber" pattern `upsertRunningRow` already uses for the same race.
 *
 * `last_run_id = NULL` (kept from the original UPDATE-only version) is still
 * required: `wrapExecute` gates its own `markCompleted` on
 * `result.success !== false` (this task returns `success: false` on the skip
 * path, so that gate alone already prevents the clobber today), but nulling
 * `last_run_id` here is the same defense-in-depth `tmdb-metadata-sync-task`
 * uses — if a future refactor ever changes that gate, a stray
 * `UPDATE ... WHERE last_run_id = ${runId}` still can't flip this row back
 * to `'completed'`. */
async function writeSkippedPermanent(
    sql: postgres.Sql,
    mediaItemId: string,
    reason: string,
    runId: string,
    logger: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, skipped_reason, updated_at
        ) VALUES (
            ${mediaItemId}::uuid, ${STAGE_ID}, 1, 'skipped_permanent', ${reason}, now()
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           SET status = 'skipped_permanent',
               skipped_reason = ${reason},
               next_eligible_at = NULL,
               last_run_id = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_stage_state.status IN
                ('pending', 'failed_transient', 'skipped_transient', 'skipped_permanent', 'obsolete')
            OR (media_item_stage_state.status = 'running'
                AND media_item_stage_state.last_run_id = ${runId})
    `.catch((err: unknown) => {
        logger.warn('metadata-translations-sync: failed to mark skipped_permanent', {
            mediaItemId,
            reason,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

// ──────────────────────────────────────────────────────────────────────────
// metadata-translations-sync — stage task
// ──────────────────────────────────────────────────────────────────────────

const syncInputSchema = z.object({
    mediaItemId: z.string().guid().optional(),
});
type MetadataTranslationsSyncInput = z.infer<typeof syncInputSchema>;

interface MetadataTranslationsSyncResult {
    itemsProcessed: number;
    reason?: string;
}

export const metadataTranslationsSyncTask = defineTask<
    MetadataTranslationsSyncInput,
    MetadataTranslationsSyncResult
>({
    id: STAGE_ID,
    purpose: 'library',
    name: 'Metadata Translations Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    // http:true — this task makes direct TMDB detail/season calls via
    // `tmdbApi`, same as series-sync/chapter-sync/tmdb-metadata-sync-task
    // (all declare `{ database: true, http: true }`).
    capabilities: { database: true, http: true },

    // Driven by stage-sweep (coversStages + enqueueable) and the lazy-fill
    // hook — not a schedule. `coversStages` alone exempts this from the boot
    // trigger-coverage audit (see `registry.ts` `classifyTriggers()`), so no
    // `manualOnly` is needed (series-sync/chapter-sync set neither).
    identityFor: (input) => input.mediaItemId ?? 'backlog',
    scope: 'global',
    resourceClass: 'bulk',
    inputSchema: syncInputSchema,

    coversStages: [
        {
            id: STAGE_ID,
            appliesTo: ['movie', 'series'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            // self-terminal (not a declarative `predicate`/`global-guard`
            // terminalDisposition): the brief's contract requires BOTH skip
            // reasons ('translations-disabled' and 'no-primary-external-id')
            // to be written from inside the per-item handler via the
            // last_run_id=NULL guard pattern, exactly like
            // tmdb-metadata-sync-task's 404 handling — which also declares
            // self-terminal despite hand-writing skipped_permanent itself.
            // (A `global-guard` entry would be the more idiomatic mechanism
            // for the config-flag condition — see report.)
            terminalDisposition: {
                kind: 'self-terminal',
                ruleId: 'metadata-translations-sync-self-terminal',
            },
        },
    ],

    timeout: { hard: '120m', soft: '115m' },
    cost: { kind: 'api_calls' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            if (ctx.signal.aborted) {
                return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
            }

            const { mediaItemId } = ctx.input;
            if (!mediaItemId) {
                // No per-item target: coverage is driven entirely by
                // stage-sweep (coversStages + enqueueable) and the lazy-fill
                // hook, each of which always passes a mediaItemId. A bare
                // manual trigger with no target has nothing to do.
                return { success: true, itemsProcessed: 0 };
            }

            const languages = config.METADATA_ADDITIONAL_LANGUAGES;
            const outcome = await syncTranslationsForItem(
                ctx.sql,
                tmdbApi,
                mediaItemId,
                languages,
                ctx.logger,
            );

            if (outcome.disposition === 'skipped_permanent') {
                await writeSkippedPermanent(
                    ctx.sql,
                    mediaItemId,
                    outcome.reason ?? 'unknown',
                    ctx.runId,
                    ctx.logger,
                );
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'skipped',
                    result: { itemsProcessed: 0, reason: outcome.reason },
                };
            }

            if (ctx.signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: outcome.itemsProcessed,
                    stopReason: 'aborted',
                };
            }

            await upsertCompletedRow(ctx.sql, {
                mediaItemId,
                stageId: STAGE_ID,
                processingVersion: 1,
            }).catch((err: unknown) => {
                ctx.logger.warn('metadata-translations-sync: upsertCompletedRow failed', {
                    mediaItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });

            return {
                success: true,
                itemsProcessed: outcome.itemsProcessed,
                result: { itemsProcessed: outcome.itemsProcessed },
            };
        });
    },
});

// ──────────────────────────────────────────────────────────────────────────
// metadata-translations-seed — one-shot/scheduled backfill trigger
// ──────────────────────────────────────────────────────────────────────────

const seedInputSchema = z.object({
    /**
     * When true, ADDITIONALLY re-enrolls `completed` stage rows via
     * `reEnrollCompletedStageForReset` — the add-a-language-later path, where
     * already-translated items must re-fetch to pick up the new language.
     * Passed ONLY by the settings-save hook (config.service.ts), which fires
     * exactly when the admin list gains entries. The scheduled 24h run omits
     * it: re-enrolling on every schedule tick would re-fetch the ENTIRE
     * completed catalog from TMDB daily, forever.
     */
    reEnroll: z.boolean().optional(),
});
type MetadataTranslationsSeedInput = z.infer<typeof seedInputSchema>;

interface MetadataTranslationsSeedResult {
    seeded: number;
    reEnrolled: number;
    skipped?: string;
}

export const metadataTranslationsSeedTask = defineTask<
    MetadataTranslationsSeedInput,
    MetadataTranslationsSeedResult
>({
    id: 'metadata-translations-seed',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'Metadata Translations Backfill Seed',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    // Fallback trigger for installs where the settings-save hook doesn't fire
    // (or fired before this task existed). NOT manualOnly — manualOnly means
    // "never scheduled", which would contradict this schedule. No-ops fast
    // (single cheap check, no query) when the feature is off.
    //
    // Scheduled runs fire with EMPTY input (no `reEnroll`), so they only seed
    // missing rows + un-skip 'translations-disabled' rows — they never
    // re-enroll completed items. Consequence for operators who change
    // METADATA_ADDITIONAL_LANGUAGES via env var only (bypassing the settings
    // UI): NEW/missing items are picked up within 24h, but items already
    // marked completed only re-fetch the added language via the UI-save hook
    // (which passes `reEnroll: true`) or a manual trigger of this task with
    // `{ "reEnroll": true }` from /admin/tasks.
    schedule: { every: '24h' },

    identityFor: () => 'global',
    scope: 'global',
    // Destructive-ish bulk write (INSERT + UPDATE across the whole catalog in
    // one tx) — a double-fire (config-save hook racing the daily schedule,
    // or two operators) must not run twice concurrently. ttl exceeds the 15m
    // hard timeout with margin, matching embedding-reset's convention.
    exclusiveWith: { scope: 'global', ttl: '20m' },
    resourceClass: 'maintenance',
    inputSchema: seedInputSchema,

    timeout: { hard: '15m', soft: '14m' },

    async execute(ctx) {
        const { sql, logger } = ctx;

        if (config.METADATA_ADDITIONAL_LANGUAGES.length === 0) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { seeded: 0, reEnrolled: 0, skipped: 'no-languages' },
            };
        }

        const reEnrollRequested = ctx.input.reEnroll === true;
        let seeded: number;
        let reEnrolled: number;
        try {
            ({ seeded, reEnrolled } = await withTx(sql, async (tx) => {
                // (a) SEED: a brand-new stage has ZERO rows on existing items —
                // stage rows are only seeded at item creation / whole-item
                // self-heal, so `reEnrollCompletedStageForReset` alone would be
                // a no-op the first time this stage is ever introduced (spec
                // §4.2). media_items.media_type is the raw DB value ('movie'/
                // 'tv' — NOT the SDK 'series' spelling used by coversStages).
                //
                // ON CONFLICT DO NOTHING (insertPendingRow's canonical clause):
                // an item created concurrently — whose lifecycle hook enrolls
                // its own stage rows between our NOT EXISTS check and the
                // insert — must lose quietly instead of aborting the whole
                // seed transaction on the (media_item_id, stage_id) PK.
                //
                // Item-status guard mirrors findSweepCandidates
                // (stage-sweep.queries.ts): only 'active', non-dismissed items
                // get rows — otherwise we'd recreate rows for soft-deleted/
                // dismissed items that the sweep would never enqueue anyway.
                const ins = await tx`
                    INSERT INTO media_item_stage_state (
                        media_item_id, stage_id, processing_version, status, updated_at
                    )
                    SELECT mi.id, ${STAGE_ID}, 1, 'pending', now()
                    FROM media_items mi
                    WHERE mi.media_type IN ('movie', 'tv')
                      AND mi.status = 'active'
                      AND COALESCE(mi.is_dismissed, false) = false
                      AND NOT EXISTS (
                          SELECT 1 FROM media_item_stage_state s
                           WHERE s.media_item_id = mi.id AND s.stage_id = ${STAGE_ID}
                      )
                    ON CONFLICT (media_item_id, stage_id) DO NOTHING
                `;

                // (b) Re-enroll previously-completed rows — the "add a
                // language later" case. ONLY when explicitly requested
                // (settings-save hook / manual trigger); the scheduled 24h
                // run must never do this or every completed item re-fetches
                // TMDB daily forever.
                const re = reEnrollRequested
                    ? await reEnrollCompletedStageForReset(tx, STAGE_ID)
                    : 0;

                // (c) Re-activate rows the per-item handler permanently
                // skipped for 'translations-disabled' (the feature was off
                // when they were last swept). Reset next_eligible_at so they
                // don't wait out any backoff window.
                const flipped = await tx`
                    UPDATE media_item_stage_state
                       SET status = 'pending',
                           attempt = 0,
                           declines = 0,
                           declines_since = NULL,
                           last_error = NULL,
                           next_eligible_at = now(),
                           updated_at = now()
                     WHERE stage_id = ${STAGE_ID}
                       AND status = 'skipped_permanent'
                       AND skipped_reason = 'translations-disabled'
                `;

                return { seeded: ins.count ?? 0, reEnrolled: re + (flipped.count ?? 0) };
            }));
        } catch (err) {
            throw new TaskError({
                message: `metadata-translations-seed: transaction failed — ${err instanceof Error ? err.message : String(err)}`,
                kind: 'transient',
            });
        }

        logger.info('metadata-translations-seed committed', {
            seeded,
            reEnrolled,
            reEnrollRequested,
        });
        return {
            success: true,
            itemsProcessed: seeded + reEnrolled,
            result: { seeded, reEnrolled },
        };
    },
});

registry.registerTask(metadataTranslationsSyncTask);
registry.registerTask(metadataTranslationsSeedTask);
