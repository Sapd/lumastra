// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Season Detail Queries
 *
 * Centralized database queries for fetching season lists under a series.
 * Extracted from /api/series/[id]/seasons/+server.ts.
 *
 * Supports two modes:
 * - UUID-based (internalId): Lumastra-only series with no Jellyfin external_id row
 * - Jellyfin-based (seriesJellyfinId): Series resolved via Jellyfin external_id
 *
 * Also handles non-standard episode orderings (virtual seasons).
 *
 * @module queries/season-detail
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type { SeasonOrdering } from '$lib/server/services/media-handle.js';

// =============================================================================
// Types
// =============================================================================

export interface DbSeasonRow {
    id: string;
    season_number: number;
    name: string | null;
    overview: string | null;
    premiere_date: string | Date | null;
    episode_count: number | null;
    image_tag: string | null;
    watched_count: number | null;
}

export interface OrderingSeasonRow {
    season_number: number;
    episode_count: number;
    watched_count: number;
    /** Internal UUID of the physical season most of this virtual season's episodes live in. */
    physical_season_id: string | null;
    image_tag: string | null;
}

export interface UnmappedPhysicalSeasonRow {
    season_id: string;
    season_number: number;
    name: string | null;
    overview: string | null;
    premiere_date: string | Date | null;
    episode_count: number;
    watched_count: number;
    image_tag: string | null;
}

// =============================================================================
// Ordering Season Queries
// =============================================================================

/**
 * Check whether a non-standard ordering exists for the given series.
 */
export async function hasNonStandardOrdering(
    sql: postgres.Sql,
    seriesUuid: string,
): Promise<boolean> {
    const [row] = await sql`
        SELECT 1 FROM series_episode_ordering
        WHERE media_id = ${seriesUuid} AND ordering_type != 'standard'
        LIMIT 1
    `;
    return Boolean(row);
}

/**
 * Fetch virtual ordering seasons for a series with a non-standard episode ordering.
 *
 * Aggregates episode_orderings by order_season_number with episode counts and watch status.
 * JOINs against physical seasons to borrow poster images: for each virtual season, finds the
 * most common physical season among mapped episodes and uses its Jellyfin ID and image tag.
 *
 * `access` is required (C8 fix round 1, 2026-09-16): this query joins to the
 * episode row (`ep_mi`) and applies `buildLibraryAccessFilter` there so a
 * denied episode drops out of both the count and the group entirely — a
 * virtual season whose every mapped episode is denied disappears the same
 * way a physical season does in `getSeriesSeasons`. This is the ordering
 * ("absolute"/"dvd") branch of `/series/{id}/seasons`, which review found
 * untouched by the first round of this fix (only the non-ordering branch,
 * `getSeasonsByInternalId`, was gated) — a restricted user with a mixed-group
 * series that has a non-standard ordering configured still saw every season.
 */
