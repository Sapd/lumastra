// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Played / total episode counts for the series and seasons on one page of a
 * Jellyfin (`/j`) listing — Jellyfin's `GetPlayedAndTotalCountBatch`: one
 * set-based query per page, never one per row.
 *
 * Counted episodes are the ones the user could list: active, file-backed,
 * not hidden by an alternate episode ordering, in an active season, with the
 * season and the episode in libraries the user may see. Age policy belongs to
 * the series (like series-episode-counts.queries.ts and episode search):
 * seasons and episodes carry no populated rating, so the limit is applied to
 * the series row.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder';
import { deniesEverything } from './builders/media-access-boundary.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from './episode-search.queries.js';

export interface FolderEpisodeCounts {
    /** Series: seasons with at least one counted episode. Season: counted episodes. */
    childCount: number;
    /** Counted episodes under the folder (Jellyfin `RecursiveItemCount`). */
    totalCount: number;
    /** Counted episodes the user has watched. */
    playedCount: number;
}

export interface FolderEpisodeCountsOptions {
    folderIds: readonly string[];
    userId: UserId | undefined;
    access: MediaAccessBoundary;
}

interface FolderCountRow {
    id: string;
    media_type: string;
    child_count: number;
    total: number;
    played: number;
}

/**
 * The aggregate behind {@link getFolderEpisodeCounts}, exported so tests can
 * `EXPLAIN` exactly the statement production runs.
 */
export function buildFolderEpisodeCountsQuery(
    sql: postgres.Sql,
    options: FolderEpisodeCountsOptions,
): postgres.PendingQuery<FolderCountRow[]> {
    const ids = [...new Set(options.folderIds)];
    const uid = sql`${options.userId ?? null}::uuid`;
    const denied = deniesEverything(options.access);
    const episodeFilters = (): postgres.PendingQuery<postgres.Row[]> => sql`
        AND ep.media_type = 'episode'
        AND ep.status = 'active'
        AND ep.has_files = true
        AND EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = ep.id)
        ${buildUnmappedEpisodeFilterFragment(sql, 'ep')}
        AND season.status = 'active'
        ${buildLibraryAccessFilter(sql, options.access.library, 'season')}
        ${buildLibraryAccessFilter(sql, options.access.library, 'ep')}
        ${buildAgeRatingFilter(sql, options.access.age, 'series')}
        ${denied ? sql`AND false` : sql``}
    `;

    // Two plain branches (series → season → episode, season → episode) so each
    // walks idx_media_items_parent_id; the watched probe is a user_media_state
    // primary-key lookup per episode.
    return sql<FolderCountRow[]>`
        WITH folder AS (
            SELECT f.id, f.media_type
            FROM media_items f
            WHERE f.id = ANY(${ids}::uuid[]) AND f.media_type IN ('tv', 'season')
        ),
        counted AS (
            SELECT folder.id AS folder_id, ep.id AS episode_id, season.id AS season_id
            FROM folder
            JOIN media_items series ON series.id = folder.id
            JOIN media_items season ON season.parent_id = series.id AND season.media_type = 'season'
            JOIN media_items ep ON ep.parent_id = season.id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            WHERE folder.media_type = 'tv'
            ${episodeFilters()}
            UNION ALL
            SELECT folder.id AS folder_id, ep.id AS episode_id, season.id AS season_id
            FROM folder
            JOIN media_items season ON season.id = folder.id
            JOIN media_items series ON series.id = season.parent_id
            JOIN media_items ep ON ep.parent_id = season.id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            WHERE folder.media_type = 'season'
            ${episodeFilters()}
        ),
        -- Aggregate per folder BEFORE joining back to the folder list. Joining
        -- folder straight to counted let the planner (it sees the id = ANY(list)
        -- CTE as ~1 row) re-run the whole counted subtree once per folder:
        -- O(folders^2) work, 89 s for one 980-series page on prod (2026-10).
        agg AS MATERIALIZED (
            SELECT
                c.folder_id,
                COUNT(DISTINCT c.season_id)::int AS child_count,
                COUNT(c.episode_id)::int AS total,
                COUNT(c.episode_id) FILTER (WHERE ums.is_watched)::int AS played
            FROM counted c
            LEFT JOIN user_media_state ums ON ums.user_id = ${uid} AND ums.media_id = c.episode_id
            GROUP BY c.folder_id
        )
        SELECT
            folder.id::text AS id,
            folder.media_type,
            COALESCE(agg.child_count, 0)::int AS child_count,
            COALESCE(agg.total, 0)::int AS total,
            COALESCE(agg.played, 0)::int AS played
        FROM folder
        LEFT JOIN agg ON agg.folder_id = folder.id
    `;
}

/**
 * Counts for every `tv` / `season` id in `folderIds` (other ids are ignored and
 * absent from the result). A folder with no counted episode maps to zeros.
 */
export async function getFolderEpisodeCounts(
    sql: postgres.Sql,
    options: FolderEpisodeCountsOptions,
): Promise<Map<string, FolderEpisodeCounts>> {
    const out = new Map<string, FolderEpisodeCounts>();
    if (options.folderIds.length === 0) return out;
    const rows = await buildFolderEpisodeCountsQuery(sql, options);
    for (const r of rows) {
        out.set(r.id, {
            childCount: r.media_type === 'season' ? r.total : r.child_count,
            totalCount: r.total,
            playedCount: r.played,
        });
    }
    return out;
}
