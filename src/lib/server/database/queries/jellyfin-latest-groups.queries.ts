// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin `/Items/Latest` with `GroupItems=true`: which of a series' newly
 * added episodes belong together (BaseItemRepository.GetLatestTvShowItems).
 *
 * For every series on the Latest page this returns the episodes whose file
 * landed within 24 hours of the series' newest one — how many, which seasons
 * they are in and the newest episode — over the episodes the user may list
 * (active, file-backed, season and episode library access, the series' age limit) and, with `isPlayed`, only
 * those in that watched state. The caller decides whether the row is shown as
 * the episode, its season or the series.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from './episode-search.queries.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder';

/** Jellyfin's "added together" window (RecentAdditionWindowHours). */
export const RECENT_ADDITION_WINDOW_HOURS = 24;

export interface LatestSeriesGroup {
    seriesId: string;
    /** Episodes added within the window of the series' newest one. */
    recentCount: number;
    /** Seasons those episodes are in. */
    seasonIds: string[];
    /** The newest of them (ties: highest id, like Jellyfin). */
    newestEpisodeId: string;
    /**
     * When that newest episode's file landed — the series' place in the Latest
     * row (GetLatestTvShowItems orders by it), over the same filtered episodes.
     */
    newestAdded: Date;
}

export interface LatestSeriesGroupsOptions {
    seriesIds: readonly string[];
    userId: UserId | undefined;
    access: MediaAccessBoundary;
    isPlayed?: boolean | null;
    /**
     * Jellyfin's global cutoff: files older than this cannot be in any ranked
     * series' window, so they are never read (the oldest ranked series' newest
     * file minus the window). Absent = every file.
     */
    addedSince?: Date | null;
}

interface LatestSeriesGroupRow {
    series_id: string;
    recent_count: number;
    season_ids: string[];
    newest_episode_id: string;
    newest_added: Date;
}

/** The statement behind {@link getLatestSeriesGroups}, exported so tests can EXPLAIN it. */
export function buildLatestSeriesGroupsQuery(
    sql: postgres.Sql,
    options: LatestSeriesGroupsOptions,
): postgres.PendingQuery<LatestSeriesGroupRow[]> {
    const ids = [...new Set(options.seriesIds)];
    const uid = sql`${options.userId ?? null}::uuid`;
    const watched = sql`EXISTS (
        SELECT 1 FROM user_media_state _u
        WHERE _u.user_id = ${uid} AND _u.media_id = ep.id AND _u.is_watched
    )`;
    const playedFilter =
        options.isPlayed === true
            ? sql`AND ${watched}`
            : options.isPlayed === false
              ? sql`AND NOT ${watched}`
              : sql``;

    return sql<LatestSeriesGroupRow[]>`
        WITH ep_added AS (
            SELECT series.id AS series_id, ep.id AS episode_id, season.id AS season_id,
                   MAX(mf.created_at) AS added
            FROM media_items series
            JOIN media_items season ON season.parent_id = series.id AND season.media_type = 'season'
            JOIN media_items ep ON ep.parent_id = season.id
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id
            JOIN media_files mf ON mf.id = mfi.file_id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            WHERE series.id = ANY(${ids}::uuid[])
              AND ep.media_type = 'episode' AND ep.status = 'active' AND ep.has_files = true
              ${buildUnmappedEpisodeFilterFragment(sql, 'ep')}
              AND season.status = 'active'
              ${buildLibraryAccessFilter(sql, options.access.library, 'season')}
              ${buildLibraryAccessFilter(sql, options.access.library, 'ep')}
              ${buildAgeRatingFilter(sql, options.access.age, 'series')}
              ${playedFilter}
              ${options.addedSince ? sql`AND mf.created_at >= ${options.addedSince}` : sql``}
            GROUP BY series.id, ep.id, season.id
        ),
        recent AS (
            SELECT e.*
            FROM ep_added e
            JOIN (SELECT series_id, MAX(added) AS newest FROM ep_added GROUP BY series_id) n
              ON n.series_id = e.series_id
            WHERE e.added >= n.newest - make_interval(hours => ${RECENT_ADDITION_WINDOW_HOURS})
        )
        SELECT
            series_id::text AS series_id,
            COUNT(*)::int AS recent_count,
            array_agg(DISTINCT season_id::text) AS season_ids,
            (array_agg(episode_id::text ORDER BY added DESC, episode_id DESC))[1] AS newest_episode_id,
            MAX(added) AS newest_added
        FROM recent
        GROUP BY series_id
    `;
}

export async function getLatestSeriesGroups(
    sql: postgres.Sql,
    options: LatestSeriesGroupsOptions,
): Promise<Map<string, LatestSeriesGroup>> {
    const out = new Map<string, LatestSeriesGroup>();
    if (options.seriesIds.length === 0 || deniesEverything(options.access)) return out;
    const rows = await buildLatestSeriesGroupsQuery(sql, options);
    for (const r of rows) {
        out.set(r.series_id, {
            seriesId: r.series_id,
            recentCount: r.recent_count,
            seasonIds: r.season_ids,
            newestEpisodeId: r.newest_episode_id,
            newestAdded: new Date(r.newest_added),
        });
    }
    return out;
}