export async function getOrderingSeasons(
    sql: postgres.Sql,
    seriesUuid: string,
    userId: UserId | undefined,
    access: MediaAccessBoundary,
): Promise<OrderingSeasonRow[]> {
    return sql<OrderingSeasonRow[]>`
        WITH virtual_seasons AS (
            SELECT
                eo.order_season_number AS season_number,
                COUNT(*)::int AS episode_count,
                COALESCE(SUM(CASE WHEN ws.is_watched THEN 1 ELSE 0 END), 0)::int AS watched_count
            FROM episode_orderings eo
            JOIN series_episode_ordering seo
                ON seo.media_id = eo.series_media_id
                AND seo.ordering_type = eo.ordering_type
                AND seo.ordering_group_id = eo.ordering_group_id
            JOIN media_items ep_mi ON ep_mi.id = eo.episode_media_id
            LEFT JOIN user_media_state ws
                ON ws.media_id = eo.episode_media_id AND ws.user_id = ${userId ?? null}::uuid
            WHERE eo.series_media_id = ${seriesUuid}
                AND seo.ordering_type != 'standard'
                AND eo.episode_media_id IS NOT NULL
                ${buildLibraryAccessFilter(sql, access.library, 'ep_mi')}
            GROUP BY eo.order_season_number
        ),
        season_mapping AS (
            SELECT DISTINCT ON (eo.order_season_number)
                eo.order_season_number,
                ep.parent_id AS physical_season_id
            FROM episode_orderings eo
            JOIN series_episode_ordering seo
                ON seo.media_id = eo.series_media_id
                AND seo.ordering_type = eo.ordering_type
                AND seo.ordering_group_id = eo.ordering_group_id
            JOIN media_items ep ON ep.id = eo.episode_media_id
            WHERE eo.series_media_id = ${seriesUuid}
                AND seo.ordering_type != 'standard'
                AND eo.episode_media_id IS NOT NULL
                AND ep.parent_id IS NOT NULL
                ${buildLibraryAccessFilter(sql, access.library, 'ep')}
            GROUP BY eo.order_season_number, ep.parent_id
            -- Tiebreak on the season id so equal counts pick the same season every time.
            ORDER BY eo.order_season_number, COUNT(*) DESC, ep.parent_id
        )
        SELECT
            vs.season_number,
            vs.episode_count,
            vs.watched_count,
            sm.physical_season_id::text AS physical_season_id,
            COALESCE(
                (SELECT pm.metadata->>'image_tag' FROM provider_metadata pm WHERE pm.media_id = sm.physical_season_id AND pm.provider = 'jellyfin' LIMIT 1),
                CASE WHEN NULLIF((SELECT mi2.custom_poster_url FROM media_items mi2 WHERE mi2.id = sm.physical_season_id), '') IS NOT NULL THEN 'catalog' END
            ) AS image_tag
        FROM virtual_seasons vs
        LEFT JOIN season_mapping sm ON sm.order_season_number = vs.season_number
        ORDER BY vs.season_number
    `;
}

/**
 * Fetch physical seasons that are entirely unmapped in the active non-standard ordering.
 * Returns seasons where no episode from that season appears in the episode ordering.
 *
 * `access` is required (C8 fix round 1, 2026-09-16) — same rationale as
 * {@link getOrderingSeasons}: this is the "unmapped physical season" half of
 * the ordering branch, and review found it untouched by the first round.
 */
export async function getUnmappedPhysicalSeasons(
    sql: postgres.Sql,
    seriesUuid: string,
    userId: UserId | undefined,
    access: MediaAccessBoundary,
): Promise<UnmappedPhysicalSeasonRow[]> {
    return sql<UnmappedPhysicalSeasonRow[]>`
        SELECT
            season.id AS season_id,
            season.season_number,
            season.title AS name,
            season.overview,
            season.premiere_date,
            (SELECT COUNT(*)::int FROM media_items ep WHERE ep.parent_id = season.id AND ep.media_type = 'episode') AS episode_count,
            COALESCE(watched.count, 0)::int AS watched_count,
            COALESCE(
                (SELECT pm.metadata->>'image_tag' FROM provider_metadata pm WHERE pm.media_id = season.id AND pm.provider = 'jellyfin' LIMIT 1),
                CASE WHEN NULLIF(season.custom_poster_url, '') IS NOT NULL THEN 'catalog' END
            ) AS image_tag
        FROM media_items season
        LEFT JOIN (
            SELECT ep.parent_id AS season_id, COUNT(*)::int AS count
            FROM media_items ep
            INNER JOIN user_media_state ws
                ON ws.media_id = ep.id AND ws.user_id = ${userId ?? null}::uuid AND ws.is_watched = true
            WHERE ep.media_type = 'episode'
            GROUP BY ep.parent_id
        ) watched ON watched.season_id = season.id
        WHERE season.parent_id = ${seriesUuid}
          AND season.media_type = 'season'
          AND NOT EXISTS (
              SELECT 1 FROM episode_orderings eo
              JOIN series_episode_ordering seo
                  ON seo.media_id = eo.series_media_id
                  AND seo.ordering_type = eo.ordering_type
                  AND seo.ordering_group_id = eo.ordering_group_id
              JOIN media_items ep ON ep.id = eo.episode_media_id
              WHERE eo.series_media_id = ${seriesUuid}
                  AND seo.ordering_type != 'standard'
                  AND ep.parent_id = season.id
          )
          ${buildLibraryAccessFilter(sql, access.library, 'season')}
        ORDER BY season.season_number
    `;
}

