// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short-TTL server-side cache for the admin media browser's filter-independent
 * reads: the LIBRARY chip row (`getLibraryGroupsWithCounts`) and the saved-view
 * counts (`countAdminMediaViews`). The library-wide stats bar this first cached
 * was replaced by the view counts (triage spec, 2026-09-27).
 *
 * Neither depends on the page's filters, sort, search or page number, yet both
 * ran on EVERY browser navigation — each tab switch, sort click, page flip and
 * search keystroke. Measured on prod (2026-09-26, ~160k media_items): the stats
 * query is a full scan with two anti-join probes per row, 0.7 s idle and 1–3 s
 * under task load; the library-groups query joins every media_file_item, up to
 * 0.8 s. The filtered list + count themselves take ~0.1 s, so these two set the
 * floor of every navigation — and they held two of the admin pool's four
 * connections while doing it.
 *
 * A minute of staleness is fine: a newly created library group showing up as
 * a chip a minute later is harmless, and a fix made from the browser
 * decrements its view count locally at once. SHARED key (not per-user):
 * the page is admin-only and neither read is access-scoped.
 */

import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';

export const ADMIN_MEDIA_BROWSER_CACHE_TTL_S = 60;

const LIBRARY_GROUPS_KEY = 'v1:admin:media-browser:library-groups';

async function cachedJson<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    const raw = await getOrComputeSingleFlight({
        cacheKey,
        ttlSeconds: ADMIN_MEDIA_BROWSER_CACHE_TTL_S,
        compute: async () => JSON.stringify(await compute()),
    });
    return JSON.parse(raw) as T;
}

/** Cache-or-compute the library groups (with their media types) for the chip row. */
export function getCachedMediaBrowserLibraryGroups<T>(compute: () => Promise<T>): Promise<T> {
    return cachedJson(LIBRARY_GROUPS_KEY, compute);
}

/**
 * Cache-or-compute the saved-view counts for one scope. `scopeKey` names the
 * scope (domain, type, library, dismissed, Jellyfin on/off); the counts are
 * the same for every admin looking at it.
 */
export function getCachedMediaBrowserViewCounts(
    scopeKey: string,
    compute: () => Promise<Record<string, number>>,
): Promise<Record<string, number>> {
    return cachedJson(`v1:admin:media-browser:view-counts:${scopeKey}`, compute);
}
