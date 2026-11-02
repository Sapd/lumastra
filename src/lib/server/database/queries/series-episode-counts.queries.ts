// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';

export interface SeriesEpisodeCountRow {
    id: string;
    seasonCount: number | null;
    episodeCount: number | null;
    availableEpisodeCount: number;
    watchedEpisodeCount: number;
    unwatchedEpisodeCount: number;
}

/** No file joins: each canonical episode contributes once, including season zero.
 * Age policy belongs to the series (seasons/episodes have no populated rating).
 * Child library predicates are still required for mixed-library hierarchies.
 */
export async function getSeriesEpisodeCountsBatch(
    sql: postgres.Sql,
    ids: readonly string[],
    userId: string | null,
    access: MediaAccessBoundary,
): Promise<SeriesEpisodeCountRow[]> {
    if (!ids.length || deniesEverything(access)) return [];
    return sql<SeriesEpisodeCountRow[]>`
        WITH roots AS (
            SELECT mi.id, mi.media_type, mi.parent_id
            FROM media_items mi
            LEFT JOIN media_items series ON series.id = mi.parent_id AND series.media_type = 'tv'
            -- media_type/library_group_id: the shared age builder reads them (audiobook floor).
            CROSS JOIN LATERAL (
                SELECT CASE WHEN mi.media_type = 'season' THEN series.age_rating ELSE mi.age_rating END AS age_rating,
                    mi.media_type, mi.library_group_id
            ) rating
            WHERE mi.id = ANY(${[...ids]}::uuid[]) AND mi.media_type IN ('tv', 'season')
              AND mi.status = 'active'
              AND (mi.media_type = 'tv' OR (series.id IS NOT NULL AND series.status = 'active'
                ${buildLibraryAccessFilter(sql, access.library, 'series')}))
              ${buildLibraryAccessFilter(sql, access.library, 'mi')}
              ${buildAgeRatingFilter(sql, access.age, 'rating')}
        ), children AS MATERIALIZED (
            SELECT roots.id AS root_id, season.id AS season_id, ep.id,
                   ep.has_files, COALESCE(ws.is_watched, false) AS watched
            FROM roots
            JOIN media_items season ON (season.parent_id = roots.id OR season.id = roots.id)
                AND season.media_type = 'season' AND season.status = 'active'
            LEFT JOIN media_items ep ON ep.parent_id = season.id
                AND ep.media_type = 'episode' AND ep.status = 'active'
                ${buildLibraryAccessFilter(sql, access.library, 'ep')}
            LEFT JOIN user_media_state ws ON ws.media_id = ep.id AND ws.user_id = ${userId}::uuid
            WHERE true ${buildLibraryAccessFilter(sql, access.library, 'season')}
        )
        SELECT roots.id,
            GREATEST(
                (SELECT MAX(NULLIF((CASE WHEN COALESCE(pm.metadata->>'season_count', pm.metadata->>'number_of_seasons') ~ '^[0-9]{1,9}$'
                    THEN COALESCE(pm.metadata->>'season_count', pm.metadata->>'number_of_seasons') END)::int, 0))
                 FROM provider_metadata pm WHERE pm.media_id = roots.id),
                NULLIF(COUNT(DISTINCT children.season_id), 0)::int
            ) AS "seasonCount",
            GREATEST(
                (SELECT MAX(NULLIF((CASE WHEN COALESCE(pm.metadata->>'number_of_episodes', pm.metadata->>'episode_count') ~ '^[0-9]{1,9}$' THEN COALESCE(pm.metadata->>'number_of_episodes', pm.metadata->>'episode_count') END)::int, 0))
                 FROM provider_metadata pm WHERE pm.media_id = roots.id
                   AND COALESCE(pm.metadata->>'number_of_episodes', pm.metadata->>'episode_count') ~ '^[0-9]{1,9}$'),
                NULLIF(COUNT(DISTINCT children.id), 0)::int
            ) AS "episodeCount",
            COUNT(DISTINCT children.id) FILTER (WHERE children.has_files)::int AS "availableEpisodeCount",
            COUNT(DISTINCT children.id) FILTER (WHERE children.has_files AND children.watched)::int AS "watchedEpisodeCount",
            COUNT(DISTINCT children.id) FILTER (WHERE children.has_files AND NOT children.watched)::int AS "unwatchedEpisodeCount"
        FROM roots LEFT JOIN children ON children.root_id = roots.id
        GROUP BY roots.id
    `;
}
