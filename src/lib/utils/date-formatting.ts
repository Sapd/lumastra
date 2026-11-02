// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Date formatting utilities for consistent date display across components
 */

import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';

/**
 * Helper to check if a date is valid
 */
function isValidDate(date: Date): boolean {
    return date instanceof Date && !Number.isNaN(date.getTime());
}

/**
 * Formats a date string with relative time indicators (Today, Tomorrow, etc.)
 * @param dateString - ISO date string
 * @returns Formatted date string in current locale
 *
 * @example
 * formatDate('2025-11-15') // "Today"
 * formatDate('2025-11-16') // "Tomorrow"
 * formatDate('2025-11-18') // "in 3 days"
 * formatDate('2025-12-01') // "Sun, Dec 1"
 */
export function formatDate(dateString?: string): string {
    if (!dateString) return m.date_tba();

    const date = new Date(dateString);
    if (!isValidDate(date)) return m.date_tba();

    const now = new Date();
    const diffTime = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return m.calendar_today();
    if (diffDays === 1) return m.calendar_tomorrow();
    if (diffDays < 7) return m.date_in_days({ count: diffDays });

    return date.toLocaleDateString(getLocale(), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
    });
}

/**
 * Gets the relative days until a given date
 * @param dateString - ISO date string
 * @returns Relative time string (e.g., "Tomorrow", "in 3 days", "2 days ago")
 *
 * @example
 * getDaysUntil('2025-11-16') // "Tomorrow"
 * getDaysUntil('2025-11-18') // "in 3 days"
 * getDaysUntil('2025-11-13') // "2 days ago"
 */
export function getDaysUntil(dateString?: string): string {
    if (!dateString) return '';

    const date = new Date(dateString);
    if (!isValidDate(date)) return '';

    const now = new Date();

    // Use date only comparison to avoid timezone issues
    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const nowOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const diffTime = dateOnly.getTime() - nowOnly.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)); // Use Math.round to avoid floating point issues

    if (diffDays === 0) return ''; // Return empty for today - will show formatted date instead
    if (diffDays === 1) return m.calendar_tomorrow();
    if (diffDays === -1) return m.date_yesterday();
    if (diffDays < -1) return m.date_days_ago({ count: Math.abs(diffDays) });
    if (diffDays > 1) return m.date_in_days({ count: diffDays });

    return '';
}

/**
 * Short localized weekday for a date (e.g. "Fri" / "Fr").
 * @param dateString - ISO date string
 * @returns Weekday abbreviation, or '' when the date is missing/invalid.
 *
 * @example
 * getWeekdayShort('2026-07-13') // "Mon"
 */
export function getWeekdayShort(dateString?: string): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (!isValidDate(date)) return '';
    return date.toLocaleDateString(getLocale(), { weekday: 'short' });
}

/**
 * Checks if an episode is considered "recent" (aired within the last 7 days)
 * @param dateString - ISO date string
 * @returns True if the episode aired in the last 7 days
 */
export function isRecentEpisode(dateString?: string): boolean {
    if (!dateString) return false;

    const airDate = new Date(dateString);
    if (!isValidDate(airDate)) return false;

    const now = new Date();
    const diffTime = now.getTime() - airDate.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    // Consider recent if aired in the last 7 days
    return diffDays >= 0 && diffDays <= 7;
}

/**
 * Calculates the number of days between two dates
 * @param date1 - First date
 * @param date2 - Second date
 * @returns Number of days difference
 */
export function daysBetween(date1: Date, date2: Date): number {
    const diffTime = date2.getTime() - date1.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}
