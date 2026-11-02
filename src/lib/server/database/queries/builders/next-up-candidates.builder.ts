// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Next-Up candidate CTEs — the single definition of "which episode is next"
 * for a user, shared by every surface that renders a Next Up list.
 *
 * Why this is a builder and not two hand-written queries: the web strip
 * (`getNextUpFromDb`) and the Jellyfin compatibility layer
 * (`getNextUpEpisodes`) each grew their own version, and they disagreed.
 * The Jellyfin one picked the *first unwatched episode anywhere in the
 * series*, so a single gap anywhere in the back catalogue pinned Next Up to
 * the start of a show forever: a user who finished all 176 episodes of TNG
 * but never marked S01E02 watched got "S01E02 — The Naked Now" offered as
 * his next episode, indefinitely. Same for a re-watcher who is on S23 of One
 * Piece but never watched S01.
 *
 * The correct model — the one the web strip already used — anchors on the
 * *most recently watched* episode and returns the first episode ordered
 * strictly after it. Gaps behind the anchor stay behind the anchor.
 *
 * Consumers get the candidate identity only (`series_id`, `media_id`, the
 * ordering-aware season/episode numbers, and the anchor's timestamp/source).
 * Everything else — artwork, overviews, external ids, access filters — is
 * the consumer's own SELECT, because the two surfaces genuinely need
 * different shapes.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';
import { buildAutoEpisodeOrderingJoinFragment } from '../episode-search.queries.js';

/**
 * When a completion became known, falling back to the historical watch date
 * for legacy state without an event log. Jellyfin can change Played while
 * retaining its old LastPlayedDate; that newly received completion still wins
 * over an earlier partial or NextUp anchor. An older completion remains a
 * valid next episode when a newer anchor represents a genuine re-watch.
 */
export function buildCompletionActivityAt(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: postgres.PendingQuery<postgres.Row[]>,
    fallback: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`COALESCE((
        SELECT MAX(completion.recorded_at) FROM user_media_events completion
        WHERE completion.user_id = ${userId}
          AND completion.media_id = ${mediaId}
          AND completion.event_type IN ('mark_watched', 'completed')
          AND completion.repudiated_at IS NULL
    ), ${fallback})`;
}

/** Exclude completions received at/after the anchor; older completions permit re-watching. */
export function buildNextUpCompletionFilter(
    sql: postgres.Sql,
    userId: UserId,
    anchorActivity: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`NOT EXISTS (
        SELECT 1 FROM user_media_state next_state
        WHERE next_state.user_id = ${userId} AND next_state.media_id = mi.id
          AND next_state.is_watched = true
          AND COALESCE(
              ${buildCompletionActivityAt(sql, userId, sql`next_state.media_id`, sql`next_state.last_watched_at`)} >= ${anchorActivity},
              true
          )
    )`;
}

export interface NextUpCandidateOptions {
    userId: UserId;
    /**
     * Drop series whose latest watch activity is older than this many days.
     * `0` disables the cutoff. Symmetric with the Continue Watching query so
     * a genuinely abandoned series doesn't surface as "next up" forever after
     * a single watched episode.
     */
    maxAgeDays: number;
    /** Restrict to a single series UUID (Jellyfin's `?seriesId=` filter). */
    seriesId?: string | null;
    /**
     * Require `status = 'active'` on the episode and its series. The Jellyfin
     * layer sets this because its browse surfaces are uniformly status-gated;
     * the web strip historically did not and stays as-is.
     */
    requireActiveStatus?: boolean;
    /**
     * Only offer an episode the user has NOT watched (Jellyfin's
     * `enableRewatching=false`): the first unwatched episode after the
     * anchor, so a re-watch of a finished show drops out instead of
     * following the re-watch. Off by default — the shared model follows
     * re-watches.
     */
    requireUnwatchedNext?: boolean;
    /** Jellyfin `nextUpDateCutoff`: ignore watch activity before this instant. */
    minLastWatchedAt?: Date | null;
}

/**
 * Emit the `WITH …` prefix defining `next_up_candidates`.
 *
 * Columns exposed by `next_up_candidates`:
 *   series_id, media_id, season_number, episode_number,
 *   last_watched_at, last_event_source
 *
 * Callers continue the statement with their own `SELECT … FROM
 * next_up_candidates ne JOIN media_items mi ON mi.id = ne.media_id …`.
 */
export function buildNextUpCandidateCtes(
    sql: postgres.Sql,
    {
        userId,
        maxAgeDays,
        seriesId = null,
        requireActiveStatus = false,
        requireUnwatchedNext = false,
        minLastWatchedAt = null,
    }: NextUpCandidateOptions,
): postgres.PendingQuery<postgres.Row[]> {
    const seriesFilter = seriesId ? sql`AND season.parent_id = ${seriesId}::uuid` : sql``;

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- deliberately boundary-free: this builder only decides WHICH episode is next per series. Both consumers gate the result — the Jellyfin query appends buildLibraryAccessFilter/buildAgeRatingFilter to its own WHERE, and the web strip runs the rows through resolveAllowedMediaIds() in effective-watching.service.ts. Duplicating the gate here would need the boundary threaded through a primitive that has no use for it.
    return sql`
        WITH eligible_series AS (
            -- Drop series whose only watched episodes were imported via
            -- the one-time migration source. Lifted out of
            -- watched_per_series so we can use DISTINCT ON below (which
            -- can't carry a HAVING). For users with mixed sources, this
            -- still lets the series through and the most-recent-engaged
            -- row anchors NextUp.
            SELECT season.parent_id AS series_id
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            ${
                requireActiveStatus
                    ? // eslint-disable-next-line callback-safety/no-unscoped-media-items -- see the note on the outer template; this fragment only narrows to active series.
                      sql`JOIN media_items series ON series.id = season.parent_id
                            AND series.media_type = 'tv'
                            AND series.status = 'active'`
                    : sql``
            }
            WHERE uws.user_id = ${userId}
              AND uws.is_watched = true
              AND mi.media_type = 'episode'
              ${seriesFilter}
            GROUP BY season.parent_id
            HAVING bool_or(
                COALESCE(uws.last_event_source, '') <> 'migration'
            )
        ),
        watched_per_series AS (
            -- Anchor on the *most recently watched* episode per series,
            -- not the furthest-forward in season/episode order. Re-watching
            -- an old completion bumps last_watched_at to today, so the
            -- anchor follows the user's current binge — whether it's a
            -- first watchthrough (anchor advances normally) or a re-watch
            -- (anchor walks back to the freshly re-completed episode and
            -- NextUp tracks the re-watch position). For migration-only or
            -- pre-migration completions the timestamps tie, and the
            -- order-DESC tiebreak preserves the prior "max watched"
            -- behaviour: the finale wins and no next exists.
            --
            -- last_event_source mirrors the row that won the DISTINCT ON,
            -- so the suspicion UI sees the source that drove the
            -- *current* anchor (relevant when ranking re-watches as
            -- legitimate vs. bulk-imported activity).
            SELECT DISTINCT ON (season.parent_id)
                season.parent_id AS series_id,
                (COALESCE(eo.order_season_number, mi.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                 + COALESCE(eo.order_episode_number, mi.episode_number)) AS recent_watched_order,
                uws.last_watched_at,
                uws.last_event_source,
                ${buildCompletionActivityAt(sql, userId, sql`uws.media_id`, sql`uws.last_watched_at`)} AS completed_activity_at
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            JOIN eligible_series es ON es.series_id = season.parent_id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
            WHERE uws.user_id = ${userId}
              AND uws.is_watched = true
              AND mi.media_type = 'episode'
              AND mi.parent_id IS NOT NULL
              -- Exclude ordering segments from anchor selection
              AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
              -- Specials (season 0) must not anchor: a user who finished a
              -- behind-the-scenes special shouldn't have NextUp jump
              -- backward to S1E1. Effective season uses the active
              -- ordering when present, falls through to stored otherwise.
              AND COALESCE(eo.order_season_number, mi.season_number) > 0
              -- Drop series whose latest activity is older than the cutoff.
              -- maxAgeDays = 0 disables the filter.
              AND (
                  ${maxAgeDays} = 0
                  OR uws.last_watched_at IS NULL
                  OR uws.last_watched_at >= NOW() - (${maxAgeDays} || ' days')::interval
              )
              ${minLastWatchedAt ? sql`AND uws.last_watched_at >= ${minLastWatchedAt}` : sql``}
            ORDER BY
                season.parent_id,
                -- Deprioritize migration rows that share their
                -- last_watched_at with 3+ siblings in the same series.
                -- That signature only exists for bulk-import wall-clocks
                -- (migration's COALESCE fallback when Jellyfin had no
                -- LastPlayedDate); real per-row Jellyfin timestamps are
                -- per-second and effectively never tie 3+ rows. Without
                -- this guard a real older non-migration anchor (e.g. a
                -- jellyfin-sync row from before migration ran) loses to
                -- the migration's freshly-stamped bulk batch: a genuine
                -- finale watch can be passed over for an earlier episode
                -- carrying a newer bulk-import timestamp. Bulk rows still
                -- anchor when no other candidate exists in the window.
                CASE
                    WHEN COALESCE(uws.last_event_source, '') = 'migration'
                         AND COUNT(*) OVER (
                             PARTITION BY season.parent_id, uws.last_watched_at
                         ) >= 3
                    THEN 1 ELSE 0
                END ASC,
                uws.last_watched_at DESC NULLS LAST,
                (COALESCE(eo.order_season_number, mi.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                 + COALESCE(eo.order_episode_number, mi.episode_number)) DESC
        ),
        next_up_candidates AS (
            -- Find the first sequential episode strictly after the anchor.
            -- Older completions stay eligible so a full prior watchthrough
            -- does not hide the next episode during a genuine re-watch.
            -- Completions received at/after the anchor are skipped below,
            -- even when the provider retained an older watch date.
            SELECT DISTINCT ON (season.parent_id)
                season.parent_id AS series_id,
                mi.id AS media_id,
                COALESCE(eo.order_season_number, mi.season_number) AS season_number,
                COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
                wps.last_watched_at,
                wps.last_event_source
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            JOIN watched_per_series wps ON wps.series_id = season.parent_id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
            WHERE mi.media_type = 'episode'
              ${requireActiveStatus ? sql`AND mi.status = 'active'` : sql``}
              AND COALESCE(eo.order_season_number, mi.season_number) > 0
              AND (COALESCE(eo.order_season_number, mi.season_number) * ${EPISODE_ORDER_MULTIPLIER} + COALESCE(eo.order_episode_number, mi.episode_number)) > wps.recent_watched_order
              -- Exclude ordering segments (unmapped episodes when ordering is active)
              AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
              ${
                  requireUnwatchedNext
                      ? sql`AND NOT EXISTS (
                  SELECT 1 FROM user_media_state nw
                  WHERE nw.media_id = mi.id AND nw.user_id = ${userId} AND nw.is_watched
              )`
                      : sql``
              }
              -- Skip episodes the user can't actually play yet. Two cases:
              --   1. Pre-aired metadata stubs from TMDB sync — Lumastra
              --      pre-creates rows for upcoming episodes so the catalog
              --      stays in sync, but the file isn't on disk and Jellyfin
              --      hasn't seen it. Surfaces in Next Up as a phantom that
              --      pretends the user is "behind" on a series they've
              --      actually caught up on.
              --   2. Episodes that were once tracked but are now orphaned
              --      from any source. A retained Jellyfin id is not file evidence.
              -- Don't require premiere_date <= today: a movie/show might be
              -- imported before its official release and still be playable.
              AND mi.has_files = true
              -- A backdated upstream completion can be newer than the anchor
              -- in observation order, even when its watch date is older.
              AND ${buildNextUpCompletionFilter(sql, userId, sql`wps.completed_activity_at`)}
              -- Series the user dismissed from Continue Watching / Next Up
              -- stay dismissed on every surface, not just the one that
              -- offered the dismiss control. target_id is TEXT (migration
              -- 16.108.0); the flag_type guard means only UUID-valued rows
              -- reach the ::uuid cast.
              AND NOT EXISTS (
                  SELECT 1 FROM user_media_flags f
                  WHERE f.user_id = ${userId}
                    AND f.flag_type = 'dismissed_cw'
                    AND f.target_id::uuid = season.parent_id
              )
            ORDER BY season.parent_id, COALESCE(eo.order_season_number, mi.season_number), COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)
        )
    `;
}
