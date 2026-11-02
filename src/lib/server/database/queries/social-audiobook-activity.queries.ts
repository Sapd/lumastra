// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Coarse, reciprocal audiobook activity for the optional Home rail. */

import type postgres from 'postgres';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import { buildLibraryGroupColumnFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildSocialVisibilityFilter } from './builders/social-visibility.builder.js';
import type { EventSource } from './user-media-events.queries.js';

/**
 * Sources whose `progress` events represent actual listening time for these
 * two queries. Deliberately narrower than `PUSHABLE_SOURCES`
 * (`user-media-events.queries.ts`): that set also includes
 * `lumastra-user-mark`, a deliberate watched/unwatched TOGGLE with no
 * `session_elapsed_ms`/position-delta semantics — not a listening session, and
 * not something either query below could turn into minutes even if it were
 * included. `lumastra-offline` carries the same `session_elapsed_ms`
 * accounting as `lumastra-player` (both write it via the same
 * `insertEvent`-based path — see `offline-playback.service.ts`), so it
 * belongs in the same de-duplicated-per-session bucket.
 */
const LISTENING_SOURCES: readonly EventSource[] = ['lumastra-player', 'lumastra-offline'];

/*
 * `position_stream` (both queries) marks the rows whose `session_elapsed_ms` is
 * NOT a listening counter, so they are measured by playhead movement instead:
 *
 *  - `audiobookshelf-sync` rows carry the position as the elapsed value (the
 *    engagement floor) and have no session at all.
 *  - `lumastra-player` rows WITHOUT a session id: the iOS AudiobookShelf deck
 *    heartbeats every ~10 s with the position copied into `session_elapsed_ms`.
 *    Grouped "per row" like an offline record, 600 heartbeats at hour 6 of a
 *    book added up to ~3,600 hr in a week (prod, 2026-11-02).
 *
 * They share ONE lag partition: the AudiobookShelf mirror re-records the same
 * positions those heartbeats report, and separate partitions would count that
 * listening twice. Offline records keep their per-record elapsed: each is one
 * stretch the device measured itself.
 */

export interface AudiobookActivityRow {
    user_id: string;
    username: string;
    media_id: string;
    title: string;
    kind: 'listened' | 'finished';
    listened_minutes: number | null;
    occurred_on: string;
    approximate: boolean;
}

/**
 * One row per person/book in the last seven calendar days. Player heartbeat
 * durations are de-duplicated by session (MAX cumulative elapsed); rows without
 * a real elapsed counter (`position_stream`, see above) use positive position
 * deltas and are marked approximate. Exact timestamps never leave this query.
 */
export async function getAudiobookActivityRail(
    sql: postgres.Sql,
    viewerId: string,
    access: MediaAccessBoundary,
    limit = 10,
    trustGroups?: readonly string[],
    /** Audience mode override — tests and pre-resolved callers only. */
    audienceMode?: string,
): Promise<AudiobookActivityRow[]> {
    if (deniesEverything(access)) return [];

    return sql<AudiobookActivityRow[]>`
        WITH recent AS (
            SELECT
                ume.id,
                ume.user_id,
                ume.media_id,
                ume.event_type,
                ume.source,
                ume.position_ms,
                ume.session_id,
                ume.session_elapsed_ms,
                ume.occurred_at,
                (ume.source = 'audiobookshelf-sync' OR (ume.source = 'lumastra-player' AND ume.session_id IS NULL)) AS position_stream,
                lag(ume.position_ms) OVER (
                    PARTITION BY ume.user_id, ume.media_id, (ume.source = 'audiobookshelf-sync' OR (ume.source = 'lumastra-player' AND ume.session_id IS NULL))
                    ORDER BY ume.occurred_at, ume.id
                ) AS previous_position_ms
            FROM user_media_events ume
            JOIN users u_priv ON u_priv.id = ume.user_id
            JOIN media_items mi ON mi.id = ume.media_id
            WHERE ume.repudiated_at IS NULL
              AND ume.event_type <> 'state_snapshot'
              AND ume.occurred_at >= date_trunc('day', now()) - interval '6 days'
              AND ume.occurred_at < now() + interval '5 minutes'
              AND mi.media_type = 'audiobook'
              AND mi.status = 'active'
              AND mi.is_dismissed = false
              AND mi.has_files = true
              ${buildLibraryGroupColumnFilter(sql, access.library, 'mi')}
              ${buildAgeRatingFilter(sql, access.age, 'mi')}
              ${buildSocialVisibilityFilter(sql, {
                  viewerId,
                  media: { alias: 'ume', column: 'media_id' },
                  subjectAlias: 'u_priv',
                  tier: 'activity',
                  trustGroups,
                  audienceMode,
                  audiobook: true,
              })}
        ),
        player_sessions AS (
            SELECT user_id, media_id,
                   max(session_elapsed_ms)::bigint AS elapsed_ms
            FROM recent
            WHERE source = ANY(${sql.array(LISTENING_SOURCES as string[])})
              AND NOT position_stream
              AND event_type = 'progress'
              AND session_elapsed_ms > 0
            GROUP BY user_id, media_id, coalesce(session_id::text, id::text)
        ),
        player_totals AS (
            SELECT user_id, media_id, sum(elapsed_ms)::bigint AS elapsed_ms
            FROM player_sessions
            GROUP BY user_id, media_id
        ),
        position_totals AS (
            SELECT user_id, media_id,
                   sum(greatest(position_ms - previous_position_ms, 0))::bigint AS elapsed_ms
            FROM recent
            WHERE position_stream
              AND event_type = 'progress'
              AND position_ms IS NOT NULL
              AND previous_position_ms IS NOT NULL
            GROUP BY user_id, media_id
        ),
        activity AS (
            SELECT
                r.user_id,
                r.media_id,
                max(r.occurred_at)::date::text AS occurred_on,
                coalesce(pt.elapsed_ms, 0) + coalesce(at.elapsed_ms, 0) AS elapsed_ms,
                coalesce(at.elapsed_ms, 0) > 0 AS approximate,
                bool_or(r.event_type IN ('completed', 'mark_watched')) AS completed_recently
            FROM recent r
            LEFT JOIN player_totals pt USING (user_id, media_id)
            LEFT JOIN position_totals at USING (user_id, media_id)
            GROUP BY r.user_id, r.media_id, pt.elapsed_ms, at.elapsed_ms
        )
        SELECT
            a.user_id,
            coalesce(nullif(u.display_name, ''), u.username) AS username,
            a.media_id,
            mi.title,
            CASE
                WHEN a.completed_recently AND coalesce(ums.is_watched, false) THEN 'finished'
                ELSE 'listened'
            END AS kind,
            CASE
                WHEN a.completed_recently AND coalesce(ums.is_watched, false) THEN NULL
                ELSE greatest(5, round(a.elapsed_ms / 300000.0) * 5)::int
            END AS listened_minutes,
            a.occurred_on,
            a.approximate
        FROM activity a
        JOIN users u ON u.id = a.user_id
        JOIN media_items mi ON mi.id = a.media_id
        LEFT JOIN user_media_state ums
          ON ums.user_id = a.user_id AND ums.media_id = a.media_id
        WHERE a.elapsed_ms > 0
           OR (a.completed_recently AND coalesce(ums.is_watched, false))
        ORDER BY a.occurred_on DESC, a.user_id, a.media_id
        LIMIT ${limit}
    `;
}

