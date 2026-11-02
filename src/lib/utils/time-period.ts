// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Time Period Utilities
 *
 * Centralized helpers for common date/time calculations.
 * Improves code readability and reduces magic numbers.
 */

// Time constants in milliseconds
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

// Time constants in seconds (for database intervals)
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
export const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

/**
 * Get a Date representing a number of days ago from now.
 *
 * @example
 * const weekAgo = daysAgo(7);
 * const yesterday = daysAgo(1);
 */
export function daysAgo(days: number, from: Date = new Date()): Date {
    return new Date(from.getTime() - days * MS_PER_DAY);
}

/**
 * Get a Date representing a number of hours ago from now.
 *
 * @example
 * const twoHoursAgo = hoursAgo(2);
 */
export function hoursAgo(hours: number, from: Date = new Date()): Date {
    return new Date(from.getTime() - hours * MS_PER_HOUR);
}

/**
 * Get a Date representing a number of minutes ago from now.
 *
 * @example
 * const thirtyMinutesAgo = minutesAgo(30);
 */
export function minutesAgo(minutes: number, from: Date = new Date()): Date {
    return new Date(from.getTime() - minutes * MS_PER_MINUTE);
}

/**
 * Get a Date representing a number of days in the future from now.
 *
 * @example
 * const nextWeek = daysFromNow(7);
 * const tomorrow = daysFromNow(1);
 */
export function daysFromNow(days: number, from: Date = new Date()): Date {
    return new Date(from.getTime() + days * MS_PER_DAY);
}

/**
 * Get a Date representing a number of hours in the future from now.
 *
 * @example
 * const inTwoHours = hoursFromNow(2);
 */
export function hoursFromNow(hours: number, from: Date = new Date()): Date {
    return new Date(from.getTime() + hours * MS_PER_HOUR);
}

/**
 * Get a Date representing a number of minutes in the future from now.
 *
 * @example
 * const inThirtyMinutes = minutesFromNow(30);
 */
export function minutesFromNow(minutes: number, from: Date = new Date()): Date {
    return new Date(from.getTime() + minutes * MS_PER_MINUTE);
}

/**
 * Get the start of the day (midnight) for a given date.
 *
 * @example
 * const todayStart = startOfDay(new Date());
 */
export function startOfDay(date: Date = new Date()): Date {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
}

/**
 * Get the end of the day (23:59:59.999) for a given date.
 *
 * @example
 * const todayEnd = endOfDay(new Date());
 */
export function endOfDay(date: Date = new Date()): Date {
    const result = new Date(date);
    result.setHours(23, 59, 59, 999);
    return result;
}

/**
 * Get the start of the week (Monday midnight) for a given date.
 *
 * @example
 * const weekStart = startOfWeek(new Date());
 */
export function startOfWeek(date: Date = new Date()): Date {
    const result = new Date(date);
    const day = result.getDay();
    const diff = day === 0 ? -6 : 1 - day; // Adjust for Monday start
    result.setDate(result.getDate() + diff);
    result.setHours(0, 0, 0, 0);
    return result;
}

/**
 * Get the start of the month for a given date.
 *
 * @example
 * const monthStart = startOfMonth(new Date());
 */
export function startOfMonth(date: Date = new Date()): Date {
    const result = new Date(date);
    result.setDate(1);
    result.setHours(0, 0, 0, 0);
    return result;
}

/**
 * Check if a date is within the last N days.
 *
 * @example
 * if (isWithinDays(item.created_at, 7)) {
 *   // Item is from the last week
 * }
 */
export function isWithinDays(date: Date, days: number): boolean {
    return date.getTime() >= daysAgo(days).getTime();
}

/**
 * Check if a date is within the last N hours.
 *
 * @example
 * if (isWithinHours(session.lastActive, 2)) {
 *   // Session was active in the last 2 hours
 * }
 */
export function isWithinHours(date: Date, hours: number): boolean {
    return date.getTime() >= hoursAgo(hours).getTime();
}

/**
 * Check if a date is in the past.
 *
 * @example
 * if (isExpired(token.expiresAt)) {
 *   return unauthorized();
 * }
 */
export function isExpired(date: Date): boolean {
    return date.getTime() < Date.now();
}

/**
 * Check if a date is in the future.
 *
 * @example
 * if (isInFuture(event.startTime)) {
 *   // Event hasn't started yet
 * }
 */
export function isInFuture(date: Date): boolean {
    return date.getTime() > Date.now();
}

/**
 * Get the difference between two dates in days.
 *
 * @example
 * const daysSinceCreated = diffInDays(new Date(), item.created_at);
 */
export function diffInDays(date1: Date, date2: Date): number {
    return Math.floor(Math.abs(date1.getTime() - date2.getTime()) / MS_PER_DAY);
}

/**
 * Get the difference between two dates in hours.
 *
 * @example
 * const hoursSinceLogin = diffInHours(new Date(), user.lastLogin);
 */
export function diffInHours(date1: Date, date2: Date): number {
    return Math.floor(Math.abs(date1.getTime() - date2.getTime()) / MS_PER_HOUR);
}

/**
 * Get the difference between two dates in minutes.
 *
 * @example
 * const minutesSinceUpdate = diffInMinutes(new Date(), lastUpdate);
 */
export function diffInMinutes(date1: Date, date2: Date): number {
    return Math.floor(Math.abs(date1.getTime() - date2.getTime()) / MS_PER_MINUTE);
}

// =============================================================================
// Daypart helpers
// =============================================================================

/**
 * Named daypart categories used for hero rotation seeding.
 */
export type Daypart = 'morning' | 'afternoon' | 'evening' | 'late-night';

/**
 * Map a local hour (0–23) to a Daypart name.
 *
 * Boundaries:
 *  - morning    5–11
 *  - afternoon 12–17
 *  - evening   18–22
 *  - late-night 23–4 (wraps through midnight)
 */
export function daypartOf(date: Date): Daypart {
    const hour = date.getHours();
    if (hour >= 5 && hour <= 11) return 'morning';
    if (hour >= 12 && hour <= 17) return 'afternoon';
    if (hour >= 18 && hour <= 22) return 'evening';
    return 'late-night';
}

/**
 * Return a numeric index (0–3) for the daypart, suitable as a seed component.
 *
 * Mapping: morning=0, afternoon=1, evening=2, late-night=3
 */
export function daypartIndex(date: Date): number {
    const dp = daypartOf(date);
    const MAP: Record<Daypart, number> = {
        morning: 0,
        afternoon: 1,
        evening: 2,
        'late-night': 3,
    };
    return MAP[dp];
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @example
 * formatDuration(3661000); // "1h 1m 1s"
 * formatDuration(60000);   // "1m 0s"
 */
export function formatDuration(ms: number): string {
    const hours = Math.floor(ms / MS_PER_HOUR);
    const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}
