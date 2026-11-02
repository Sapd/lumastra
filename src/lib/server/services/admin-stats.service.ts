// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin stats service — shared query logic used by both the SPA-internal
 * /api/watch-stats surface and the public v1 /api/v1/admin/watch-stats surface.
 *
 * Returns a raw `{ stats, day? }` payload. Each route layer applies its own
 * response envelope on top:
 *   - /api/watch-stats        → `{ success: true, stats, day? }` (legacy SPA shape)
 *   - /api/v1/admin/watch-stats → `{ stats, day? }` (v1 contract, no wrapper)
 */

import { userImageSets } from './image-descriptor/avatars.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { Sql } from 'postgres';
import {
    getTopMovies,
    getTopTVShows,
    getActivityStats,
    getTopUsers,
    getActiveUsers,
    getGenreBreakdown,
    getContentFreshness,
    getDayHours,
    getSummary,
    getColdContent,
    getCompletionLeaderboard,
    getDormantUsers,
    getDeviceMix,
    getSurfaceMix,
    type Timeframe,
} from '$lib/server/database/queries/admin-stats.queries.js';
import { PLAY_SESSION_RETENTION_DAYS } from '$lib/server/tasks/builtin/native/database-cleanup.js';

export interface AdminStatsParams {
    type: string;
    timeframe: Timeframe;
    limit: number;
    sort: 'cold' | 'skyline';
    day: string;
    /** Sanitised day value safe for use as a cache-key segment. */
    daySegment: string;
}

/** Raw payload shared across both route surfaces. */
export interface AdminStatsPayload {
    stats: unknown;
    day?: string;
}

/**
 * Run the appropriate stats query for the given params and return a raw
 * `{ stats, day? }` object.  Callers are responsible for caching and for
 * wrapping the result in their own response envelope.
 */
async function withUserImages<T extends { id: string }>(
    sql: Sql,
    rows: T[],
): Promise<(T & { images: ImageSet })[]> {
    const images = await userImageSets(
        sql,
        'internal',
        rows.map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, images: images.get(row.id) ?? {} }));
}

export async function fetchAdminStats(
    sql: Sql,
    params: AdminStatsParams,
): Promise<AdminStatsPayload> {
    const { type, timeframe, limit, sort, day } = params;

    switch (type) {
        case 'movies':
            return { stats: await getTopMovies(sql, timeframe, limit) };
        case 'tvshows':
            return { stats: await getTopTVShows(sql, timeframe, limit) };
        case 'activity':
            return { stats: await getActivityStats(sql, timeframe) };
        case 'top-users':
            return { stats: await withUserImages(sql, await getTopUsers(sql, timeframe, limit)) };
        case 'active-users':
            return { stats: await withUserImages(sql, await getActiveUsers(sql, limit)) };
        case 'genre-breakdown':
            return { stats: await getGenreBreakdown(sql, timeframe, limit) };
        case 'content-freshness':
            return { stats: await getContentFreshness(sql, timeframe) };
        case 'day-hours':
            return { stats: await getDayHours(sql, day, timeframe), day: day || undefined };
        case 'cold-content':
            return { stats: await getColdContent(sql, timeframe, limit, sort) };
        case 'completion-leaderboard':
            return { stats: await getCompletionLeaderboard(sql, timeframe, limit) };
        case 'dormant-users':
            return { stats: await withUserImages(sql, await getDormantUsers(sql, limit)) };
        case 'device-mix':
            return { stats: await getDeviceMix(sql, timeframe) };
        case 'surface-mix':
            // Ignores `timeframe` on purpose: this one reads play_sessions,
            // which is pruned at PLAY_SESSION_RETENTION_DAYS, so an 'AllTime'
            // request has no honest answer. The window is returned in the
            // payload for the UI to caption.
            return { stats: await getSurfaceMix(sql, PLAY_SESSION_RETENTION_DAYS) };
        case 'summary':
        default:
            return { stats: await getSummary(sql) };
    }
}