/**
 * The viewer's OWN audiobook listening over a recent window, in milliseconds.
 *
 * Used as a relevance gate, not as a statistic: For You should not spend a row
 * on what a circle is listening to when the viewer does not listen to
 * audiobooks. Deliberately NOT access-filtered — this is the viewer's own
 * history, and a book they can no longer see still says something true about
 * whether they are an audiobook listener.
 *
 * Mirrors the two-part accounting of {@link getAudiobookActivityRail}: player
 * heartbeats de-duplicated per session (they carry a CUMULATIVE elapsed, so
 * summing rows would multiply the real time), plus positive position deltas for
 * the `position_stream` rows, which have no elapsed counter of their own.
 */
export async function getViewerAudiobookListeningMs(
    sql: postgres.Sql,
    viewerId: string,
    days: number,
): Promise<number> {
    const [row] = await sql<{ elapsed_ms: string | number | null }[]>`
        WITH recent AS (
            SELECT
                ume.id,
                ume.media_id,
                ume.source,
                ume.position_ms,
                ume.session_id,
                ume.session_elapsed_ms,
                (ume.source = 'audiobookshelf-sync' OR (ume.source = 'lumastra-player' AND ume.session_id IS NULL)) AS position_stream,
                lag(ume.position_ms) OVER (
                    PARTITION BY ume.media_id, (ume.source = 'audiobookshelf-sync' OR (ume.source = 'lumastra-player' AND ume.session_id IS NULL))
                    ORDER BY ume.occurred_at, ume.id
                ) AS previous_position_ms
            FROM user_media_events ume
            JOIN media_items mi ON mi.id = ume.media_id
            WHERE ume.user_id = ${viewerId}::uuid
              AND ume.repudiated_at IS NULL
              AND ume.event_type = 'progress'
              AND ume.occurred_at >= now() - make_interval(days => ${days})
              AND mi.media_type = 'audiobook'
        ),
        player_sessions AS (
            SELECT max(session_elapsed_ms)::bigint AS elapsed_ms
            FROM recent
            WHERE source = ANY(${sql.array(LISTENING_SOURCES as string[])})
              AND NOT position_stream
              AND session_elapsed_ms > 0
            GROUP BY media_id, coalesce(session_id::text, id::text)
        )
        SELECT (
            coalesce((SELECT sum(elapsed_ms) FROM player_sessions), 0)
            + coalesce((
                SELECT sum(greatest(position_ms - previous_position_ms, 0))
                FROM recent
                WHERE position_stream
                  AND position_ms IS NOT NULL
                  AND previous_position_ms IS NOT NULL
            ), 0)
        )::bigint AS elapsed_ms
    `;
    // postgres.js hands bigint back as a string; NaN must read as "no listening"
    // so a parse failure hides the rail rather than showing it to everyone.
    const value = Number(row?.elapsed_ms ?? 0);
    return Number.isFinite(value) ? value : 0;
}
