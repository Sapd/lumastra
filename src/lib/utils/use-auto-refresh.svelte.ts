// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { untrack } from 'svelte';

/** Reactive controls returned by {@link useAutoRefresh}. Backward-compatible: callers
 *  that ignore the return value behave exactly as before. */
export interface AutoRefreshControls {
    /** Trigger an out-of-band refresh now (coalesced with an in-flight call). */
    refresh: () => void;
    /** Epoch ms of the last successful refresh, or null until the first completes. */
    readonly lastUpdatedAt: number | null;
    /** True while a refresh is in flight (drives a spinner / disabled refresh button). */
    readonly refreshing: boolean;
}

/**
 * Auto-refresh utility for admin pages.
 * Calls `fn` immediately, then every `intervalMs` milliseconds.
 * Automatically cleans up on component destroy.
 *
 * Handles async functions safely:
 * - Errors are caught and logged (interval continues)
 * - Overlapping calls are skipped (if previous call is still running)
 *
 * Returns reactive controls ({@link AutoRefreshControls}) for surfaces that want a
 * manual refresh button and a "last updated" indicator. The return value is purely
 * additive — existing callers that use it as a statement are unaffected.
 */
export function useAutoRefresh(
    fn: () => void | Promise<void>,
    intervalMs: number,
): AutoRefreshControls {
    let running = $state(false);
    let lastUpdatedAt = $state<number | null>(null);

    async function safeFn(): Promise<void> {
        if (running) return;
        running = true;
        try {
            await fn();
            lastUpdatedAt = Date.now();
        } catch (err) {
            console.error('[useAutoRefresh] callback error:', err);
        } finally {
            running = false;
        }
    }

    $effect(() => {
        // `safeFn` reads AND writes the `running` $state (the overlap guard).
        // Calling it directly inside the effect would make the effect TRACK
        // `running`, so every flip (false→true→false around each fetch)
        // re-runs the effect and fires another fetch immediately — a
        // network-rate refetch loop (observed hammering /api/admin/cluster →
        // 429). `untrack` severs that subscription: the effect depends on
        // nothing reactive, so it runs once on mount and only the interval
        // drives subsequent refreshes.
        void untrack(() => safeFn());
        const interval = setInterval(() => void untrack(() => safeFn()), intervalMs);
        return () => clearInterval(interval);
    });

    return {
        refresh: () => void safeFn(),
        get lastUpdatedAt(): number | null {
            return lastUpdatedAt;
        },
        get refreshing(): boolean {
            return running;
        },
    };
}
