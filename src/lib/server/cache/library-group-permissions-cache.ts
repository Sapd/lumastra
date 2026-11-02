// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * L1 in-process cache for library group access restrictions.
 *
 * Caches the full library_group_permissions table as a Map<group_id, allowed_groups[]>.
 * TTL: 5 minutes. Invalidated immediately on admin save.
 *
 * When no restrictions exist (common case), getDeniedLibraryGroups returns null
 * and query functions skip the filter entirely — zero query overhead.
 */

import type postgres from 'postgres';
import { getAllLibraryGroupPermissions } from '../database/queries/library-group-permissions.queries.js';
import { buildLibraryAccessFilter } from '../database/queries/builders/library-access.builder.js';
import { publishMessage, subscribeToChannel } from './valkey.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('LibraryGroupPermissionsCache');
const PERMISSIONS_INVALIDATE_CHANNEL = 'permissions:invalidate';

const TTL_MS = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// L1 per-item access cache
// ---------------------------------------------------------------------------

const ITEM_ACCESS_TTL_MS = 60 * 60_000; // 60 minutes — explicit invalidation covers permission changes
const ITEM_ACCESS_MAX = 5000;

const itemAccessCache = new Map<string, { value: boolean; expiresAt: number }>();

function itemAccessKey(mediaItemId: string, denied: string[]): string {
    return `${mediaItemId}:${[...denied].sort().join(',')}`;
}

