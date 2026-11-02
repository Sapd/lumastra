// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * provider-artwork-backfill — materialize provider artwork to durable local
 * files, one media item per run.
 *
 * FIVE sibling tasks, not one task with five stages. `media_item_stage_state`
 * is keyed `(media_item_id, stage_id)` with NO artwork-type dimension, so one
 * stage spanning poster+backdrop+logo could not represent partial completion —
 * a movie whose poster succeeds and whose backdrop 404s would either lose the
 * backdrop forever or re-fetch the poster on every sweep. And `runner.ts:1963`
 * applies the pipeline-coverage wrapper ONLY to a task declaring exactly one
 * covered stage; more logs `coverage skipped (Phase 1a single-stage limit)`
 * and every stage row stays non-terminal, re-enqueued every 60s forever.
 *
 * WHY THE MANIFESTS ARE SPELLED OUT FIVE TIMES. `stage-applies-to-mirror-in-sync`
 * (the ESLint rule that keeps `ingest-map.constants.ts` honest) scrapes THIS
 * FILE with regexes over raw source — `/\{\s*id:\s*'…'[^}]*?appliesTo:\s*\[…\]/`
 * and `/resourceClass:\s*'…'[\s\S]{0,4000}?coversStages:\s*\[…\]\s*,/`. A
 * factory that computes `id` or `appliesTo` at runtime produces zero matches,
 * so the rule silently validates nothing and the mirror can drift freely. The
 * shared *behaviour* lives in `makeLaneAExecute`; the *manifest* is literal.
 *
 * TWO LANES.
 *   Lane A (poster / backdrop / logo / thumb) reads the path off the item's own
 *   winning `provider_metadata` row — zero external API calls, plain CDN
 *   fetches. `invalidatedBy` works because `metadata.changed` and
 *   `identity.changed` fire on the item's own id.
 *
 *   Lane B (season posters) is structurally different: seasons carry no own
 *   `provider_metadata` and, by explicit design, no own `external_id`
 *   (`metadata-sync-single.service.ts:1129-1135`), so Lane A's predicate is
 *   false for every season row that exists — the one slot this feature exists
 *   to fix. It resolves through the parent series and costs one
 *   `getTVShowSeasons()` call per SEASON RUN. It declares NO `invalidatedBy`:
 *   `invalidateByEvent` is single-item scoped (`stage-state.service.ts:602-612`)
 *   with no descendant propagation, so neither `metadata.changed` (fires on a
 *   provider_metadata row's media_id — a season has none) nor `identity.changed`
 *   (fires with the SERIES id) can ever reach a season row. Its recovery rail is
 *   a bounded fixed-interval re-check expressed through the stage retry policy
 *   (exponential from 1 minute out to a 7-day ceiling), the same shape
 *   `mal-anime-id-enrichment.ts:93-107` documents for the same reason.
 *
 * THROW vs RETURN. `run-wrapper.ts` dead-letters a stage row once
 * `attempt >= retryPolicy.maxAttempts`, so what a blocked run does with its
 * control flow decides whether the backlog survives:
 *   - GLOBAL and routinely-true conditions (hourly rate cap, full disk, TMDB
 *     unreachable) are pre-filtered by the `global-guard` below: `stage-sweep`
 *     stops enqueuing runs while any of them hold, so reaching `execute()`
 *     with one still true is a rare race (the budget/headroom changed between
 *     the guard evaluating and the run actually executing), not the steady
 *     state. When that race happens, `execute()` still RETURNS
 *     `{ success: false, stopReason }` rather than throwing — the wrapper
 *     resets the row to `'pending'` (never leaves it `'running'`) with
 *     `attempt` UNCHANGED, so it re-enters the backlog on the next drain
 *     tick. Throwing here would dead-letter a large share of the library
 *     during a perfectly healthy drain — the default cap is 2000 items/hour
 *     against a 158k-item backlog.
 *   - PER-ITEM failures (CDN fetch, a season with no tmdb-identified parent,
 *     TMDB unreachable) THROW a transient TaskError so they get a real backoff
 *     and eventually dead-letter as admin-visible.
 *   - PER-ITEM failures that RE-ASKING CANNOT FIX throw a PERMANENT TaskError
 *     instead, so they dead-letter at attempt 0 rather than grinding out the
 *     full backoff ladder to the same answer: a 404 series id, and a series
 *     TMDB answers for but lists no seasons on. Telling those apart from a
 *     429/5xx needs `getTVShowSeasonsResult`, not `getTVShowSeasons` — the
 *     latter collapses both into `[]`.
 *   - Both the LONG-LIVED off switch (disabled / no TMDB key) AND the
 *     ROUTINE global blocks (hourly rate cap, disk headroom) are handled
 *     structurally by the SAME `global-guard` terminalDisposition, which
 *     drains the stage to `skipped_transient` so nothing is enqueued at all
 *     while any of them hold.
 *
 * KNOWN LIMITATION (documented, not fixed here): a series re-matched to a
 * different TMDB id keeps its already-materialized season posters —
 * `materializeProviderArtwork` returns 'already-local' rather than overwriting
 * disk, and no event reaches the season row. Operator remedy: admin "Remove"
 * on the season artwork (which tombstones it) then re-run the stage.
 *
 * SIZING. ~150KB average per file; a 10k-file library across ~3 applicable
 * types is 4-5 GB, with a transient ~2x peak because `fetchFromUrl` also
 * persists each buffer into the 7-day `customUrlCache`
 * (`image-proxy/service.ts:72`). Hence the per-volume headroom guard and the
 * hourly budget below.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext, TaskResult, StageGuardContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config } from '../../../config.js';
