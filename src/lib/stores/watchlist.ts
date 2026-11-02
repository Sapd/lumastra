// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable } from 'svelte/store';
import type { ExternalIds } from '$lib/types/api-common';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers';

export interface WatchlistItem {
    /** External IDs from various providers */
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title?: string;
    overview?: string;
    rating?: string | number;
    criticRating?: number;
    canRequest?: boolean;
    isAvailable?: boolean;
    availabilitySource?: string;
    savedAt: string | undefined;
    // MDBList ratings (camelCase)
    letterboxdRating?: number | null;
    letterboxdVotes?: number | null;
    rtCritic?: number | null;
    rtAudience?: number | null;
    mdblistScore?: number | null;
    traktScore?: number | null;
    malScore?: number | null;
}

/**
 * Request body for POST /api/ai/save-movie
 */
export interface SaveMovieRequest {
    /** External IDs from various providers */
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    overview?: string;
    rating?: number;
    criticRating?: number;
    canRequest?: boolean;
    isAvailable?: boolean;
    availabilitySource?: string;
}

/**
 * Request body for DELETE /api/ai/save-movie
 */
export interface RemoveMovieRequest {
    /** External IDs from various providers */
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
}

// Store for watchlist items
export const watchlistItems = writable<WatchlistItem[]>([]);

// Store for managing watchlist state
// Start with loading: true so SSR shows loading spinner instead of "database not available"
export const watchlistState = writable({
    loading: true,
    error: '',
    isDatabaseAvailable: false,
});

// Function to add item immediately to store
export function addToWatchlistStore(item: WatchlistItem) {
    // Ensure database is marked as available when adding items
    // (if we can add, the database must be working)
    watchlistState.update((state) => {
        if (!state.isDatabaseAvailable) {
            return { ...state, isDatabaseAvailable: true, error: '' };
        }
        return state;
    });

    watchlistItems.update((items) => {
        // Check if item already exists using composite key (handles TMDB ID collisions)
        const newKey = mediaCompositeKey(item.externalIds, item.mediaType);
        const exists = items.some(
            (existing) => mediaCompositeKey(existing.externalIds, existing.mediaType) === newKey,
        );
        if (!exists) {
            return [item, ...items]; // Add to beginning for "recently added" feel
        }
        return items;
    });
}

// Function to remove item from store
// Uses externalIds for proper composite key handling
export function removeFromWatchlistStore(externalIds: ExternalIds, mediaType: 'movie' | 'tv') {
    const keyToRemove = mediaCompositeKey(externalIds, mediaType);
    watchlistItems.update((items) => {
        return items.filter(
            (item) => mediaCompositeKey(item.externalIds, item.mediaType) !== keyToRemove,
        );
    });
}

// Function to load items into store
export function setWatchlistItems(items: WatchlistItem[]) {
    watchlistItems.set(items);
}

// Function to update watchlist state
export function setWatchlistState(
    state: Partial<{
        loading: boolean;
        error: string;
        isDatabaseAvailable: boolean;
    }>,
) {
    watchlistState.update((current) => ({ ...current, ...state }));
}
