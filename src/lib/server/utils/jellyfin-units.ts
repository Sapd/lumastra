// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin time unit conversion utilities.
 * Jellyfin uses "ticks" — 100-nanosecond intervals (10,000 ticks = 1 ms, 10,000,000 ticks = 1 second).
 */

/** Ticks per millisecond */
export const TICKS_PER_MS = 10_000;

/** Ticks per second */
export const TICKS_PER_SECOND = 10_000_000;

/** Convert Jellyfin ticks to milliseconds */
export function ticksToMs(ticks: number | null | undefined): number {
    return Math.floor((ticks ?? 0) / TICKS_PER_MS);
}

/** Convert Jellyfin ticks to seconds */
export function ticksToSeconds(ticks: number | null | undefined): number {
    return Math.floor((ticks ?? 0) / TICKS_PER_SECOND);
}

/** Ticks per minute */
export const TICKS_PER_MINUTE = 600_000_000;

/** Convert Jellyfin ticks to minutes (rounded) */
export function ticksToMinutes(ticks: number | null | undefined): number | undefined {
    const t = ticks ?? 0;
    return t > 0 ? Math.round(t / TICKS_PER_MINUTE) : undefined;
}

/**
 * Episode ordering multiplier.
 * Used to create a single sortable number from season + episode: `season * EPISODE_ORDER_MULTIPLIER + episode`.
 * Supports up to 9,999 episodes per season.
 */
export const EPISODE_ORDER_MULTIPLIER = 10_000;

/** Create a sortable episode order key from season and episode numbers */
export function episodeOrderKey(seasonNumber: number, episodeNumber: number): number {
    return seasonNumber * EPISODE_ORDER_MULTIPLIER + episodeNumber;
}
