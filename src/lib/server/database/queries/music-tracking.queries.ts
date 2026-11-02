// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/database/queries/music-tracking.queries.ts
/**
 * Music Tracking Query Module
 *
 * Reads and writes for user_music_state and music_listen_events tables.
 * State table = fast aggregated reads. Event table = append-only analytics.
 *
 * @module queries/music-tracking
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MusicStateRow {
    user_id: string;
    track_id: string;
    play_count: number;
    skip_count: number;
    complete_count: number;
    total_listen_ms: string; // bigint comes as string from postgres
    last_played_at: Date;
    first_played_at: Date;
}

export interface MusicListenEventRow {
    id: string;
    user_id: string;
    track_id: string;
    started_at: Date;
    duration_ms: number | null;
    track_duration_ms: number | null;
    was_completed: boolean;
    was_skipped: boolean;
    play_context: string | null;
    created_at: Date;
}

// ─── State Writes ────────────────────────────────────────────────────────────

/**
 * Record play start: increment play_count, update last_played_at.
 * Called once when a track begins playing (not on every progress tick).
 */
export async function recordPlayStart(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at, first_played_at)
        VALUES (${userId}, ${trackId}, 1, NOW(), NOW())
        ON CONFLICT (user_id, track_id)
        DO UPDATE SET
            play_count = user_music_state.play_count + 1,
            last_played_at = NOW()
    `;
}

/**
 * Record play end: update cumulative stats based on how the listen ended.
 * Called once when a track stops (completed, skipped, or abandoned).
 * Uses UPSERT in case the play-start was lost (crash, network failure).
 *
 * Note: last_played_at is intentionally NOT updated here. It is set by
 * recordPlayStart (when the track begins) and should reflect the most
 * recent time the user started playing the track, not when it ended.
 * Updating it on play-end would skew recency-based recommendation queries
 * that rely on last_played_at as a "when did the user listen to this" signal.
 *
 * @param bumpPlayCount - When true, the DO UPDATE branch also increments
 *   play_count. Callers that always pair a play-end with a prior
 *   recordPlayStart (the normal online path) leave this false — play_count
 *   was already counted at start. The offline-flush path never calls
 *   recordPlayStart at all, so without this a track replayed offline that
 *   already had a user_music_state row would grow total_listen_ms/
 *   complete_count forever while play_count stayed frozen, invisible to
 *   every play_count-ranked surface (rotation lane, alchemy's popularity
 *   term). The INSERT branch is unaffected — a never-before-played track
 *   still gets play_count = 1 there regardless of this flag.
 */
export async function recordPlayEnd(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
    listenedMs: number,
    wasSkipped: boolean,
    wasCompleted: boolean,
    bumpPlayCount: boolean = false,
    /**
     * When the listen actually happened.
     *
     * Omit for a live report, where now IS the occurrence time. Supply it for
     * an offline flush: those arrive hours or days late, and stamping them
     * `NOW()` dates a first-ever row to the flush rather than the listen —
     * which silently reorders every recency-ranked surface (recently played,
     * the rotation lane) around when the device happened to reconnect.
     *
     * Only ever moves the INSERT branch. An existing row's `last_played_at`
     * is left to the live path, so a late flush cannot drag a track's recency
     * backwards over a newer play.
     */
    occurredAt?: Date,
): Promise<void> {
    const safeListen = Math.max(0, Number.isFinite(listenedMs) ? listenedMs : 0);
    const stamp = occurredAt ?? new Date();
    await sql`
        INSERT INTO user_music_state
            (user_id, track_id, play_count, skip_count, complete_count,
             total_listen_ms, last_played_at, first_played_at)
        VALUES
            (${userId}, ${trackId}, 1,
             ${wasSkipped ? 1 : 0}, ${wasCompleted ? 1 : 0},
             ${safeListen}, ${stamp}, ${stamp})
        ON CONFLICT (user_id, track_id)
        DO UPDATE SET
            play_count = user_music_state.play_count + ${bumpPlayCount ? 1 : 0},
            total_listen_ms = user_music_state.total_listen_ms + ${safeListen},
            skip_count = user_music_state.skip_count + ${wasSkipped ? 1 : 0},
            complete_count = user_music_state.complete_count + ${wasCompleted ? 1 : 0}
    `;
}

/**
 * Record play end without timing information (e.g. Subsonic 'stopped' with no prior 'starting').
 * This is an UPDATE-ONLY path — it never inserts a phantom row for a play that was
 * never started. If no row exists (the track was never played via the normal start path)
 * this is a silent no-op, which is the correct behaviour: we should not inflate
 * play_count or complete_count for a play we have no record of starting.
 */
export async function recordPlayEndNoTiming(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        UPDATE user_music_state
        SET
            complete_count = complete_count + 1
        WHERE user_id = ${userId} AND track_id = ${trackId}
    `;
}

