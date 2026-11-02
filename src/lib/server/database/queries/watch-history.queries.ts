// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch History Query Module
 *
 * Centralized queries for watch_history table operations.
 * Used for watch analytics, trending content, activity feeds, and statistics.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { defineExistsQuery, defineQuery, defineScalarQuery } from '../typed-query.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'movie' | 'tv' | 'episode';
export type Timeframe = 'today' | 'week' | 'month' | 'year' | 'all';

export interface WatchHistoryRow {
    id: string;
    user_id: string;
    media_id: string; // Internal media_items UUID
    media_type: MediaType;
    session_start_time: Date;
    session_end_time: Date | null;
    actual_watch_time_seconds: number | null;
}

export interface WatchStatsRow {
    session_count: number;
    unique_viewers: number;
    total_watch_minutes: number;
    avg_watch_minutes: number;
}

export interface TrendingMediaRow {
    media_id: string; // Internal media_items UUID
    media_type: MediaType;
    session_count: number;
    unique_viewers: number;
    total_watch_minutes: number;
    trending_score: number;
}

export interface UserWatchActivityRow {
    user_id: string;
    media_id: string; // Internal media_items UUID
    media_type: MediaType;
    title: string | null;
    session_start_time: Date;
    actual_watch_time_seconds: number | null;
}

export interface PlaybackQualityRow {
    resolution: string | null;
    bitrate_kbps: number | null;
    session_count: number;
    avg_watch_minutes: number;
}

export interface ViewerRow {
    user_id: string;
    session_count: number;
    total_watch_minutes: number;
    last_watched: Date;
}

// =============================================================================
// Timeframe Helpers
// =============================================================================

/**
 * Convert timeframe to PostgreSQL interval.
 */
export function timeframeToInterval(timeframe: Timeframe): string {
    switch (timeframe) {
        case 'today':
            return '1 day';
        case 'week':
            return '7 days';
        case 'month':
            return '30 days';
        case 'year':
            return '365 days';
        case 'all':
            return '100 years'; // Effectively no filter
    }
}

/**
 * Convert timeframe to number of days.
 */
export function timeframeToDays(timeframe: Timeframe): number {
    switch (timeframe) {
        case 'today':
            return 1;
        case 'week':
            return 7;
        case 'month':
            return 30;
        case 'year':
            return 365;
        case 'all':
            return 36500;
    }
}

// =============================================================================
// Read Queries - Single Item
// =============================================================================

/**
 * Get watch statistics for a specific media item.
 */
export const getMediaWatchStats = defineScalarQuery<{ mediaId: string }, WatchStatsRow>(
    'getMediaWatchStats',
    (sql, { mediaId }) => sql`
        SELECT
            COUNT(*)::int as session_count,
            COUNT(DISTINCT user_id)::int as unique_viewers,
            COALESCE(SUM(actual_watch_time_seconds) / 60, 0)::int as total_watch_minutes,
            COALESCE(AVG(actual_watch_time_seconds) / 60, 0)::numeric(10,1)::float8 as avg_watch_minutes
        FROM watch_history
        WHERE media_id = ${mediaId}::uuid
    `,
    (row) => ({
        session_count: row.session_count as number,
        unique_viewers: row.unique_viewers as number,
        total_watch_minutes: row.total_watch_minutes as number,
        avg_watch_minutes: row.avg_watch_minutes as number,
    }),
);

/**
 * Get watch statistics for a media item within a timeframe.
 */
export const getMediaWatchStatsInTimeframe = defineScalarQuery<
    { mediaId: string; days: number },
    WatchStatsRow
>(
    'getMediaWatchStatsInTimeframe',
    (sql, { mediaId, days }) => sql`
        SELECT
            COUNT(*)::int as session_count,
            COUNT(DISTINCT user_id)::int as unique_viewers,
            COALESCE(SUM(actual_watch_time_seconds) / 60, 0)::int as total_watch_minutes,
            COALESCE(AVG(actual_watch_time_seconds) / 60, 0)::numeric(10,1)::float8 as avg_watch_minutes
        FROM watch_history
        WHERE media_id = ${mediaId}::uuid
          AND session_start_time >= NOW() - (${days} || ' days')::interval
    `,
    (row) => ({
        session_count: row.session_count as number,
        unique_viewers: row.unique_viewers as number,
        total_watch_minutes: row.total_watch_minutes as number,
        avg_watch_minutes: row.avg_watch_minutes as number,
    }),
);

