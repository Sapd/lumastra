// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Hierarchy Queries
 *
 * Queries for building the series → season → episode hierarchy tree
 * used by the admin media sidebar.
 */

import type postgres from 'postgres';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';
import { buildExternalIdSubquery } from './builders/external-id-subquery.builder.js';

export interface HierarchyItemRow {
    id: string;
    title: string | null;
    mediaType: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    parentId: string | null;
    jellyfinId: string | null;
}

export interface SeasonRow {
    id: string;
    title: string | null;
    season_number: number | null;
    parent_id: string | null;
    jellyfin_id: string | null;
    episode_count: string;
}

export interface EpisodeRow {
    id: string;
    title: string | null;
    episode_number: number | null;
    season_number: number | null;
    parent_id: string | null;
    jellyfin_id: string | null;
    has_file: boolean;
    is_ordering_segment: boolean;
}

/**
 * Load a media item with its Jellyfin external ID.
 */
export async function getHierarchyItem(
    sql: postgres.Sql,
    id: string,
): Promise<HierarchyItemRow | null> {
    const [row] = await sql<HierarchyItemRow[]>`
        SELECT mi.id, mi.title, mi.media_type AS "mediaType",
               mi.season_number AS "seasonNumber",
               mi.episode_number AS "episodeNumber",
               mi.parent_id AS "parentId",
               ${buildExternalIdSubquery(sql, sql`mi.id`, 'jellyfin')} AS "jellyfinId"
        FROM media_items mi
        WHERE mi.id = ${id}
    `;
    return row ?? null;
}

/**
 * Resolve the parent media item's basic info (for walking up the hierarchy).
 */
export async function getParentBasicInfo(
    sql: postgres.Sql,
    parentId: string,
): Promise<{ id: string; mediaType: string; parentId: string | null } | null> {
    const [row] = await sql<{ id: string; mediaType: string; parentId: string | null }[]>`
        SELECT id, media_type AS "mediaType", parent_id AS "parentId"
        FROM media_items WHERE id = ${parentId}
    `;
    return row ?? null;
}

/**
 * Load all seasons for a series, each with an episode count.
 */
export async function getSeasonsForSeries(
    sql: postgres.Sql,
    seriesId: string,
): Promise<SeasonRow[]> {
    return sql<SeasonRow[]>`
        SELECT mi.id, mi.title, mi.season_number,
               mi.parent_id,
               ${buildExternalIdSubquery(sql, sql`mi.id`, 'jellyfin')} AS jellyfin_id,
               (SELECT COUNT(*) FROM media_items ep
                WHERE ep.media_type = 'episode'
                      AND ep.parent_id = mi.id
               ) AS episode_count
        FROM media_items mi
        WHERE mi.parent_id = ${seriesId} AND mi.media_type = 'season'
        ORDER BY mi.season_number
    `;
}

/**
 * Load all episodes belonging to a series (directly or via seasons).
 */
export async function getEpisodesForSeriesHierarchy(
    sql: postgres.Sql,
    seriesId: string,
): Promise<EpisodeRow[]> {
    return sql<EpisodeRow[]>`
        SELECT mi.id, mi.title,
               COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
               COALESCE(eo.order_season_number, mi.season_number) AS season_number,
               mi.parent_id,
               ${buildExternalIdSubquery(sql, sql`mi.id`, 'jellyfin')} AS jellyfin_id,
               EXISTS(
                   SELECT 1 FROM media_file_items mfi
                   WHERE mfi.media_item_id = mi.id
               ) AS has_file,
               (seo.media_id IS NOT NULL
                AND eo.episode_media_id IS NULL
                AND EXISTS (
                    SELECT 1 FROM episode_orderings eo_sib
                    JOIN media_items ep_sib ON ep_sib.id = eo_sib.episode_media_id
                    WHERE eo_sib.series_media_id = seo.media_id
                      AND eo_sib.ordering_type = seo.ordering_type
                      AND eo_sib.ordering_group_id = seo.ordering_group_id
                      AND ep_sib.parent_id = mi.parent_id
                )
               ) AS is_ordering_segment
        FROM media_items mi
        LEFT JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        WHERE mi.media_type = 'episode'
          AND (
              mi.parent_id = ${seriesId}
              OR mi.parent_id IN (
                  SELECT s.id FROM media_items s
                  WHERE s.parent_id = ${seriesId} AND s.media_type = 'season'
              )
          )
        ORDER BY COALESCE(eo.order_season_number, mi.season_number),
                 COALESCE(eo.order_episode_number, mi.episode_number)
    `;
}

