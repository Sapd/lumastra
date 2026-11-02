// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineQuery } from '$lib/server/database/typed-query.js';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { buildContinueWatchingCompletionFilter } from '$lib/server/database/queries/builders/continue-watching.builder.js';
import {
    buildMovedOnGateCtes,
    buildMovedOnKeepPredicate,
} from '$lib/server/database/queries/builders/moved-on-gate.builder.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import {
    buildSeriesOwnedAgeRatingFilter,
    type AgeRatingFilterParams,
} from '$lib/server/database/queries/builders/age-rating.builder.js';
import type { UserId } from '$lib/shared/user-id.js';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';

export interface ContinueWatchingPageQuery {
    offset: number;
    /** Internal DB media types after mapping from the public API vocabulary. */
    mediaTypes: readonly string[] | null;
    staleAfterDays: number;
    audiobookStaleAfterDays: number;
    minProgressPercent: number;
}

/**
 * Endpoint-owned exact page query. It intentionally does not use WatchManager's
 * limit-keyed prefix cache: final membership, recency order and pagination must
 * be resolved together by Postgres.
 *
 * C3 (2026-09-18 fix-plan-4): `user_media_state` rows are the caller's OWN watch
 * history, but that only proves access at the time the item was watched — a
 * library-group revocation or a tightened age profile since then is not
 * re-checked anywhere else on this path (`continue-watching.ts` calls this
 * query directly with no post-filter; see its handler). `deniedGroupIds` /
 * `ageRating` are threaded through and applied via the canonical
 * `buildLibraryAccessFilter` / `buildSeriesOwnedAgeRatingFilter` fragments on
 * `mi` (the item itself, the same alias `effectiveWatchingFor`'s
 * `filterAccessibleMediaIds` path gates) so a page the caller can no longer see
 * is excluded before pagination runs, rather than filtered afterward and
 * short-paging the result. Episodes are judged by their series' rating: their
 * own `age_rating` is never written, so the plain filter dropped every episode
 * for a profile without unrated access.
 */
export const getExactContinueWatchingPageFromDb = defineQuery<
    {
        userId: UserId;
        limit: number;
        minMs: number;
        minPercent: number;
        maxAgeDays: number;
        /** Library groups the caller currently may not see; null = unrestricted. */
        deniedGroupIds: string[] | null;
        /** Caller's current age-rating ceiling; null = unrestricted. */
        ageRating: AgeRatingFilterParams | null;
        page: ContinueWatchingPageQuery;
    },
    ContinueWatchingRow
