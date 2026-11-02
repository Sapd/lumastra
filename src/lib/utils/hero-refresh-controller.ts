// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hero Section Refresh Controller
 *
 * Manages the state machine for hero section caching with stale-while-revalidate pattern.
 * Extracted from +page.svelte for testability.
 */

export interface HeroRefreshState {
    /** Whether a refresh is currently in progress */
    refreshInProgress: boolean;
    /** Timestamp of last successful refresh */
    lastRefreshTime: number;
    /** Whether the initial fetch has completed */
    initialFetchComplete: boolean;
}

export interface HeroRefreshConfig {
    /** Maximum age of cache before skipping validation (ms) */
    skipValidationThreshold: number;
}

export const DEFAULT_CONFIG: HeroRefreshConfig = {
    skipValidationThreshold: 30000,
};

export function createInitialState(): HeroRefreshState {
    return {
        refreshInProgress: false,
        lastRefreshTime: 0,
        initialFetchComplete: false,
    };
}

/**
 * Determines what action to take after initial fetch completes.
 */
export type PostFetchAction =
    | { type: 'skip_validation'; reason: 'fresh_data' }
    | { type: 'skip_validation'; reason: 'recent_cache' }
    | { type: 'validate' };

export function handleInitialFetchComplete(
    state: HeroRefreshState,
    result: { nextUpCached: boolean; nextUpCachedAt?: number },
    config: HeroRefreshConfig = DEFAULT_CONFIG,
): { action: PostFetchAction; newState: Partial<HeroRefreshState> } {
    const baseNewState: Partial<HeroRefreshState> = {
        refreshInProgress: false,
        initialFetchComplete: true,
    };

    // Fresh data (not from cache) - no validation needed
    if (!result.nextUpCached) {
        return {
            action: { type: 'skip_validation', reason: 'fresh_data' },
            newState: { ...baseNewState, lastRefreshTime: Date.now() },
        };
    }

    // Cache is very recent - skip validation
    if (
        result.nextUpCachedAt &&
        Date.now() - result.nextUpCachedAt < config.skipValidationThreshold
    ) {
        return {
            action: { type: 'skip_validation', reason: 'recent_cache' },
            newState: { ...baseNewState, lastRefreshTime: Date.now() },
        };
    }

    // Need to validate cache freshness
    return {
        action: { type: 'validate' },
        newState: baseNewState,
    };
}

/**
 * Determines what action to take after validation completes.
 */
export type PostValidationAction = { type: 'refresh' } | { type: 'no_refresh' };

export function handleValidationComplete(isStale: boolean): {
    action: PostValidationAction;
    newState: Partial<HeroRefreshState>;
} {
    if (isStale) {
        // Validation-triggered refresh bypasses cooldown
        // (cooldown is only for user-triggered refreshes)
        return {
            action: { type: 'refresh' },
            newState: { refreshInProgress: true },
        };
    }

    return {
        action: { type: 'no_refresh' },
        newState: { lastRefreshTime: Date.now() },
    };
}

/**
 * State update after a refresh completes (success or failure).
 */
export function handleRefreshComplete(success: boolean): Partial<HeroRefreshState> {
    return {
        refreshInProgress: false,
        ...(success ? { lastRefreshTime: Date.now() } : {}),
    };
}