import {
    ARTWORK_TYPE_TO_TMDB_SIZE,
    providerSourceTag,
    type MaterializableArtworkType,
} from '../../../utils/media-extras.js';
import {
    getWinningProviderArtworkPath,
    getSeasonBackfillTarget,
} from '../../../database/queries/provider-artwork.queries.js';
import { getOwnLocalArtwork } from '../../../database/queries/media-artwork.queries.js';
import { buildWinningProviderArtworkPathFilterFragment } from '../../../database/queries/builders/provider-metadata.builder.js';
import { checkArtworkDiskHeadroom } from '../../../utils/artwork-volume-headroom.js';
import { consumeArtworkBudget, peekArtworkBudget } from '../../../utils/artwork-rate-budget.js';
import { isAbsoluteUrl } from '../../../services/image-proxy/providers/generic-url.provider.js';
import { withApiCallSpend } from '../../api-call-spend.js';

// ---------------------------------------------------------------------------
// Shared input / result
// ---------------------------------------------------------------------------

const inputSchema = z
    .object({
        /**
         * REQUIRED. `stage-sweep` enqueues `{ mediaItemId }` (`stage-sweep.ts:721`)
         * and the runner's coverage wrapper fires only when a string
         * `mediaItemId` is present on the input (`runner.ts:1977`, `:2038`).
         */
        mediaItemId: z.string(),
        /**
         * Operator dry-run for ONE item: resolve the source URL and the target
         * path, then stop — no fetch, no write. Returns `success: false` so the
         * coverage wrapper does not mark the stage completed for work that did
         * not happen; the row is left `running` and is reclaimed by
         * `reclaimWedgedRunningStageRows` (`stage-state.queries.ts:1047`). For a
         * LIBRARY-WIDE dry run use the `provider-artwork-report` task instead —
         * it declares no `coversStages` and therefore touches no stage rows.
         */
        dryRun: z.boolean().optional(),
    })
    .passthrough();

type ProviderArtworkTaskInput = z.infer<typeof inputSchema>;

