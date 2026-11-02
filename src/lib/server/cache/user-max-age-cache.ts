// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * L1 in-process cache for DB-sourced max_age_rating values.
 *
 * Mirrors user-admin-cache.ts. Without this cache, every authenticated
 * request — including every image fetch — paid a `SELECT max_age_rating
 * FROM users` query in `resolveDbMaxAgeRating`. On a page that loads 20
 * episode posters that's 20 round-trips to Postgres just to learn the
 * user's age rating, which doesn't change per-request.
 *
 * Cached value is `number | null` (null = no rating set), so we can't use
 * "null = miss" semantics like the admin cache does. The `entry` presence
 * check (Map.get returning undefined for missing keys) is what
 * distinguishes miss from cached-null.
 *
 * TTL: 10 min. Manual admin pin/unpin invalidates immediately via
 * invalidateUserMaxAgeCache().
 *
 * Cross-replica invalidation (FIX ROUND 1, Important 2, security review
 * 2026-09-16): invalidateUserMaxAgeCache() now ALSO publishes to the
 * auth-cache-bus, mirroring user-admin-cache.ts. Before this fix it only
 * cleared the local replica's Map, so a sibling replica kept serving a
 * lowered age cap for up to the full 10-minute TTL — including to a `/j`
 * session on that replica, which is exactly the staleness C9 was fixed to
 * close.
 */

import {
    isAuthCacheBusDown,
    publishAuthCacheInvalidation,
    onRemoteUserMaxAgeInvalidate,
    onAuthCacheBusResync,
} from './auth-cache-bus.js';

const TTL_MS = 10 * 60_000;

const cache = new Map<string, { value: number | null; expiresAt: number }>();

/** Sentinel returned by `getCachedMaxAge` to distinguish a miss from a
 *  legitimately cached `null`. Callers test `!== MAX_AGE_MISS`. */
export const MAX_AGE_MISS = Symbol('max-age-miss');
export type MaxAgeCacheResult = number | null | typeof MAX_AGE_MISS;

/** Return cached max age rating, MAX_AGE_MISS if not cached or expired. */
export function getCachedMaxAge(username: string): MaxAgeCacheResult {
    if (isAuthCacheBusDown()) return MAX_AGE_MISS;
    const entry = cache.get(username);
    if (!entry) return MAX_AGE_MISS;
    if (Date.now() >= entry.expiresAt) {
        cache.delete(username);
        return MAX_AGE_MISS;
    }
    return entry.value;
}

/** Write (or refresh) a cache entry. */
export function setCachedMaxAge(username: string, value: number | null): void {
    cache.set(username, { value, expiresAt: Date.now() + TTL_MS });
}

// Register local-clear callback so remote invalidation events (from sibling
// replicas via auth-cache-bus) clear entries in this process too.
onRemoteUserMaxAgeInvalidate((username: string) => {
    cache.delete(username);
});
// The bus came back after a gap: an invalidation published meanwhile is lost,
// so drop everything rather than serve it for the rest of the TTL.
onAuthCacheBusResync(() => cache.clear());

/** Remove a cache entry — call after a manual age-rating change. */
export function invalidateUserMaxAgeCache(username: string): void {
    cache.delete(username);
    // Publish cross-replica so sibling replicas also drop the stale entry
    // (FIX ROUND 1, Important 2) — without this, a lowered cap took up to
    // 10 minutes to reach a sibling replica.
    publishAuthCacheInvalidation({ kind: 'user-max-age', username });
}