// =============================================================================
// Read Queries - Lists
// =============================================================================

/**
 * Get trending media based on recent viewing activity.
 * Trending score = (unique_viewers * 100) + total_watch_minutes
 */
export const getTrendingMedia = defineQuery<
    { days: number; mediaTypes: string[]; limit: number },
    TrendingMediaRow
>(
    'getTrendingMedia',
    (sql, { days, mediaTypes, limit }) => sql`
    SELECT
        vs.media_id,
        vs.media_type,
        COUNT(*)::int as session_count,
        COUNT(DISTINCT vs.user_id)::int as unique_viewers,
        COALESCE(SUM(vs.actual_watch_time_seconds) / 60, 0)::int as total_watch_minutes,
        (COUNT(DISTINCT vs.user_id) * 100 + COALESCE(SUM(vs.actual_watch_time_seconds) / 60, 0))::int as trending_score
    FROM watch_history vs
    WHERE vs.session_start_time >= NOW() - (${days} || ' days')::interval
      AND vs.media_type = ANY(${mediaTypes.map((t) => t.toLowerCase())}::text[])
      AND vs.actual_watch_time_seconds >= 300
      AND vs.media_id IS NOT NULL
    GROUP BY vs.media_id, vs.media_type
    ORDER BY trending_score DESC
    LIMIT ${limit}
`,
);

/**
 * Get trending movies specifically.
 */
export const getTrendingMovies = defineQuery<{ days: number; limit: number }, TrendingMediaRow>(
    'getTrendingMovies',
    (sql, { days, limit }) => sql`
        SELECT
            vs.media_id,
            vs.media_type,
            COUNT(*)::int as session_count,
            COUNT(DISTINCT vs.user_id)::int as unique_viewers,
            COALESCE(SUM(vs.actual_watch_time_seconds) / 60, 0)::int as total_watch_minutes,
            (COUNT(DISTINCT vs.user_id) * 100 + COALESCE(SUM(vs.actual_watch_time_seconds) / 60, 0))::int as trending_score
        FROM watch_history vs
        WHERE vs.session_start_time >= NOW() - (${days} || ' days')::interval
          AND vs.media_type = 'movie'
          AND vs.actual_watch_time_seconds >= 300
          AND vs.media_id IS NOT NULL
        GROUP BY vs.media_id, vs.media_type
        ORDER BY trending_score DESC
        LIMIT ${limit}
    `,
);

/**
 * Get trending episodes (for series trending).
 */
export const getTrendingEpisodes = defineQuery<{ days: number; limit: number }, TrendingMediaRow>(
    'getTrendingEpisodes',
    (sql, { days, limit }) => sql`
        SELECT
            vs.media_id,
            vs.media_type,
            COUNT(*)::int as session_count,
            COUNT(DISTINCT vs.user_id)::int as unique_viewers,
            COALESCE(SUM(vs.actual_watch_time_seconds) / 60, 0)::int as total_watch_minutes,
            (COUNT(DISTINCT vs.user_id) * 100 + COALESCE(SUM(vs.actual_watch_time_seconds) / 60, 0))::int as trending_score
        FROM watch_history vs
        WHERE vs.session_start_time >= NOW() - (${days} || ' days')::interval
          AND vs.media_type = 'episode'
          AND vs.actual_watch_time_seconds >= 300
          AND vs.media_id IS NOT NULL
        GROUP BY vs.media_id, vs.media_type
        ORDER BY trending_score DESC
        LIMIT ${limit}
    `,
);

/**
 * Get all viewers for a specific media item.
 */