interface ProviderArtworkTaskResult {
    materialized: boolean;
    /** Present when nothing was written. */
    reason?: string;
    /** Present on success, or on a dry run (the path that WOULD be written). */
    filePath?: string;
    /** Present on a dry run. */
    sourceUrl?: string;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * How long a `global-guard` drain lasts before `stage-sweep` re-checks the
 * predicate. Deliberately MINUTES, not hours: this guard now also covers the
 * hourly rate cap and the disk-headroom margin, both of which are expected to
 * flip back to "clear" within the hour (budget resets on the hour boundary;
 * headroom can free up as soon as an operator clears space). A multi-hour
 * `retryAfterMs` would strand the whole backlog behind the LAST time the
 * guard tripped, even after the underlying condition resolved — exactly the
 * kind of wedge this guard exists to prevent. Kept well above the 60s sweep
 * tick so a persistently-false guard doesn't churn the bulk UPDATE every tick.
 */
const GLOBAL_GUARD_RETRY_MS = 5 * 60 * 1000;

/**
 * Shared budget + disk-headroom pre-filter for BOTH `global-guard`
 * dispositions below (Lane A and Lane B), in addition to each one's own
 * kill-switch check.
 *
 * These two conditions are GLOBAL and — for the hourly budget in particular —
 * ROUTINELY true: the default cap is 2000 items/hour against a 158k-item
 * backlog, so the cap binds for most of every hour of a healthy drain.
 * Checking them here (not just inside `execute()`) means `stage-sweep` stops
 * ENQUEUING runs while either holds, instead of enqueuing a run that
 * immediately returns `{ success: false }` and — before this fix — left a
 * stale `'running'` stage row behind on every single enqueue. `execute()`
 * keeps its own `checkDrainBlocked` check too: a guard is a pre-filter, not a
 * guarantee, since disk headroom can still change between this guard
 * evaluating and `execute()` actually running. That race is now rare, not the
 * steady state.
 *
 * PEEKS the hourly budget — never consumes it. `stage-sweep` evaluates this
 * guard on every drain tick for the stage; consuming here would burn the
 * budget on guard checks alone rather than on actual materializations.
 */
/**
 * Log-and-pass-through for a boolean guard condition, so a false result names
 * itself instead of vanishing into stage-sweep's single opaque reason string.
 */
function logIfBlocked(ctx: StageGuardContext, condition: string, ok: boolean): boolean {
    if (!ok) ctx.logger.info('provider-artwork guard: blocked', { condition });
    return ok;
}

async function drainCapacityAvailable(ctx: StageGuardContext): Promise<boolean> {
    // Observability, not decoration. This guard gates ~50k rows and, when it
    // returns false, stage-sweep bulk-parks the ENTIRE stage with one opaque
    // reason string (`provider-artwork-backfill-blocked`). On 2026-07-28 that
    // opacity turned a stalled prod drain into hours of inference: every input
    // measured healthy from outside the process (88G free, no budget key, no
    // config override) while the guard kept returning false. Name the failing
    // condition, with its numbers, so the next occurrence is one log line.
    const minFreeBytes = Math.max(0, config.PROVIDER_ARTWORK_MIN_FREE_GB) * BYTES_PER_GB;
    if (minFreeBytes > 0) {
        const headroom = await checkArtworkDiskHeadroom(ctx.sql, minFreeBytes);
        if (!headroom.ok) {
            ctx.logger.info('provider-artwork guard: blocked on disk headroom', {
                minFreeGb: config.PROVIDER_ARTWORK_MIN_FREE_GB,
                below: headroom.volumes
                    .filter((v) => v.belowMargin)
                    .map((v) => `${v.label}:${v.path}:${v.freeBytes ?? 'unknown'}`),
            });
            return false;
        }
    }

    const maxPerHour = config.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR;
    if (maxPerHour > 0) {
        const used = await peekArtworkBudget();
        if (used >= maxPerHour) {
            ctx.logger.info('provider-artwork guard: blocked on hourly budget', {
                used,
                maxPerHour,
            });
            return false;
        }
    }

    return true;
}

/**
 * The shared `terminalDisposition` guard, spelled once and referenced by all
 * five manifests. Both the long-lived GLOBAL off-switch AND the routine
 * GLOBAL blocks (hourly rate cap, disk headroom) are handled structurally
 * here rather than per run: when the predicate is false, `stage-sweep` drains
 * the whole stage to `skipped_transient` and enqueues nothing, so no attempts
 * are burned and nothing dead-letters. Precedent: `mdblist-sync.ts:105-109`,
 * `album-enrichment.ts:1143-1147`.
 *
 * NOTE: this must stay a SINGLE object (not the array form) at every use site —
 * the mirror lint's resourceClass scraper stops the `coversStages` body at the
 * first `]` followed by a comma, and an array disposition would supply one.
 */
const providerArtworkGlobalGuard = {
    kind: 'global-guard' as const,
    ruleId: 'provider-artwork-backfill-enabled',
    reason: 'provider-artwork-backfill-blocked',
    retryAfterMs: GLOBAL_GUARD_RETRY_MS,
    guard: async (ctx: StageGuardContext): Promise<boolean> =>
        logIfBlocked(ctx, 'backfill-disabled', config.PROVIDER_ARTWORK_BACKFILL_ENABLED) &&
        (await drainCapacityAvailable(ctx)),
};

/** Lane B additionally needs a TMDB key — same structural treatment. */
const seasonPosterGlobalGuard = {
    kind: 'global-guard' as const,
    ruleId: 'provider-artwork-season-poster-available',
    reason: 'provider-artwork-season-poster-blocked',
    retryAfterMs: GLOBAL_GUARD_RETRY_MS,
    guard: async (ctx: StageGuardContext): Promise<boolean> =>
        config.PROVIDER_ARTWORK_BACKFILL_ENABLED &&
        config.TMDB_API_KEY.trim().length > 0 &&
        (await drainCapacityAvailable(ctx)),
};

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Why a run declined to do any work. `null` means "go ahead". */
type DrainBlockReason = 'backfill-disabled' | 'disk-headroom' | 'hourly-budget-exhausted';

/**
 * Kill switch + per-volume disk headroom. SIDE-EFFECT FREE — does NOT touch
 * the hourly budget. See `consumeBudgetOrBlocked` below for that: charging
 * the budget here, before the item's own already-local/no-provider-path
 * checks run, was the prod incident (2026-07-28) — a backlog dominated by
 * `already-local` items burned the entire hourly cap confirming there was
 * nothing to fetch, while genuine downloads starved behind them (17,369
 * completed stage rows overnight, zero new files).
 *
 * RETURNS a reason instead of throwing, and callers turn that into
 * `{ success: false, stopReason: 'budget' }`. Throwing would be wrong here:
 * both of these conditions are GLOBAL and disk headroom in particular can be
 * routinely true for a while — and the throw path increments `attempt` and
 * dead-letters the row at `retryPolicy.maxAttempts`, so a normal, healthy
 * drain would permanently drop a large share of the library as
 * `failed_permanent`.
 *
 * BELT AND BRACES: the `global-guard` terminalDisposition above now checks
 * this same headroom/kill-switch state (plus the budget, via
 * `drainCapacityAvailable`'s PEEK) BEFORE `stage-sweep` enqueues a run at all,
 * so reaching this function with a condition still true is expected to be a
 * rare race (state changed between the guard evaluating and this run
 * executing), not the steady state it used to be.
 *
 * On `success: false` the wrapper resets the row to `'pending'` (it does NOT
 * leave it `'running'`) with `attempt` left UNCHANGED, so the item re-enters
 * the backlog on the very next drain tick instead of waiting for
 * `reclaimWedgedRunningStageRows`'s 10-minute wedge reclassification.
 *
 * Per-ITEM failures still throw (see the call sites) — those SHOULD consume
 * attempts and eventually dead-letter.
 */
async function checkDrainBlocked(
    ctx: TaskContext<ProviderArtworkTaskInput>,
): Promise<DrainBlockReason | null> {
    if (!config.PROVIDER_ARTWORK_BACKFILL_ENABLED) {
        // Belt and braces: the global-guard disposition normally drains the
        // stage before anything is enqueued, but a run already in flight when
        // the switch flips lands here.
        return 'backfill-disabled';
    }

    const minFreeBytes = Math.max(0, config.PROVIDER_ARTWORK_MIN_FREE_GB) * BYTES_PER_GB;
    if (minFreeBytes > 0) {
        const headroom = await checkArtworkDiskHeadroom(ctx.sql, minFreeBytes);
        if (!headroom.ok) {
            const low = headroom.volumes
                .filter((v) => v.belowMargin)
                .map((v) => `${v.path} (${v.freeBytes ?? '?'} bytes free)`)
                .join(', ');
            ctx.logger.warn('provider-artwork backfill paused: disk headroom below margin', {
                marginGb: config.PROVIDER_ARTWORK_MIN_FREE_GB,
                volumes: low,
            });
            return 'disk-headroom';
        }
    }

    return null;
}

/**
 * Charge one hourly-budget slot. Call this ONLY at the point of no return —
 * immediately before `materializeProviderArtwork` — after the item's own
 * cheap terminal checks (no provider path, already-local, dry run) have all
 * passed. Those checks do real work for free; only an actual fetch+write
 * should cost a slot.
 */
async function consumeBudgetOrBlocked(): Promise<DrainBlockReason | null> {
    if (!(await consumeArtworkBudget(config.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR))) {
        return 'hourly-budget-exhausted';
    }
    return null;
}

/** The one shape every blocked run returns. */
function blockedResult(reason: DrainBlockReason): TaskResult<ProviderArtworkTaskResult> {
    return {
        success: false,
        itemsProcessed: 0,
        stopReason: 'budget',
        result: { materialized: false, reason },
    };
}

/**
 * Only the PATH is stored in `provider_metadata`; the CDN size is a
 * per-request decision. A non-TMDB provider (tvdb, anidb, fanart) stores an
 * absolute URL in the artwork block instead — pass those through untouched.
 */
function buildArtworkUrl(artworkType: MaterializableArtworkType, storedPath: string): string {
    if (isAbsoluteUrl(storedPath)) return storedPath;
    return `https://image.tmdb.org/t/p/${ARTWORK_TYPE_TO_TMDB_SIZE[artworkType]}${storedPath}`;
}

/**
 * Which `MaterializeSkipReason`s are worth retrying for THIS item.
 *
 * `write-path-failed` is included deliberately: it is thrown by
 * `resolveWritePath` for strict `alongside` on a read-only mount
 * (`metadata-storage.service.ts:132-136`) — an environment condition an
 * operator can fix. If it were treated as terminal the stage row would be
 * marked `completed` with no artwork, and nothing would ever re-run it: the
 * eligibility HEAL pass only re-flips `skipped_permanent` rows, and Lane B has
 * no `invalidatedBy` at all. Retrying instead backs it off and eventually
 * dead-letters as `failed_permanent`, which is admin-visible.
 *
 * Everything else (`admin-source-tag`, `bad-source-tag`, `suppressed`,
 * `already-local`, `no-extension`, `unsupported-content-type`,
 * `register-skipped`) is a decision, not a failure — re-running would reach the
 * same answer forever.
 *
 * `unsupported-content-type` is the one that had to be SPLIT OUT of
 * `fetch-failed` to get here: TMDB's SVG logos are refused by
 * `ALLOWED_CONTENT_TYPES`, and while that refusal shared the `fetch-failed`
 * reason it was retried to the attempt cap on every one of them (prod
 * 2026-07-30 — 29 items, 145 failed runs in 24h). Lane A's `invalidatedBy`
 * re-opens the row if the provider later swaps in a raster logo, which is the
 * only event that could change the answer.
 */
function isRetryableSkip(reason: string | undefined): boolean {
    return reason === 'fetch-failed' || reason === 'write-failed' || reason === 'write-path-failed';
}

// ---------------------------------------------------------------------------
// Lane A executor (poster / backdrop / logo / thumb)
// ---------------------------------------------------------------------------

/**
 * Record the task's outbound provider requests (TMDB detail/season lookups) on
 * the cost page. These five tasks were the TMDB callers left unwrapped — the
 * season-poster stage alone ran 760 times on a busy prod day with no spend on
 * record. Image downloads go to the provider's image CDN, which is not an API
 * quota, and are not counted (same as every other image fetch).
 */
function withCostTracking(
    execute: (
        ctx: TaskContext<ProviderArtworkTaskInput>,
    ) => Promise<TaskResult<ProviderArtworkTaskResult>>,
): (ctx: TaskContext<ProviderArtworkTaskInput>) => Promise<TaskResult<ProviderArtworkTaskResult>> {
    return (ctx) => withApiCallSpend(ctx, () => execute(ctx));
}

function makeLaneAExecute(
    artworkType: MaterializableArtworkType,
): (ctx: TaskContext<ProviderArtworkTaskInput>) => Promise<TaskResult<ProviderArtworkTaskResult>> {
    return async function execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }

