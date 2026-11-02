// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Time and duration formatting utilities
 * Centralized functions for formatting durations, dates, and relative times
 */

import * as m from '$lib/paraglide/messages';

/**
 * Format seconds into HH:MM:SS or MM:SS format
 * @param seconds - Number of seconds to format
 * @returns Formatted time string (e.g., "1:23:45" or "23:45")
 */
export function formatDuration(seconds: number): string {
    if (!seconds || seconds < 0) return m.time_zero();

    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Convert seconds to hours and minutes (e.g., "2h 34m")
 * @param seconds - Number of seconds
 * @returns Formatted string like "2h 34m" or "34m"
 */
export function formatDurationHoursMinutes(seconds: number): string {
    if (!seconds || seconds < 0) return m.time_zero_minutes();

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0 && minutes > 0) {
        return `${m.time_hours_abbr({ hours })} ${m.time_minutes_abbr({ minutes })}`;
    } else if (hours > 0) {
        return m.time_hours_abbr({ hours });
    } else {
        return m.time_minutes_abbr({ minutes });
    }
}

/**
 * Format a date/time string to time only (HH:MM format)
 * @param dateString - ISO date string or Date object
 * @param locale - Locale for formatting (default: 'de-DE')
 * @returns Formatted time string (e.g., "23:45")
 */
export function formatTimeOnly(dateString: string | Date, locale: string = 'de-DE'): string {
    const date = new Date(dateString);

    if (isNaN(date.getTime())) {
        console.error('[time-formatting] Invalid date:', dateString);
        return m.time_invalid();
    }

    return date.toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Format a date/time string to full date and time
 * @param dateString - ISO date string or Date object
 * @param locale - Locale for formatting (default: 'de-DE')
 * @returns Formatted date and time string
 */
export function formatDateTime(dateString: string | Date, locale: string = 'de-DE'): string {
    const date = new Date(dateString);

    if (isNaN(date.getTime())) {
        console.error('[time-formatting] Invalid date:', dateString);
        return m.time_invalid_date();
    }

    return date.toLocaleString(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Format a date to relative time (e.g., "5m ago", "2h ago", "3d ago")
 * @param dateString - ISO date string or Date object
 * @returns Relative time string
 */
export function formatRelativeTime(dateString: string | Date): string {
    const date = new Date(dateString);

    if (isNaN(date.getTime())) {
        console.error('[time-formatting] Invalid date for relative time:', dateString);
        return '?';
    }

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffMins < 1) return m.time_just_now();
    if (diffMins < 60) return m.time_minutes_ago_short({ count: diffMins });

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return m.time_hours_ago_short({ count: diffHours });

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return m.time_days_ago_short({ count: diffDays });

    const diffWeeks = Math.floor(diffDays / 7);
    if (diffDays < 30) return m.time_weeks_ago_short({ count: diffWeeks });

    const diffMonths = Math.floor(diffDays / 30);
    if (diffDays < 365) return m.time_months_ago_short({ count: diffMonths });

    const diffYears = Math.floor(diffDays / 365);
    return m.time_years_ago_short({ count: diffYears });
}

/**
 * Format seconds to a human-readable string (e.g., "2 hours 34 minutes")
 * @param seconds - Number of seconds
 * @param short - Use short format (h/m instead of hours/minutes)
 * @returns Formatted string
 */
export function formatDurationLong(seconds: number, short: boolean = false): string {
    if (!seconds || seconds < 0) return m.time_zero_minutes_long();

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];

    if (hours > 0) {
        parts.push(
            short
                ? m.time_hours_abbr({ hours })
                : hours === 1
                  ? m.time_hours_long_one({ count: hours })
                  : m.time_hours_long_many({ count: hours }),
        );
    }
    if (minutes > 0) {
        parts.push(
            short
                ? m.time_minutes_abbr({ minutes })
                : minutes === 1
                  ? m.time_minutes_long_one({ count: minutes })
                  : m.time_minutes_long_many({ count: minutes }),
        );
    }

    return parts.join(' ') || m.time_zero_minutes_long();
}

/**
 * Format a progress percentage with completion time
 * @param currentSeconds - Current position in seconds
 * @param totalSeconds - Total duration in seconds
 * @returns Object with formatted current time, total time, and percentage
 */
export function formatProgress(currentSeconds: number, totalSeconds: number) {
    const percentage = totalSeconds > 0 ? (currentSeconds / totalSeconds) * 100 : 0;

    return {
        current: formatDuration(currentSeconds),
        total: formatDuration(totalSeconds),
        percentage: Math.round(percentage),
        percentageDecimal: percentage,
    };
}

/**
 * Calculate and format time remaining
 * @param currentSeconds - Current position in seconds
 * @param totalSeconds - Total duration in seconds
 * @returns Formatted time remaining (e.g., "1h 23m left")
 */
export function formatTimeRemaining(currentSeconds: number, totalSeconds: number): string {
    const remaining = Math.max(0, totalSeconds - currentSeconds);
    return m.time_remaining_left({
        time: formatDurationHoursMinutes(remaining),
    });
}

/**
 * Convert a Jellyfin `RunTimeTicks` value (100-nanosecond units) to SECONDS.
 *
 * Every `duration` field handed to the media modal is in seconds — the
 * enrichment path builds it as `runtime * 60` from TMDB minutes, and
 * `convertSecondsToHoursAndMinutes` renders it as seconds. Episode-modal
 * openers used to divide ticks by an extra 60, handing MINUTES into that
 * seconds-typed prop; since `mergeModalValue` prefers the caller's value over
 * the enriched one, a 45-minute episode rendered as 45 *seconds* -> "00m".
 *
 * @param ticks - Jellyfin RunTimeTicks, or null/undefined when unknown
 * @returns Whole seconds, or `undefined` when there is no usable runtime (so
 *          callers fall through to the enriched value instead of pinning a 0)
 */
export function runTimeTicksToSeconds(ticks: number | null | undefined): number | undefined {
    if (!ticks || ticks <= 0) return undefined;
    return Math.round(ticks / 10_000_000);
}