export const getMediaViewers = defineQuery<{ mediaId: string; limit: number }, ViewerRow>(
    'getMediaViewers',
    (sql, { mediaId, limit }) => sql`
        SELECT
            user_id,
            COUNT(*)::int as session_count,
            COALESCE(SUM(actual_watch_time_seconds) / 60, 0)::int as total_watch_minutes,
            MAX(session_start_time) as last_watched
        FROM watch_history
        WHERE media_id = ${mediaId}::uuid
        GROUP BY user_id
        ORDER BY last_watched DESC
        LIMIT ${limit}
    `,
);

/**
 * Get recent watch activity for a user.
 */
export const getUserRecentWatchActivity = defineQuery<
    { userId: UserId; limit: number },
    UserWatchActivityRow
>(
    'getUserRecentWatchActivity',
    (sql, { userId, limit }) => sql`
    SELECT
        vs.user_id,
        vs.media_id,
        vs.media_type,
        COALESCE(mi.title, vs.title) as title,
        vs.session_start_time,
        vs.actual_watch_time_seconds
    FROM watch_history vs
    LEFT JOIN media_items mi ON mi.id = vs.media_id
    WHERE vs.user_id = ${userId}
    ORDER BY vs.session_start_time DESC
    LIMIT ${limit}
`,
);

/**
 * Get recent activity across all users (for activity feed).
 */
export const getRecentActivity = defineQuery<
    { limit: number; minWatchSeconds: number },
    UserWatchActivityRow
>(
    'getRecentActivity',
    (sql, { limit, minWatchSeconds }) => sql`
    SELECT
        vs.user_id,
        vs.media_id,
        vs.media_type,
        COALESCE(mi.title, vs.title) as title,
        vs.session_start_time,
        vs.actual_watch_time_seconds
    FROM watch_history vs
    LEFT JOIN media_items mi ON mi.id = vs.media_id
    WHERE COALESCE(vs.actual_watch_time_seconds, 0) >= ${minWatchSeconds}
    ORDER BY vs.session_start_time DESC
    LIMIT ${limit}
`,
);

// =============================================================================
// User Statistics Queries
// =============================================================================

/**
 * Get watch statistics for a user.
 */
export const getUserWatchStats = defineScalarQuery<
    { userId: UserId },
    {
        total_sessions: number;
        total_watch_hours: number;
        movies_watched: number;
        episodes_watched: number;
        avg_session_minutes: number;
    }
>(
    'getUserWatchStats',
    (sql, { userId }) => sql`
        SELECT
            COUNT(*)::int as total_sessions,
            COALESCE(SUM(actual_watch_time_seconds) / 3600, 0)::numeric(10,1)::float8 as total_watch_hours,
            COUNT(*) FILTER (WHERE media_type = 'movie')::int as movies_watched,
            COUNT(*) FILTER (WHERE media_type = 'episode')::int as episodes_watched,
            COALESCE(AVG(actual_watch_time_seconds) / 60, 0)::numeric(10,1)::float8 as avg_session_minutes
        FROM watch_history
        WHERE user_id = ${userId}
    `,
    (row) => ({
        total_sessions: row.total_sessions as number,
        total_watch_hours: row.total_watch_hours as number,
        movies_watched: row.movies_watched as number,
        episodes_watched: row.episodes_watched as number,
        avg_session_minutes: row.avg_session_minutes as number,
    }),
);

/**
 * Get user's watch statistics within a timeframe.
 */
export const getUserWatchStatsInTimeframe = defineScalarQuery<
    { userId: UserId; days: number },
    {
        total_sessions: number;
        total_watch_hours: number;
        movies_watched: number;
        episodes_watched: number;
    }
>(
    'getUserWatchStatsInTimeframe',
    (sql, { userId, days }) => sql`
        SELECT
            COUNT(*)::int as total_sessions,
            COALESCE(SUM(actual_watch_time_seconds) / 3600, 0)::numeric(10,1)::float8 as total_watch_hours,
            COUNT(*) FILTER (WHERE media_type = 'movie')::int as movies_watched,
            COUNT(*) FILTER (WHERE media_type = 'episode')::int as episodes_watched
        FROM watch_history
        WHERE user_id = ${userId}
          AND session_start_time >= NOW() - (${days} || ' days')::interval
    `,
    (row) => ({
        total_sessions: row.total_sessions as number,
        total_watch_hours: row.total_watch_hours as number,
        movies_watched: row.movies_watched as number,
        episodes_watched: row.episodes_watched as number,
    }),
);

