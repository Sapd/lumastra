// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Utility functions for cache management in the admin UI
 */

import { toasts } from '$lib/stores/toast.store';
import { isRecord } from '$lib/utils/data-extraction';
import * as m from '$lib/paraglide/messages';

/**
 * Generic action handler for cache operations
 * Reduces duplication across clearFilesystemCache, clearStandaloneCache, etc.
 *
 * @param confirmMsg - Confirmation dialog message (empty string to skip confirmation)
 * @param apiEndpoint - API endpoint to call (e.g., '/api/cache-stats?action=clear')
 * @param payload - Request body payload
 * @param successMsg - Success toast message
 * @param errorMsg - Error toast message
 * @param onSuccess - Optional callback after successful operation
 * @returns Promise that resolves to boolean (true if successful)
 */

export async function handleCacheAction(options: {
    confirmMsg: string;
    apiEndpoint: string;
    payload?: unknown;
    successMsg: string;
    errorMsg: string;
    onSuccess?: () => Promise<void>;
}): Promise<boolean> {
    const { confirmMsg, apiEndpoint, payload, successMsg, errorMsg, onSuccess } = options;

    // Show confirmation dialog if message provided
    if (confirmMsg && !confirm(confirmMsg)) {
        return false;
    }

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload ? JSON.stringify(payload) : undefined,
        });

        if (response.ok) {
            const result: unknown = await response.json();
            const responseData = isRecord(result) ? result : {};

            // Handle special success messages with data
            if (typeof responseData.deletedFiles === 'number') {
                toasts.success(
                    m.toast_cleared_files({
                        count: responseData.deletedFiles,
                        size:
                            typeof responseData.freedFormatted === 'string'
                                ? responseData.freedFormatted
                                : '0 B',
                    }),
                );
            } else if (
                typeof responseData.deletedCount === 'number' &&
                responseData.deletedCount > 0
            ) {
                toasts.success(
                    m.toast_cache_action_with_count({
                        message: successMsg,
                        count: responseData.deletedCount,
                    }),
                );
            } else {
                toasts.success(successMsg);
            }

            // Call onSuccess callback if provided
            if (onSuccess) {
                await onSuccess();
            }

            return true;
        } else {
            toasts.error(errorMsg);
            return false;
        }
    } catch (error) {
        console.error('Cache action failed:', error);
        toasts.error(errorMsg);
        return false;
    }
}

/**
 * Format date relative to now
 */
export function formatDate(isoString: string | undefined): string {
    if (!isoString) return '-';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return m.calendar_today();
    if (diffDays === 1) return m.date_yesterday();
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
}

/**
 * Get color class for cache hit rate
 */
export function getHitRateColor(hitRate: number): string {
    if (hitRate >= 80) return 'text-green-400';
    if (hitRate >= 50) return 'text-yellow-400';
    return 'text-red-400';
}

/**
 * Calculate hit rate percentage
 */
export function calculateHitRate(hits: number, misses: number): number {
    const total = hits + misses;
    return total > 0 ? (hits / total) * 100 : 0;
}
