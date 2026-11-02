// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Intro Analysis Queries
 *
 * Queries for the lumastra intro analyzer plugin.
 * Episode grouping, file path resolution, and chapter data.
 */

import type postgres from 'postgres';

export interface EpisodeWithFile {
    episodeId: string;
    title: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    filePath: string | null;
    durationSeconds: number | null;
}

export interface SeasonGroup {
    seasonId: string;
    seasonNumber: number | null;
    seriesId: string;
    episodes: EpisodeWithFile[];
}

/**
 * Get all episodes for a season with their primary file paths.
 * Used for chromaprint batch analysis.
 *
 * ⚠️ NOT THE LIVE PATH. `lumastra-intro-analyzer.ts` carries its own private
 * copy of this function (and of `getFilePathForItem` / `getMediaItemInfo` /
 * `getUnanalyzedSeasons`); nothing outside this module's tests imports these.
 * Both copies shipped the same is_default defect, and fixing only this one
 * changed no runtime behaviour. Fix the analyzer's copy — or delete this
 * module and have the analyzer import from here.
 */
export async function getEpisodesWithFilesForSeason(
    sql: postgres.Sql,
    seasonId: string,
): Promise<EpisodeWithFile[]> {
    return sql<EpisodeWithFile[]>`
        SELECT DISTINCT ON (ep.id)
            ep.id AS "episodeId",
            ep.title,
            ep.season_number AS "seasonNumber",
            ep.episode_number AS "episodeNumber",
            mf.file_path AS "filePath",
            mf.duration_seconds AS "durationSeconds"
        FROM media_items ep
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = ep.id
        LEFT JOIN media_files mf ON mf.id = mfi.file_id
        WHERE ep.parent_id = ${seasonId}
          AND ep.media_type = 'episode'
        ORDER BY ep.id, mfi.is_default DESC NULLS LAST, mf.part_number NULLS FIRST, ep.sort_order NULLS LAST, ep.episode_number NULLS LAST
    `;
}

/**
 * Get all seasons that have unanalyzed episodes for a given source.
 * Returns season IDs with their series parent and episode count.
 */
export async function getUnanalyzedSeasons(
    sql: postgres.Sql,
    source: string,
    limit: number,
): Promise<Array<{ seasonId: string; seriesId: string; episodeCount: number }>> {
    return sql<Array<{ seasonId: string; seriesId: string; episodeCount: number }>>`
        SELECT
            season.id AS "seasonId",
            season.parent_id AS "seriesId",
            COUNT(ep.id)::int AS "episodeCount"
        FROM media_items season
        JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
        WHERE season.media_type = 'season'
          AND EXISTS (
              SELECT 1 FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE mfi.media_item_id = ep.id AND mf.file_path IS NOT NULL
          )
        GROUP BY season.id, season.parent_id
        HAVING COUNT(ep.id) >= 2
          AND COUNT(ep.id) FILTER (
              WHERE NOT EXISTS (
                  SELECT 1 FROM media_segments ms
                  WHERE ms.media_id = ep.id AND ms.source = ${source}
              )
          ) > 0
        ORDER BY season.parent_id, season.id
        LIMIT ${limit}
    `;
}

/**
 * Get file path for a single media item.
 * Returns first available file path (by part_number).
 */
export async function getFilePathForItem(
    sql: postgres.Sql,
    mediaId: string,
): Promise<string | null> {
    const rows = await sql<Array<{ file_path: string }>>`
        SELECT mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaId}
          AND mf.file_path IS NOT NULL
        ORDER BY mfi.is_default DESC, mf.part_number NULLS FIRST
        LIMIT 1
    `;
    return rows[0]?.file_path ?? null;
}

/**
 * Get media item basic info (type, duration, parent_id).
 */
export async function getMediaItemInfo(
    sql: postgres.Sql,
    mediaId: string,
): Promise<{
    mediaType: string;
    parentId: string | null;
    durationSeconds: number | null;
} | null> {
    const rows = await sql<
        Array<{
            media_type: string;
            parent_id: string | null;
            duration_seconds: number | null;
        }>
    >`
        SELECT mi.media_type, mi.parent_id,
               mf.duration_seconds
        FROM media_items mi
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        LEFT JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mi.id = ${mediaId}
        ORDER BY mfi.is_default DESC NULLS LAST
        LIMIT 1
    `;
    if (!rows[0]) return null;
    return {
        mediaType: rows[0].media_type,
        parentId: rows[0].parent_id,
        durationSeconds: rows[0].duration_seconds,
    };
}