        const { mediaItemId, dryRun } = ctx.input;
        const blocked = await checkDrainBlocked(ctx);
        if (blocked) return blockedResult(blocked);

        const winning = await getWinningProviderArtworkPath(ctx.sql, mediaItemId, artworkType);
        if (!winning) {
            // Terminal for this item: the winning provider row carries no path
            // for this slot. `invalidatedBy` flips the row back to pending if
            // metadata later changes, so completing here is safe. No budget
            // charged — this item was never going to fetch anything.
            return {
                success: true,
                itemsProcessed: 0,
                result: { materialized: false, reason: 'no-provider-path' },
            };
        }

        const url = buildArtworkUrl(artworkType, winning.path);

        if (dryRun === true) {
            const { resolveArtworkWritePath } =
                await import('../../../services/media-image-storage.service.js');
            const target = await resolveArtworkWritePath(
                ctx.sql,
                mediaItemId,
                `${artworkType}.jpg`,
            );
            return {
                success: false,
                itemsProcessed: 0,
                stopReason: 'skipped',
                result: {
                    materialized: false,
                    reason: 'dry-run',
                    filePath: target.filePath,
                    sourceUrl: url,
                },
            };
        }

        // Cheap pre-check BEFORE charging the budget: `materializeProviderArtwork`
        // does this same check internally, but by then the budget would already
        // be spent on an item that was never going to write anything. Same
        // `reason` value ('already-local') that outcome would have reported, so
        // nothing downstream (report task, admin UI) sees a new value.
        if (await getOwnLocalArtwork(ctx.sql, mediaItemId, artworkType)) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { materialized: false, reason: 'already-local' },
            };
        }

        const budgetBlocked = await consumeBudgetOrBlocked();
        if (budgetBlocked) return blockedResult(budgetBlocked);

        // Lazy import: the image-storage service drags in the whole image-proxy
        // dependency graph; keep it out of the orchestrator boot path (same
        // rationale as library-embeddings-task.ts:177-181).
        const { materializeProviderArtwork } =
            await import('../../../services/media-image-storage.service.js');

        const outcome = await materializeProviderArtwork(
            ctx.sql,
            mediaItemId,
            artworkType,
            url,
            providerSourceTag(winning.provider, artworkType),
        );

        if (!outcome.materialized && isRetryableSkip(outcome.reason)) {
            throw new TaskError({
                message: `provider-artwork ${artworkType}: ${outcome.reason} for ${mediaItemId} (${url})`,
                kind: 'transient',
            });
        }

        ctx.logger.info('provider-artwork materialization', {
            mediaItemId,
            artworkType,
            provider: winning.provider,
            materialized: outcome.materialized,
            reason: outcome.reason,
        });

        return {
            success: true,
            itemsProcessed: outcome.materialized ? 1 : 0,
            result: {
                materialized: outcome.materialized,
                reason: outcome.reason,
                filePath: outcome.filePath,
            },
        };
    };
}

