// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * Library counts + the newest additions for the Homepage integration endpoint
 * (GET /api/v1/integrations/homepage). Server-wide by design: the endpoint is
 * admin-only (`{kind:'admin'}`).
 *
 * Deliberately lighter than getMediaBrowserStats(): no external_ids join, only the
 * per-type counts. The caller caches the result for minutes.
 */

export interface HomepageLibraryCounts {
    movies: number;
    series: number;
    episodes: number;
    artists: number;
    albums: number;
    tracks: number;
    audiobooks: number;
}

export interface HomepageRecentRow {
    title: string;
    media_type: string;
    year: number | null;
    added_at: Date;
}

export interface HomepageLibrarySnapshot {
    counts: HomepageLibraryCounts;
    recent: HomepageRecentRow[];
}

export async function getHomepageLibrarySnapshot(
    sql: postgres.Sql,
    recentLimit = 10,
): Promise<HomepageLibrarySnapshot> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- server-wide admin summary, route-gated on admin
    const countsQuery = sql<HomepageLibraryCounts[]>`
        SELECT
            COUNT(*) FILTER (WHERE media_type = 'movie')::int AS movies,
            COUNT(*) FILTER (WHERE media_type = 'tv')::int AS series,
            COUNT(*) FILTER (WHERE media_type = 'episode')::int AS episodes,
            COUNT(*) FILTER (WHERE media_type = 'artist')::int AS artists,
            COUNT(*) FILTER (WHERE media_type = 'album')::int AS albums,
            COUNT(*) FILTER (WHERE media_type = 'track')::int AS tracks,
            COUNT(*) FILTER (WHERE media_type = 'audiobook')::int AS audiobooks
        FROM media_items
        WHERE has_files AND status = 'active'
    `;

    // Same semantics (and partial index idx_media_items_recently_added) as the app's own
    // "Recently added" row: active top-level items with files, newest library add first.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- server-wide admin summary, route-gated on admin
    const recentQuery = sql<HomepageRecentRow[]>`
        SELECT
            mi.title,
            mi.media_type,
            mi.year,
            COALESCE(mi.library_added_at, mi.created_at) AS added_at
        FROM media_items mi
        WHERE mi.status = 'active'
          AND mi.parent_id IS NULL
          AND mi.has_files = true
          AND mi.media_type IN ('movie', 'tv', 'audiobook')
        ORDER BY COALESCE(mi.library_added_at, mi.created_at) DESC
        LIMIT ${recentLimit}
    `;

    const [countRows, recent] = await Promise.all([countsQuery, recentQuery]);
    return {
        counts: countRows[0] ?? {
            movies: 0,
            series: 0,
            episodes: 0,
            artists: 0,
            albums: 0,
            tracks: 0,
            audiobooks: 0,
        },
        recent,
    };
}