/**
 * Get total watch history count for a user.
 */
export const getUserWatchCount = defineScalarQuery<{ userId: UserId }, number>(
    'getUserWatchCount',
    (sql, { userId }) => sql`
        SELECT COUNT(*)::int as count
        FROM watch_history
        WHERE user_id = ${userId}
    `,
    (row) => row.count as number,
);

/**
 * Check whether a user has any watch activity (a completed session) after a
 * given timestamp. Used to detect stale recommendation/next-up caches.
 */
export const hasUserWatchActivitySince = defineExistsQuery<{
    userId: UserId;
    since: Date;
}>(
    'hasUserWatchActivitySince',
    (sql, { userId, since }) => sql`
    SELECT 1
    FROM watch_history
    WHERE user_id = ${userId}
      AND session_end_time > ${since}
    LIMIT 1
`,
);

// =============================================================================
// Playback Quality Queries (Admin)
// =============================================================================

/**
 * Get playback quality distribution for admin analytics.
 * Note: resolution is computed from resolution_width, bitrate is in bits not bps
 */
export const getPlaybackQualityStats = defineQuery<{ days: number }, PlaybackQualityRow>(
    'getPlaybackQualityStats',
    (sql, { days }) => sql`
        SELECT
            CASE
                WHEN vs.resolution_width IS NOT NULL
                THEN vs.resolution_width::text
                ELSE NULL
            END as resolution,
            CASE
                WHEN vs.bitrate_bps IS NOT NULL THEN (vs.bitrate_bps / 1000)::int
                ELSE NULL
            END as bitrate_kbps,
            COUNT(*)::int as session_count,
            COALESCE(AVG(vs.actual_watch_time_seconds) / 60, 0)::numeric(10,1)::float8 as avg_watch_minutes
        FROM watch_history vs
        WHERE vs.session_start_time >= NOW() - (${days} || ' days')::interval
        GROUP BY vs.resolution_width, vs.bitrate_bps
        ORDER BY session_count DESC
        LIMIT 100
    `,
);

/**
 * Get transcoding percentage over time.
 * Note: is_transcoding was dropped from watch_history (always NULL/false).
 * This now returns 0% transcoded / 100% direct play based on session count.
 */
export const getTranscodingPercentage = defineScalarQuery<
    { days: number },
    { transcoded_pct: number; direct_play_pct: number; total_sessions: number }
>(
    'getTranscodingPercentage',
    // Transcoding tracking columns were removed (never populated).
    // Returns hardcoded zeros until proper transcoding metrics are added.
    (sql, _params) => sql`
        SELECT
            0::numeric(5,1) as transcoded_pct,
            100::numeric(5,1) as direct_play_pct,
            0 as total_sessions
    `,
    (row) => ({
        transcoded_pct: Number(row.transcoded_pct),
        direct_play_pct: Number(row.direct_play_pct),
        total_sessions: Number(row.total_sessions),
    }),
);

// =============================================================================
// Complex Aggregation Queries
// =============================================================================

/**
 * Get users who have watched specific content recently (for "also watched" features).
 * @param mediaIds - Array of internal media_items UUIDs
 */
export async function getUsersWhoWatched(
    sql: postgres.Sql,
    mediaIds: string[],
    days: number,
    minWatchSeconds: number = 300,
): Promise<Map<string, string[]>> {
    if (mediaIds.length === 0) {
        return new Map();
    }

    const rows = await sql<{ media_id: string; user_id: string }[]>`
        SELECT DISTINCT media_id::text as media_id, user_id
        FROM watch_history
        WHERE media_id = ANY(${mediaIds}::uuid[])
          AND session_start_time >= NOW() - (${days} || ' days')::interval
          AND COALESCE(actual_watch_time_seconds, 0) >= ${minWatchSeconds}
        LIMIT 10000
    `;

    const result = new Map<string, string[]>();
    for (const row of rows) {
        const users = result.get(row.media_id) || [];
        users.push(row.user_id);
        result.set(row.media_id, users);
    }
    return result;
}
