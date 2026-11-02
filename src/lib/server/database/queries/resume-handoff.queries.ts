// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQL behind the implicit resume handoff: the facts about a user's recent
 * play sessions that `resume-handoff.service.ts` walks as a chain from the
 * asking player's position. Decisions live in the service.
 * Design: docs/superpowers/specs/2026-10-22-implicit-resume-handoff.md.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';

/** Sessions read per request (oldest first since the anchor); a chain is a handful of episodes. */
export const HANDOFF_SESSION_LIMIT = 200;

export interface HandoffAnchorMediaRow {
    media_id: string;
    media_type: string;
    /** Series of an episode; null for anything else. */
    series_id: string | null;
    runtime_ms: number | null;
}

/** The item the asking player shows: type, series and runtime. */
export async function getHandoffAnchorMedia(
    sql: postgres.Sql,
    mediaId: string,
): Promise<HandoffAnchorMediaRow | null> {
    type Raw = Omit<HandoffAnchorMediaRow, 'runtime_ms'> & { runtime_ms: string | number | null };
    // Access: the endpoint gates the anchor and every item it returns (checkMediaAccess in defs/me/resume-handoff.ts).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<Raw[]>`
        SELECT
            mi.id::text AS media_id,
            mi.media_type,
            CASE WHEN mi.media_type = 'episode' THEN season.parent_id::text END AS series_id,
            mi.runtime_seconds::bigint * 1000 AS runtime_ms
        FROM media_items mi
        LEFT JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE mi.id = ${mediaId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return { ...row, runtime_ms: row.runtime_ms === null ? null : Number(row.runtime_ms) };
}

export interface HandoffSessionRow {
    session_id: string;
    media_id: string;
    media_type: string;
    device_id: string;
    device_name: string | null;
    entry_mode: string | null;
    started_at: Date;
    /** Where the session started; 0 for rows that predate the column. */
    start_position_ms: number;
    /** Furthest position reached; null for rows that predate the column. */
    high_water_ms: number | null;
    /** Newest durable position: the newest progress/completed event, else the row's last heartbeat. */
    last_position_ms: number;
    /** The newest event is a completion. */
    completed: boolean;
    /** When the newest progress/completed event happened; null when the session wrote none. */
    moved_at: Date | null;
    runtime_ms: number | null;
}

/**
 * This user's sessions that started after `since`, on `mediaId` or (for an
 * episode) anywhere in its series, oldest first. "Moved" is the newest
 * progress/completed event, not the heartbeat: a paused device keeps sending
 * keepalives that write no event.
 */
export async function loadHandoffSessions(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string; seriesId: string | null; since: Date },
): Promise<HandoffSessionRow[]> {
    type Raw = Omit<
        HandoffSessionRow,
        'start_position_ms' | 'high_water_ms' | 'last_position_ms' | 'runtime_ms'
    > & {
        start_position_ms: string | number | null;
        high_water_ms: string | number | null;
        last_position_ms: string | number | null;
        runtime_ms: string | number | null;
    };
    // Access: the endpoint gates the anchor and every item it returns (checkMediaAccess in defs/me/resume-handoff.ts).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<Raw[]>`
        WITH recent AS (
            -- The oldest sessions since the anchor first: the chain's first link
            -- must survive the cap; only the newest of a very long binge is cut.
            SELECT ps.*
            FROM play_sessions ps
            JOIN media_items mi ON mi.id = ps.media_id
            LEFT JOIN media_items season
                ON season.id = mi.parent_id AND season.media_type = 'season'
            WHERE ps.user_id = ${params.userId}
              AND ps.started_at > ${params.since}
              AND NOT ps.is_preview
              -- An offline download is not watching: it moves no position.
              AND ps.purpose <> 'download'
              AND (
                  ps.media_id = ${params.mediaId}::uuid
                  OR (
                      ${params.seriesId}::uuid IS NOT NULL
                      AND mi.media_type = 'episode'
                      AND season.parent_id = ${params.seriesId}::uuid
                  )
              )
            ORDER BY ps.started_at ASC
            LIMIT ${HANDOFF_SESSION_LIMIT}
        )
        SELECT
            ps.id::text AS session_id,
            ps.media_id::text AS media_id,
            mi.media_type,
            ps.device_id,
            COALESCE(NULLIF(ud.custom_name, ''), NULLIF(ud.reported_name, ''), ps.client_name)
                AS device_name,
            ps.entry_mode,
            ps.started_at,
            COALESCE(ps.start_position_ms, 0) AS start_position_ms,
            ps.high_water_ms,
            COALESCE(ev.position_ms, ps.position_ms) AS last_position_ms,
            COALESCE(ev.event_type = 'completed', false) AS completed,
            ev.occurred_at AS moved_at,
            COALESCE(ps.runtime_ms, mi.runtime_seconds::bigint * 1000) AS runtime_ms
        FROM recent ps
        JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN LATERAL (
            SELECT e.position_ms, e.event_type, e.occurred_at
            FROM user_media_events e
            WHERE e.user_id = ps.user_id
              AND e.media_id = ps.media_id
              AND e.session_id = ps.id::text
              AND e.source = 'lumastra-player'
              AND e.event_type IN ('progress', 'completed')
              AND e.repudiated_at IS NULL
            ORDER BY e.occurred_at DESC
            LIMIT 1
        ) ev ON true
        LEFT JOIN user_devices ud ON ud.user_id = ps.user_id AND ud.device_id = ps.device_id
        ORDER BY ps.started_at ASC
    `;
    const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
    return rows.map((r) => ({
        ...r,
        start_position_ms: Number(r.start_position_ms ?? 0),
        high_water_ms: num(r.high_water_ms),
        last_position_ms: Number(r.last_position_ms ?? 0),
        runtime_ms: num(r.runtime_ms),
    }));
}

/**
 * Display name of the device whose session took this (user, media) over from
 * `sessionId`: the newest session on the item from another device.
 */
export async function getTakeoverDeviceName(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
    sessionId: string,
): Promise<string | null> {
    const rows = await sql<{ device_name: string | null }[]>`
        SELECT COALESCE(NULLIF(ud.custom_name, ''), NULLIF(ud.reported_name, ''), ps.client_name)
            AS device_name
        FROM play_sessions ps
        JOIN play_sessions caller ON caller.id = ${sessionId}::uuid
        LEFT JOIN user_devices ud ON ud.user_id = ps.user_id AND ud.device_id = ps.device_id
        WHERE ps.user_id = ${userId}
          AND ps.media_id = ${mediaId}::uuid
          AND NOT ps.is_preview
          AND ps.purpose <> 'download'
          AND ps.device_id <> caller.device_id
          AND ps.started_at > caller.started_at
        ORDER BY ps.started_at DESC
        LIMIT 1
    `;
    return rows[0]?.device_name ?? null;
}
