// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * One row per active/paused playback session, trimmed to exactly the fields the
 * compact Operations-drawer streaming strip needs. A single indexed query over
 * `play_sessions` (+ media_items for the title) — same cost profile as the other
 * cheap signal sources; it covers BOTH Lumastra-native and mirrored direct-Jellyfin
 * sessions (the sessions-cache service ingests Jellyfin into `play_sessions`).
 */
export interface ActiveStreamRow {
    user_id: string | null;
    owner_username: string | null;
    source: string | null;
    device_id: string | null;
    media_title: string | null;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    play_method: string | null;
    bitrate_kbps: number | null;
    position_ms: number | null;
    runtime_ms: number | null;
    status: string;
}

/**
 * Active/paused sessions, newest-first, bounded. Operator-console view: lists EVERY
 * active session across all users by design; scoping is enforced by the route guard.
 * The media_items join only resolves a display title.
 */
export async function getActiveStreams(sql: postgres.Sql, limit = 100): Promise<ActiveStreamRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- operator console, route-guarded; join is title-only
    return sql<ActiveStreamRow[]>`
        SELECT
            ps.user_id,
            COALESCE(u.username, ps.user_id::text) AS owner_username,
            ps.source,
            ps.device_id,
            mi.title AS media_title,
            COALESCE(grandparent.title, parent.title) AS series_title,
            mi.season_number,
            mi.episode_number,
            ps.play_method,
            ps.bitrate_kbps,
            ps.position_ms,
            ps.runtime_ms,
            ps.status
        FROM play_sessions ps
        LEFT JOIN users u ON u.id = ps.user_id
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
        WHERE ps.status IN ('ACTIVE', 'PAUSED')
          AND NOT ps.is_preview AND ps.purpose = 'play'
        ORDER BY ps.last_heartbeat_at DESC NULLS LAST
        LIMIT ${limit}
    `;
}
