// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared key layout + reader for the daily counters of unknown /j
 * (Jellyfin-compat) requests. The writer lives in the proprietary
 * jellyfin-compat tree (it needs the contract digest); this AGPL module only
 * knows the Valkey layout and reads it, so the admin API can use it without
 * crossing the license boundary.
 *
 * Layout: HASH `jfunk:<YYYY-MM-DD>` (UTC), field `<route>|<client> <version>`,
 * value = count. Expires after 8 days.
 */

import { hGetAll } from '$lib/server/cache/valkey.js';

export const UNKNOWN_ROUTE_KEY_PREFIX = 'jfunk:';
export const UNKNOWN_ROUTE_TTL_SECONDS = 8 * 24 * 60 * 60;
export const UNKNOWN_ROUTE_MAX_DAYS = 8;

export interface UnknownRouteItem {
    route: string;
    client: string;
    count: number;
}

export function unknownRouteDayKey(date: Date = new Date()): string {
    return `${UNKNOWN_ROUTE_KEY_PREFIX}${date.toISOString().slice(0, 10)}`;
}

/** Sum the last `days` (1..8) daily hashes, sorted by count desc. Never throws. */
export async function readUnknownRoutes(
    days: number,
    now: Date = new Date(),
): Promise<UnknownRouteItem[]> {
    const n = Math.min(Math.max(Math.trunc(days) || 1, 1), UNKNOWN_ROUTE_MAX_DAYS);
    const totals = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        let hash: Record<string, string>;
        try {
            hash = await hGetAll(unknownRouteDayKey(new Date(now.getTime() - i * 86_400_000)));
        } catch {
            continue;
        }
        for (const [field, value] of Object.entries(hash)) {
            const c = Number.parseInt(value, 10);
            if (Number.isFinite(c) && c > 0) totals.set(field, (totals.get(field) ?? 0) + c);
        }
    }
    const items: UnknownRouteItem[] = [];
    for (const [field, count] of totals) {
        const sep = field.lastIndexOf('|');
        items.push({
            route: sep === -1 ? field : field.slice(0, sep),
            client: sep === -1 ? '' : field.slice(sep + 1),
            count,
        });
    }
    items.sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
    return items;
}