// =============================================================================
// Physical Season Queries
// =============================================================================

/**
 * Fetch seasons by the series' internal UUID.
 *
 * `access` is required (C8, 2026-09-16 security review 3): this query used to
 * apply no library predicate at all. The caller's `checkMediaAccess` gate
 * only proves the SERIES itself is visible — `media_items.library_group_id`
 * is sticky (set once at first scan, only ever backfilled while NULL), so a
 * series that later gains a season in a new library group kept listing that
 * season's title/overview/premiere_date/episode_count to a user denied that
 * group.
 *
 * Library axis ONLY — deliberately no age-rating filter (fix round 1 review):
 * `media_items.age_rating` for a `season` row is never written by anything in
 * this codebase (only `updateMediaAgeRating` writes it, and only for
 * `movie`/`tv`), so it is always `NULL`. `buildAgeRatingFilter` would then
 * emit `(season.age_rating IS NULL AND $allowUnrated) OR ...`, and
 * `UNRATED_CONTENT_VISIBLE` defaults to `false` — the filter would empty this
 * listing for every age-restricted user (`maxAgeRating` non-null), not deny
 * anything legitimately. Do not add it back without also populating
 * `season.age_rating` somewhere, and a test proving it does not empty the
 * listing.
 */
export async function getSeasonsByInternalId(
    sql: postgres.Sql,
    internalId: string,
    userId: UserId | undefined,
    access: MediaAccessBoundary,
): Promise<DbSeasonRow[]> {
    return sql<DbSeasonRow[]>`
        SELECT
            season.id,
            season.season_number,
            season.title as name,
            season.overview,
            season.premiere_date,
            (SELECT COUNT(*)::int FROM media_items ep WHERE ep.parent_id = season.id AND ep.media_type = 'episode') as episode_count,
            COALESCE(
                (SELECT pm.metadata->>'image_tag' FROM provider_metadata pm WHERE pm.media_id = season.id AND pm.provider = 'jellyfin' LIMIT 1),
                -- No Jellyfin tag (TMDB-only deployment): a non-null sentinel tells
                -- the UI a season-specific poster exists so it requests the catalog
                -- image route, which serves season.custom_poster_url. The value
                -- itself is unused — getSeasonImageUrl() only checks truthiness.
                CASE WHEN NULLIF(season.custom_poster_url, '') IS NOT NULL THEN 'catalog' END
            ) as image_tag,
            COALESCE(watched.count, 0)::int as watched_count
        FROM media_items season
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        LEFT JOIN (
            SELECT
                ep.parent_id as season_id,
                COUNT(*)::int as count
            FROM media_items ep
            INNER JOIN user_media_state ws
                ON ws.media_id = ep.id
                AND ws.user_id = ${userId ?? null}::uuid
                AND ws.is_watched = true
            WHERE ep.media_type = 'episode'
            GROUP BY ep.parent_id
        ) watched ON watched.season_id = season.id
        WHERE series.id = ${internalId}
          AND season.media_type = 'season'
          ${buildLibraryAccessFilter(sql, access.library, 'season')}
        ORDER BY season.season_number
    `;
}

/** Active ordering; standard remains physical even when a configuration row exists. */
export async function getSeriesOrdering(
    sql: postgres.Sql,
    seriesId: string,
): Promise<SeasonOrdering> {
    const [row] = await sql<
        { ordering_type: SeasonOrdering }[]
    >`
        SELECT ordering_type FROM series_episode_ordering WHERE media_id = ${seriesId}::uuid
    `;
    return row?.ordering_type ?? 'standard';
}
