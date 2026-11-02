// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-item facts behind the `/j` BaseItemDto fields that no browse query
 * selects (cloud-parity brief 09): critic rating, series status / end date /
 * display order, track lyrics and loudness, and the episode span of a
 * multi-episode file. One query per response, over items the caller already
 * scoped — the same contract as `jellyfin-item-images.queries.ts`.
 */

import type postgres from 'postgres';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export interface JellyfinItemExtrasRow {
    id: string;
    media_type: string;
    /** Rotten Tomatoes critics score (0–100) as stored. */
    rt_rating: string | null;
    /** Series: TMDB status (`Returning Series`, `Ended`, …). */
    series_status: string | null;
    /** Series: date of the last aired episode. */
    last_air_date: string | null;
    /** Series: the active episode ordering (`dvd`, `absolute`, …), never `standard`. */
    display_order: string | null;
    /** Track: stored plain or synced lyrics. */
    has_lyrics: boolean;
    /** Track: integrated loudness (LUFS) from the audio analysis. */
    loudness_lufs: string | null;
    /** Episode: own number, and the lowest / highest number of the episodes in the same season sharing a file with it. */
    episode_number: number | null;
    span_min: number | null;
    span_max: number | null;
}

export async function getJellyfinItemExtras(
    sql: postgres.Sql,
    itemIds: readonly string[],
): Promise<JellyfinItemExtrasRow[]> {
    const ids = [...new Set(itemIds.filter((id) => isUuid(id)))];
    if (ids.length === 0) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- ids are items the caller already scoped; the span only reads siblings of those episodes
    return sql<JellyfinItemExtrasRow[]>`
        SELECT
            mi.id::text AS id,
            mi.media_type,
            pm.metadata->>'rt_rating' AS rt_rating,
            CASE WHEN mi.media_type = 'tv' THEN pm.metadata->>'status' END AS series_status,
            CASE WHEN mi.media_type = 'tv' THEN pm.metadata->>'last_air_date' END AS last_air_date,
            seo.ordering_type AS display_order,
            (
                mi.media_type = 'track'
                AND jsonb_typeof(mi.custom_metadata->'lyrics') = 'object'
                AND (COALESCE(mi.custom_metadata->'lyrics'->>'synced', '') <> ''
                     OR COALESCE(mi.custom_metadata->'lyrics'->>'plain', '') <> '')
            ) AS has_lyrics,
            CASE WHEN mi.media_type = 'track'
                THEN mi.custom_metadata->'essentia'->>'loudness_lufs' END AS loudness_lufs,
            mi.episode_number,
            span.span_min,
            span.span_max
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        LEFT JOIN series_episode_ordering seo
            ON seo.media_id = mi.id
           AND mi.media_type = 'tv'
           AND seo.ordering_type <> 'standard'
        LEFT JOIN LATERAL (
            SELECT MIN(o.episode_number) AS span_min, MAX(o.episode_number) AS span_max
            FROM media_file_items own
            JOIN media_file_items shared ON shared.file_id = own.file_id
            JOIN media_items o ON o.id = shared.media_item_id
            WHERE mi.media_type = 'episode'
              AND own.media_item_id = mi.id
              AND o.media_type = 'episode'
              AND o.status = 'active'
              AND o.parent_id = mi.parent_id
        ) span ON true
        WHERE mi.id = ANY(${ids}::uuid[])
    `;
}
