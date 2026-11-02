// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Preview-data cache for MediaInspector.
 *
 * One entry per `id`, replaced whenever `updatedAt` changes — so a mutation
 * that bumps `updatedAt` (a sync, an unlock, a metadata edit) busts its own
 * entry instead of the panel silently showing stale data, WITHOUT keeping the
 * superseded version around. An earlier version of this cache keyed the
 * backing `Map` itself by `id + updatedAt` (two separate entries per item
 * once it had been edited once), which meant arrow-walking a large library
 * accumulated one payload per item PER VERSION for the life of the session —
 * unbounded growth in exchange for invalidation that a single-entry-per-id
 * design gets for free. The previous inline preview's cache (a plain
 * `Map<id, data>` in +page.svelte, no `updatedAt` at all) had the opposite
 * problem: bounded, but no invalidation — edit an item, reopen its preview,
 * and it lied.
 *
 * Module-level singleton (not component state) so every MediaInspector
 * instance shares one cache, matching how `previewCache` was shared via a
 * prop before. `clearPreviewCache` is called from the component whenever
 * `page.data` changes (see MediaInspector.svelte) to cover `invalidateAll()`,
 * which does not fire SvelteKit's `afterNavigate` hook.
 */

import type { MediaPreviewResponse } from '$lib/schemas/api-admin-responses';

interface CacheEntry {
    updatedAt: string;
    data: MediaPreviewResponse;
}

const cache = new Map<string, CacheEntry>();

export function getCachedPreview(id: string, updatedAt: string): MediaPreviewResponse | undefined {
    const entry = cache.get(id);
    if (!entry || entry.updatedAt !== updatedAt) return undefined;
    return entry.data;
}

export function setCachedPreview(id: string, updatedAt: string, data: MediaPreviewResponse): void {
    // Overwrites whatever was stored for this id, including a stale entry
    // from a previous `updatedAt` — one entry per id, never two.
    cache.set(id, { updatedAt, data });
}

export function clearPreviewCache(): void {
    cache.clear();
}

/** Test-only accessor — avoids exporting the Map itself. */
export function previewCacheSizeForTest(): number {
    return cache.size;
}
