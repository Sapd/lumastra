// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * Shared completion guard for the Home strip and exact Continue Watching page.
 * Requires the user_media_state alias `uws` and a separate resume-position gate.
 * A watched row needs playback after completion, not just a newer sync timestamp.
 * Materialized resume positions need not equal an individual event's position.
 */
export function buildContinueWatchingCompletionFilter(
    sql: postgres.Sql,
): postgres.PendingQuery<postgres.Row[]> {
    // Archiving must not remove rewatch evidence or a decisive report that
    // invalidates it. Both tables have an index starting with (user_id, media_id).
    const events = sql`
        SELECT event_type, source, occurred_at, recorded_at, repudiated_at
        FROM user_media_events
        WHERE user_id = uws.user_id AND media_id = uws.media_id
        UNION ALL
        SELECT event_type, source, occurred_at, recorded_at, repudiated_at
        FROM user_media_events_archive
        WHERE user_id = uws.user_id AND media_id = uws.media_id
    `;

    return sql`(
        uws.is_watched = false
        OR (
            -- A missing completion timestamp cannot establish a rewatch.
            uws.last_watched_at IS NOT NULL
            AND (
                -- Legacy state can predate the event log and source attribution.
                -- Preserve its timestamp evidence, but not a known sync-only row
                -- whose newer timestamp may merely report an old partial position.
                (
                    uws.last_event_at > uws.last_watched_at
                    AND (uws.last_event_source IS NULL
                         OR uws.last_event_source IN ('lumastra-player', 'lumastra-offline'))
                    AND NOT EXISTS (SELECT 1 FROM (${events}) logged)
                )
                OR EXISTS (
                    SELECT 1 FROM (${events}) progress
                    WHERE progress.event_type = 'progress'
                      AND progress.repudiated_at IS NULL
                      -- Backdated uploads may prove later activity by arrival time.
                      -- Neither exact position nor latest-source equality proves
                      -- whether playback happened after the completion.
                      AND (progress.occurred_at > uws.last_watched_at
                           OR progress.recorded_at > uws.last_watched_at)
                      AND NOT EXISTS (
                          SELECT 1 FROM (${events}) decisive
                          WHERE decisive.event_type IN ('mark_watched', 'completed', 'mark_unwatched')
                            AND decisive.repudiated_at IS NULL
                            -- A completion imported later still wins over an old
                            -- partial even if LastPlayedDate was backdated. Equal
                            -- times also reject a sync's mark + stale-position pair.
                            AND (decisive.occurred_at >= progress.occurred_at
                                 OR decisive.recorded_at >= progress.recorded_at)
                      )
                )
            )
        )
    )`;
}
