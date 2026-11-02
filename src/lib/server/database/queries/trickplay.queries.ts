// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay Query Module
 *
 * Pure SQL queries for trickplay generation.
 * Finds video paths and episode lists for media items.
 */

import type postgres from 'postgres';

interface TrickplayMediaItem {
    id: string;
    media_type: string;
    title: string;
    parent_id: string | null;
}

interface TrickplayEpisode {
    id: string;
    title: string;
}

/**
 * Get media item type and metadata for routing trickplay generation.
 */
export async function getMediaItemForTrickplay(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<TrickplayMediaItem | null> {
    const rows = await sql<TrickplayMediaItem[]>`
        SELECT id, media_type, title, parent_id
        FROM media_items
        WHERE id = ${mediaItemId}
    `;
    return rows[0] ?? null;
}

/**
 * Find the video file path for a media item.
 * Checks media_files via media_file_items junction table.
 * Walks hierarchy: item → parent (season) → grandparent (series).
 */
export async function findVideoPath(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<string | null> {
    // Check direct file link
    const direct = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
          AND mf.file_path IS NOT NULL
        LIMIT 1
    `;
    if (direct[0]?.file_path) return direct[0].file_path;

    // Get parent info for hierarchy walk
    const [item] = await sql<{ media_type: string; parent_id: string | null }[]>`
        SELECT media_type, parent_id FROM media_items WHERE id = ${mediaItemId}
    `;
    if (!item?.parent_id) return null;

    // Check parent (season-level) file link
    const parentFile = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${item.parent_id}
          AND mf.file_path IS NOT NULL
        LIMIT 1
    `;
    if (parentFile[0]?.file_path) return parentFile[0].file_path;

    // Check grandparent (series-level) file link
    const [parent] = await sql<{ parent_id: string | null }[]>`
        SELECT parent_id FROM media_items WHERE id = ${item.parent_id}
    `;
    if (!parent?.parent_id) return null;

    const grandparentFile = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${parent.parent_id}
          AND mf.file_path IS NOT NULL
        LIMIT 1
    `;
    return grandparentFile[0]?.file_path ?? null;
}

/**
 * Find all episodes for a series.
 * Episodes are children of seasons that are children of the series.
 */
export async function findEpisodesForSeries(
    sql: postgres.Sql,
    seriesId: string,
): Promise<TrickplayEpisode[]> {
    return sql<TrickplayEpisode[]>`
        SELECT mi.id, mi.title
        FROM media_items mi
        WHERE mi.parent_id IN (
            SELECT id FROM media_items
            WHERE parent_id = ${seriesId}
              AND media_type = 'season'
        )
          AND mi.media_type = 'episode'
        ORDER BY mi.sort_order NULLS LAST, mi.title
    `;
}

/**
 * Find all episodes for a season.
 */
export async function findEpisodesForSeason(
    sql: postgres.Sql,
    seasonId: string,
): Promise<TrickplayEpisode[]> {
    return sql<TrickplayEpisode[]>`
        SELECT mi.id, mi.title
        FROM media_items mi
        WHERE mi.parent_id = ${seasonId}
          AND mi.media_type = 'episode'
        ORDER BY mi.sort_order NULLS LAST, mi.title
    `;
}
