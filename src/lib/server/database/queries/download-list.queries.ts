// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rows behind GET /api/media/{id}/download-list: the item (or every episode of
 * a series/season) with the file a download takes by default. The default file
 * is the one `resolvePlaybackSelection` picks: the default link, else the first
 * by sort order, among the files the caller's library scope allows. Naming columns match `MediaDownloadNamingRow` so
 * `buildDownloadFilename` gives the same name the download route sends.
 */

import type postgres from 'postgres';
import type { MediaDownloadNamingRow } from './catalog-operations.queries.js';

export interface DownloadListRoot {
    id: string;
    title: string;
    year: number | null;
    media_type: string;
}

export interface DownloadListRow extends MediaDownloadNamingRow {
    /** Year of the owning series; only set by getSingleDownloadRow for an episode. */
    series_year?: number | null;
    file_id: string | null;
    file_path: string | null;
    file_size_bytes: number | string | null;
    is_missing: boolean | null;
}

/**
 * The caller's library scope applied to FILE selection, before the ORDER BY / LIMIT 1:
 * the default file is the best allowed one, never a denied file the item also carries.
 */
function fileScope(sql: postgres.Sql, denied: readonly string[] | null) {
    if (!denied || denied.length === 0) return sql``;
    return sql`AND (mf.library_group_id IS NULL OR mf.library_group_id != ALL(${[...denied]}::uuid[]))`;
}

export async function getDownloadListRoot(
    sql: postgres.Sql,
    id: string,
): Promise<DownloadListRoot | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- access gated by caller (download-list.ts: checkMediaAccess + checkMediaAccessBatch)
    const rows = await sql<DownloadListRoot[]>`
        SELECT id, title, year, media_type
        FROM media_items
        WHERE id = ${id} AND status = 'active'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/** Every active episode under a series (or one season) (file_id null when it has no file row). */
export async function listEpisodeDownloadRows(
    sql: postgres.Sql,
    containerId: string,
    denied: readonly string[] | null = null,
): Promise<DownloadListRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- access gated by caller (download-list.ts: checkMediaAccess + checkMediaAccessBatch)
    return sql<DownloadListRow[]>`
        SELECT mi.id, mi.title, mi.year, mi.media_type, mi.season_number, mi.episode_number,
               series.title AS series_title,
               f.id AS file_id, f.file_path, f.file_size_bytes, f.is_missing
        FROM media_items mi
        LEFT JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = COALESCE(season.parent_id, mi.parent_id)
        LEFT JOIN LATERAL (
            SELECT mf.id, mf.file_path, mf.file_size_bytes, mf.is_missing
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mfi.media_item_id = mi.id
              ${fileScope(sql, denied)}
            ORDER BY mfi.is_default DESC NULLS LAST, mfi.sort_order, mf.part_number NULLS FIRST, mf.id
            LIMIT 1
        ) f ON true
        WHERE mi.media_type = 'episode' AND mi.status = 'active'
          AND (series.id = ${containerId} OR season.id = ${containerId})
        ORDER BY mi.season_number NULLS LAST, mi.episode_number NULLS LAST, mi.title, mi.id
    `;
}

/** One non-container item (movie, ...) with its default file. */
export async function getSingleDownloadRow(
    sql: postgres.Sql,
    id: string,
    denied: readonly string[] | null = null,
): Promise<DownloadListRow | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- access gated by caller (download-list.ts: checkMediaAccess + checkMediaAccessBatch)
    const rows = await sql<DownloadListRow[]>`
        SELECT mi.id, mi.title, mi.year, mi.media_type, mi.season_number, mi.episode_number,
               series.title AS series_title, series.year AS series_year,
               f.id AS file_id, f.file_path, f.file_size_bytes, f.is_missing
        FROM media_items mi
        LEFT JOIN media_items season ON mi.media_type = 'episode' AND season.id = mi.parent_id
        LEFT JOIN media_items series ON mi.media_type = 'episode' AND series.id = season.parent_id
        LEFT JOIN LATERAL (
            SELECT mf.id, mf.file_path, mf.file_size_bytes, mf.is_missing
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mfi.media_item_id = mi.id
              ${fileScope(sql, denied)}
            ORDER BY mfi.is_default DESC NULLS LAST, mfi.sort_order, mf.part_number NULLS FIRST, mf.id
            LIMIT 1
        ) f ON true
        WHERE mi.id = ${id} AND mi.status = 'active'
    `;
    return rows[0] ?? null;
}