>(
    'getExactContinueWatchingPageFromDb',
    (sql, { userId, limit, minMs, minPercent, maxAgeDays, deniedGroupIds, ageRating, page }) => sql`
        WITH candidates AS (
            SELECT
                uws.media_id,
                uws.is_watched,
                mi.media_type,
                mi.title,
                mi.overview,
                mi.custom_metadata,
                uws.resume_position_ms,
                COALESCE(
                    NULLIF(uws.runtime_ms, 0),
                    mi.runtime_seconds * 1000,
                    (
                        SELECT ROUND(mf.duration_seconds * 1000)::bigint
                        FROM media_files mf
                        JOIN media_file_items mfi ON mfi.file_id = mf.id
                        WHERE mfi.media_item_id = mi.id
                          AND mf.duration_seconds > 0
                        ORDER BY mf.duration_seconds DESC
                        LIMIT 1
                    )
                )::bigint AS runtime_ms,
                uws.last_event_at,
                uws.last_event_source,
                mi.parent_id,
                parent_mi.id AS parent_mi_id,
                grandparent_mi.id AS series_id,
                COALESCE(grandparent_mi.title, parent_mi.title) AS series_name,
                COALESCE(eo.order_season_number, mi.season_number) AS season_number,
                COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
                mi.season_number AS raw_season_number,
                mi.episode_number AS raw_episode_number,
                COALESCE(grandparent_mi.id, mi.id) AS collapse_key
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            LEFT JOIN media_items parent_mi ON parent_mi.id = mi.parent_id
            LEFT JOIN media_items grandparent_mi ON grandparent_mi.id = parent_mi.parent_id
            LEFT JOIN series_episode_ordering seo
              ON seo.media_id = parent_mi.parent_id
             AND seo.ordering_type <> 'standard'
            LEFT JOIN episode_orderings eo
              ON eo.episode_media_id = mi.id
             AND eo.series_media_id = seo.media_id
             AND eo.ordering_type = seo.ordering_type
             AND eo.ordering_group_id = seo.ordering_group_id
            WHERE uws.user_id = ${userId}
              AND uws.resume_position_ms > 0
              AND ${buildContinueWatchingCompletionFilter(sql)}
              AND mi.media_type NOT IN (
                  'music', 'audio', 'podcast', 'track', 'album', 'artist',
                  'channel', 'livetv', 'live', 'extra'
              )
              AND (${page.mediaTypes == null} OR mi.media_type = ANY(${page.mediaTypes ?? []}))
              AND (
                  mi.has_files = true
                  OR EXISTS (
                      SELECT 1 FROM external_ids playable_ei
                      WHERE playable_ei.media_id = mi.id
                        AND playable_ei.provider = 'jellyfin'
                  )
              )
              -- C3 (2026-09-18 fix-plan-4): a watch-state row only proves the
              -- caller had access WHEN they watched it, not that they still
              -- do — re-check the caller's CURRENT library/age boundary here.
              ${buildLibraryAccessFilter(sql, deniedGroupIds, 'mi')}
              ${buildSeriesOwnedAgeRatingFilter(sql, ageRating, 'mi')}
              AND NOT EXISTS (
                  SELECT 1 FROM user_media_flags f
                  WHERE f.user_id = ${userId}
                    AND f.flag_type = 'dismissed_cw'
                    AND f.target_id::uuid = COALESCE(grandparent_mi.id, mi.id)
              )
              AND (
                  ${maxAgeDays} = 0
                  OR uws.last_event_at IS NULL
                  OR uws.last_event_at >= NOW() - (${maxAgeDays} * INTERVAL '1 day')
              )
        ),
        eligible AS (
            SELECT candidates.*
            FROM candidates
            WHERE (
                    candidates.runtime_ms IS NULL
                    OR candidates.runtime_ms <= 0
                    OR candidates.resume_position_ms::float / candidates.runtime_ms < CASE
                        WHEN candidates.runtime_ms < 90 * 60 * 1000  THEN 0.90
                        WHEN candidates.runtime_ms < 150 * 60 * 1000 THEN 0.95
                        ELSE 0.96
                    END
                  )
              AND (
                  (
                      candidates.resume_position_ms > ${minMs}
                      AND candidates.runtime_ms IS NOT NULL
                      AND candidates.runtime_ms > 0
                      AND candidates.resume_position_ms::float / candidates.runtime_ms > ${minPercent / 100}
                  )
                  OR (
                      (candidates.runtime_ms IS NULL OR candidates.runtime_ms <= 0)
                      AND candidates.resume_position_ms > 300000
                  )
                  -- Audiobooks: skip the percent-of-runtime gate — a 10-20h
                  -- book needs 1-2h of listening to clear minPercent, so a
                  -- book just started never qualifies. Use the same flat
                  -- time floor as the unknown-runtime branch instead.
                  OR (
                      LOWER(candidates.media_type) = 'audiobook'
                      AND candidates.resume_position_ms > ${minMs}
                  )
              )
              AND (
                  candidates.last_event_at IS NULL
                  OR candidates.last_event_at >= NOW() - (${page.staleAfterDays} * INTERVAL '1 day')
                  OR (
                      LOWER(candidates.media_type) <> 'audiobook'
                      AND (
                          candidates.runtime_ms IS NULL
                          OR candidates.runtime_ms <= 0
                          OR candidates.resume_position_ms::float / candidates.runtime_ms >= ${page.minProgressPercent / 100}
                      )
                  )
              )
              AND (
                  LOWER(candidates.media_type) <> 'audiobook'
                  OR candidates.last_event_at IS NULL
                  OR candidates.last_event_at >= NOW() - (${page.audiobookStaleAfterDays} * INTERVAL '1 day')
              )
        ),
        -- Moved-on gate, shared with the Home strip and /j Resume
        -- (moved-on-gate.builder.ts). Re-watch rows skip only the
        -- later-episode half, as before.
        cand_series AS (
            SELECT series_id, MIN(last_event_at) AS min_clock
            FROM eligible
            WHERE series_id IS NOT NULL
            GROUP BY series_id
        ),
        ${buildMovedOnGateCtes(sql, userId)},
        gated AS (
            SELECT eligible.*
            FROM eligible
            WHERE eligible.media_type <> 'episode'
               OR ${buildMovedOnKeepPredicate(sql, {
                   seriesId: sql`eligible.series_id`,
                   mediaId: sql`eligible.media_id`,
                   clock: sql`eligible.last_event_at`,
                   effSeason: sql`eligible.season_number`,
                   effEpisode: sql`eligible.episode_number`,
                   laterGateApplies: sql`(
                       eligible.is_watched = false
                       AND eligible.raw_season_number IS NOT NULL
                       AND eligible.raw_episode_number IS NOT NULL
                   )`,
               })}
        ),
        collapsed AS (
            SELECT DISTINCT ON (gated.collapse_key) gated.*
            FROM gated
            ORDER BY
                gated.collapse_key,
                gated.last_event_at DESC NULLS LAST,
                gated.season_number DESC NULLS LAST,
                gated.episode_number DESC NULLS LAST,
                gated.media_id
        ),
        page_rows AS (
            SELECT *
            FROM collapsed
            ORDER BY last_event_at DESC NULLS LAST, media_id
            OFFSET ${page.offset}
            LIMIT ${limit}
        )
        SELECT
            page_rows.media_id,
            page_rows.media_type,
            page_rows.title,
            page_rows.overview,
            page_rows.custom_metadata,
            LEAST(page_rows.resume_position_ms, 2147483647)::integer AS resume_position_ms,
            LEAST(page_rows.runtime_ms, 2147483647)::integer AS runtime_ms,
            page_rows.last_event_at,
            page_rows.last_event_source,
            page_rows.parent_id,
            page_rows.series_id,
            page_rows.series_name,
            page_rows.season_number,
            page_rows.episode_number,
            ext.tmdb_id,
            ext.imdb_id,
            COALESCE(page_rows.last_event_at, 'epoch'::timestamptz) AS sort_date
        FROM page_rows
        LEFT JOIN LATERAL (
            SELECT
                MAX(ei.external_id) FILTER (
                    WHERE ei.media_id = COALESCE(page_rows.series_id, page_rows.parent_mi_id, page_rows.media_id)
                      AND ei.provider = ${getPrimaryExternalIdProvider()}
                ) AS tmdb_id,
                MAX(ei.external_id) FILTER (
                    WHERE ei.media_id = COALESCE(page_rows.series_id, page_rows.parent_mi_id, page_rows.media_id)
                      AND ei.provider = 'imdb'
                ) AS imdb_id
            FROM external_ids ei
            WHERE ei.media_id = COALESCE(page_rows.series_id, page_rows.parent_mi_id, page_rows.media_id)
              AND ei.provider IN (${getPrimaryExternalIdProvider()}, 'imdb')
        ) ext ON TRUE
        ORDER BY page_rows.last_event_at DESC NULLS LAST, page_rows.media_id
    `,
);

export async function getExactContinueWatchingPage(
    userId: UserId,
    limit: number,
    page: ContinueWatchingPageQuery,
    /** Caller's current access boundary — see the C3 note above `getExactContinueWatchingPageFromDb`. */
    access: { deniedGroupIds: string[] | null; ageRating: AgeRatingFilterParams | null },
): Promise<ContinueWatchingRow[]> {
    const sql = getDb();
    if (!sql) return [];
    return getExactContinueWatchingPageFromDb.all(sql, {
        userId,
        limit,
        minMs: config.CONTINUE_WATCHING_MIN_SECONDS * 1000,
        minPercent: config.CONTINUE_WATCHING_MIN_PERCENT,
        maxAgeDays: config.CONTINUE_WATCHING_MAX_AGE_DAYS,
        deniedGroupIds: access.deniedGroupIds,
        ageRating: access.ageRating,
        page,
    });
}
