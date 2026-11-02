// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import {
    type AgeRatingFilterParams,
    buildSeriesOwnedAgeRatingFilter,
} from '$lib/server/database/queries/builders/age-rating.builder.js';
import type { UserId } from '$lib/shared/user-id.js';

/**
 * One user's watch history for GET /api/v1/integrations/watch-history (an admin
 * service-token endpoint feeding an external recommender). Reads `user_media_state`
 * — the per-(user, item) state the app itself uses — scoped by `user_id` through its
 * primary key, so every query touches one user's rows only.
 *
 * Bulk-sync artefact: the 2026-03-31 Jellyfin import stamped `last_watched_at` /
 * `last_event_at` with the import time (17:00–23:00 UTC) on thousands of rows. Those
 * stamps are not watch dates, so `historyRows()` turns them into NULL
 * ("unknown") before ordering, windowing and the cursor ever see them.
 */

/** Half-open [start, end) UTC window of the 2026-03-31 Jellyfin bulk import. */
export const BULK_IMPORT_ARTEFACT_START = new Date('2026-03-31T17:00:00.000Z');
export const BULK_IMPORT_ARTEFACT_END = new Date('2026-03-31T23:00:00.000Z');

/** Media types listed by the endpoint. Tracks are counted (music log), never listed. */
export const WATCH_HISTORY_MEDIA_TYPES = ['movie', 'episode', 'audiobook'] as const;

export interface WatchHistoryAccess {
    /** Library groups the target user may not see; null = unrestricted. */
    deniedGroupIds: string[] | null;
    /** Target user's age ceiling; null = unrestricted. */
    ageRating: AgeRatingFilterParams | null;
}

export interface WatchHistoryUserRow {
    id: string;
    username: string;
    display_name: string | null;
    is_admin: boolean;
    groups: string[] | null;
    max_age_rating: number | null;
}

export interface WatchHistoryRow {
    media_id: string;
    media_type: string;
    title: string | null;
    year: number | null;
    season_number: number | null;
    episode_number: number | null;
    is_watched: boolean;
    resume_position_ms: string | number;
    runtime_ms: string | number | null;
    watched_at: Date | null;
    series_id: string | null;
    series_title: string | null;
    series_year: number | null;
}

export interface WatchHistoryCursor {
    /** ISO timestamp of the last row on the previous page, or null for an undated row. */
    t: string | null;
    id: string;
}

export interface WatchHistoryGenreRow {
    media_id: string;
    genre_id: number;
    genre_name: string | null;
}

export interface WatchHistoryTopGenreRow {
    genre_id: number;
    genre_name: string | null;
    /** Distinct genre-bearing titles (movie / series / audiobook ids) carrying the genre. */
    title_ids: string[];
}

