// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * L1 in-process cache for a user's resolved in-app access (effective group names
 * + OR-merged capability flags from the access_groups layer).
 *
 * Mirrors user-admin-cache.ts: a short TTL keeps the hot forward-auth/session
 * path off the DB, and an explicit invalidate makes an admin's group/membership
 * edit take effect on the target user's very next request rather than after the
 * TTL. Keyed by users.id UUID (the stable identity key).
 *
 * Standalone module so both the auth paths (read) and the admin access routes /
 * service (invalidate) can share it without circular imports.
 *
 * Cross-replica invalidation: on explicit invalidation calls this module
 * publishes to auth-cache-bus so sibling replicas clear their local entry too.
 * This keeps REVOKE prompt across the cluster (ADD lag is harmless).
 */

import type { UserPermissions } from '$lib/server/auth.js';
import {
    isAuthCacheBusDown,
    publishAuthCacheInvalidation,
    onRemoteUserAccessInvalidate,
    onRemoteUserAccessManyInvalidate,
    onAuthCacheBusResync,
} from './auth-cache-bus.js';

/** Resolved in-app access for one user. */
export interface ResolvedUserAccess {
    /** In-app group names this user belongs to (merged with synced groups upstream). */
    groupNames: string[];
    /** Capability flags to OR-merge into buildUserPermissions. */
    capabilities: Partial<UserPermissions>;
}

const TTL_MS = 60_000; // 1 min — short, like the auth hot-path caches.

const cache = new Map<string, { access: ResolvedUserAccess; expiresAt: number }>();

// Register local-clear callbacks so remote invalidation events (from sibling
// replicas via auth-cache-bus) clear entries in this process too.
onRemoteUserAccessInvalidate((userId: string) => {
    cache.delete(userId);
});
onRemoteUserAccessManyInvalidate((userIds: readonly string[]) => {
    for (const id of userIds) cache.delete(id);
});
// The bus came back after a gap: an invalidation published meanwhile is lost,
// so drop everything rather than serve it for the rest of the TTL.
onAuthCacheBusResync(() => cache.clear());

/** Return cached resolved access for a user id, or null if missing/expired. */
export function getCachedUserAccess(userId: string): ResolvedUserAccess | null {
    if (isAuthCacheBusDown()) return null;
    const entry = cache.get(userId);
    if (!entry || Date.now() >= entry.expiresAt) {
        if (entry) cache.delete(userId);
        return null;
    }
    return entry.access;
}

/** Write (or refresh) a user's resolved-access cache entry. */
export function setCachedUserAccess(userId: string, access: ResolvedUserAccess): void {
    cache.set(userId, { access, expiresAt: Date.now() + TTL_MS });
}

/** Remove a user's entry — call after a membership or group-capability change. */
export function invalidateUserAccessCache(userId: string): void {
    cache.delete(userId);
    // Publish cross-replica so sibling replicas also drop the stale entry.
    publishAuthCacheInvalidation({ kind: 'user-access', userId });
}

/** Invalidate several users at once (e.g. all members of an edited group). */
export function invalidateUserAccessCacheMany(userIds: readonly string[]): void {
    for (const id of userIds) cache.delete(id);
    if (userIds.length > 0) {
        // Publish cross-replica invalidation for the whole batch.
        publishAuthCacheInvalidation({ kind: 'user-access-many', userIds: [...userIds] });
    }
}

/** Test hook: clear the whole cache. */
export function clearUserAccessCache(): void {
    cache.clear();
}
