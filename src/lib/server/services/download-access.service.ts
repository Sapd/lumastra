// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who may download. Gate order, first match wins:
 *   1. FEATURE_MEDIA_DOWNLOAD off -> false (canDownload only; userMayDownload has
 *      no master switch, rendition routes bring their own flag)
 *   2. no user -> false
 *   3. admin -> true, but only for a user row that exists and is neither disabled nor
 *      deleted (a disabled admin session that is still alive must not download)
 *   4. per-user override (users.allow_downloads) when not null
 *   5. DOWNLOAD_GROUPS non-empty -> the user's synced groups (users.groups, from
 *      the DB row, not request headers) must match one of them
 *   6. DOWNLOADS_ALLOWED_BY_DEFAULT
 * Cached 5 s per user id.
 */

import { config } from '$lib/server/config.js';
import { hasGroupPermission } from '$lib/server/auth.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserAllowDownloads } from '$lib/server/database/queries/users.queries.js';

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;

type AccessRow = { allowDownloads: boolean | null; groups: string[] | null };

/** Caches only the per-user row (override + groups) (not the config), so config changes apply at once. */
const cache = new Map<string, { row: AccessRow | undefined; expires: number }>();

export function invalidateDownloadAccess(userId: string): void {
    cache.delete(userId);
}

async function loadRow(userId: string): Promise<AccessRow | undefined> {
    const now = Date.now();
    const hit = cache.get(userId);
    if (hit && hit.expires > now) return hit.row;
    const db = getDb();
    if (!db) return undefined; // fail closed (treated as no such user), uncached
    const row = await getUserAllowDownloads(db, userId);
    if (cache.size >= MAX_ENTRIES) {
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        if (cache.size >= MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    }
    cache.set(userId, { row, expires: now + TTL_MS });
    return row;
}

/**
 * Pure rule for a loaded user row (steps 3-6 of the gate order above). `reason`
 * says which step decided, for the admin UI's "Default: allowed via group" label.
 */
export function explainDownloadAccess(
    row: AccessRow,
    isAdmin: boolean,
): { allowed: boolean; reason: 'admin' | 'override' | 'group' | 'default' } {
    if (isAdmin) return { allowed: true, reason: 'admin' };
    if (row.allowDownloads !== null) return { allowed: row.allowDownloads, reason: 'override' };
    const allowedGroups = config.DOWNLOAD_GROUPS.filter((g) => g.trim() !== '');
    if (allowedGroups.length > 0) {
        return { allowed: hasGroupPermission(row.groups ?? [], allowedGroups), reason: 'group' };
    }
    return { allowed: config.DOWNLOADS_ALLOWED_BY_DEFAULT, reason: 'default' };
}

/**
 * Per-user part of the gate (no master switch): no user -> false, admin -> true,
 * then override, DOWNLOAD_GROUPS, DOWNLOADS_ALLOWED_BY_DEFAULT (see file header).
 * Rendition routes use this on top of their own FEATURE_DOWNLOAD_RENDITIONS flag.
 */
export async function userMayDownload(
    user: { userId?: string; username?: string; isAdmin?: boolean } | null | undefined,
): Promise<boolean> {
    if (!user) return false;
    // A principal with no user id (nothing to look up) keeps the plain admin verdict.
    if (user.isAdmin && !user.userId) return true;
    if (!user.userId) return false;
    const row = await loadRow(user.userId);
    if (row === undefined) return false; // no such user, or disabled / deleted
    return explainDownloadAccess(row, user.isAdmin === true).allowed;
}

/** Original-file downloads: FEATURE_MEDIA_DOWNLOAD master switch plus the per-user part. */
export async function canDownload(
    user: { userId?: string; username?: string; isAdmin?: boolean } | null | undefined,
): Promise<boolean> {
    if (!config.FEATURE_MEDIA_DOWNLOAD) return false;
    return userMayDownload(user);
}