// ---------------------------------------------------------------------------
// Lane B executor (season posters)
// ---------------------------------------------------------------------------

/**
 * The season/series filename collision is owned by plan C, which exports
 * `buildSeasonArtworkFileNameResolver(sql, seriesMediaItemId, seasonNumber, artworkType)`
 * from `media-image-storage.service.ts`. Do NOT re-implement it here — two
 * copies drifted on the "series directory unresolvable" fallback during
 * parallel authoring, and the write side must agree with itself.
 *
 * What it does: in a season-FOLDERLESS layout (`Show/S01E01.mkv`) a season and
 * its series both resolve to `Show/`, so both would write `poster.jpg` and the
 * last writer wins. It resolves the SERIES directory once, and when the
 * season's resolved directory matches it, returns the Kodi/Jellyfin flat
 * convention `season01-poster.jpg` — exactly what plan A's reader
 * (`seasonArtworkFromStem`) parses back, so the format round-trips. When the
 * series directory cannot be resolved at all it always qualifies the filename,
 * which is never wrong — only more verbose than necessary.
 *
 * `seasonArtworkFileName` is therefore NOT imported by this file. It stays in
 * `media-extras.ts` (Task 1) because plan C's resolver consumes it.
 */

async function executeSeasonPoster(
    ctx: TaskContext<ProviderArtworkTaskInput>,
): Promise<TaskResult<ProviderArtworkTaskResult>> {
    if (ctx.signal.aborted) {
        return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
    }

    const { mediaItemId, dryRun } = ctx.input;
    const blocked = await checkDrainBlocked(ctx);
    if (blocked) return blockedResult(blocked);

    const target = await getSeasonBackfillTarget(ctx.sql, mediaItemId);
    if (!target) {
        // PER-ITEM: this season fails the Lane B gate — it has no files, no
        // season_number, or no tmdb-identified `tv` parent. Do NOT name one
        // specific cause here: the message used to claim "no tmdb-identified tv
        // parent" and sent an operator hunting for a missing provider id when the
        // real cause was `has_files = false` (prod 2026-07-30).
        //
        // 'permanent', NOT 'transient'. The reason is the circuit breaker: a
        // 'permanent' failure is EXCLUDED from its consecutive-failure count
        // (runner.ts:3619), while under 'transient' a handful of catalog-only
        // `Specials` seasons re-enqueued by every series sync opened the circuit and
        // paused the whole stage, blocking the items that could have succeeded.
        // Retrying was never useful anyway — 30 exponential-backoff attempts out to
        // a 7-day ceiling all re-read the same DB predicate.
        //
        // BE CLEAR ABOUT THE RECOVERY STORY — do not re-add a claim that the
        // eligibility heal rail covers this. It does not: `reEnrollMisSkippedStage`
        // matches `status = 'skipped_permanent'` ONLY (stage-sweep.queries.ts:211),
        // and `wrapExecute` sends a 'permanent' kind straight to
        // `markFailedPermanent` on the FIRST attempt (run-wrapper.ts:225-228, :282).
        // This stage also declares no `invalidatedBy`, so the event-driven
        // `invalidateByEvent` rail does not reach it either. A row that lands here is
        // therefore a dead-letter until either an operator retries it or the next
        // `syncSeriesWithChildren` for the series re-enqueues it — which is the
        // realistic path, since `failed_permanent` is deliberately claimable
        // (stage-state.queries.ts:103) and the event that restores a season's files
        // is a scan, which triggers that sync.
        //
        // That is acceptable ONLY because reaching this point is now a genuine RACE:
        // both enqueue paths — `stage-sweep`'s `eligibility.sql` and
        // `filterSeasonsWithBackfillTarget` — pre-filter on this exact predicate, so
        // arriving here means the season lost its files between the filter and the
        // run. A season that is merely catalog-only never gets enqueued at all, and
        // its row stays `skipped_permanent/ineligible`, which the heal rail DOES
        // reclaim once files appear.
        throw new TaskError({
            message: `season poster: item ${mediaItemId} does not meet the season-poster gate (needs media_type 'season', a season_number, has_files, and a tmdb-identified 'tv' parent)`,
            kind: 'permanent',
        });
    }

    // Local check BEFORE the TMDB lookup. The season's own artwork row (not the
    // parent series'), the same predicate `materializeProviderArtwork` uses.
    // `getTVShowSeasonsResult` below is a real HTTP request whenever the response
    // cache misses, and it was counted as an api call. An already-local season
    // needs no TMDB data, so it must cost none.
    if (await getOwnLocalArtwork(ctx.sql, mediaItemId, 'poster')) {
        return {
            success: true,
            itemsProcessed: 0,
            result: { materialized: false, reason: 'already-local' },
        };
    }

    const { tmdbApi } = await import('../../../providers/implementations/tmdb/client.js');
    if (!tmdbApi.isAvailable()) {
        // GLOBAL, not per-item (missing key, or the client's authFailed latch).
        // Returning rather than throwing keeps a TMDB outage from burning 30
        // attempts on every season row. `seasonPosterGlobalGuard` drains the
        // whole stage structurally when the key is simply absent.
        ctx.logger.warn('season poster: TMDB API not available; deferring', { mediaItemId });
        return {
            success: false,
            itemsProcessed: 0,
            stopReason: 'skipped',
            result: { materialized: false, reason: 'tmdb-unavailable' },
        };
    }

    const numericSeriesId = Number.parseInt(target.seriesTmdbId, 10);
    if (!Number.isFinite(numericSeriesId)) {
        return {
            success: true,
            itemsProcessed: 0,
            result: { materialized: false, reason: 'non-numeric-series-tmdb-id' },
        };
    }

    // `getTVShowSeasonsResult` (NOT the lenient `getTVShowSeasons`) is required
    // here: the lenient one collapses every failure into `[]`, so "TMDB has no
    // such series" and "TMDB was rate-limited" arrive identically and the only
    // safe reading is `transient` — which retries an unfixable 404 forever.
    // Observed on prod: series 216416 sat at 17 attempts against a hard 404.
    const seasonsResult = await tmdbApi.getTVShowSeasonsResult(numericSeriesId);

    if (!seasonsResult.ok && seasonsResult.reason === 'unavailable') {
        // Says nothing about the series — 429/5xx/network/timeout/bad key.
        // Retry, exactly as before.
        throw new TaskError({
            message: `season poster: TMDB unreachable for series ${numericSeriesId} (${seasonsResult.message})`,
            kind: 'transient',
        });
    }

    if (!seasonsResult.ok) {
        // reason === 'not-found': TMDB answered 404. The series id stored on the
        // parent is wrong or the entry was deleted upstream. No number of
        // retries fixes that — it needs a re-identify, which the "needs
        // re-identify" rail surfaces. Terminal.
        throw new TaskError({
            message: `season poster: TMDB has no series ${numericSeriesId} (404) — the parent's TMDB id is stale or wrong; re-identify the series`,
            kind: 'permanent',
            remediation: 'identity',
        });
    }

    const seasons = seasonsResult.seasons;
    if (seasons.length === 0) {
        // TMDB ANSWERED and listed no seasons at all. Unlike the swallowed-error
        // case above this is a fact about the series, and re-asking returns the
        // same empty list forever. Terminal.
        throw new TaskError({
            message: `season poster: TMDB lists no seasons for series ${numericSeriesId}`,
            kind: 'permanent',
        });
    }

    const posterPath = seasons.find((s) => s.seasonNumber === target.seasonNumber)?.posterPath;
    if (!posterPath) {
        // TMDB answered, and genuinely has no poster for this season number.
        // Terminal — re-running would issue the same API call to the same
        // answer forever.
        return {
            success: true,
            itemsProcessed: 0,
            result: { materialized: false, reason: 'no-season-poster-at-provider' },
        };
    }

    const url = buildArtworkUrl('poster', posterPath);
    // Plan C's export — see the comment block above. One implementation only.
    const { buildSeasonArtworkFileNameResolver } =
        await import('../../../services/media-image-storage.service.js');
    const fileNameResolver = await buildSeasonArtworkFileNameResolver(
        ctx.sql,
        target.seriesId,
        target.seasonNumber,
        'poster',
    );

    if (dryRun === true) {
        const { resolveArtworkWritePath } =
            await import('../../../services/media-image-storage.service.js');
        const resolved = await resolveArtworkWritePath(ctx.sql, mediaItemId, 'poster.jpg', (dir) =>
            fileNameResolver(dir, '.jpg'),
        );
        return {
            success: false,
            itemsProcessed: 0,
            stopReason: 'skipped',
            result: {
                materialized: false,
                reason: 'dry-run',
                filePath: resolved.filePath,
                sourceUrl: url,
            },
        };
    }

    // The already-local check ran before the TMDB lookup above, so reaching here
    // means a real fetch is about to happen. Charge the budget for it.
    const budgetBlocked = await consumeBudgetOrBlocked();
    if (budgetBlocked) return blockedResult(budgetBlocked);

    const { materializeProviderArtwork } =
        await import('../../../services/media-image-storage.service.js');
    const outcome = await materializeProviderArtwork(
        ctx.sql,
        mediaItemId,
        'poster',
        url,
        providerSourceTag('tmdb', 'poster'),
        fileNameResolver,
    );

    if (!outcome.materialized && isRetryableSkip(outcome.reason)) {
        throw new TaskError({
            message: `season poster: ${outcome.reason} for ${mediaItemId} (${url})`,
            kind: 'transient',
        });
    }

    ctx.logger.info('season poster materialization', {
        mediaItemId,
        seasonNumber: target.seasonNumber,
        materialized: outcome.materialized,
        reason: outcome.reason,
    });

    return {
        success: true,
        itemsProcessed: outcome.materialized ? 1 : 0,
        result: {
            materialized: outcome.materialized,
            reason: outcome.reason,
            filePath: outcome.filePath,
        },
    };
}