function getCachedItemAccess(key: string): boolean | undefined {
    const entry = itemAccessCache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
        itemAccessCache.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCachedItemAccess(key: string, value: boolean): void {
    if (itemAccessCache.size >= ITEM_ACCESS_MAX) {
        const firstKey = itemAccessCache.keys().next().value;
        if (firstKey !== undefined) itemAccessCache.delete(firstKey);
    }
    itemAccessCache.set(key, {
        value,
        expiresAt: Date.now() + ITEM_ACCESS_TTL_MS,
    });
}

interface CachedPermissions {
    /** Map from library_group_id → lowercase allowed group names */
    restrictions: Map<string, string[]>;
    expiresAt: number;
}

let cached: CachedPermissions | null = null;

/**
 * Bumped by every invalidation. A load that started before an invalidation
 * must not repopulate the cache with what it read: an admin who adds a
 * restriction while a request is mid-load would otherwise see the pre-change
 * rows cached on this replica for the full TTL (restricted users keep access
 * for up to 5 minutes; the per-item cache for up to an hour).
 */
let generation = 0;

async function loadRestrictions(sql: postgres.Sql): Promise<Map<string, string[]>> {
    const rows = await getAllLibraryGroupPermissions(sql);
    const map = new Map<string, string[]>();
    for (const row of rows) {
        // Only store rows that actually restrict access (non-empty allowed_groups)
        if (row.allowed_groups.length > 0) {
            map.set(
                row.library_group_id,
                row.allowed_groups.map((g) => g.toLowerCase()),
            );
        }
    }
    return map;
}

async function getRestrictions(sql: postgres.Sql): Promise<Map<string, string[]>> {
    if (cached && Date.now() < cached.expiresAt) {
        return cached.restrictions;
    }
    const startedAt = generation;
    const restrictions = await loadRestrictions(sql);
    if (startedAt === generation) {
        cached = { restrictions, expiresAt: Date.now() + TTL_MS };
    }
    return restrictions;
}

export interface LibraryAccessUser {
    isAdmin: boolean;
    userGroups: string[];
}

/**
 * Convert locals.user (from SvelteKit event) to LibraryAccessUser.
 * Convenience helper to avoid repeating the mapping in every route.
 *
 * Admin needs BOTH the user flag and the credential's capability. A copy that
 * lowers `isAdmin` (the assistant's `deEscalateUser`, service-token
 * impersonation of a non-admin) keeps the spread `mediaAccessIsAdmin: true`,
 * and that stale flag must not restore the bypass.
 */
export function toLibraryAccessUser(
    localsUser:
        { ownerIsAdmin?: boolean; mediaAccessIsAdmin?: boolean; userGroups?: string[] } | undefined,
): LibraryAccessUser | undefined {
    if (!localsUser) return undefined;
    return {
        isAdmin: localsUser.ownerIsAdmin === true && localsUser.mediaAccessIsAdmin !== false,
        userGroups: localsUser.userGroups ?? [],
    };
}

/**
 * Compute which library group IDs the user is denied access to.
 *
 * @returns null if no filter needed (admin, no user, or no restrictions exist).
 *          string[] of denied library_group_ids otherwise.
 */
export async function getDeniedLibraryGroups(
    sql: postgres.Sql,
    user: LibraryAccessUser | undefined,
): Promise<string[] | null> {
    // Admins bypass all restrictions
    if (!user || user.isAdmin) return null;

    const restrictions = await getRestrictions(sql);

    // No restrictions configured at all — common case, zero overhead
    if (restrictions.size === 0) return null;

    const userGroupsLower = user.userGroups.map((g) => g.toLowerCase());
    const denied: string[] = [];

    for (const [groupId, allowedGroups] of restrictions) {
        // User is denied if they don't belong to ANY of the allowed groups
        const hasAccess = allowedGroups.some((ag) => userGroupsLower.includes(ag));
        if (!hasAccess) {
            denied.push(groupId);
        }
    }

    return denied.length > 0 ? denied : null;
}

/**
 * Check whether a specific media item passes the LIBRARY-GROUP axis.
 *
 * ⚠️ This is HALF an access check. It knows nothing about age ratings, and it
 * normally returns `true` early when `getDeniedLibraryGroups` yields null — which is
 * the common case (no library_group_permissions rows configured at all). A route
 * that gates solely on this therefore serves 18-rated items to an age-restricted
 * user whenever no library restrictions happen to be configured.
 *
 * Do NOT use as a standalone gate. Use `checkMediaAccess` from
 * `$lib/server/middleware/media-access.js`, which composes this with the age
 * gate. This stays exported only because `checkMediaAccess` builds on it.
 *
 * ## Collapsed onto `buildLibraryAccessFilter` (C7 — 2026-09-16 security review 3)
 *
 * This used to carry its own hand-written copy of the container-aware rule —
 * a `SELECT EXISTS (... UNION ALL ...)` mirroring, but never sharing code
 * with, {@link buildLibraryAccessFilter}. Being a separate copy, it missed the
 * own-column declared-affiliation disjunct entirely: `buildLibraryAccessFilter`
 * and `buildLibraryGroupColumnFilter` both received that fix (2026-09-15,
 * corrected 2026-09-15 for the sticky-column desync case — see the builder's
 * own doc comment for the full history and the exact rule), and this function
 * was never touched by either round. A file-less `tv`/`season`/`artist`/
 * `album` row whose OWN `media_items.library_group_id` named a denied group
 * therefore still passed `checkMediaAccess` after both those fixes shipped.
 *
 * Rather than hand-patch a fifth copy of the same rule, this now runs
 * `buildLibraryAccessFilter` itself against the one
 * candidate row, so the two can never diverge again — a future edit to the
 * builder's CASE dispatch or its own-column guard is picked up here for free.
 * It also preserves the
 * "nonexistent id still passes" behavior (`mi.id IS NULL` after the LEFT JOIN): `buildLibraryAccessFilter`'s fragment is correlated to a row that
 * has to exist in `mi` to match anything, so it can never itself account for
 * an id with no row at all. See `builders/library-access-container.integration.test.ts`
 * ("own-column declared affiliation" describe block) for the differential
 * coverage — including the two `checkMediaAccess` cases added for C7 — that
 * keeps this primitive and the builder provably in sync.
 *
 * The optional live audiobook availability gate is used by checkMediaAccess for
 * unrestricted metadata readers. Restricted readers fold it into their age
 * lookup instead. File-backed callers retain the no-restrictions fast path.
 */
export async function isMediaAccessible(
    sql: postgres.Sql,
    mediaItemId: string,
    user: LibraryAccessUser,
    options: { checkAudiobookAvailability?: boolean } = {},
): Promise<boolean> {
    if (user.isAdmin) return true;

    const denied = await getDeniedLibraryGroups(sql, user);
    const checkAvailability = options.checkAudiobookAvailability === true;
    if (!denied && !checkAvailability) return true;

    const cacheKey = `${itemAccessKey(mediaItemId, denied ?? [])}:${checkAvailability ? 'book-live' : 'library'}`;
    const hit = getCachedItemAccess(cacheKey);
    if (hit !== undefined) return hit;

    const startedAt = generation;
    // Retirement is part of the library lookup, never a separate round trip.
    // Only audiobooks use this live gate: discovery-only movies and other
    // file-backed types retain their previous access semantics.
    const rows = await sql<{ accessible: boolean; media_type: string | null }[]>`
        SELECT mi.media_type,
            (mi.id IS NULL OR (true
                ${buildLibraryAccessFilter(sql, denied, 'mi')}
                ${checkAvailability ? sql`AND (mi.media_type <> 'audiobook' OR (mi.has_files AND NOT mi.is_dismissed))` : sql``}
            )) AS accessible
        FROM (VALUES (1)) probe(dummy)
        LEFT JOIN media_items mi ON mi.id = ${mediaItemId}
    `;
    const result = rows[0]?.accessible ?? false;
    // An audiobook's availability must be re-read, including when no library
    // restrictions exist. Caching a verdict here would revive retired books.
    if (startedAt === generation && (!checkAvailability || rows[0]?.media_type !== 'audiobook')) {
        setCachedItemAccess(cacheKey, result);
    }
    return result;
}

/*
 * NOTE: a second, library-axis-only `filterAccessibleMediaIds` used to live here.
 * It was deleted (2026-07-21) rather than kept as a deprecated alias: it had no
 * importers, it was NAME-IDENTICAL to the hardened
 * `$lib/server/utils/media-access-batch.ts` export, and picking the wrong one out
 * of the autocomplete list produced no type error. Its fast paths were
 * fail-open by construction — `!user` returned every id, and a null denied list
 * returned every id — and it had no age parameter at all, so the age axis was
 * structurally unenforceable through it.
 *
 * Use `filterAccessibleMediaIds` from `$lib/server/utils/media-access-batch.js`,
 * which takes a required MediaAccessBoundary covering both axes.
 */

/** Invalidate cache immediately — call after admin permission changes. */
export function invalidateLibraryGroupPermissionsCache(): void {
    generation++;
    cached = null;
    itemAccessCache.clear();
}

/**
 * Invalidate locally and broadcast to all replicas via Valkey pub/sub.
 * Call this from admin routes instead of the local-only invalidation.
 */
export function broadcastPermissionsInvalidation(): void {
    // Invalidate locally first — immediate, no pub/sub latency
    invalidateLibraryGroupPermissionsCache();

    publishMessage(PERMISSIONS_INVALIDATE_CHANNEL, 'invalidate').catch(() => {
        logger.warn(
            'Failed to broadcast permissions invalidation — other replicas may serve stale data',
        );
    });
}

// Subscribe so this replica receives invalidation events from all other replicas.
// Runs once at module initialization — if Valkey is unavailable, logs a warning.
void subscribeToChannel(PERMISSIONS_INVALIDATE_CHANNEL, () => {
    invalidateLibraryGroupPermissionsCache();
}).catch((err: unknown) => {
    logger.warn(
        'Failed to subscribe to permissions invalidation channel — cross-replica invalidation unavailable',
        {},
        err as Error,
    );
});
