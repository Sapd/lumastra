// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { CacheManager } from '$lib/server/cache/unified-cache.js';
import { CACHE_NAMESPACES } from '$lib/server/cache/namespaces.js';
import { getLiveTvProvider } from './livetv/index.js';
import { invalidateHiddenStationsCache } from './livetv/channel-health.service.js';

/**
 * Invalidate all LiveTV-related caches.
 * Call from any LiveTV admin mutation route instead of inline cache clearing.
 */
export async function invalidateLiveTvCaches(): Promise<void> {
    invalidateHiddenStationsCache();
    const cacheManager = CacheManager.getInstance();
    const channelCache = cacheManager.for(CACHE_NAMESPACES.browseChannels);
    await channelCache.clear();

    // Bust the active provider's in-memory channel/category/guide caches on this
    // node. The standalone provider memoizes channels + categories (~30s) and the
    // guide (~60s) in private fields that the browseChannels Valkey clear above never
    // touches, so an admin rename/reorder/hide would otherwise keep serving stale
    // data from this node until those TTLs lapse. bustCaches() is only present on
    // providers that hold in-memory caches (the standalone provider); the disabled
    // provider has none, so feature-detect before calling.
    try {
        const provider = await getLiveTvProvider();
        const maybeBust = (provider as { bustCaches?: () => void }).bustCaches;
        if (typeof maybeBust === 'function') {
            maybeBust.call(provider);
        }
    } catch {
        // Provider unavailable (e.g. LiveTV disabled) — nothing in-memory to bust.
    }
}
