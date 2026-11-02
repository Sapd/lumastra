// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch History Filter Utilities
 *
 * Helper functions for building time-based and watch-time filters
 * for watch history queries.
 *
 * @module filters/watch-history
 */

/**
 * Timeframe type for watch history queries.
 */
export type Timeframe = 'AllTime' | 'LastWeek' | 'LastMonth' | 'LastYear';

/**
 * Convert timeframe to number of days for database queries.
 *
 * @param timeframe - Time period string
 * @returns Number of days
 *
 * @example
 * const days = timeframeToDays('LastMonth'); // 30
 * const interval = `NOW() - INTERVAL '1 day' * ${days}`;
 */
export function timeframeToDays(timeframe: Timeframe): number {
    switch (timeframe) {
        case 'LastWeek':
            return 7;
        case 'LastMonth':
            return 30;
        case 'LastYear':
            return 365;
        default: // AllTime
            return 3650; // ~10 years, effectively all time
    }
}

/**
 * Build a time window filter for watch history.
 *
 * @param days - Number of days to look back
 * @param column - Column to filter on (default: 'vs.session_start_time')
 * @returns SQL WHERE clause fragment
 *
 * @example
 * const filter = buildTimeWindowFilter(30);
 * // Returns: "vs.session_start_time >= NOW() - INTERVAL '30 days'"
 */
export function buildTimeWindowFilter(
    days: number,
    column: string = 'vs.session_start_time',
): string {
    return `${column} >= NOW() - INTERVAL '${days} days'`;
}

/**
 * Build minimum watch time filter in seconds.
 *
 * @param minMinutes - Minimum watch time in minutes
 * @param column - Column to filter on (default: 'vs.actual_watch_time_seconds')
 * @returns SQL WHERE clause fragment
 *
 * @example
 * const filter = buildMinWatchTimeFilter(5);
 * // Returns: "COALESCE(vs.actual_watch_time_seconds, 0) >= 300"
 */
export function buildMinWatchTimeFilter(
    minMinutes: number,
    column: string = 'vs.actual_watch_time_seconds',
): string {
    const minSeconds = minMinutes * 60;
    return `COALESCE(${column}, 0) >= ${minSeconds}`;
}

/**
 * Build a timeframe filter from a Timeframe type.
 *
 * @param timeframe - Timeframe enum value
 * @param column - Column to filter on (default: 'vs.session_start_time')
 * @returns SQL WHERE clause fragment
 *
 * @example
 * const filter = buildTimeframeFilter('LastMonth');
 * // Returns: "vs.session_start_time >= NOW() - INTERVAL '30 days'"
 */
export function buildTimeframeFilter(
    timeframe: Timeframe,
    column: string = 'vs.session_start_time',
): string {
    const days = timeframeToDays(timeframe);
    return buildTimeWindowFilter(days, column);
}

/**
 * Build a completion percentage filter.
 *
 * @param minPercentage - Minimum completion percentage (0-100)
 * @param column - Column to filter on (default: 'vs.completion_percentage')
 * @returns SQL WHERE clause fragment
 *
 * @example
 * const filter = buildCompletionFilter(75);
 * // Returns: "COALESCE(vs.completion_percentage, 0) >= 75"
 */
export function buildCompletionFilter(
    minPercentage: number,
    column: string = 'vs.completion_percentage',
): string {
    return `COALESCE(${column}, 0) >= ${minPercentage}`;
}
