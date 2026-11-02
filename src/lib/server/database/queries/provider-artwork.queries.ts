// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read side of the provider-artwork backfill drain.
 *
 * Lane A (movie / tv / episode) reads the artwork path off the item's OWN
 * winning `provider_metadata` row — the same row
 * `buildOverrideAwareMetadataLateralJoin` (`provider-metadata.builder.ts:555`)
 * would pick. Agreement is mandatory: an eligibility predicate that admits a
 * losing-chain path produces a stage row that can never complete.
 *
 * Lane B (seasons) has no own `provider_metadata` and, by explicit design, no
 * own `external_id` (`metadata-sync-single.service.ts:1129-1135`), so it
 * resolves through the parent series exactly the way `getSeasonPosterPath`
 * (`image-proxy/providers/tmdb.provider.ts:244-254`) does.
 */

import type postgres from 'postgres';
import {
    buildProviderArtworkPathExprFragment,
    buildProviderChainOrderExprFragment,
} from './builders/provider-metadata.builder.js';
import { getMetadataProviderChain } from '../../utils/provider-config.js';
import type { MaterializableArtworkType } from '../../utils/media-extras.js';

export interface WinningProviderArtworkPath {
    /** The `provider_metadata.provider` value the path came from. */
    provider: string;
    /** Either a TMDB-relative path ('/abc.jpg') or an absolute http(s) URL. */
    path: string;
}

/**
 * The artwork path carried by the item's OWN winning provider_metadata row,
 * or null. Never walks the ancestor chain — an inherited series poster written
 * onto an episode as a depth-0 row would permanently beat later frame
 * extraction (`image-proxy/service.ts:856-859` guards the read side of exactly
 * this).
 */
