// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

export interface InsertWatchHistoryParams {
    userId: UserId;
    mediaId: string;
    mediaType: string;
    title: string;
    year?: number;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    sessionStartTime: Date;
    sessionEndTime: Date;
    actualWatchTimeSeconds: number;
    maxPositionSeconds: number;
    totalRuntimeSeconds?: number;
    completionPercentage: number;
    isCompleted: boolean;
    deviceName?: string;
    clientName?: string;
    playMethod?: string;
    videoCodec?: string;
    resolution?: string;
    bitrateKbps?: number;
    sourcePlaySessionId?: string;
    sourceService?: string;
}

export async function insertWatchHistoryFromSession(
    sql: postgres.Sql,
    params: InsertWatchHistoryParams,
): Promise<void> {
    await sql`
        INSERT INTO watch_history (
            user_id, media_id, media_type, source_service,
            title, year, series_name, season_number, episode_number,
            session_start_time, session_end_time,
            actual_watch_time_seconds, max_position_seconds, total_runtime_seconds,
            completion_percentage, status,
            device_name, client_name,
            video_codec, resolution_width,
            bitrate_bps,
            source_play_session_id
        ) VALUES (
            ${params.userId},
            ${params.mediaId}::uuid,
            ${params.mediaType},
            ${params.sourceService ?? 'lumastra'},
            ${params.title},
            ${params.year ?? null},
            ${params.seriesName ?? null},
            ${params.seasonNumber ?? null},
            ${params.episodeNumber ?? null},
            ${params.sessionStartTime},
            ${params.sessionEndTime},
            ${params.actualWatchTimeSeconds},
            ${params.maxPositionSeconds},
            ${params.totalRuntimeSeconds ?? null},
            ${params.completionPercentage},
            ${params.isCompleted ? 'completed' : 'abandoned'},
            ${params.deviceName ?? null},
            ${params.clientName ?? null},
            ${params.videoCodec ?? null},
            ${params.resolution && params.resolution.includes('x') ? parseInt(params.resolution.split('x')[0] || '0', 10) || null : null},
            ${params.bitrateKbps ? params.bitrateKbps * 1000 : null},
            ${params.sourcePlaySessionId ?? null}
        )
        ON CONFLICT (source_play_session_id)
            WHERE source_play_session_id IS NOT NULL
            DO NOTHING
    `;
}

export interface MediaMetadataForHistory {
    title: string;
    media_type: string;
    season_number: number | null;
    episode_number: number | null;
    series_name: string | null;
    runtime_seconds: number | null;
    year: number | null;
}

export async function getMediaMetadataForHistory(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaMetadataForHistory | null> {
    // The TV hierarchy is always series → season → episode, so an episode's
    // parent_id points at the SEASON row, not the series. Joining a single level
    // would store the season title ("Staffel 3") as series_name. When the parent
    // is a season, take the grandparent (the series) title — and NEVER fall back
    // to the season's own title if the series is unresolvable (orphan season or
    // null-titled series), as that would re-introduce the bug; NULL is correct
    // there and consumers already guard `series_name IS NOT NULL`. For anything
    // else (a movie with no parent, or an episode attached directly to a series)
    // the parent title is the right value.
    const [row] = await sql<MediaMetadataForHistory[]>`
        SELECT mi.title, mi.media_type, mi.season_number, mi.episode_number,
               CASE
                   WHEN parent.media_type = 'season' THEN grandparent.title
                   ELSE parent.title
               END as series_name,
               mi.runtime_seconds,
               EXTRACT(YEAR FROM mi.premiere_date)::int as year
        FROM media_items mi
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
        WHERE mi.id = ${mediaId}::uuid
    `;
    return row ?? null;
}
