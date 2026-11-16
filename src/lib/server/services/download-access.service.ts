// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who may download. Gate order: FEATURE_MEDIA_DOWNLOAD master switch, then no
 * user -> false, admin -> true, else the per-user override (users.allow_downloads)
 * falling back to DOWNLOADS_ALLOWED_BY_DEFAULT. Cached 5 s per user id.
 */

import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserAllowDownloads } from '$lib/server/database/queries/users.queries.js';

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;

/** Caches only the per-user override (not the config), so config changes apply at once. */
const cache = new Map<string, { override: boolean | null | undefined; expires: number }>();

export function invalidateDownloadAccess(userId: string): void {
    cache.delete(userId);
}

async function loadOverride(userId: string): Promise<boolean | null | undefined> {
    const now = Date.now();
    const hit = cache.get(userId);
    if (hit && hit.expires > now) return hit.override;
    const db = getDb();
    if (!db) return false; // fail closed, uncached
    const override = await getUserAllowDownloads(db, userId);
    if (cache.size >= MAX_ENTRIES) {
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        if (cache.size >= MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    }
    cache.set(userId, { override, expires: now + TTL_MS });
    return override;
}

export async function canDownload(
    user: { userId?: string; username?: string; isAdmin?: boolean } | null | undefined,
): Promise<boolean> {
    if (!config.FEATURE_MEDIA_DOWNLOAD) return false;
    if (!user) return false;
    if (user.isAdmin) return true;
    if (!user.userId) return false;
    const override = await loadOverride(user.userId);
    if (override === undefined) return false; // no such user
    return override ?? config.DOWNLOADS_ALLOWED_BY_DEFAULT;
}
