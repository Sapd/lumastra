// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * series-interest.service.ts — the pieces of "does this user follow this
 * series" that more than one surface shares:
 *
 * - viewing moments ({@link SERIES_INTEREST_MOMENT_GAP_SECONDS}), the unit the
 *   follow threshold of `new-release-rule.ts` counts;
 * - `series_excluded`, the explicit unfollow, in both directions
 *   ({@link loadSeriesExclusionsForUser} for user → series,
 *   {@link listUsersExcludingSeries} for series → users).
 *
 * Which episodes a follower hears about is `new-release-rule.ts`, for the
 * banner and the `library.new_episode` notification alike. The two-tier rule
 * that used to live here (ACTIVE viewers heard about every episode that
 * became playable, a fulfilled request for an old season included) was
 * retired on 2026-10-20.
 *
 * ## Viewing moments, not episodes
 *
 * The thresholds count VIEWING MOMENTS: watched episodes less than
 * {@link SERIES_INTEREST_MOMENT_GAP_SECONDS} apart (by `last_watched_at`) are one
 * moment, and all undated rows of a (user, series) are one moment between them.
 * No real episode is that short, so real viewing is one moment per episode,
 * while a bulk "mark season/series watched" — or an import that stamps a
 * whole history in one instant — is one moment however many episodes it
 * touched. Counting episodes made a 100-episode bulk mark the strongest
 * possible fan: on prod (2026-10-02) an import had marked ~19 series watched
 * for nearly every user at once, and each new season pushed "new episode" to
 * ~30 people who had never seen the show. Someone who bulk-marks a series and
 * wants its new episodes can follow it or watchlist it.
 *
 * Deliberately NOT access-gated: a user must still be able to un-exclude a
 * series that was moved into a denied library group. Every caller that turns
 * a row into something a user can SEE applies the gate itself.
 */

import type postgres from 'postgres';
import {
    isCatalogItemExcluded,
    type SeriesExclusions,
} from '$lib/server/utils/excluded-series-match.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    getExcludedSeriesKeys,
    resolveCatalogIdsToExternal,
    resolveTmdbToCatalogIds,
    TMDB_TARGET_PREFIX,
} from '$lib/server/database/queries/user-excluded-series.queries.js';

/**
 * Watched episodes closer together than this are ONE viewing moment. Shorter
 * than any real episode, far longer than a bulk mark (milliseconds apart).
 */
export const SERIES_INTEREST_MOMENT_GAP_SECONDS = 120;

export interface EpisodeNumbering {
    seasonNumber: number | null;
    episodeNumber: number | null;
}

/** Episode 1 of a regular season. Specials (season 0) never premiere. */
export function isSeasonPremiere(episode: EpisodeNumbering): boolean {
    return (
        episode.episodeNumber === 1 && episode.seasonNumber !== null && episode.seasonNumber >= 1
    );
}

// ---------------------------------------------------------------------------
// series_excluded — the explicit unfollow
// ---------------------------------------------------------------------------

export type { SeriesExclusions } from '$lib/server/utils/excluded-series-match.js';

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A user's `series_excluded` flags as id sets (see `user-excluded-series.queries.ts`
 * for the keyings). TMDB keys are resolved to the catalog items carrying
 * that TMDB id, so a mute made on a monitored-only row keeps working once the
 * title is ingested. The other way round, the TMDB id of every muted catalog
 * item is added (and the TVDB id of every muted catalog series), so a
 * Sonarr/Radarr row for a muted catalog title is hidden too.
 */
export async function loadSeriesExclusionsForUser(
    sql: postgres.Sql,
    userId: string,
): Promise<SeriesExclusions> {
    const keys = await getExcludedSeriesKeys.all(sql, { userId: toUserId(userId) });
    const itemIds = new Set<string>();
    const directIds: string[] = [];
    const tmdbTv = new Set<string>();
    const tmdbMovie = new Set<string>();
    const tvdbTv = new Set<string>();
    for (const { target_type, target_id } of keys) {
        if (target_type === 'series') {
            const id = target_id.toLowerCase();
            if (!UUID_TEXT.test(id)) continue;
            itemIds.add(id);
            directIds.push(id);
        } else if (target_type === 'tmdb_tv') {
            tmdbTv.add(target_id.slice(TMDB_TARGET_PREFIX.tmdb_tv.length));
        } else if (target_type === 'tmdb_movie') {
            tmdbMovie.add(target_id.slice(TMDB_TARGET_PREFIX.tmdb_movie.length));
        }
    }
    let unresolvedTmdb = false;
    if (tmdbTv.size > 0 || tmdbMovie.size > 0) {
        const resolved = await resolveTmdbToCatalogIds.all(sql, {
            tvIds: [...tmdbTv],
            movieIds: [...tmdbMovie],
        });
        const matched = new Set<string>();
        for (const row of resolved) {
            itemIds.add(row.id.toLowerCase());
            // Its TVDB id too, for a Sonarr row whose TMDB id is missing or differs.
            directIds.push(row.id.toLowerCase());
            matched.add(`${row.media_type}:${row.external_id}`);
        }
        unresolvedTmdb =
            [...tmdbTv].some((id) => !matched.has(`tv:${id}`)) ||
            [...tmdbMovie].some((id) => !matched.has(`movie:${id}`));
    }
    if (directIds.length > 0) {
        const external = await resolveCatalogIdsToExternal.all(sql, { ids: directIds });
        for (const row of external) {
            if (row.provider === 'tvdb') tvdbTv.add(row.external_id);
            else (row.media_type === 'movie' ? tmdbMovie : tmdbTv).add(row.external_id);
        }
    }
    return { itemIds, tmdbTv, tmdbMovie, tvdbTv, unresolvedTmdb };
}

/** Whether a catalog series is muted. Titles are never compared; a series has an id. */
export function isSeriesExcludedFor(
    exclusions: SeriesExclusions,
    seriesId: string | null,
): boolean {
    return isCatalogItemExcluded(exclusions, seriesId);
}

/**
 * Users who have muted one catalog series, by its id or by its TMDB TV id. The
 * series → users counterpart of {@link loadSeriesExclusionsForUser}.
 *
 * `target_id` is compared as TEXT rather than cast to uuid: `user_media_flags`
 * also holds composite-key rows for other flag types, and a `target_id::uuid`
 * cast in a predicate Postgres is free to evaluate before the `flag_type`
 * filter would raise `invalid input syntax for type uuid` on those rows.
 * `series.id::text` is canonical lowercase, which is exactly what
 * `upsertExcludedSeries` writes.
 */
export async function listUsersExcludingSeries(
    sql: postgres.Sql,
    seriesId: string,
): Promise<Set<string>> {
    const rows = await sql<{ user_id: string }[]>`
        SELECT DISTINCT user_id::text AS user_id
        FROM user_media_flags
        WHERE flag_type = 'series_excluded'
          AND (
              (target_type = 'series' AND LOWER(target_id) = LOWER(${seriesId}::text))
              OR (
                  target_type = 'tmdb_tv'
                  AND target_id IN (
                      SELECT 'tv:' || ei.external_id
                      FROM external_ids ei
                      WHERE ei.media_id = ${seriesId}::uuid
                        AND ei.provider = 'tmdb'
                        AND ei.media_type = 'tv'
                  )
              )
          )
    `;
    return new Set(rows.map((r) => r.user_id));
}
