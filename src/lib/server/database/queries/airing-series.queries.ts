// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Airing series whose TMDB data is due for a refresh.
 *
 * series-sync only runs when a series is matched or a file lands, so the
 * episode rows of a running show stop at whatever TMDB knew back then: the
 * calendar showed newly announced episodes only as Sonarr gap-fill rows, and
 * new seasons were missing entirely. airing-series-refresh uses this list to
 * re-sync those series on a schedule.
 */

import type postgres from 'postgres';

/** TMDB `status` values of a show that still gets new episodes. */
export const AIRING_TMDB_STATUSES = [
    'Returning Series',
    'In Production',
    'Planned',
    'Pilot',
] as const;

export interface AiringSeriesDue {
    id: string;
    title: string;
    /** When the TMDB data was last written; null when it never was. */
    synced_at: Date | null;
}

/**
 * Library series (with files, not metadata-locked, with a TMDB id) that are
 * airing — by TMDB status, or because Sonarr lists an episode between a week
 * ago and a month ahead — and whose TMDB data is older than `staleBefore`.
 * Oldest first, so a capped run always works off the longest-stale series.
 *
 * Skipped: a series with a series-sync queued or running (it would only come
 * back deduped and take a slot from the next series), and one whose last
 * series-sync started after `staleBefore` but left its data stale (a sync that
 * fails, e.g. on a TMDB 404, never advances `updated_at`; without this it would
 * sit at the head of the list and be retried every run).
 */
export async function findAiringSeriesDueForRefresh(
    sql: postgres.Sql,
    opts: { staleBefore: Date; limit: number },
): Promise<AiringSeriesDue[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- maintenance task over the whole library; no user-facing listing.
    return sql<AiringSeriesDue[]>`
        WITH attempted AS MATERIALIZED (
            SELECT DISTINCT input->>'mediaItemId' AS media_id
            FROM task_history
            WHERE task_id = 'series-sync'
              AND (
                  state IN ('pending', 'active', 'cancelling')
                  OR started_at > ${opts.staleBefore}
              )
        )
        SELECT s.id::text AS id, s.title, pm.updated_at AS synced_at
        FROM media_items s
        LEFT JOIN provider_metadata pm ON pm.media_id = s.id AND pm.provider = 'tmdb'
        WHERE s.media_type = 'tv'
          AND s.status = 'active'
          AND s.has_files = true
          AND NOT s.metadata_locked
          AND EXISTS (
              SELECT 1 FROM external_ids tmdb
              WHERE tmdb.media_id = s.id AND tmdb.provider = 'tmdb' AND tmdb.media_type = 'tv'
          )
          AND (pm.updated_at IS NULL OR pm.updated_at < ${opts.staleBefore})
          AND NOT EXISTS (SELECT 1 FROM attempted WHERE attempted.media_id = s.id::text)
          AND (
              pm.metadata->>'status' = ANY(${sql.array([...AIRING_TMDB_STATUSES])}::text[])
              OR EXISTS (
                  SELECT 1
                  FROM upcoming_releases ur
                  JOIN external_ids ei ON ei.media_id = s.id
                                      AND ei.media_type = 'tv'
                                      AND (
                                          (ei.provider = 'tmdb' AND ei.external_id = ur.tmdb_id::text)
                                          OR (ei.provider = 'tvdb' AND ei.external_id = ur.tvdb_id::text)
                                      )
                  WHERE ur.media_type = 'episode'
                    AND ur.air_date BETWEEN current_date - 7 AND current_date + 30
              )
          )
        ORDER BY pm.updated_at ASC NULLS FIRST, s.id
        LIMIT ${opts.limit}
    `;
}