export interface WatchHistoryStatsRow {
    movies_watched: number;
    episodes_watched: number;
    series_watched: number;
    audiobooks_finished: number;
    in_progress: number;
    active_in_window: number;
    undated: number;
    tracks_played_in_window: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WatchHistoryUserLookup =
    { kind: 'found'; user: WatchHistoryUserRow } | { kind: 'not_found' } | { kind: 'ambiguous' };

/**
 * A live (not deleted) user by UUID or username. A UUID-shaped string is tried as an
 * id first, then as a username. Usernames match exactly first, then case-insensitively;
 * two case-insensitive matches are `ambiguous` (never an arbitrary pick).
 */
export async function findWatchHistoryUser(
    sql: postgres.Sql,
    userOrId: string,
): Promise<WatchHistoryUserLookup> {
    if (UUID_RE.test(userOrId)) {
        const [byId] = await sql<WatchHistoryUserRow[]>`
            SELECT id, username, display_name, is_admin, groups, max_age_rating
            FROM users
            WHERE deleted_at IS NULL AND id = ${userOrId}::uuid`;
        if (byId) return { kind: 'found', user: byId };
    }
    const [exact] = await sql<WatchHistoryUserRow[]>`
        SELECT id, username, display_name, is_admin, groups, max_age_rating
        FROM users
        WHERE deleted_at IS NULL AND username = ${userOrId}`;
    if (exact) return { kind: 'found', user: exact };
    const folded = await sql<WatchHistoryUserRow[]>`
        SELECT id, username, display_name, is_admin, groups, max_age_rating
        FROM users
        WHERE deleted_at IS NULL AND lower(username) = lower(${userOrId})
        LIMIT 2`;
    if (folded.length > 1) return { kind: 'ambiguous' };
    return folded[0] ? { kind: 'found', user: folded[0] } : { kind: 'not_found' };
}

/**
 * The target user's listable state rows joined to their item (and, for an episode,
 * its series), behind the user's CURRENT library/age boundary. `watched_at` is the
 * newer of `last_watched_at` / `last_event_at` after the artefact window is nulled
 * out per column — so a genuine Jellyfin LastPlayedDate survives next to an
 * import-time `last_event_at`.
 */
function historyRows(sql: postgres.Sql, userId: UserId, access: WatchHistoryAccess) {
    const start = BULK_IMPORT_ARTEFACT_START;
    const end = BULK_IMPORT_ARTEFACT_END;
    return sql`
        SELECT
            ums.media_id,
            mi.media_type,
            mi.title,
            COALESCE(mi.year, series.year) AS year,
            COALESCE(mi.season_number, parent.season_number) AS season_number,
            mi.episode_number,
            ums.is_watched,
            ums.resume_position_ms,
            COALESCE(NULLIF(ums.runtime_ms, 0), mi.runtime_seconds::bigint * 1000) AS runtime_ms,
            -- Truncated to milliseconds so the value round-trips through a JS Date in
            -- the cursor exactly (Postgres keeps microseconds).
            date_trunc('milliseconds', GREATEST(
                CASE WHEN ums.last_watched_at >= ${start} AND ums.last_watched_at < ${end}
                     THEN NULL ELSE ums.last_watched_at END,
                CASE WHEN ums.last_event_at >= ${start} AND ums.last_event_at < ${end}
                     THEN NULL ELSE ums.last_event_at END
            )) AS watched_at,
            series.id AS series_id,
            series.title AS series_title,
            series.year AS series_year
        FROM user_media_state ums
        JOIN media_items mi ON mi.id = ums.media_id
        LEFT JOIN media_items parent
          ON parent.id = mi.parent_id AND mi.media_type = 'episode'
        LEFT JOIN media_items grandparent
          ON grandparent.id = parent.parent_id AND parent.media_type = 'season'
        LEFT JOIN LATERAL (
            SELECT s.id, s.title, s.year
            FROM media_items s
            WHERE s.id = COALESCE(grandparent.id, CASE WHEN parent.media_type = 'tv' THEN parent.id END)
        ) series ON TRUE
        WHERE ums.user_id = ${userId}
          AND (ums.is_watched OR ums.resume_position_ms > 0)
          AND mi.media_type = ANY(${[...WATCH_HISTORY_MEDIA_TYPES]})
          ${buildLibraryAccessFilter(sql, access.deniedGroupIds, 'mi')}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.ageRating, 'mi')}
    `;
}

/**
 * One keyset page of the history: dated rows newest first, then undated rows, ties
 * broken by media id. Fetches `limit + 1` so the caller can compute `hasMore`.
 */
export async function getWatchHistoryPage(
    sql: postgres.Sql,
    userId: UserId,
    access: WatchHistoryAccess,
    limit: number,
    cursor: WatchHistoryCursor | null,
): Promise<WatchHistoryRow[]> {
    const after = !cursor
        ? sql``
        : cursor.t === null
          ? sql`WHERE h.watched_at IS NULL AND h.media_id > ${cursor.id}::uuid`
          : sql`WHERE h.watched_at < ${new Date(cursor.t)}
                   OR (h.watched_at = ${new Date(cursor.t)} AND h.media_id > ${cursor.id}::uuid)
                   OR h.watched_at IS NULL`;
    return sql<WatchHistoryRow[]>`
        SELECT h.*
        FROM (${historyRows(sql, userId, access)}) h
        ${after}
        ORDER BY h.watched_at DESC NULLS LAST, h.media_id
        LIMIT ${limit + 1}
    `;
}

/** Genres of the given items; an episode's genres come from its series row. */
export async function getWatchHistoryGenres(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<WatchHistoryGenreRow[]> {
    if (mediaIds.length === 0) return [];
    return sql<WatchHistoryGenreRow[]>`
        SELECT DISTINCT mg.media_id, mg.genre_id, mg.genre_name
        FROM media_genres mg
        WHERE mg.media_id = ANY(${mediaIds}::uuid[])
        ORDER BY mg.media_id, mg.genre_id
    `;
}

/**
 * Genres of the titles watched in the last `days` days, one row per genre id with the
 * distinct TITLES carrying it (a series counts once, however many episodes). Undated
 * rows are outside every window. Unlimited on purpose: the caller merges ids that share
 * a display name (set union) before ranking; a library has a few dozen genre ids.
 */
export async function getWatchHistoryTopGenres(
    sql: postgres.Sql,
    userId: UserId,
    access: WatchHistoryAccess,
    days: number,
): Promise<WatchHistoryTopGenreRow[]> {
    return sql<WatchHistoryTopGenreRow[]>`
        WITH titles AS (
            SELECT DISTINCT COALESCE(h.series_id, h.media_id) AS genre_media_id
            FROM (${historyRows(sql, userId, access)}) h
            WHERE h.watched_at >= NOW() - (${days} * INTERVAL '1 day')
        )
        SELECT mg.genre_id,
               MAX(mg.genre_name) AS genre_name,
               ARRAY_AGG(DISTINCT t.genre_media_id::text) AS title_ids
        FROM titles t
        JOIN media_genres mg ON mg.media_id = t.genre_media_id
        GROUP BY mg.genre_id
        ORDER BY mg.genre_id
    `;
}

export async function getWatchHistoryStats(
    sql: postgres.Sql,
    userId: UserId,
    access: WatchHistoryAccess,
    days: number,
): Promise<WatchHistoryStatsRow> {
    const [row] = await sql<WatchHistoryStatsRow[]>`
        WITH h AS (${historyRows(sql, userId, access)})
        SELECT
            COUNT(*) FILTER (WHERE h.is_watched AND h.media_type = 'movie')::int AS movies_watched,
            COUNT(*) FILTER (WHERE h.is_watched AND h.media_type = 'episode')::int AS episodes_watched,
            COUNT(DISTINCT h.series_id) FILTER (WHERE h.is_watched AND h.media_type = 'episode')::int
                AS series_watched,
            COUNT(*) FILTER (WHERE h.is_watched AND h.media_type = 'audiobook')::int AS audiobooks_finished,
            COUNT(*) FILTER (WHERE NOT h.is_watched)::int AS in_progress,
            COUNT(*) FILTER (WHERE h.watched_at >= NOW() - (${days} * INTERVAL '1 day'))::int
                AS active_in_window,
            COUNT(*) FILTER (WHERE h.watched_at IS NULL)::int AS undated,
            (
                SELECT COUNT(*)::int FROM music_listen_events mle
                WHERE mle.user_id = ${userId}
                  AND mle.duration_ms > 0 -- zero-heard rows are idempotency claims, not plays
                  AND mle.created_at >= NOW() - (${days} * INTERVAL '1 day')
            ) AS tracks_played_in_window
        FROM h
    `;
    return row;
}
