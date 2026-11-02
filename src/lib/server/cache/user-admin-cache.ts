// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * L1 in-process cache for DB-sourced is_admin / disabled / userId values.
 *
 * Lives in a standalone module so both hooks.server.ts (reads/writes)
 * and the PATCH /api/admin/users/[username] route (invalidates) can share it
 * without circular imports.
 *
 * TTL: 10 min. After a manual admin toggle or disable change the entry is
 * invalidated immediately so the target user's very next request sees the
 * updated value.
 *
 * Cross-replica invalidation: explicit invalidation calls also publish to the
 * auth-cache-bus so sibling replicas clear their local entries promptly.
 * This keeps REVOKE prompt (disable / admin-demote) across all replicas.
 */

import {
    isAuthCacheBusDown,
    publishAuthCacheInvalidation,
    onRemoteUserAdminInvalidate,
    onAuthCacheBusResync,
} from './auth-cache-bus.js';

const TTL_MS = 10 * 60_000;

const cache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

/** Return cached isAdmin, or null if missing/expired. */
export function getCachedIsAdmin(username: string): boolean | null {
    if (isAuthCacheBusDown()) return null;
    const entry = cache.get(username);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.isAdmin;
}

/** Write (or refresh) a cache entry. */
export function setCachedIsAdmin(username: string, isAdmin: boolean): void {
    cache.set(username, { isAdmin, expiresAt: Date.now() + TTL_MS });
}

// Parallel L1 cache for the raw `users.admin_pinned` column (FIX ROUND 1,
// Important 4, security review 2026-09-16). Added so resolveTokenUserAccess's
// cache-first fast path can apply the SAME pin-aware `isAdminOverride`
// tri-state (`adminPinned ? isAdmin : undefined`) native-session.ts and
// resolveOwnerIsAdminOverride() already use, instead of always passing a
// DEFINED override — which, per buildUserPermissions' `isAdminOverride ??
// (...)` semantics, silently suppressed the in-app `admin` capability for
// every UNPINNED owner (the same class of bug Task 2's fix-round-1 corrected
// in forward-auth.ts's own producers, but which remained in this shared
// resolver — reachable by the play-token, Live TV, `/j` session and `/j` PAT
// paths). Kept separate from the isAdmin entry so existing isAdmin callers
// (which want the raw column value) are untouched.
const adminPinnedCache = new Map<string, { adminPinned: boolean; expiresAt: number }>();

/** Return cached admin_pinned flag, or null if missing/expired. */
export function getCachedAdminPinned(username: string): boolean | null {
    if (isAuthCacheBusDown()) return null;
    const entry = adminPinnedCache.get(username);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.adminPinned;
}

/** Write (or refresh) the admin_pinned cache entry. */
export function setCachedAdminPinned(username: string, adminPinned: boolean): void {
    adminPinnedCache.set(username, { adminPinned, expiresAt: Date.now() + TTL_MS });
}

// Parallel L1 cache for the account-disabled kill-switch, sharing the admin
// cache's invalidation so a disable/enable takes effect on the target's very
// next forward-auth request (rather than after the 10-min TTL). Kept separate
// from the isAdmin entry so existing isAdmin callers are untouched.
const disabledCache = new Map<string, { disabled: boolean; expiresAt: number }>();

/** Return cached disabled flag, or null if missing/expired. */
export function getCachedDisabled(username: string): boolean | null {
    if (isAuthCacheBusDown()) return null;
    const entry = disabledCache.get(username);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.disabled;
}

/** Write (or refresh) the disabled-flag cache entry. */
export function setCachedDisabled(username: string, disabled: boolean): void {
    disabledCache.set(username, { disabled, expiresAt: Date.now() + TTL_MS });
}