// ---------------------------------------------------------------------------
// Task manifests — LITERAL, one coversStages entry each. See header.
// ---------------------------------------------------------------------------

export const providerArtworkPosterTask = defineTask<
    ProviderArtworkTaskInput,
    ProviderArtworkTaskResult
>({
    id: 'provider-artwork-poster',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'Provider Artwork: Posters',
    description:
        'Downloads poster images from your metadata provider into your library folders so they keep working offline.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    inputSchema,
    timeout: { hard: '5m', soft: '4m' },
    resourceClass: 'bulk',
    coversStages: [
        {
            id: 'provider-artwork-poster',
            appliesTo: ['movie', 'series', 'episode'] as const,
            invalidatedBy: ['metadata.changed', 'identity.changed'] as const,
            enqueueable: true,
            terminalDisposition: providerArtworkGlobalGuard,
            retryPolicy: {
                maxAttempts: 30,
                backoff: 'exponential',
                initialDelayMs: 60_000,
                maxDelayMs: 21_600_000,
            },
            eligibility: {
                sql: (sql) => sql`
                    mi.media_type IN ('movie', 'tv', 'episode')
                    AND mi.has_files = true
                    AND ${buildWinningProviderArtworkPathFilterFragment(sql, 'poster')}
                `,
            },
        },
    ],

    cost: { kind: 'api_calls' },
    execute: withCostTracking(makeLaneAExecute('poster')),
});

