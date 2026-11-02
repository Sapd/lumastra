// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Detail Queries
 *
 * Queries for fetching episode lists with watch state for the series detail view.
 * Used by the /api/series/[id]/episodes endpoint.
 *
 * @module queries/episode-detail
 */

import type postgres from 'postgres';
import { isAvailableExpr } from './availability.queries.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type { UserId } from '$lib/shared/user-id';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from './episode-search.queries.js';

// =============================================================================
// Types
// =============================================================================

export interface EpisodeSegment {
    episodeNumber: number;
    title: string;
}

export interface SeriesEpisodeRow {
    id: string;
    season_id: string;
    ordering: string;
    absolute_number: number | null;
    previous_id: string | null;
    next_id: string | null;
    title: string | null;
    overview: string | null;
    season_number: number;
    episode_number: number;
    episode_number_end: number | null;
    runtime_seconds: number | null;
    premiere_date: string | Date | null;
    series_id: string | null;
    series_tmdb_id: string | null;
    primary_ext_id: string | null;
    imdb_id: string | null;
    series_name: string | null;
    is_watched: boolean | null;
    resume_position_ms: number | null;
    runtime_ms: number | null;
    last_watched_at: string | Date | null;
    last_event_at: string | Date | null;
    original_language?: string | null;
    audio_languages: string[];
    subtitle_languages: string[];
    has_file: boolean;
    segments: EpisodeSegment[] | null;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch episodes for a series with watch state for a given user.
 *
 * The series is addressed by its internal UUID.
 * Applies ordering-aware display numbers via auto-resolving LEFT JOINs.
 * Filters out unmapped episodes when a non-standard ordering is active.
 *
 * @param sql - Postgres SQL client
 * @param seriesInternalId - Internal UUID of the series
 * @param userId - User UUID for watch state lookup (undefined disables watch state)
 * @param seasonNumber - Optional season filter; if undefined, all seasons are returned
 */
export interface EpisodeWalkOptions {
    /** User-facing walks hide retained metadata-only episodes before pagination. */
    availableOnly?: boolean;
    limit?: number;
    offset?: number;
    specials?: 'include' | 'exclude' | 'only';
    episode?: number;
    absolute?: number;
    access?: MediaAccessBoundary;
    /** Physical season detail must ignore the active logical ordering. */
    physicalSeasonId?: string;
    physical?: boolean;
}

export async function getSeriesEpisodesWithWatchState(
    sql: postgres.Sql,
    seriesInternalId: string,
    userId: UserId | undefined,
    seasonNumber: number | undefined,
    options: EpisodeWalkOptions = {},
): Promise<SeriesEpisodeRow[]> {
    const seriesFilter = sql`series.id = ${seriesInternalId}`;

    return sql<SeriesEpisodeRow[]>`
        WITH episode_walk AS (SELECT DISTINCT ON (ep.id)
            ep.id,
            season.id AS season_id,
            COALESCE(seo.ordering_type, 'standard') AS ordering,
            COALESCE(eo.absolute_number, absolute_map.absolute_number) AS absolute_number,
            ep.title,
            ep.overview,
            COALESCE(eo.order_season_number, ep.season_number) as season_number,
            COALESCE(eo.order_episode_number, ep.episode_number) as episode_number,
            COALESCE(eo.order_episode_number_end, CASE WHEN seo.media_id IS NULL THEN standard_map.order_episode_number_end END) as episode_number_end,
            ep.runtime_seconds,
            ep.premiere_date,
            season.parent_id as series_id,
            (SELECT external_id FROM external_ids WHERE media_id = season.parent_id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as series_tmdb_id,
            (SELECT external_id FROM external_ids WHERE media_id = ep.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
            (SELECT external_id FROM external_ids WHERE media_id = ep.id AND provider = 'imdb' LIMIT 1) as imdb_id,
            series.title as series_name,
            (SELECT original_pm.metadata->>'original_language' FROM provider_metadata original_pm
             WHERE original_pm.media_id IN (series.id, ep.id)
               AND NULLIF(original_pm.metadata->>'original_language', '') IS NOT NULL
             ORDER BY (original_pm.media_id = ep.id),
               CASE original_pm.provider WHEN 'aggregated' THEN 0 WHEN 'tmdb' THEN 1 ELSE 2 END
             LIMIT 1) AS original_language,
            ws.is_watched,
            ws.resume_position_ms,
            ws.runtime_ms,
            ws.last_watched_at,
            ws.last_event_at,
            ARRAY(
                SELECT DISTINCT ms.language
                FROM media_file_items mfi
                JOIN media_streams ms ON ms.file_id = mfi.file_id
                WHERE mfi.media_item_id = ep.id
                  AND mfi.is_default = true
                  AND ms.stream_type = 'audio'
                  AND ms.language IS NOT NULL
                  AND ms.language NOT IN ('', 'und')
                ORDER BY ms.language
            ) AS audio_languages,
            ARRAY(
                SELECT DISTINCT lang FROM (
                    SELECT ms.language AS lang
                    FROM media_file_items mfi
                    JOIN media_streams ms ON ms.file_id = mfi.file_id
                    WHERE mfi.media_item_id = ep.id
                      AND mfi.is_default = true
                      AND ms.stream_type = 'subtitle'
                      AND ms.language IS NOT NULL
                      AND ms.language NOT IN ('', 'und')
                    UNION
                    SELECT esf.language AS lang
                    FROM media_file_items mfi
                    JOIN external_subtitle_files esf ON esf.file_id = mfi.file_id
                    WHERE mfi.media_item_id = ep.id
                      AND mfi.is_default = true
                      AND esf.language IS NOT NULL
                      AND esf.language NOT IN ('', 'und')
                ) sub
                ORDER BY lang
            ) AS subtitle_languages,
            EXISTS (
                SELECT 1 FROM media_file_items mfi
                WHERE mfi.media_item_id = ep.id
            ) AS has_file,
            CASE WHEN eo.order_episode_number_end IS NOT NULL THEN (
                -- File order (window start, then link sort_order), so a file an
                -- admin linked by hand as 9x20 then 9x19 lists them that way.
                SELECT json_agg(
                    json_build_object('episodeNumber', x.en, 'title', x.t)
                    ORDER BY x.start_ms ASC NULLS LAST, x.link_order, x.en
                )
                FROM (
                    SELECT DISTINCT ON (s.episode_number)
                        s.episode_number AS en, s.title AS t,
                        s_mfi.start_offset_ms AS start_ms, s_mfi.sort_order AS link_order
                    FROM media_file_items mfi_self
                    JOIN media_file_items s_mfi ON s_mfi.file_id = mfi_self.file_id AND s_mfi.is_default = true
                    JOIN media_items s ON s.id = s_mfi.media_item_id AND s.media_type = 'episode'
                    WHERE mfi_self.media_item_id = ep.id AND mfi_self.is_default = true
                    ORDER BY s.episode_number
                ) x
            ) ELSE NULL END AS segments
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        ${
            options.physicalSeasonId || options.physical
                ? sql`
            LEFT JOIN series_episode_ordering seo ON false
            LEFT JOIN episode_orderings eo ON false
        `
                : buildAutoEpisodeOrderingJoinFragment(sql)
        }
        LEFT JOIN LATERAL (
            SELECT std.order_episode_number_end FROM episode_orderings std
            WHERE std.episode_media_id = ep.id AND std.series_media_id = series.id
              AND std.ordering_type = 'standard'
            ORDER BY std.id LIMIT 1
        ) standard_map ON true
        LEFT JOIN LATERAL (
            SELECT abs.absolute_number FROM episode_orderings abs
            WHERE abs.episode_media_id = ep.id AND abs.series_media_id = series.id
              AND abs.absolute_number IS NOT NULL
            ORDER BY (abs.ordering_type = 'absolute') DESC, abs.id
            LIMIT 1
        ) absolute_map ON true
        LEFT JOIN user_media_state ws ON ws.media_id = ep.id AND ws.user_id = ${userId ?? null}::uuid
        WHERE ${seriesFilter}
          AND ep.media_type = 'episode' AND ep.status = 'active'
          ${options.availableOnly ? sql`AND ${isAvailableExpr(sql, sql`ep.id`)} AND ep.is_dismissed = false` : sql``}
          ${options.physicalSeasonId ? sql`AND season.id = ${options.physicalSeasonId}::uuid` : options.physical ? sql`` : buildUnmappedEpisodeFilterFragment(sql)}
          ${options.specials === 'exclude' ? sql`AND COALESCE(eo.order_season_number, ep.season_number) != 0` : sql``}
          ${options.specials === 'only' ? sql`AND COALESCE(eo.order_season_number, ep.season_number) = 0` : sql``}
          ${options.access ? buildLibraryAccessFilter(sql, options.access.library, 'ep') : sql``}
        ORDER BY ep.id, (eo.provider = seo.ordering_provider) DESC NULLS LAST, eo.id
        ), neighbours AS (
            SELECT *,
                lag(id) OVER walk AS previous_id,
                lead(id) OVER walk AS next_id
            FROM episode_walk
            WHERE true
              ${options.specials === 'exclude' ? sql`AND season_number != 0` : sql``}
              ${options.specials === 'only' ? sql`AND season_number = 0` : sql``}
            WINDOW walk AS (ORDER BY (season_number = 0), season_number, episode_number, id)
        )
        SELECT * FROM neighbours
        WHERE true
          ${seasonNumber !== undefined ? sql`AND season_number = ${seasonNumber}` : sql``}
          ${options.episode !== undefined ? sql`AND ${options.episode} BETWEEN episode_number AND COALESCE(episode_number_end, episode_number)` : sql``}
          ${options.absolute !== undefined ? sql`AND ${options.absolute} BETWEEN absolute_number AND absolute_number + GREATEST(COALESCE(episode_number_end, episode_number) - episode_number, 0)` : sql``}
        ORDER BY (season_number = 0), season_number, episode_number, id
        ${options.limit !== undefined ? sql`LIMIT ${options.limit}` : sql``}
        OFFSET ${options.offset ?? 0}
    `;
}

/**
 * Which of the given series has the user watched at least one episode of?
 *
 * The "my shows" signal for the release calendar. There is no follows /
 * subscriptions table in this schema — the calendar's only per-user filter is
 * the NEGATIVE `series_excluded` opt-out — so watch history is the sole
 * positive evidence that a user cares about a series. Measured on prod against
 * the 60 series with upcoming episodes in 30 days, this narrows the list to
 * 4–15 per user, which is the difference between an answer and a wall of anime
 * titles.
 *
 * Episode → season → series is walked via `parent_id` rather than joining the
 * series row, because only the series UUID is needed and the caller already
 * has it.
 *
 * @param sql - Postgres SQL client
 * @param userId - Caller's users.id UUID
 * @param seriesIds - Series UUIDs to test; an empty array short-circuits
 * @returns The subset of `seriesIds` with >= 1 watched episode
 */
export async function getWatchedSeriesIds(
    sql: postgres.Sql,
    userId: UserId,
    seriesIds: readonly string[],
): Promise<Set<string>> {
    if (seriesIds.length === 0) return new Set();

    const rows = await sql<{ series_id: string }[]>`
        SELECT DISTINCT season.parent_id AS series_id
        FROM user_media_state ums
        JOIN media_items ep ON ep.id = ums.media_id
                           AND ep.media_type = 'episode' AND ep.status = 'active'
        JOIN media_items season ON season.id = ep.parent_id
                               AND season.media_type = 'season'
        WHERE ums.user_id = ${userId}::uuid
          AND ums.is_watched = true
          AND season.parent_id = ANY(${sql.array([...seriesIds])}::uuid[])
    `;

    return new Set(rows.map((r) => r.series_id));
}
