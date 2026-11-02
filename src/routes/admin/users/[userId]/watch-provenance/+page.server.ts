// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin per-user watch-provenance explorer.
 *
 * Loads event provenance groups for a single user so operators can spot
 * "8 188 events from jellyfin-sync in a 4-second window" patterns without
 * querying the database directly.
 *
 * Repudiation is scoped to **detected bulk-mark windows** rather than the
 * hour-bucketed exploration table — an hour of legitimate activity from
 * the same source should never be nuked alongside a 10-second bulk-mark
 * burst. The hour table stays for context; the bulk-mark windows table
 * owns the Repudiate action. Repudiated jellyfin-sync windows whose Jellyfin
 * unmark failed (or left no record) are listed with a Retry action.
 */

import type { PageServerLoad } from './$types';
import { redirect, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import {
    getProvenanceGroups,
    detectBulkMarkWindows,
    getPendingJellyfinUnmarkWindows,
    type ProvenanceGroup,
    type BulkMarkWindow,
    type PendingJellyfinUnmarkWindow,
} from '$lib/server/database/queries/user-media-events.queries.js';
import { ADMIN_AUDIT_LOG_RETENTION_DAYS } from '$lib/server/config.js';
import { isUserId, toUserId } from '$lib/shared/user-id.js';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const BUCKET_MINUTES = 60;
const GROUP_LIMIT = 200;

// Bulk-mark detector tuning. These match the defaults used elsewhere in
// the codebase: anything that writes ≥ 50 events in a 10s window is
// almost certainly a Jellyfin "Mark series as played" cascade or similar.
const BULK_WINDOW_MS = 10_000;
const BULK_MIN_EVENT_COUNT = 50;

// Repudiated jellyfin-sync windows whose Jellyfin unmark may not have taken.
// Whether it took is read from the audit row, so look back no further than
// the admin audit retention: an older window would read as "no record".
const PENDING_UNMARK_LIMIT = 20;

export interface SummaryBySource {
    source: string;
    event_count: number;
}

export interface PageData {
    userId: string;
    groups: ProvenanceGroup[];
    totalEvents: number;
    /** True when the loader hit GROUP_LIMIT and the derived stats under-count. */
    totalEventsIsCapped: boolean;
    bySource: SummaryBySource[];
    earliestEvent: string | null;
    latestEvent: string | null;
    bucketMinutes: number;
    bulkMarkWindows: BulkMarkWindow[];
    pendingJellyfinUnmarks: PendingJellyfinUnmarkWindow[];
}

export const load: PageServerLoad = async ({ params, locals }) => {
    if (!localsIsAdmin(locals)) {
        redirect(303, appPath('/'));
    }

    // The [userId] route param is the user's stable users.id UUID — validate
    // the shape and mint the brand at this trusted boundary.
    if (!isUserId(params.userId)) {
        throw error(404, 'Not found');
    }
    const userId = toUserId(params.userId);

    const sql = getDb();
    if (!sql) {
        throw error(503, 'Database not available');
    }

    const [groups, bulkMarkWindows, pendingJellyfinUnmarks] = await Promise.all([
        getProvenanceGroups.all(sql, {
            userId,
            bucketMinutes: BUCKET_MINUTES,
            limit: GROUP_LIMIT,
        }),
        detectBulkMarkWindows.all(sql, {
            userId,
            windowMs: BULK_WINDOW_MS,
            minEventCount: BULK_MIN_EVENT_COUNT,
        }),
        getPendingJellyfinUnmarkWindows(sql, {
            userId,
            lookbackDays: ADMIN_AUDIT_LOG_RETENTION_DAYS,
            limit: PENDING_UNMARK_LIMIT,
        }),
    ]);

    // Derive summary stats from the groups we already loaded so we avoid
    // extra queries. Note: this under-counts when groups > GROUP_LIMIT, but
    // that is acceptable for an operator overview.
    let totalEvents = 0;
    let earliestEvent: string | null = null;
    let latestEvent: string | null = null;
    const sourceMap = new Map<string, number>();

    for (const g of groups) {
        totalEvents += g.event_count;

        const bucketStr = g.bucket_start;
        if (!earliestEvent || bucketStr < earliestEvent) {
            earliestEvent = bucketStr;
        }
        if (!latestEvent || bucketStr > latestEvent) {
            latestEvent = bucketStr;
        }

        const prev = sourceMap.get(g.source) ?? 0;
        sourceMap.set(g.source, prev + g.event_count);
    }

    const bySource: SummaryBySource[] = [...sourceMap.entries()]
        .map(([source, event_count]) => ({ source, event_count }))
        .sort((a, b) => b.event_count - a.event_count);

    return {
        userId,
        groups,
        totalEvents,
        totalEventsIsCapped: groups.length === GROUP_LIMIT,
        bySource,
        earliestEvent,
        latestEvent,
        bucketMinutes: BUCKET_MINUTES,
        bulkMarkWindows,
        pendingJellyfinUnmarks,
    } satisfies PageData;
};
