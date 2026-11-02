// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short-TTL shared cache for `GET /api/admin/library/coverage`'s `summary`.
 *
 * The summary counts every `media_item_stage_state` row joined to its item —
 * ~300 ms on prod (2026-09-26, 1–2M stage rows), up to 1 s under task load —
 * and it is POLLED: `LibraryProcessingHero` asks for `?limit=1` every 8 s while
 * work is in flight (30 s idle) and the notification drawer every 20 s while
 * open, per tab. Prod's slow log caught 430 of these in 50 minutes from two
 * open admin tabs, all with no filter. Paging the grid by cursor re-ran the
 * same summary for every page too, although the filter had not changed.
 *
 * 15 s of staleness is invisible in a progress hero that polls every 8 s, and
 * single-flight collapses concurrent tabs/replicas into one compute. Keyed on
 * the FILTER only (limit/offset/cursor do not change the counts), hashed —
 * `scopedCacheKey` rules reserve `|`/`:` in segments and a search string can
 * hold anything. Shared, not per-user: the endpoint is admin-only and the
 * counts are not access-scoped.
 */

import { createHash } from 'node:crypto';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';

export const LIBRARY_COVERAGE_SUMMARY_TTL_S = 15;

export interface CoverageSummaryFilter {
    mediaTypes?: ReadonlyArray<string>;
    incompleteOnly?: boolean;
    missingStage?: string;
    search?: string;
}

export function coverageSummaryCacheKey(filter: CoverageSummaryFilter): string {
    const canonical = JSON.stringify([
        filter.mediaTypes && filter.mediaTypes.length > 0 ? [...filter.mediaTypes].sort() : null,
        filter.incompleteOnly ?? false,
        filter.missingStage ?? null,
        filter.search ?? null,
    ]);
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    return `v1:admin:library-coverage:summary:${digest}`;
}

/** Cache-or-compute the coverage summary for one filter. */
export async function getCachedCoverageSummary<T>(
    filter: CoverageSummaryFilter,
    compute: () => Promise<T>,
): Promise<T> {
    const raw = await getOrComputeSingleFlight({
        cacheKey: coverageSummaryCacheKey(filter),
        ttlSeconds: LIBRARY_COVERAGE_SUMMARY_TTL_S,
        compute: async () => JSON.stringify(await compute()),
    });
    return JSON.parse(raw) as T;
}
