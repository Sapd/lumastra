// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Input rows for the "New episodes available" rule
 * (`services/new-release-rule.ts`). The rule itself is applied in TypeScript;
 * these queries only gather what it needs, so the rule stays unit-testable.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { AIRING_TMDB_STATUSES } from './airing-series.queries.js';

/** Provider `status` values of a series that still gets new episodes (TMDB + TVDB). */
export const AIRING_SERIES_STATUSES: readonly string[] = [
    ...AIRING_TMDB_STATUSES,
    'Continuing',
    'Upcoming',
];
const ENDED_SERIES_STATUSES: readonly string[] = ['Ended', 'Canceled', 'Cancelled'];

export interface SeriesFollowRow {
    series_id: string;
    series_title: string;
    watched_episode_count: number;
    watched_moment_count: number;
    last_watched_at: Date | null;
    newest_watched_air_date: Date | null;
    explicitly_followed: boolean;
    in_watchlist: boolean;
    /** Provider status (aggregated first, then TMDB/TVDB), null when unknown. */
    series_status: string | null;
}

/** true = airing, false = ended, null = unknown status. */
export function isAiringStatus(status: string | null): boolean | null {
    if (!status) return null;
    if (AIRING_SERIES_STATUSES.includes(status)) return true;
    if (ENDED_SERIES_STATUSES.includes(status)) return false;
    return null;
}

type FollowScope = { kind: 'user'; userId: UserId } | { kind: 'series'; seriesId: string };

/** A follow-state row of one (user, series) pair; the series → users direction. */
export interface SeriesFollowerRow extends SeriesFollowRow {
    user_id: string;
}

/**
 * One SQL body for both directions; only the scope predicates differ.
 * Not access-filtered: callers gate what they show or send.
 */
async function selectSeriesFollowStates(
    sql: postgres.Sql,
    scope: FollowScope,
    momentGapSeconds: number,
): Promise<SeriesFollowerRow[]> {
    const watchedScope =
        scope.kind === 'user'
            ? sql`ums.user_id = ${scope.userId}::uuid`
            : sql`season.parent_id = ${scope.seriesId}::uuid`;
    // target_id is compared as text in the series scope (series.id::text is
    // canonical lowercase, which is what the flag endpoint writes); the user
    // scope casts, guarded by CASE against non-UUID target_ids of other flag types.
    const followedSeries =
        scope.kind === 'user'
            ? sql`CASE
                       WHEN f.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN f.target_id::uuid
                   END`
            : sql`${scope.seriesId}::uuid`;
    const followedScope =
        scope.kind === 'user'
            ? sql`f.user_id = ${scope.userId}::uuid`
            : sql`LOWER(f.target_id) = LOWER(${scope.seriesId}::text)`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- the callers access-filter the series ids (filterAccessibleMediaIds) before any row is shown or sent.
    const rows = await sql<SeriesFollowerRow[]>`
        WITH watched_rows AS (
            SELECT ums.user_id,
                   season.parent_id AS series_id,
                   ep.id AS episode_id,
                   ep.premiere_date,
                   ums.last_watched_at
            FROM user_media_state ums
            JOIN media_items ep ON ep.id = ums.media_id AND ep.media_type = 'episode'
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE ${watchedScope}
              AND ums.is_watched = true
        ),
        -- Viewing moments as in series-interest.service.ts: rows less than
        -- momentGapSeconds apart are one moment, all undated
        -- rows together are one moment.
        marked AS (
            SELECT wr.*,
                   CASE
                       WHEN lag(last_watched_at) OVER w IS NULL
                           THEN CASE WHEN row_number() OVER w = 1 OR last_watched_at IS NOT NULL THEN 1 ELSE 0 END
                       WHEN last_watched_at - lag(last_watched_at) OVER w
                           >= make_interval(secs => ${momentGapSeconds}::int) THEN 1
                       ELSE 0
                   END AS starts_moment
            FROM watched_rows wr
            WINDOW w AS (PARTITION BY user_id, series_id ORDER BY last_watched_at NULLS FIRST)
        ),
        watched AS (
            SELECT user_id,
                   series_id,
                   COUNT(DISTINCT episode_id)::int AS watched_episode_count,
                   SUM(starts_moment)::int AS watched_moment_count,
                   MAX(last_watched_at) AS last_watched_at,
                   MAX(premiere_date) AS newest_watched_air_date
            FROM marked
            GROUP BY user_id, series_id
        ),
        followed AS (
            SELECT DISTINCT f.user_id, ${followedSeries} AS series_id
            FROM user_media_flags f
            WHERE ${followedScope}
              AND f.flag_type = 'series_episode_notifications'
              AND (f.expires_at IS NULL OR f.expires_at > NOW())
        ),
        candidates AS (
            SELECT user_id, series_id FROM watched
            UNION
            SELECT user_id, series_id FROM followed WHERE series_id IS NOT NULL
        )
        SELECT c.user_id::text AS user_id,
               s.id::text AS series_id,
               s.title AS series_title,
               COALESCE(w.watched_episode_count, 0)::int AS watched_episode_count,
               COALESCE(w.watched_moment_count, 0)::int AS watched_moment_count,
               w.last_watched_at,
               w.newest_watched_air_date::timestamptz AS newest_watched_air_date,
               EXISTS (
                   SELECT 1 FROM followed fo
                   WHERE fo.user_id = c.user_id AND fo.series_id = s.id
               ) AS explicitly_followed,
               EXISTS (
                   SELECT 1
                   FROM playlists p
                   JOIN playlist_items pi ON pi.playlist_id = p.id
                   WHERE p.user_id = c.user_id
                     AND p.playlist_type = 'watchlist'
                     AND pi.media_id = s.id
               ) AS in_watchlist,
               (
                   SELECT pm.metadata->>'status'
                   FROM provider_metadata pm
                   WHERE pm.media_id = s.id
                     AND pm.metadata->>'status' IS NOT NULL
                   ORDER BY (pm.provider = 'aggregated') DESC, (pm.provider = 'tmdb') DESC, pm.provider
                   LIMIT 1
               ) AS series_status
        FROM candidates c
        JOIN media_items s ON s.id = c.series_id
        LEFT JOIN watched w ON w.user_id = c.user_id AND w.series_id = s.id
        WHERE s.media_type = 'tv'
          AND s.status = 'active'
    `;
    return rows.map((r) => ({
        ...r,
        watched_episode_count: Number(r.watched_episode_count),
        watched_moment_count: Number(r.watched_moment_count),
    }));
}

