// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channel View Utilities
 *
 * Handles channel view preferences and live TV program tracking.
 * Extracted from browse/+page.svelte for reusability.
 */

import { browser } from '$app/environment';

/** Channel view types */
export type ChannelView = 'grid' | 'guide';

/** Storage key for channel view preference */
export const CHANNEL_VIEW_STORAGE_KEY = 'browse-channel-view-preference';

/** Default program tick interval (ms) - update progress every 5 seconds */
export const PROGRAM_TICK_MS = 5000;

/** Default program refresh interval (ms) - refresh data every 2 minutes */
export const PROGRAM_REFRESH_MS = 120000;

/**
 * Save channel view preference to localStorage
 */
export function saveChannelViewPreference(view: ChannelView): void {
    if (!browser) return;
    localStorage.setItem(CHANNEL_VIEW_STORAGE_KEY, view);
}

/**
 * Load channel view preference from localStorage
 */
export function loadChannelViewPreference(): ChannelView {
    if (!browser) return 'grid';
    const stored = localStorage.getItem(CHANNEL_VIEW_STORAGE_KEY);
    if (stored === 'grid' || stored === 'guide') {
        return stored;
    }
    return 'grid';
}

/**
 * Program info for a channel
 */
export interface ChannelProgram {
    name: string;
    startTime: string;
    endTime: string;
    progress?: number;
}

/**
 * Calculate program progress as a percentage (0-100)
 */
export function calculateProgramProgress(
    startTime: string | Date,
    endTime: string | Date,
    now: Date = new Date(),
): number {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const current = now.getTime();

    if (current < start) return 0;
    if (current >= end) return 100;

    const duration = end - start;
    const elapsed = current - start;

    return Math.round((elapsed / duration) * 100);
}

/**
 * Check if a program is currently airing
 */
export function isProgramLive(
    startTime: string | Date,
    endTime: string | Date,
    now: Date = new Date(),
): boolean {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const current = now.getTime();

    return current >= start && current < end;
}

/**
 * Format remaining time for a program
 */
export function formatRemainingTime(endTime: string | Date, now: Date = new Date()): string {
    const end = new Date(endTime).getTime();
    const current = now.getTime();

    const remainingMs = end - current;
    if (remainingMs <= 0) return '0m';

    const minutes = Math.floor(remainingMs / 60000);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Create a program tick controller for live TV progress updates
 */
export function createProgramTickController(
    onTick: () => void,
    tickIntervalMs: number = PROGRAM_TICK_MS,
) {
    let tickInterval: ReturnType<typeof setInterval> | null = null;
    let tick = 0;

    /**
     * Start the tick interval
     */
    function start(): void {
        if (tickInterval) return;
        tickInterval = setInterval(() => {
            tick++;
            onTick();
        }, tickIntervalMs);
    }

    /**
     * Stop the tick interval
     */
    function stop(): void {
        if (tickInterval) {
            clearInterval(tickInterval);
            tickInterval = null;
        }
    }

    /**
     * Get current tick count
     */
    function getTick(): number {
        return tick;
    }

    /**
     * Reset tick count
     */
    function reset(): void {
        tick = 0;
    }

    return {
        start,
        stop,
        getTick,
        reset,
    };
}

/**
 * Create a program refresh controller for periodic data refresh
 */
export function createProgramRefreshController(
    onRefresh: () => void | Promise<void>,
    refreshIntervalMs: number = PROGRAM_REFRESH_MS,
) {
    let refreshInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Start the refresh interval
     */
    function start(): void {
        if (refreshInterval) return;
        refreshInterval = setInterval(() => {
            void Promise.resolve(onRefresh());
        }, refreshIntervalMs);
    }

    /**
     * Stop the refresh interval
     */
    function stop(): void {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    }

    /**
     * Trigger an immediate refresh
     */
    function refreshNow(): void {
        void Promise.resolve(onRefresh());
    }

    return {
        start,
        stop,
        refreshNow,
    };
}