export async function getWinningProviderArtworkPath(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: MaterializableArtworkType,
): Promise<WinningProviderArtworkPath | null> {
    const chain = getMetadataProviderChain();
    if (chain.length === 0) return null;
    const pathExpr = buildProviderArtworkPathExprFragment(sql, artworkType, 'pm');
    const orderExpr = buildProviderChainOrderExprFragment(
        sql,
        chain,
        'pm.provider',
        'mi.preferred_provider',
    );

    // System backfill query — whole-catalog background processing; the caller
    // is a task run enqueued by stage-sweep, not a user request, so no
    // per-user access scoping applies (precedent: stage-sweep.queries.ts:104).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ provider: string; path: string | null }[]>`
        SELECT pm.provider, ${pathExpr} AS path
          FROM provider_metadata pm
          JOIN media_items mi ON mi.id = pm.media_id
         WHERE pm.media_id = ${mediaItemId}::uuid
           AND pm.provider = ANY(${chain}::text[])
         ORDER BY ${orderExpr}
         LIMIT 1
    `;

    const row = rows[0];
    if (!row?.path) return null;
    return { provider: row.provider, path: row.path };
}

export interface SeasonBackfillTarget {
    /** The parent series' internal UUID. */
    seriesId: string;
    /** The parent series' TMDB id, as stored (string). */
    seriesTmdbId: string;
    /** 0 for specials. */
    seasonNumber: number;
}

/**
 * Lane B target resolution — constraint-for-constraint the same gate
 * `getSeasonPosterPath` applies (`tmdb.provider.ts:244-254`, `:271-273`):
 * a `season` row with a non-null `season_number`, whose parent is a `tv` row
 * carrying a `tmdb` external id under the COMPOSITE key
 * (`provider='tmdb' AND media_type='tv'` — a provider id is not unique across
 * media types). `has_files` is required so a discovery catalog can't drain
 * ~1M ghost seasons into the small /config volume.
 */
export async function getSeasonBackfillTarget(
    sql: postgres.Sql,
    seasonItemId: string,
): Promise<SeasonBackfillTarget | null> {
    // System backfill query — see note above.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ series_id: string; series_tmdb_id: string; season_number: number }[]>`
        SELECT series.id::text        AS series_id,
               series_tmdb.external_id AS series_tmdb_id,
               season.season_number    AS season_number
          FROM media_items season
          JOIN media_items series
            ON series.id = season.parent_id
           AND series.media_type = 'tv'
          JOIN external_ids series_tmdb
            ON series_tmdb.media_id = series.id
           AND series_tmdb.provider = 'tmdb'
           AND series_tmdb.media_type = 'tv'
         WHERE season.id = ${seasonItemId}::uuid
           AND season.media_type = 'season'
           AND season.season_number IS NOT NULL
           AND season.has_files = true
         LIMIT 1
    `;

    const row = rows[0];
    if (!row) return null;
    return {
        seriesId: row.series_id,
        seriesTmdbId: row.series_tmdb_id,
        seasonNumber: row.season_number,
    };
}

/**
 * Batch form of {@link getSeasonBackfillTarget}'s gate — "which of these season
 * ids would Lane B actually accept?".
 *
 * Exists because the DIRECT enqueue path (`enqueueSeasonArtworkMaterialization`,
 * called by `syncSeriesWithChildren`) bypasses `stage-sweep` and therefore never
 * evaluates the stage's declared `eligibility.sql`. TMDB's season list routinely
 * contains seasons the library does not hold — a `Specials` row exists for almost
 * every series — so the sync fanned out runs for `has_files = false` seasons that
 * `getSeasonBackfillTarget` then rejected, and the resulting throw fed the task's
 * circuit breaker until it opened (prod 2026-07-30: Harborfolk Specials + Seasons
 * 14-17 re-enqueued every ~2h, 19 consecutive failures, stage paused — which also
 * blocked the 60 genuinely-pending season rows behind it).
 *
 * Keep the WHERE body identical to `getSeasonBackfillTarget` and to the stage's
 * `eligibility.sql`. All three encode one predicate; a filter that is LOOSER than
 * the executor re-opens exactly the bug above.
 */
export async function filterSeasonsWithBackfillTarget(
    sql: postgres.Sql,
    seasonItemIds: ReadonlyArray<string>,
): Promise<string[]> {
    if (seasonItemIds.length === 0) return [];
    // System backfill query — see note on getWinningProviderArtworkPath.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ id: string }[]>`
        SELECT season.id::text AS id
          FROM media_items season
          JOIN media_items series
            ON series.id = season.parent_id
           AND series.media_type = 'tv'
          JOIN external_ids series_tmdb
            ON series_tmdb.media_id = series.id
           AND series_tmdb.provider = 'tmdb'
           AND series_tmdb.media_type = 'tv'
         WHERE season.id = ANY(${seasonItemIds as string[]}::uuid[])
           AND season.media_type = 'season'
           AND season.season_number IS NOT NULL
           AND season.has_files = true
    `;
    return rows.map((r) => r.id);
}

/** A season and the TMDB poster URL the series sync just read for it. */
export interface SeasonPosterRequest {
    mediaItemId: string;
    posterUrl: string;
}

/**
 * Which of these seasons ALREADY HAVE their poster, so re-enqueueing them is
 * wasted work. Runs on every series sync, which re-lists every season that has a
 * TMDB poster, so without this filter a series sync enqueues a run per season
 * whatever the library already holds.
 *
 * A season is already served when its own selected, unsuppressed local poster
 * row (the same predicate as `getOwnLocalArtwork`) is one of:
 *  - a folder or other non-TMDB poster: the executor never replaces a local
 *    poster (`materializeProviderArtwork` policy 4), so there is nothing to do;
 *  - a TMDB poster materialized from the URL the sync just read (`provider_ref`
 *    is the full CDN URL, the same string `series-children.ts` builds as
 *    `posterUrl`).
 *
 * NOT returned, so still enqueued: no local poster row (new season, or the
 * file-existence cleanup deleted the row for a vanished file), and a TMDB-sourced
 * local poster whose upstream path changed.
 *
 * Callers pass only ids that already passed `filterSeasonsWithBackfillTarget`.
 */
export async function filterSeasonsWithCurrentLocalPoster(
    sql: postgres.Sql,
    requests: ReadonlyArray<SeasonPosterRequest>,
): Promise<string[]> {
    if (requests.length === 0) return [];
    // System backfill query: season ids come from the series sync, not a user request.
    // Any selected local poster counts, whatever its TMDB path: the task never
    // replaces a local poster, so a changed upstream path would only re-enqueue a no-op.
    const rows = await sql<{ id: string }[]>`
        SELECT r.media_item_id::text AS id
          FROM unnest(
                   ${requests.map((r) => r.mediaItemId)}::uuid[],
                   ${requests.map((r) => r.posterUrl)}::text[]
               ) AS r(media_item_id, poster_url)
         WHERE EXISTS (
               SELECT 1
                 FROM image_candidates ic
                WHERE ic.media_item_id = r.media_item_id
                  AND ic.artwork_type = 'poster'
                  AND (
                      (ic.source = 'local' AND ic.selected AND NOT ic.suppressed)
                      -- This exact TMDB image is already held, possibly hidden by an
                      -- admin: fetching it again cannot change anything.
                      OR (ic.provider = 'tmdb' AND ic.provider_ref = r.poster_url)
                  )
         )
    `;
    return rows.map((r) => r.id);
}

export interface StageBacklogCount {
    stageId: string;
    /** Rows in a sweepable status (the drain's remaining work). */
    pending: number;
    /**
     * How many of those items own at least one `media_files` row. An ESTIMATE
     * of the alongside-vs-central split: an item with no own file resolves via
     * `findDescendantDirAnchors` or falls back to central.
     */
    withOwnFile: number;
}

/** Per-stage remaining-work counts for the dry-run report. */
export async function countProviderArtworkBacklog(
    sql: postgres.Sql,
    stageIds: ReadonlyArray<string>,
): Promise<StageBacklogCount[]> {
    if (stageIds.length === 0) return [];
    // The status list alone is NOT the sweeper's reachability predicate. This counter
    // must apply the same item-level gates as `findSweepCandidates`
    // (`stage-sweep.queries.ts`) or the dry-run report promises work the drain can
    // never do: on prod 2466 seasons were `is_dismissed` (migration 13.0.0's
    // ghost-season false positives) and every one of them satisfies this stage's
    // eligibility fragment, so an ungated count reported them as pending forever.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ stage_id: string; pending: string; with_own_file: string }[]>`
        SELECT s.stage_id,
               COUNT(*)::text AS pending,
               COUNT(*) FILTER (
                   WHERE EXISTS (
                       SELECT 1 FROM media_file_items mfi
                        WHERE mfi.media_item_id = s.media_item_id
                   )
               )::text AS with_own_file
          FROM media_item_stage_state s
          JOIN media_items mi ON mi.id = s.media_item_id
         WHERE s.stage_id = ANY(${stageIds as string[]}::text[])
           AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
           AND mi.status = 'active'
           AND COALESCE(mi.is_dismissed, false) = false
           AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
         GROUP BY s.stage_id
    `;
    return rows.map((r) => ({
        stageId: r.stage_id,
        pending: Number.parseInt(r.pending, 10),
        withOwnFile: Number.parseInt(r.with_own_file, 10),
    }));
}
