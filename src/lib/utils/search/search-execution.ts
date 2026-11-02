// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Execution
 *
 * Parallel search execution for Search.svelte (ref: DL-006).
 *
 * Separation of concerns:
 *   This file: parallel API calls, URL building, stale-result detection
 *   Search.svelte: version tracking, loading state, groupedResults merging
 *
 * Pure async functions — no Svelte $state access, fully testable in isolation.
 *
 * Stale-result detection: each group checks getVersion() after its fetch returns.
 * If the component's searchVersion has changed, the result is discarded silently.
 * This prevents earlier slow responses from overwriting later fast ones.
 */

import { apiGet } from '$lib/api/client';
import { SearchResponseSchema } from '$lib/api/content';
import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';
import type { SearchOperators } from '$lib/utils/search/query-parser';

// =============================================================================
// Types
// =============================================================================

export interface SearchGroup {
    types: string;
    categories: string[];
}

export interface SearchExecutionParams {
    effectiveQuery: string;
    parsedOperators: SearchOperators;
    fulltextMode: boolean;
    limit: number;
    /** Pagination offset (per-category load-more); omitted/0 for the first page. */
    offset?: number;
}

export interface SearchGroupResult {
    failed?: boolean;
    categories: string[];
    items: V1SearchResultItem[];
    /** Whether more results exist beyond this page (drives per-category load-more). */
    hasMore?: boolean;
}

// =============================================================================
// URL Builder
// =============================================================================

function buildGroupParams(group: SearchGroup, params: SearchExecutionParams): URLSearchParams {
    const urlParams = new URLSearchParams();
    urlParams.set('q', params.effectiveQuery || '*');
    urlParams.set('limit', String(params.limit));
    urlParams.set('types', group.types);
    if (params.offset && params.offset > 0) {
        urlParams.set('offset', String(params.offset));
    }
    urlParams.set('fulltext', String(params.fulltextMode));
    const { parsedOperators: ops } = params;
    if (ops.yearMin !== undefined) urlParams.set('yearMin', String(ops.yearMin));
    if (ops.yearMax !== undefined) urlParams.set('yearMax', String(ops.yearMax));
    if (ops.ratingMin !== undefined) urlParams.set('ratingMin', String(ops.ratingMin));
    if (ops.genres && ops.genres.length > 0) urlParams.set('genres', ops.genres.join(','));
    if (ops.exclude && ops.exclude.length > 0) urlParams.set('exclude', ops.exclude.join(','));
    return urlParams;
}

// =============================================================================
// executeSearchGroups
// =============================================================================

/**
 * Execute all search groups in parallel and deliver results to the caller incrementally.
 * Each group's result is delivered via onGroupResult as soon as it arrives.
 * The version parameter allows the caller to discard stale results.
 *
 * @param searchGroups - Groups to search (built by buildSearchGroups in Search.svelte)
 * @param params - Query and filter parameters
 * @param version - Current search version at call time
 * @param onGroupResult - Called when a group completes (success or error)
 * @param getVersion - Returns the current component search version for stale-result detection
 * @param signal - Optional AbortSignal; aborting cancels all in-flight group requests
 */
export async function executeSearchGroups(
    searchGroups: SearchGroup[],
    params: SearchExecutionParams,
    version: number,
    onGroupResult: (result: SearchGroupResult) => void,
    getVersion: () => number,
    signal?: AbortSignal,
): Promise<void> {
    const promises = searchGroups.map(async (group) => {
        try {
            const urlParams = buildGroupParams(group, params);
            const { data, error: fetchError } = await apiGet(
                `/api/search?${urlParams.toString()}`,
                SearchResponseSchema,
                signal ? { signal } : undefined,
            );
            if (fetchError || !data) throw new Error(fetchError || 'Search failed');

            // Discard stale responses when a newer search has started
            if (getVersion() !== version || signal?.aborted) return;

            const items = Array.isArray(data.items) ? data.items : [];
            onGroupResult({
                categories: group.categories,
                items,
                hasMore: data.page?.hasMore ?? false,
            });
        } catch (error) {
            // Stale or aborted: a newer search owns the UI state -- never clobber it
            // (aborts happen precisely because a newer search bumped the version).
            if (getVersion() !== version || signal?.aborted) return;
            console.error(`Search error for ${group.types}:`, error);
            // Deliver empty result so the caller can clear the loading indicator
            onGroupResult({ categories: group.categories, items: [], failed: true });
        }
    });

    await Promise.all(promises);
}

/**
 * Fetch a SINGLE search group page (used by per-category "Load more"). Unlike
 * executeSearchGroups this has no version/stale logic -- the caller appends the
 * returned items and reads hasMore. Returns null on error.
 */
export async function fetchSearchGroupPage(
    group: SearchGroup,
    params: SearchExecutionParams,
): Promise<SearchGroupResult | null> {
    try {
        const urlParams = buildGroupParams(group, params);
        const { data, error: fetchError } = await apiGet(
            `/api/search?${urlParams.toString()}`,
            SearchResponseSchema,
        );
        if (fetchError || !data) return null;
        return {
            categories: group.categories,
            items: Array.isArray(data.items) ? data.items : [],
            hasMore: data.page?.hasMore ?? false,
        };
    } catch (error) {
        console.error(`Load-more error for ${group.types}:`, error);
        return null;
    }
}
