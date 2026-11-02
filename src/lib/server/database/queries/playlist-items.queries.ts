// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface SeriesEpisodeRow {
    id: string;
    title: string;
    season_number: number | null;
    episode_number: number | null;
    poster_path: string | null;
    overview: string | null;
}

export interface AlbumTrackRow {
    id: string;
    title: string;
    sort_order: number | null;
    episode_number: number | null;
    runtime_seconds: number | null;
}

/**
 * Get all episodes for a TV series via DB hierarchy (series → seasons → episodes).
 */
export async function getSeriesEpisodesForPlaylist(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<SeriesEpisodeRow[]> {
    return sql<SeriesEpisodeRow[]>`
        SELECT mi.id, mi.title, mi.season_number, mi.episode_number,
               COALESCE(mi.custom_poster_url,
                   (SELECT pm.metadata->>'poster_path'
                    FROM provider_metadata pm
                    WHERE pm.media_id = mi.id
                    ORDER BY pm.updated_at DESC LIMIT 1)
               ) AS poster_path,
               mi.overview
        FROM media_items mi
        WHERE mi.parent_id IN (
            SELECT id FROM media_items WHERE parent_id = ${seriesMediaId} AND media_type = 'season'
        ) AND mi.media_type = 'episode' AND mi.has_files = true
        ORDER BY mi.season_number, mi.episode_number
    `;
}

/**
 * Episode ids of one season, in episode order (only episodes with files).
 */
export async function getSeasonEpisodeIds(
    sql: postgres.Sql,
    seasonMediaId: string,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM media_items
        WHERE parent_id = ${seasonMediaId}
          AND media_type = 'episode'
          AND has_files = true
        ORDER BY episode_number NULLS LAST, id
    `;
    return rows.map((r) => r.id);
}

/**
 * Get all tracks for a music album (children with media_type='track').
 */
export async function getAlbumTracks(
    sql: postgres.Sql,
    albumMediaId: string,
): Promise<AlbumTrackRow[]> {
    return sql<AlbumTrackRow[]>`
        SELECT id, title, sort_order, episode_number, runtime_seconds
        FROM media_items
        WHERE parent_id = ${albumMediaId}
          AND media_type = 'track'
          AND has_files = true
        ORDER BY COALESCE(sort_order, episode_number, 0) ASC
    `;
}