// ─── Event Log Writes ────────────────────────────────────────────────────────

/**
 * Append a listen event to the event log.
 * Called once per track play, at play-end.
 */
export async function insertListenEvent(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        trackId: string;
        startedAt: Date;
        durationMs: number | null;
        trackDurationMs: number | null;
        wasCompleted: boolean;
        wasSkipped: boolean;
        playContext: string | null;
        /**
         * Client-supplied idempotency key, or null for legacy callers.
         * When non-null this insert IS the idempotency claim — see the
         * return value.
         */
        eventId?: string | null;
    },
): Promise<{ inserted: boolean }> {
    // ON CONFLICT DO NOTHING is load-bearing, not defensive tidiness: the
    // partial unique index on (user_id, event_id, track_id) turns a repeat
    // submission into zero returned rows, which is how the caller learns to
    // skip the non-idempotent aggregate and rating side effects. With
    // event_id NULL the index does not apply, no conflict is possible, and
    // every legacy call still inserts exactly as it always did.
    //
    // The index includes track_id (16.227.0) because event_id is minted
    // client-side and is not an identity: a client reusing one across two
    // tracks used to have the second play answered `duplicate` and never
    // recorded, while being told it succeeded. A genuine retry repeats all
    // three columns and still collapses.
    const rows = await sql<{ id: string }[]>`
        INSERT INTO music_listen_events
            (user_id, track_id, started_at, duration_ms, track_duration_ms,
             was_completed, was_skipped, play_context, event_id)
        VALUES
            (${params.userId}, ${params.trackId}, ${params.startedAt},
             ${params.durationMs}, ${params.trackDurationMs},
             ${params.wasCompleted}, ${params.wasSkipped}, ${params.playContext},
             ${params.eventId ?? null})
        ON CONFLICT DO NOTHING
        RETURNING id
    `;
    return { inserted: rows.length > 0 };
}

// ─── State Reads ─────────────────────────────────────────────────────────────

/**
 * Get music state for a specific user+track.
 */