/**
 * Every series the user has watched an episode of or explicitly follows,
 * with the watch facts the rule needs. Not access-filtered: the caller runs
 * the result through `filterAccessibleMediaIds` before anything is shown.
 */
export async function getSeriesFollowStates(
    sql: postgres.Sql,
    userId: UserId,
    /** SERIES_INTEREST_MOMENT_GAP_SECONDS, passed in to keep queries free of service imports. */
    momentGapSeconds: number,
): Promise<SeriesFollowRow[]> {
    const rows = await selectSeriesFollowStates(sql, { kind: 'user', userId }, momentGapSeconds);
    return rows.map(({ user_id: _userId, ...row }) => row);
}

/**
 * The same facts for one series, one row per user who has watched an episode
 * of it or explicitly follows it. The `library.new_episode` notifier's
 * direction. Not access-filtered.
 */
export async function getSeriesFollowers(
    sql: postgres.Sql,
    seriesId: string,
    momentGapSeconds: number,
): Promise<SeriesFollowerRow[]> {
    return selectSeriesFollowStates(sql, { kind: 'series', seriesId }, momentGapSeconds);
}

export interface EpisodeArrivalRow {
    id: string;
    series_id: string;
    season_number: number;
    episode_number: number;
    title: string | null;
    overview: string | null;
    runtime_seconds: number | null;
    air_date: Date | null;
    file_added_at: Date | null;
    watched: boolean;
}

/**
 * Episodes with a file of the given series that the rule could pick, plus
 * their arrival-batch siblings: everything that aired in the last
 * `lookbackDays`, or whose file arrived in that span (so a bulk import is
 * seen as a whole). Duplicate S/E rows collapse to the oldest row.
 *
 * `userId` null (the notifier, which judges many users at once) reports
 * `watched` false for every row. `includeEpisodeId` is returned even without
 * `has_files` or outside the lookback: the episode that just became playable
 * is judged on its own air date, whatever state its row is in yet.
 */
export async function getEpisodeArrivalsForSeries(
    sql: postgres.Sql,
    userId: UserId | null,
    seriesIds: readonly string[],
    lookbackDays: number,
    options: { includeEpisodeId?: string } = {},
): Promise<EpisodeArrivalRow[]> {
    if (seriesIds.length === 0) return [];
    const include = options.includeEpisodeId
        ? sql`OR ep.id = ${options.includeEpisodeId}::uuid`
        : sql``;
    const watched = userId
        ? sql`EXISTS (
                   SELECT 1 FROM user_media_state ums
                   WHERE ums.user_id = ${userId}::uuid
                     AND ums.media_id = ep.id
                     AND ums.is_watched = true
               )`
        : sql`false`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- seriesIds were access-filtered by the caller (filterAccessibleMediaIds).
    return sql<EpisodeArrivalRow[]>`
        SELECT DISTINCT ON (season.parent_id, COALESCE(ep.season_number, season.season_number), ep.episode_number)
               ep.id::text AS id,
               season.parent_id::text AS series_id,
               COALESCE(ep.season_number, season.season_number) AS season_number,
               ep.episode_number,
               ep.title,
               ep.overview,
               ep.runtime_seconds,
               ep.premiere_date::timestamptz AS air_date,
               COALESCE(ep.library_added_at, ep.first_file_at, ep.created_at) AS file_added_at,
               ${watched} AS watched
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ANY(${seriesIds as string[]}::uuid[])
          AND ep.media_type = 'episode'
          AND ep.status = 'active'
          AND COALESCE(ep.season_number, season.season_number) IS NOT NULL
          AND ep.episode_number IS NOT NULL
          AND (
              (
                  ep.has_files = true
                  AND (
                      ep.premiere_date >= (NOW() - make_interval(days => ${lookbackDays}))::date
                      OR COALESCE(ep.library_added_at, ep.first_file_at, ep.created_at)
                          >= NOW() - make_interval(days => ${lookbackDays})
                  )
              )
              ${include}
          )
        ORDER BY season.parent_id, COALESCE(ep.season_number, season.season_number), ep.episode_number,
                 ep.created_at ASC, ep.id ASC
    `;
}
