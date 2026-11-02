// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Temporal display formatting for LiveTV program search results.
 *
 * Formats human-readable time context strings based on program temporal status.
 * All user-facing strings use paraglide i18n message keys.
 */

import * as m from '$lib/paraglide/messages.js';

/**
 * Returns the appropriate human-readable time context string
 * based on the program's temporal status.
 */
export function formatTemporalContext(
    temporalStatus: string,
    startTime: string,
    endTime: string,
    locale?: string,
    now: Date = new Date(),
): string {
    switch (temporalStatus) {
        case 'live':
            return formatLiveContext(startTime, endTime, now);
        case 'upcoming_today':
            return formatUpcomingContext(startTime, locale, now);
        case 'future':
            return formatFutureContext(startTime, locale, now);
        case 'ended':
            return formatEndedContext(endTime, now);
        default:
            return formatTimeRange(startTime, endTime, locale);
    }
}

/**
 * Format context for live programs.
 * "Ends in 25 min", "Ends in 1 hr 10 min", or "Ends soon"
 */
export function formatLiveContext(
    _startTime: string,
    endTime: string,
    now: Date = new Date(),
): string {
    const endMs = new Date(endTime).getTime();
    if (isNaN(endMs)) {
        return m.temporal_ends_soon();
    }
    const diffMs = endMs - now.getTime();

    if (diffMs <= 60_000) {
        return m.temporal_ends_soon();
    }

    const totalMinutes = Math.ceil(diffMs / 60_000);

    if (totalMinutes >= 60) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (minutes === 0) {
            return m.temporal_ends_in_minutes({ minutes: 60 * hours });
        }
        return m.temporal_ends_in_hours_minutes({
            hours,
            minutes,
        });
    }

    return m.temporal_ends_in_minutes({ minutes: totalMinutes });
}

/**
 * Format context for upcoming_today programs.
 * "In 45 min", "In 2 hr", "Tonight 20:15" (if > 3 hours and after 18:00)
 */
export function formatUpcomingContext(
    startTime: string,
    locale?: string,
    now: Date = new Date(),
): string {
    const startMs = new Date(startTime).getTime();
    const diffMs = startMs - now.getTime();
    const totalMinutes = Math.ceil(diffMs / 60_000);

    if (totalMinutes < 60) {
        return m.temporal_in_minutes({
            minutes: Math.max(1, totalMinutes),
        });
    }

    const hours = Math.round(totalMinutes / 60);

    if (totalMinutes <= 180) {
        return m.temporal_in_hours({ hours });
    }

    // > 3 hours away — show absolute time
    const startDate = new Date(startTime);
    const timeStr = formatLocaleTime(startDate, locale);

    if (startDate.getHours() >= 18) {
        return m.temporal_tonight({ time: timeStr });
    }

    return timeStr;
}

/**
 * Format context for future programs.
 * "Tomorrow 14:30" or "Wed 20:00"
 */
export function formatFutureContext(
    startTime: string,
    locale?: string,
    now: Date = new Date(),
): string {
    const startDate = new Date(startTime);
    const timeStr = formatLocaleTime(startDate, locale);

    if (isTomorrow(startDate, now)) {
        return m.temporal_tomorrow({ time: timeStr });
    }

    // Day name + time for within-week
    const dayName = startDate.toLocaleDateString(locale, {
        weekday: 'short',
    });
    return `${dayName} ${timeStr}`;
}

/**
 * Format context for ended programs.
 * "Ended 5 min ago" or "Ended 2 hr ago"
 */
export function formatEndedContext(endTime: string, now: Date = new Date()): string {
    const endMs = new Date(endTime).getTime();
    if (isNaN(endMs)) {
        return m.temporal_ended_minutes_ago({ minutes: 1 });
    }
    const diffMs = now.getTime() - endMs;
    const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000));

    if (totalMinutes >= 60) {
        const hours = Math.floor(totalMinutes / 60);
        return m.temporal_ended_hours_ago({ hours });
    }

    return m.temporal_ended_minutes_ago({ minutes: totalMinutes });
}

/** Format HH:MM using locale */
function formatLocaleTime(date: Date, locale?: string): string {
    return date.toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** Check if a date is tomorrow relative to now */
function isTomorrow(date: Date, now: Date): boolean {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return (
        date.getFullYear() === tomorrow.getFullYear() &&
        date.getMonth() === tomorrow.getMonth() &&
        date.getDate() === tomorrow.getDate()
    );
}

/** Simple fallback: "HH:MM – HH:MM" */
function formatTimeRange(startTime: string, endTime: string, locale?: string): string {
    return `${formatLocaleTime(new Date(startTime), locale)} – ${formatLocaleTime(new Date(endTime), locale)}`;
}