export async function getMusicState(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<MusicStateRow | null> {
    const rows = await sql<MusicStateRow[]>`
        SELECT * FROM user_music_state
        WHERE user_id = ${userId} AND track_id = ${trackId}
    `;
    return rows[0] ?? null;
}

/**
 * Get recently played track IDs for a user (for for-you helpers UNION).
 */
export async function getRecentlyPlayedTrackIds(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
): Promise<{ media_id: string; watched_at: Date }[]> {
    return sql<{ media_id: string; watched_at: Date }[]>`
        SELECT track_id AS media_id, last_played_at AS watched_at
        FROM user_music_state
        WHERE user_id = ${userId} AND complete_count > 0
        ORDER BY last_played_at DESC
        LIMIT ${limit}
    `;
}

// ─── Music Watched Status (for /api/watched/[itemId]) ────────────────────────

/**
 * Check if a user has completed a music track (for watched status API).
 */
export async function isMusicTrackCompleted(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<boolean> {
    const rows = await sql<{ complete_count: number }[]>`
        SELECT complete_count FROM user_music_state
        WHERE user_id = ${userId} AND track_id = ${trackId}
    `;
    return (rows[0]?.complete_count ?? 0) > 0;
}

/**
 * Reset music track state (for "mark unwatched" API).
 */
export async function resetMusicTrackState(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        UPDATE user_music_state
        SET complete_count = 0, skip_count = 0
        WHERE user_id = ${userId} AND track_id = ${trackId}
    `;
}

// ─── Event Log Cleanup ───────────────────────────────────────────────────────

/**
 * Delete events older than the given number of days.
 * Called by the database-cleanup plugin.
 * Loops in batches until all expired events are pruned.
 */
export async function pruneOldListenEvents(
    sql: postgres.Sql,
    retentionDays: number,
    batchLimit = 50000,
): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    let totalPruned = 0;
    let batchCount: number;

    do {
        const result = await sql`
            DELETE FROM music_listen_events
            WHERE id IN (
                SELECT id FROM music_listen_events
                WHERE created_at < ${cutoff}
                LIMIT ${batchLimit}
            )
        `;
        batchCount = result.count;
        totalPruned += batchCount;
    } while (batchCount >= batchLimit);

    do {
        const result = await sql`
            DELETE FROM music_play_starts
            WHERE (user_id, event_id) IN (
                SELECT user_id, event_id FROM music_play_starts
                WHERE created_at < ${cutoff}
                LIMIT ${batchLimit}
            )
        `;
        batchCount = result.count;
    } while (batchCount >= batchLimit);

    return totalPruned;
}

// ─── Bulk Reset ──────────────────────────────────────────────────────────────

/**
 * Bulk-clear a user's entire music listening history: aggregate state
 * (`user_music_state`) + the append-only event log (`music_listen_events`).
 * Mirrors the per-track `resetMusicTrackState`, but wipes all rows for the user.
 */
export async function clearAllMusicState(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{ musicState: number; listenEvents: number }> {
    const state = await sql`DELETE FROM user_music_state WHERE user_id = ${userId}`;
    const events = await sql`DELETE FROM music_listen_events WHERE user_id = ${userId}`;
    return { musicState: state.count, listenEvents: events.count };
}

/** Serialize event retries within the caller's transaction, independent of track. */
export async function isRecordedListenEvent(
    sql: postgres.Sql,
    userId: UserId,
    eventId: string,
): Promise<boolean> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${eventId}`}, 0))`;
    const rows =
        await sql`SELECT 1 FROM music_listen_events WHERE user_id = ${userId} AND event_id = ${eventId}::uuid LIMIT 1`;
    return rows.length > 0;
}

/** Claim the start counter in the same transaction that writes it. */
export async function claimMusicPlayStart(
    sql: postgres.Sql,
    userId: UserId,
    eventId: string,
): Promise<boolean> {
    const rows = await sql`INSERT INTO music_play_starts (user_id, event_id)
        VALUES (${userId}, ${eventId}::uuid) ON CONFLICT DO NOTHING RETURNING event_id`;
    return rows.length > 0;
}

/**
 * True when a live session on this track already claimed its play start close
 * to `startedAt` (music_play_starts.event_id is the playback session id).
 * Used by replay items that did not carry their playbackSessionId.
 */
export async function hasMusicPlayStartNear(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
    startedAt: Date,
    windowMs = 5 * 60 * 1000,
): Promise<boolean> {
    const rows = await sql`SELECT 1
        FROM music_play_starts s
        JOIN play_sessions p ON p.id = s.event_id
        WHERE s.user_id = ${userId}
          AND p.media_id = ${trackId}::uuid
          AND p.started_at BETWEEN ${new Date(startedAt.getTime() - windowMs)}
                               AND ${new Date(startedAt.getTime() + windowMs)}
        LIMIT 1`;
    return rows.length > 0;
}
