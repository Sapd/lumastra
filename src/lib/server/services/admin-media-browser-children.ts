// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Series drill-down for the admin media browser (triage spec §4): a series'
 * seasons and episodes, grouped for the tree rows, each with the same issue
 * badges as a list row.
 *
 * The rows come from `listAdminMediaItems` scoped with `ancestorId`, so a
 * child row's issues are computed by exactly the columns and
 * `deriveMediaIssues` call the page uses. This module only groups them.
 */

import type postgres from 'postgres';
import {
    listAdminMediaItems,
    type AdminMediaRow,
} from '$lib/server/database/queries/admin-media.queries.js';
import type { MediaIssue } from '$lib/shared/media-issues.js';
import { issuesForAdminRow } from './admin-media-issues.js';

/** Upper bound on descendants fetched for one series (long-running anime run past 1,000). */
export const BROWSER_CHILDREN_LIMIT = 5000;

export interface BrowserChildRow {
    id: string;
    title: string;
    mediaType: string;
    seasonNumber?: number;
    episodeNumber?: number;
    hasFiles: boolean;
    issues: MediaIssue[];
}

export interface BrowserSeasonGroup {
    /** The season row, or undefined for episodes parented directly to the series. */
    season?: BrowserChildRow;
    seasonNumber: number;
    episodes: BrowserChildRow[];
    /** Episodes that have files, for the "13 of 13 have files" line. */
    withFiles: number;
}

function toChild(r: AdminMediaRow, jellyfinEnabled: boolean): BrowserChildRow {
    return {
        id: r.id,
        title: r.title ?? 'Untitled',
        mediaType: r.media_type,
        seasonNumber: r.season_number ?? undefined,
        episodeNumber: r.episode_number ?? undefined,
        hasFiles: r.has_files,
        issues: issuesForAdminRow(r, jellyfinEnabled),
    };
}

/**
 * Group descendant rows into seasons. Episodes attach to their parent season
 * row when there is one, else to a virtual group by `season_number` (an
 * episode parented directly to the series). Sorted by season, then episode.
 */
export function groupBrowserChildren(
    rows: readonly AdminMediaRow[],
    jellyfinEnabled: boolean,
): BrowserSeasonGroup[] {
    const bySeasonId = new Map<string, BrowserSeasonGroup>();
    const virtual = new Map<number, BrowserSeasonGroup>();

    for (const r of rows) {
        if (r.media_type !== 'season') continue;
        bySeasonId.set(r.id, {
            season: toChild(r, jellyfinEnabled),
            seasonNumber: r.season_number ?? 0,
            episodes: [],
            withFiles: 0,
        });
    }
    for (const r of rows) {
        if (r.media_type !== 'episode') continue;
        let group = r.parent_id ? bySeasonId.get(r.parent_id) : undefined;
        if (!group) {
            const sn = r.season_number ?? 0;
            group = virtual.get(sn);
            if (!group) {
                group = { seasonNumber: sn, episodes: [], withFiles: 0 };
                virtual.set(sn, group);
            }
        }
        group.episodes.push(toChild(r, jellyfinEnabled));
        if (r.has_files) group.withFiles++;
    }

    const groups = [...bySeasonId.values(), ...virtual.values()];
    for (const g of groups) {
        g.episodes.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
    }
    return groups.sort((a, b) => a.seasonNumber - b.seasonNumber);
}

export interface BrowserChildrenResult {
    seasons: BrowserSeasonGroup[];
    /**
     * More descendants exist than BROWSER_CHILDREN_LIMIT. Prod's largest series
     * has 10,803 episodes (2026-09-27); the tree says so rather than looking
     * complete while missing half of them.
     */
    truncated: boolean;
}

export async function getBrowserChildren(
    sql: postgres.Sql,
    seriesId: string,
    jellyfinEnabled: boolean,
): Promise<BrowserChildrenResult> {
    const rows = await listAdminMediaItems(sql, {
        types: ['season', 'episode'],
        ancestorId: seriesId,
        // Missing episodes are part of what a completeness check shows.
        showUnavailable: true,
        sortBy: 'hierarchy',
        // One extra row tells a full page from a truncated one.
        limit: BROWSER_CHILDREN_LIMIT + 1,
        offset: 0,
    });
    const truncated = rows.length > BROWSER_CHILDREN_LIMIT;
    return {
        seasons: groupBrowserChildren(
            truncated ? rows.slice(0, BROWSER_CHILDREN_LIMIT) : rows,
            jellyfinEnabled,
        ),
        truncated,
    };
}
