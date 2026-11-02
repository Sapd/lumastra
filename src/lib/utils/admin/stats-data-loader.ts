// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stats Data Loader Utility
 * Generic data loading functions for admin stats page
 */

import { apiGet } from '$lib/api/client';
import { z } from 'zod';
import { isRecord } from '$lib/utils/data-extraction';

const PassthroughSchema = z.record(z.string(), z.unknown());

/**
 * Stat state object with data, loading flag, and optional error message
 */
export interface StatState<T = unknown> {
    data: T | null;
    loading: boolean;
    error: string | null;
}

/**
 * Generic data loader for watch stats API
 * Handles loading state, error handling, and API response unwrapping
 *
 * @param endpoint - API endpoint path
 * @param setter - Function to update the data state
 * @param loadingSetter - Function to update the loading state
 * @param errorSetter - Optional function to update the error state
 * @returns Promise that resolves when loading completes
 */
export async function loadStat<T>(
    endpoint: string,
    setter: (data: T | null) => void,
    loadingSetter: (loading: boolean) => void,
    errorSetter?: (error: string | null) => void,
): Promise<void> {
    loadingSetter(true);
    errorSetter?.(null);
    try {
        const { data: result, error: fetchError } = await apiGet(endpoint, PassthroughSchema);
        if (fetchError) {
            console.error(`Failed to load stat from ${endpoint}:`, fetchError);
            setter(null);
            errorSetter?.(String(fetchError));
        } else {
            setter((result as T) || null);
        }
    } catch (error) {
        console.error(`Failed to load stat from ${endpoint}:`, error);
        setter(null);
        errorSetter?.(error instanceof Error ? error.message : String(error));
    } finally {
        loadingSetter(false);
    }
}

/**
 * Load watch stats with specific type and timeframe
 * Convenience wrapper around loadStat for the watch-stats API
 *
 * @param type - Stats type (movies, tvshows, activity, etc.)
 * @param timeframe - Time range filter
 * @param setter - Function to update the data state
 * @param loadingSetter - Function to update the loading state
 * @param additionalParams - Additional query parameters
 * @param errorSetter - Optional function to update the error state
 */
export async function loadWatchStat<T>(
    type: string,
    timeframe: string,
    setter: (data: T | null) => void,
    loadingSetter: (loading: boolean) => void,
    additionalParams?: Record<string, string | number>,
    errorSetter?: (error: string | null) => void,
): Promise<void> {
    const params = new URLSearchParams({
        type,
        timeframe,
        ...Object.fromEntries(
            Object.entries(additionalParams || {}).map(([k, v]) => [k, String(v)]),
        ),
    });
    await loadStat(`/api/watch-stats?${params}`, setter, loadingSetter, errorSetter);
}

/**
 * Transform API response for chart display
 * Handles various response formats and normalizes to chart-compatible format
 */
type ChartDatum = {
    label: string;
    count: number;
    minutes: number;
    percentage: number;
};

export function transformChartData<T extends Record<string, unknown>>(
    result: unknown,
    mapper: (item: T) => {
        label: string;
        count: number;
        minutes: number;
        percentage: number;
    },
): { success: boolean; data: ChartDatum[] } {
    // Server returns bare { stats: T[] } — no legacy `success` wrapper.
    if (isRecord(result) && Array.isArray(result.stats)) {
        return {
            success: true,
            data: result.stats.map((item) => mapper(item as T)),
        };
    }
    return { success: false, data: [] };
}
