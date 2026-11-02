// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enqueue per-season provider-artwork materialization.
 *
 * The sync path must NOT materialize inline. The season loop in
 * `metadata-sync-single.service.ts` runs under `onProgress` plus an abort check;
 * swapping its one UPDATE for a CDN fetch, a disk write and three path-resolution
 * queries would inflate that task's wall clock by roughly the season count, in a
 * task that already has abort-budget pressure.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { getRegistry } from '$lib/server/tasks/registry.js';
import { handleTriggerFailure } from '$lib/server/tasks/handle-trigger-failure.js';
import {
    filterSeasonsWithBackfillTarget,
    filterSeasonsWithCurrentLocalPoster,
    type SeasonPosterRequest,
} from '$lib/server/database/queries/provider-artwork.queries.js';

const logger = Logger.for('SeasonArtworkEnqueue');

/**
 * The season-poster backfill task. Its `coversStages` entry, `appliesTo`
 * (`['season']`, SDK spelling) and eligibility live in the task file itself.
 */
export const SEASON_ARTWORK_TASK_ID = 'provider-artwork-season-poster';

/**
 * Enqueue one run per season that is ELIGIBLE and still MISSING its poster.
 * Returns how many were actually enqueued.
 *
 * ALREADY-LOCAL SEASONS ARE FILTERED HERE too (`filterSeasonsWithCurrentLocalPoster`).
 * The sync re-lists every season with a TMDB poster on each series sync, so without
 * this a daily airing refresh (~400 series) enqueued ~700 runs a day that each
 * made one TMDB call and wrote nothing (prod, 7 days: 4,879 `already-local` runs).
 *
 *
 * Registry presence is checked first: the backfill task ships separately, and
 * `handleTriggerFailure` RE-THROWS an "Unknown task" error in dev
 * (handle-trigger-failure.ts:11-13), which would turn an unrelated series sync
 * into a crash on any deployment where the task is absent.
 *
 * Per-item identity is what makes the runner's pipeline-coverage wrapper fire
 * (runner.ts:1977, :2038), so the input MUST carry `mediaItemId`.
 *
 * ELIGIBILITY IS FILTERED HERE, not left to the task. This is a DIRECT enqueue:
 * it does not go through `stage-sweep`, so the stage's declared `eligibility.sql`
 * never runs, and the caller (`syncSeriesWithChildren`) selects seasons purely on
 * "TMDB has a poster for it" — which includes seasons the library does not hold.
 * Those items are rejected by the executor's own gate, and a rejected per-item run
 * is still a FAILED run as far as the circuit breaker is concerned. See
 * `filterSeasonsWithBackfillTarget` for the incident this prevents.
 */
export async function enqueueSeasonArtworkMaterialization(
    sql: postgres.Sql,
    seasons: ReadonlyArray<SeasonPosterRequest>,
    sourceRoute: string,
): Promise<number> {
    // De-duplicate by season id, keeping the first poster URL seen for it.
    const byId = new Map<string, SeasonPosterRequest>();
    for (const season of seasons) {
        if (!byId.has(season.mediaItemId)) byId.set(season.mediaItemId, season);
    }
    const requested = [...byId.values()];
    if (requested.length === 0) return 0;

    if (!getRegistry().getTask(SEASON_ARTWORK_TASK_ID)) {
        logger.debug('Season artwork backfill task not registered — skipping enqueue', {
            taskId: SEASON_ARTWORK_TASK_ID,
            seasons: requested.length,
        });
        return 0;
    }

    const eligibleIds = new Set(
        await filterSeasonsWithBackfillTarget(
            sql,
            requested.map((s) => s.mediaItemId),
        ),
    );
    const eligible = requested.filter((s) => eligibleIds.has(s.mediaItemId));
    if (eligible.length < requested.length) {
        // Not a warning: a catalog-only season (a `Specials` row TMDB knows about
        // and the library does not) is the normal case, not a misconfiguration.
        logger.debug('Skipped season artwork enqueue for ineligible seasons', {
            requested: requested.length,
            eligible: eligible.length,
            sourceRoute,
        });
    }

    const alreadyServed = new Set(await filterSeasonsWithCurrentLocalPoster(sql, eligible));
    const ids = eligible.map((s) => s.mediaItemId).filter((id) => !alreadyServed.has(id));
    if (alreadyServed.size > 0) {
        logger.debug('Skipped season artwork enqueue for seasons already served locally', {
            alreadyServed: alreadyServed.size,
            sourceRoute,
        });
    }
    if (ids.length === 0) return 0;

    const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');

    let enqueued = 0;
    for (const mediaItemId of ids) {
        try {
            await orchestrator.startRun(
                SEASON_ARTWORK_TASK_ID,
                { mediaItemId },
                { trigger: { kind: 'in-process', sourceRoute } },
            );
            enqueued++;
        } catch (err) {
            // One failed enqueue must not abort the rest of the sync's seasons.
            //
            // handleTriggerFailure RE-THROWS whenever NODE_ENV !== 'production'
            // (handle-trigger-failure.ts:88-93) — and vitest runs with
            // NODE_ENV === 'test', so the throw is NOT hypothetical. It has
            // already logged at `error` level with the structured
            // TASK_TRIGGER_FAILURE / TASK_REGISTRY_INCONSISTENCY payload by the
            // time it throws, so the fail-loud contract is satisfied by the log;
            // swallowing the dev re-throw here only stops one bad season from
            // aborting the remaining N-1. The genuinely loud case — the task not
            // existing at all — is handled by the registry check above, which
            // never reaches this catch.
            try {
                handleTriggerFailure(err, {
                    logger,
                    action: 'enqueue season artwork materialization',
                    taskId: SEASON_ARTWORK_TASK_ID,
                    context: { mediaItemId, sourceRoute },
                });
            } catch {
                // Dev/test re-throw: already reported at error level above.
            }
        }
    }

    return enqueued;
}
