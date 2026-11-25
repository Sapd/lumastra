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
 * ORDER BY terms that put an album's tracks in the order the album view shows
 * them: disc number, then track number, both from the file tags, then
 * `sort_order`. Many scans leave `sort_order` NULL and keep the position only in
 * `custom_metadata`, so ordering by `sort_order` alone shuffled such an album
 * by UUID when it was added to a playlist.
 *
 * The tag values are freeform jsonb (admins can bulk-edit them), so each cast
 * is guarded: a bare `::int` on a value like "3/12" would fail the whole
 * statement. Positions follow `parseTagPosition` in track-projection.ts: a
 * positive integer, or a string's leading digits; anything else counts as
 * missing. A track with no position sorts last. The track row must be
 * aliased `m`.
 */
export function albumTrackOrderSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        COALESCE(
            CASE
                WHEN jsonb_typeof(m.custom_metadata->'disc_number') = 'number'
                    -- Nested, so the cast only ever sees a JSON number: AND does
                    -- not guarantee evaluation order.
                    THEN CASE
                        WHEN (m.custom_metadata->>'disc_number')::numeric > 0
                            AND (m.custom_metadata->>'disc_number')::numeric = trunc((m.custom_metadata->>'disc_number')::numeric)
                            THEN (m.custom_metadata->>'disc_number')::numeric
                    END
                WHEN jsonb_typeof(m.custom_metadata->'disc_number') = 'string'
                    THEN NULLIF(substring(m.custom_metadata->>'disc_number' from '^[[:space:]]*[+]?([0-9]{1,9})')::numeric, 0)
            END,
            1
        ),
        COALESCE(
            CASE
                WHEN jsonb_typeof(m.custom_metadata->'track_number') = 'number'
                    -- Nested, so the cast only ever sees a JSON number: AND does
                    -- not guarantee evaluation order.
                    THEN CASE
                        WHEN (m.custom_metadata->>'track_number')::numeric > 0
                            AND (m.custom_metadata->>'track_number')::numeric = trunc((m.custom_metadata->>'track_number')::numeric)
                            THEN (m.custom_metadata->>'track_number')::numeric
                    END
                WHEN jsonb_typeof(m.custom_metadata->'track_number') = 'string'
                    THEN NULLIF(substring(m.custom_metadata->>'track_number' from '^[[:space:]]*[+]?([0-9]{1,9})')::numeric, 0)
            END,
            CASE WHEN m.sort_order > 0 THEN m.sort_order END,
            999999
        ),
        m.sort_order NULLS LAST,
        m.id
    `;
}

/**
 * Get all tracks for a music album (children with media_type='track'), in
 * album order (see `albumTrackOrderSql`).
 */
export async function getAlbumTracks(
    sql: postgres.Sql,
    albumMediaId: string,
): Promise<AlbumTrackRow[]> {
    return sql<AlbumTrackRow[]>`
        SELECT m.id, m.title, m.sort_order, m.episode_number, m.runtime_seconds
        FROM media_items m
        WHERE m.parent_id = ${albumMediaId}
          AND m.media_type = 'track'
          AND m.has_files = true
        ORDER BY ${albumTrackOrderSql(sql)}
    `;
}