export const providerArtworkBackdropTask = defineTask<
    ProviderArtworkTaskInput,
    ProviderArtworkTaskResult
>({
    id: 'provider-artwork-backdrop',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'Provider Artwork: Backdrops',
    description:
        'Downloads backdrop images from your metadata provider into your library folders so they keep working offline.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    inputSchema,
    timeout: { hard: '5m', soft: '4m' },
    resourceClass: 'bulk',
    coversStages: [
        {
            id: 'provider-artwork-backdrop',
            appliesTo: ['movie', 'series', 'episode'] as const,
            invalidatedBy: ['metadata.changed', 'identity.changed'] as const,
            enqueueable: true,
            terminalDisposition: providerArtworkGlobalGuard,
            retryPolicy: {
                maxAttempts: 30,
                backoff: 'exponential',
                initialDelayMs: 60_000,
                maxDelayMs: 21_600_000,
            },
            eligibility: {
                sql: (sql) => sql`
                    mi.media_type IN ('movie', 'tv', 'episode')
                    AND mi.has_files = true
                    AND ${buildWinningProviderArtworkPathFilterFragment(sql, 'backdrop')}
                `,
            },
        },
    ],

    cost: { kind: 'api_calls' },
    execute: withCostTracking(makeLaneAExecute('backdrop')),
});