// Parallel L1 cache for the `users.deleted_at` soft-delete marker (security
// review 2026-09-16, task 6 follow-up). Same shape and invalidation as
// `disabledCache` above — `deleted_at` is `disabled_at`'s sibling lifecycle
// column, and every reader of one (resolveTokenUserAccess) now reads both
// through the SAME cache-or-DB seam so a future re-check gated on only one
// of the two cache maps (the exact shape of security review C6) cannot
// recur for this pair.
const deletedCache = new Map<string, { deleted: boolean; expiresAt: number }>();

/** Return cached deleted flag, or null if missing/expired. */
export function getCachedDeleted(username: string): boolean | null {
    if (isAuthCacheBusDown()) return null;
    const entry = deletedCache.get(username);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.deleted;
}

/** Write (or refresh) the deleted-flag cache entry. */
export function setCachedDeleted(username: string, deleted: boolean): void {
    deletedCache.set(username, { deleted, expiresAt: Date.now() + TTL_MS });
}

// Parallel L1 cache mapping username → stable users.id UUID, so the forward-auth
// path can attach `UserContext.userId` on the warm path without a DB round-trip.
// The mapping is stable for a user's lifetime; invalidated alongside the others
// (a delete+recreate of the same username gets a fresh UUID on the next miss).
const userIdCache = new Map<string, { userId: string; expiresAt: number }>();

/** Return cached users.id UUID for a username, or null if missing/expired. */
export function getCachedUserId(username: string): string | null {
    if (isAuthCacheBusDown()) return null;
    const entry = userIdCache.get(username);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.userId;
}

/** Write (or refresh) the username → users.id cache entry. */
export function setCachedUserId(username: string, userId: string): void {
    userIdCache.set(username, { userId, expiresAt: Date.now() + TTL_MS });
}

// Parallel L1 cache for the persisted `users.groups` column (the last-synced
// IdP group membership). Added for the token-derived UserContext resolver
// (resolveTokenUserAccess — security review C4/P2 follow-up): a token
// request carries no live forward-auth header, so unlike resolveDbAuth (whose
// isAdmin/maxAge cache is filled from a header value on every request
// regardless of cache state), that resolver's ONLY source for the synced
// group list is this DB column. Without caching it too, a warm isAdmin/
// maxAge/disabled/userId cache still forced a `users` row read on every
// token-authenticated request (every HLS segment / music track / Live TV
// segment) — sharing this cache/TTL/invalidation is what lets that path skip
// the DB entirely on a warm hit.
const groupsCache = new Map<string, { groups: string[]; expiresAt: number }>();

/** Return cached users.groups for a username, or null if missing/expired. */
export function getCachedGroups(username: string): string[] | null {
    if (isAuthCacheBusDown()) return null;
    const entry = groupsCache.get(username);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.groups;
}

/** Write (or refresh) the users.groups cache entry. */
export function setCachedGroups(username: string, groups: string[]): void {
    groupsCache.set(username, { groups, expiresAt: Date.now() + TTL_MS });
}

// Register local-clear callback so remote invalidation events (from sibling
// replicas via auth-cache-bus) clear entries in this process too.
onRemoteUserAdminInvalidate((username: string) => {
    cache.delete(username);
    adminPinnedCache.delete(username);
    disabledCache.delete(username);
    deletedCache.delete(username);
    userIdCache.delete(username);
    groupsCache.delete(username);
});
// The bus came back after a gap: an invalidation published meanwhile is lost,
// so drop everything rather than serve it for the rest of the TTL.
onAuthCacheBusResync(() => {
    cache.clear();
    adminPinnedCache.clear();
    disabledCache.clear();
    deletedCache.clear();
    userIdCache.clear();
    groupsCache.clear();
});

/** Remove a user's cache entries — call after a manual admin-status or disable change. */
export function invalidateUserAdminCache(username: string): void {
    cache.delete(username);
    adminPinnedCache.delete(username);
    disabledCache.delete(username);
    deletedCache.delete(username);
    userIdCache.delete(username);
    groupsCache.delete(username);
    // Publish cross-replica so sibling replicas also drop the stale entry.
    publishAuthCacheInvalidation({ kind: 'user-admin', username });
}
