// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * seen-media — lightweight, client-only "already shown above" registry for the
 * home page.
 *
 * The home feed is assembled from independent sources: the For You feed
 * (SSR/streamed, built server-side by RecommendationFeed) and the Trending
 * widget (client-fetched by Trending.svelte). Because they don't share a build,
 * a popular title can appear in For You's "New Releases" rail AND in Trending
 * at the same time.
 *
 * This registry lets a section record the media keys it renders at a given
 * "rank" (render position, lower = higher up the page), and lets a lower section
 * query everything already shown ABOVE it so it can thin duplicates before
 * render. Keys are the UUID-first composite produced by `buildMediaKey`
 * (internal UUID → tmdb:id:mediaType fallback), so they match the keys the
 * For You feed already dedupes on.
 *
 * SSR-safe: all mutations/reads are no-ops (empty) on the server so nothing
 * leaks across requests. The registry is module-scoped, so it must be reset on
 * page mount (see `resetSeenMedia`) to avoid stale ids surviving a client-side
 * navigation.
 */

import { browser } from '$app/environment';
import { SvelteMap } from 'svelte/reactivity';

/**
 * Render-rank constants. Ranks only need to preserve the page's vertical order:
 * anything the For You feed marks sits ABOVE the Trending widget, so Trending
 * (higher rank number) can thin items already shown in For You (lower rank).
 * The home page statically renders For You before Trending.
 */
export const FOR_YOU_FRESH_RELEASES_RANK = 10;
export const TRENDING_WIDGET_RANK = 20;

/** rank → set of media keys rendered at that rank. Reactive via SvelteMap. */
const seenByRank = new SvelteMap<number, Set<string>>();

/**
 * Record the media keys a section renders at `sectionRank`. Merges with any
 * keys already recorded for that rank (a section can stream in progressively).
 * No-op on the server or for an empty id list.
 */
export function markSeen(sectionRank: number, ids: string[]): void {
    if (!browser || ids.length === 0) return;
    // Always build a fresh Set so the SvelteMap.set() reliably notifies readers,
    // even when the rank already existed.
    const next = new Set(seenByRank.get(sectionRank)); // eslint-disable-line svelte/prefer-svelte-reactivity -- immutable snapshot; reactivity comes from SvelteMap.set() replacing the value
    let changed = false;
    for (const id of ids) {
        if (id && !next.has(id)) {
            next.add(id);
            changed = true;
        }
    }
    if (changed) seenByRank.set(sectionRank, next);
}

/**
 * Reactive: all media keys seen by sections ranked strictly ABOVE `rank`.
 * Iterating the SvelteMap registers a dependency, so a `$derived` that calls
 * this re-computes when a higher section marks new items later (late streaming).
 */
export function seenAboveRank(rank: number): Set<string> {
    const out = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- return-value snapshot; dependency registration happens via SvelteMap iteration below
    if (!browser) return out;
    for (const [r, ids] of seenByRank) {
        if (r < rank) for (const id of ids) out.add(id);
    }
    return out;
}

/**
 * Clear the registry. Call on page mount (RecommendationFeed) so ids from a
 * previous page don't leak across a client-side navigation.
 */
export function resetSeenMedia(): void {
    seenByRank.clear();
}