export const providerArtworkLogoTask = defineTask<
    ProviderArtworkTaskInput,
    ProviderArtworkTaskResult
>({
    id: 'provider-artwork-logo',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'Provider Artwork: Logos',
    description:
        'Downloads title logo images from your metadata provider into your library folders so they keep working offline.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    inputSchema,
    timeout: { hard: '5m', soft: '4m' },
    resourceClass: 'bulk',
    coversStages: [
        {
            id: 'provider-artwork-logo',
            appliesTo: ['movie', 'series'] as const,
            invalidatedBy: ['metadata.changed', 'identity.changed'] as const,
            enqueueable: true,
            terminalDisposition: providerArtworkGlobalGuard,
            retryPolicy: {
                maxAttempts: 30,
                backoff: 'exponential',
                initialDelayMs: 60_000,
                maxDelayMs: 21_600_000,
            },
            eligibility: {
                sql: (sql) => sql`
                    mi.media_type IN ('movie', 'tv')
                    AND mi.has_files = true
                    AND ${buildWinningProviderArtworkPathFilterFragment(sql, 'logo')}
                `,
            },
        },
    ],

    cost: { kind: 'api_calls' },
    execute: withCostTracking(makeLaneAExecute('logo')),
});

export const providerArtworkThumbTask = defineTask<
    ProviderArtworkTaskInput,
    ProviderArtworkTaskResult
>({
    id: 'provider-artwork-thumb',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'Provider Artwork: Episode Thumbnails',
    description:
        'Downloads episode still images from your metadata provider into your library folders so they keep working offline.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    inputSchema,
    timeout: { hard: '5m', soft: '4m' },
    resourceClass: 'bulk',
    coversStages: [
        {
            id: 'provider-artwork-thumb',
            appliesTo: ['episode'] as const,
            invalidatedBy: ['metadata.changed', 'identity.changed'] as const,
            enqueueable: true,
            terminalDisposition: providerArtworkGlobalGuard,
            retryPolicy: {
                maxAttempts: 30,
                backoff: 'exponential',
                initialDelayMs: 60_000,
                maxDelayMs: 21_600_000,
            },
            eligibility: {
                sql: (sql) => sql`
                    mi.media_type = 'episode'
                    AND mi.has_files = true
                    AND ${buildWinningProviderArtworkPathFilterFragment(sql, 'thumb')}
                `,
            },
        },
    ],

    cost: { kind: 'api_calls' },
    execute: withCostTracking(makeLaneAExecute('thumb')),
});

export const providerArtworkSeasonPosterTask = defineTask<
    ProviderArtworkTaskInput,
    ProviderArtworkTaskResult
>({
    id: 'provider-artwork-season-poster',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'Provider Artwork: Season Posters',
    description:
        'Downloads season poster images from TMDB into your library folders. Season posters are the only artwork slot with no durable local backing today.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    identityFor: (input) => `item-${input.mediaItemId}`,
    scope: 'global',
    inputSchema,
    timeout: { hard: '5m', soft: '4m' },
    resourceClass: 'bulk',
    coversStages: [
        {
            id: 'provider-artwork-season-poster',
            appliesTo: ['season'] as const,
            enqueueable: true,
            terminalDisposition: seasonPosterGlobalGuard,
            retryPolicy: {
                maxAttempts: 30,
                backoff: 'exponential',
                initialDelayMs: 60_000,
                maxDelayMs: 604_800_000,
            },
            eligibility: {
                // The ONLY sql template in this file that reads `media_items`.
                // System backfill eligibility — a whole-catalog background stage
                // predicate evaluated by stage-sweep, never a user request, so no
                // per-user access scoping applies. No eslint-disable is needed
                // here: `callback-safety/no-unscoped-media-items` only applies to
                // files under src/routes/, database/queries/, and services/ —
                // this task file (tasks/builtin/native/) is outside its scope.
                sql: (sql) => sql`
                    mi.media_type = 'season'
                    AND mi.season_number IS NOT NULL
                    AND mi.has_files = true
                    AND EXISTS (
                        SELECT 1
                          FROM media_items series
                          JOIN external_ids ei ON ei.media_id = series.id
                         WHERE series.id = mi.parent_id
                           AND series.media_type = 'tv'
                           AND ei.provider = 'tmdb'
                           AND ei.media_type = 'tv'
                    )
                `,
            },
        },
    ],

    cost: { kind: 'api_calls' },
    execute: withCostTracking(executeSeasonPoster),
});

registry.registerTask(providerArtworkPosterTask);
registry.registerTask(providerArtworkBackdropTask);
registry.registerTask(providerArtworkLogoTask);
registry.registerTask(providerArtworkThumbTask);
registry.registerTask(providerArtworkSeasonPosterTask);
