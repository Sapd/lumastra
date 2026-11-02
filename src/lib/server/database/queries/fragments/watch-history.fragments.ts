// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch History Query Fragments
 *
 * SQL fragments for watch_history table aggregations and analytics.
 * Use these to build consistent analytics queries across services.
 *
 * Common table alias: watch_history (vs)
 *
 * @module fragments/watch-history
 */

/**
 * SQL fragments for watch_history table aggregations.
 * Use these to build consistent analytics queries across services.
 *
 * Common table: watch_history (vs)
 */
export const WatchHistoryFragments = {
    // =========================================================================
    // AGGREGATION EXPRESSIONS - Use in SELECT clauses
    // =========================================================================

    /**
     * Total watch time in minutes from sessions.
     * Use: SELECT ${WatchHistoryFragments.totalWatchMinutes} as total_minutes
     */
    totalWatchMinutes: `ROUND(SUM(COALESCE(vs.actual_watch_time_seconds, 0)) / 60.0, 1)`,

    /**
     * Total watch time in hours from sessions.
     */
    totalWatchHours: `ROUND(SUM(COALESCE(vs.actual_watch_time_seconds, 0)) / 3600.0, 1)`,

    /**
     * Average watch time per session in minutes.
     */
    avgWatchMinutes: `ROUND(AVG(COALESCE(vs.actual_watch_time_seconds, 0)) / 60.0, 1)`,

    /**
     * Unique viewer count.
     */
    uniqueViewers: `COUNT(DISTINCT vs.user_id)`,

    /**
     * Total session count.
     */
    sessionCount: `COUNT(*)`,

    /**
     * Completed session count.
     */
    completedCount: `COUNT(*) FILTER (WHERE vs.status = 'completed')`,

    /**
     * Completion rate as percentage.
     */
    completionRate: `ROUND(COUNT(*) FILTER (WHERE vs.status = 'completed')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1)`,

    /**
     * Average completion percentage across sessions.
     */
    avgCompletionPct: `ROUND(AVG(COALESCE(vs.completion_percentage, 0))::NUMERIC, 1)`,

    /**
     * Last activity timestamp.
     */
    lastWatched: `MAX(vs.session_start_time)`,

    /**
     * Sessions per viewer (engagement metric).
     */
    sessionsPerViewer: `ROUND(COUNT(*)::NUMERIC / NULLIF(COUNT(DISTINCT vs.user_id), 0), 1)`,

    /**
     * Trending score calculation (viewers * 100 + total minutes).
     * Higher score = more trending.
     */
    trendingScore: `(COUNT(DISTINCT vs.user_id) * 100 + SUM(COALESCE(vs.actual_watch_time_seconds, 0)) / 60)::NUMERIC`,

    // =========================================================================
    // FILTER EXPRESSIONS - Use in WHERE clauses
    // =========================================================================

    /**
     * Filter for movie sessions only.
     * Use: WHERE ${WatchHistoryFragments.movieFilter}
     */
    movieFilter: `vs.media_type = 'movie'`,

    /**
     * Filter for episode sessions only.
     */
    episodeFilter: `vs.media_type = 'episode'`,

    /**
     * Filter for completed sessions only.
     */
    completedFilter: `vs.status = 'completed'`,

    /**
     * Filter for active sessions only.
     */
    activeFilter: `vs.status = 'active'`,

    /**
     * Filter for paused sessions only.
     */
    pausedFilter: `vs.status = 'paused'`,

    /**
     * Minimum watch time filter (5 minutes = 300 seconds).
     * Use: WHERE ${WatchHistoryFragments.minWatchTime5Min}
     */
    minWatchTime5Min: `COALESCE(vs.actual_watch_time_seconds, 0) >= 300`,

    /**
     * Minimum watch time filter (10 minutes = 600 seconds).
     */
    minWatchTime10Min: `COALESCE(vs.actual_watch_time_seconds, 0) >= 600`,

    /**
     * Filter for sessions with series name (TV episodes).
     */
    hasSeriesName: `vs.series_name IS NOT NULL AND vs.series_name != ''`,

    // =========================================================================
    // GROUP BY EXPRESSIONS - Common grouping patterns
    // =========================================================================

    /**
     * Group by media item (for content-level stats).
     */
    groupByMedia: `vs.media_id, vs.title, vs.series_name, vs.year, vs.media_type, vs.source_service`,

    /**
     * Group by series only (for series-level aggregation).
     */
    groupBySeries: `vs.series_name`,

    /**
     * Group by user (for user-level stats).
     */
    groupByUser: `vs.user_id`,

    /**
     * Group by day of week (0=Sunday through 6=Saturday).
     */
    groupByDayOfWeek: `EXTRACT(DOW FROM vs.session_start_time)`,

    /**
     * Group by hour of day (0-23).
     */
    groupByHour: `EXTRACT(HOUR FROM vs.session_start_time)`,

    // =========================================================================
    // COMBINED SELECT EXPRESSIONS - Ready-to-use field groups
    // =========================================================================

    /**
     * Basic content statistics fields.
     * Returns: session_count, unique_viewers, total_minutes, avg_minutes
     */
    basicContentStats: `
        COUNT(*)::INTEGER as session_count,
        COUNT(DISTINCT vs.user_id)::INTEGER as unique_viewers,
        ROUND(SUM(COALESCE(vs.actual_watch_time_seconds, 0)) / 60.0, 1) as total_minutes,
        ROUND(AVG(COALESCE(vs.actual_watch_time_seconds, 0)) / 60.0, 1) as avg_minutes
    `,

    /**
     * Engagement statistics fields.
     * Returns: unique_viewers, total_sessions, sessions_per_viewer, total_hours, avg_minutes_per_session
     */
    engagementStats: `
        COUNT(DISTINCT vs.user_id)::INTEGER as unique_viewers,
        COUNT(*)::INTEGER as total_sessions,
        ROUND(COUNT(*)::NUMERIC / NULLIF(COUNT(DISTINCT vs.user_id), 0), 1) as sessions_per_viewer,
        ROUND(SUM(COALESCE(vs.actual_watch_time_seconds, 0)) / 3600.0, 1) as total_hours,
        ROUND(AVG(COALESCE(vs.actual_watch_time_seconds, 0)) / 60.0, 1) as avg_minutes_per_session
    `,

    /**
     * Completion statistics fields.
     * Returns: completion_count, total_starts, completion_rate_pct, avg_completion_pct
     */
    completionStats: `
        COUNT(*) FILTER (WHERE vs.status = 'completed')::INTEGER as completion_count,
        COUNT(*)::INTEGER as total_starts,
        ROUND(COUNT(*) FILTER (WHERE vs.status = 'completed')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) as completion_rate_pct,
        ROUND(AVG(COALESCE(vs.completion_percentage, 0))::NUMERIC, 1) as avg_completion_pct
    `,

    /**
     * Activity time statistics fields.
     * Returns: day_of_week, session_count, total_minutes
     */
    activityTimeStats: `
        EXTRACT(DOW FROM vs.session_start_time) as day_of_week,
        COUNT(*) as session_count,
        SUM(COALESCE(vs.actual_watch_time_seconds, 0)) / 60 as total_minutes
    `,
} as const;

export default WatchHistoryFragments;