export interface FlattenedEpisodeRow {
    episode_id: string;
    season_number: number;
    episode_number: number;
}

/**
 * Returns episodes in the raw stored metadata-provider order.
 *
 * Deliberately does NOT join episode_orderings — slicing for external list
 * sync must use the canonical primary-provider ordering (e.g. TMDB), not
 * admin-applied display orderings. See media_external_groupings.
 *
 * Excludes specials (`season_number = 0` or NULL) — MAL/AniList `num_episodes`
 * counts canonical episodes only. Including specials would consume slice slots
 * meant for real episodes and push tail eps out of the mapping.
 */
export async function flattenSeriesEpisodesRaw(
    sql: postgres.Sql,
    seriesId: string,
): Promise<FlattenedEpisodeRow[]> {
    return sql<FlattenedEpisodeRow[]>`
        SELECT mi.id::text AS episode_id, mi.season_number, mi.episode_number
        FROM media_items mi
        WHERE mi.media_type = 'episode'
          AND mi.season_number IS NOT NULL
          AND mi.season_number > 0
          AND (
              mi.parent_id = ${seriesId}
              OR mi.parent_id IN (
                  SELECT s.id FROM media_items s
                  WHERE s.parent_id = ${seriesId} AND s.media_type = 'season'
              )
          )
        ORDER BY mi.season_number, mi.episode_number NULLS LAST
    `;
}

/**
 * The episode that plays after `episodeId` in the same series: the next
 * (season, episode) pair that is active and has a linked file. Specials
 * (season 0) are only followed by further specials, and a regular episode is
 * never followed by a special. Episodes sit either under a season or directly
 * under the series. Returns null for a non-episode or the last episode.
 */
export async function getNextEpisodeWithFile(
    sql: postgres.Sql,
    episodeId: string,
): Promise<{ id: string } | null> {
    // System lookup feeding a background subtitle prefetch; the prefetched
    // content is only ever served through the access-checked subtitle route.
    const rows = await sql<{ id: string }[]>`
        WITH cur AS (
            SELECT COALESCE(e.season_number, s.season_number, 0) AS sn,
                   e.episode_number AS en,
                   CASE WHEN s.media_type = 'season' THEN s.parent_id ELSE e.parent_id END AS series_id
            FROM media_items e
            LEFT JOIN media_items s ON s.id = e.parent_id
            WHERE e.id = ${episodeId}::uuid AND e.media_type = 'episode'
        )
        SELECT e.id::text AS id
        FROM cur
        JOIN media_items e ON e.media_type = 'episode'
        LEFT JOIN media_items s ON s.id = e.parent_id AND s.media_type = 'season'
        WHERE (s.parent_id = cur.series_id OR e.parent_id = cur.series_id)
          AND e.status = 'active'
          AND e.has_files = true
          AND e.episode_number IS NOT NULL
          AND cur.en IS NOT NULL
          AND EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = e.id)
          AND (
                (COALESCE(e.season_number, s.season_number, 0) = cur.sn AND e.episode_number > cur.en)
             OR (cur.sn > 0 AND COALESCE(e.season_number, s.season_number, 0) > cur.sn)
          )
        ORDER BY COALESCE(e.season_number, s.season_number, 0), e.episode_number, e.id
        LIMIT 1
    `;
    return rows[0] ?? null;
}
