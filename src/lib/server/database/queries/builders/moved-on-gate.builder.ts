// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Moved on" gate — the single definition of when a paused episode leaves
 * Continue Watching because the user has since watched something else of the
 * same series. Shared by the Home strip (`getContinueWatchingFromDb`), the
 * Continue Watching page (`getExactContinueWatchingPageFromDb`) and the
 * Jellyfin `/j` Resume feed (`getResumeItems`), which used to disagree: `/j`
 * had no gate at all, so Infuse kept offering an episode abandoned before the
 * user finished three later ones.
 *
 * An episode A is hidden when either holds:
 *
 * 1. Later-episode gate: a LATER main-line episode (effective order) is
 *    watched with `last_watched_at` after A's last activity. Any completion
 *    counts here, marks and syncs included, so CW agrees with Next Up, which
 *    also advances past marked episodes. Not applied to re-watch rows.
 * 2. Finished-by-playback gate: ANY other main-line episode of the series was
 *    played to the end after A's last activity. Only real playback counts — a
 *    `completed` event from the Lumastra player (web, apps and Jellyfin
 *    clients playing through `/j` all report as `lumastra-player`) or an
 *    offline report. `session_elapsed_ms` is NOT a playback signal: the
 *    Jellyfin/Plex sync writes it too. A mark, a sync or a short wrong tap on
 *    another episode therefore leaves A alone.
 *
 * Nothing is reset: A keeps its resume position, so the episode list still
 * shows its progress and playing it again brings it back (its clock is then
 * newer than the other episode's finish).
 *
 * Specials (effective season 0) never suppress and are never suppressed.
 * Design: docs/superpowers/specs/2026-11-02-cw-moved-on-design.md (repo root).
 *
 * Consumers provide a CTE named `cand_series(series_id, min_clock)` — the
 * series of their gateable candidates and the oldest candidate clock — and
 * add the two CTEs below after it.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** Sources whose `completed` events are a real viewing to the end. */
const PLAYBACK_SOURCES = ['lumastra-player', 'lumastra-offline'];

/**
 * `watched_pos` (later-episode gate) and `playback_finishes` (finished-by-
 * playback gate), both restricted to `cand_series`. Interpolate after the
 * consumer's `cand_series` CTE, separated by a comma.
 */
export function buildMovedOnGateCtes(sql: postgres.Sql, userId: UserId | null): Fragment {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- only decides WHETHER a candidate the consumer already selected is hidden; both consumers apply their own library/age boundary to the rows they return.
    return sql`
        -- Watched episodes of the candidate series, in EFFECTIVE order.
        -- Aliases are suffixed _l for the later-episode side. When no ordering
        -- is active for a series, both sides fall through to stored numbers.
        watched_pos AS (
            SELECT
                later_season.parent_id AS series_id,
                COALESCE(eo_l.order_season_number, later_ep.season_number) AS eff_season,
                COALESCE(eo_l.order_episode_number, later_ep.episode_number) AS eff_episode,
                later_uws.last_watched_at
            FROM user_media_state later_uws
            JOIN media_items later_ep
                ON later_ep.id = later_uws.media_id
            JOIN media_items later_season
                ON later_season.id = later_ep.parent_id
               AND later_season.media_type = 'season'
            JOIN cand_series cs
                ON cs.series_id = later_season.parent_id
            LEFT JOIN series_episode_ordering seo_l
                ON seo_l.media_id = later_season.parent_id
               AND seo_l.ordering_type != 'standard'
            LEFT JOIN episode_orderings eo_l
                ON eo_l.episode_media_id = later_ep.id
               AND eo_l.series_media_id = seo_l.media_id
               AND eo_l.ordering_type = seo_l.ordering_type
               AND eo_l.ordering_group_id = seo_l.ordering_group_id
            WHERE later_uws.user_id = ${userId}::uuid
              AND later_uws.is_watched = true
              AND later_ep.media_type = 'episode'
              AND later_uws.last_watched_at IS NOT NULL
              AND later_ep.season_number IS NOT NULL
              AND later_ep.episode_number IS NOT NULL
              -- Specials never suppress a main-line resume.
              AND COALESCE(eo_l.order_season_number, later_ep.season_number) > 0
        ),
        -- Newest real-playback finish per watched episode of the candidate
        -- series. last_watched_at is the newest positive event, so a finish
        -- after the oldest candidate clock implies last_watched_at after it:
        -- that prefilter bounds the episodes, and the LATERAL walks one
        -- episode's events newest-first on idx_ume_user_media_time, stopping
        -- at the first completion (a few credits heartbeats in). Never
        -- aggregate the user's whole event log: heavy users have 60k+ rows.
        playback_finishes AS (
            SELECT
                fin_season.parent_id AS series_id,
                fin_ep.id AS media_id,
                fin.occurred_at AS finished_at
            FROM user_media_state fin_uws
            JOIN media_items fin_ep
                ON fin_ep.id = fin_uws.media_id
               AND fin_ep.media_type = 'episode'
            JOIN media_items fin_season
                ON fin_season.id = fin_ep.parent_id
               AND fin_season.media_type = 'season'
            JOIN cand_series cs
                ON cs.series_id = fin_season.parent_id
            LEFT JOIN series_episode_ordering seo_f
                ON seo_f.media_id = fin_season.parent_id
               AND seo_f.ordering_type != 'standard'
            LEFT JOIN episode_orderings eo_f
                ON eo_f.episode_media_id = fin_ep.id
               AND eo_f.series_media_id = seo_f.media_id
               AND eo_f.ordering_type = seo_f.ordering_type
               AND eo_f.ordering_group_id = seo_f.ordering_group_id
            -- Events move to user_media_events_archive after a year of
            -- recorded_at; a finish still counts there. Each side stops at
            -- its first match on its (user_id, media_id, occurred_at) index.
            CROSS JOIN LATERAL (
                SELECT MAX(done.occurred_at) AS occurred_at
                FROM (
                    (
                        SELECT e.occurred_at
                        FROM user_media_events e
                        WHERE e.user_id = fin_uws.user_id
                          AND e.media_id = fin_uws.media_id
                          AND e.repudiated_at IS NULL
                          AND e.occurred_at > cs.min_clock
                          AND e.event_type = 'completed'
                          AND e.source = ANY(${PLAYBACK_SOURCES}::text[])
                        ORDER BY e.occurred_at DESC
                        LIMIT 1
                    )
                    UNION ALL
                    (
                        SELECT a.occurred_at
                        FROM user_media_events_archive a
                        WHERE a.user_id = fin_uws.user_id
                          AND a.media_id = fin_uws.media_id
                          AND a.repudiated_at IS NULL
                          AND a.occurred_at > cs.min_clock
                          AND a.event_type = 'completed'
                          AND a.source = ANY(${PLAYBACK_SOURCES}::text[])
                        ORDER BY a.occurred_at DESC
                        LIMIT 1
                    )
                ) done
            ) fin
            WHERE fin_uws.user_id = ${userId}::uuid
              AND fin.occurred_at IS NOT NULL
              AND fin_uws.is_watched = true
              AND fin_uws.last_watched_at > cs.min_clock
              -- Specials never suppress; an episode without a season number
              -- counts as main line.
              AND COALESCE(eo_f.order_season_number, fin_ep.season_number, 1) <> 0
        )
    `;
}

/** Column expressions of the candidate row the gate judges. */
export interface MovedOnGateRow {
    /** Series UUID; NULL for movies, which are never hidden. */
    seriesId: Fragment;
    mediaId: Fragment;
    /** The candidate's last activity (`user_media_state.last_event_at`). */
    clock: Fragment;
    /** Ordering-aware season / episode numbers. */
    effSeason: Fragment;
    effEpisode: Fragment;
    /**
     * TRUE when the later-episode gate may hide this row: a paused
     * (not re-watch) episode with stored season and episode numbers.
     */
    laterGateApplies: Fragment;
}

/**
 * Boolean expression: TRUE when the row stays visible. Requires the CTEs from
 * {@link buildMovedOnGateCtes} in scope.
 */
export function buildMovedOnKeepPredicate(sql: postgres.Sql, row: MovedOnGateRow): Fragment {
    return sql`(
        -- A special is never suppressed.
        (${row.effSeason} IS NOT NULL AND ${row.effSeason} <= 0)
        OR (
            (
                NOT (${row.laterGateApplies})
                OR ${row.effSeason} IS NULL
                OR NOT EXISTS (
                    SELECT 1
                    FROM watched_pos w
                    WHERE w.series_id = ${row.seriesId}
                      AND (
                          ${row.clock} IS NULL
                          OR w.last_watched_at > ${row.clock}
                      )
                      AND (
                          w.eff_season > ${row.effSeason}
                          OR (
                              w.eff_season = ${row.effSeason}
                              AND w.eff_episode > ${row.effEpisode}
                          )
                      )
                )
            )
            AND (
                ${row.clock} IS NULL
                OR NOT EXISTS (
                    SELECT 1
                    FROM playback_finishes pf
                    WHERE pf.series_id = ${row.seriesId}
                      AND pf.media_id <> ${row.mediaId}
                      AND pf.finished_at > ${row.clock}
                )
            )
        )
    )`;
}
