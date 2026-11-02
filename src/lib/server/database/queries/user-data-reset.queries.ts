// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';

/**
 * Hard-delete a user's VOD watch history across every store the self-service
 * "Clear watch history" action owns. MUST be run inside a transaction (pass a
 * `sql.begin` handle) so the event source of truth and the derived read model
 * disappear atomically — deleting only the read model would be resurrected on
 * the next rebuild from surviving events. Currently-live play sessions
 * ('ACTIVE'/'PAUSED') are intentionally spared (see below); every other store
 * is wiped for the user.
 */
export async function clearAllWatchHistory(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{
    events: number;
    state: number;
    watchHistory: number;
    playSessions: number;
    playlistItemWatched: number;
}> {
    const events = await sql`DELETE FROM user_media_events WHERE user_id = ${userId}`;
    const state = await sql`DELETE FROM user_media_state WHERE user_id = ${userId}`;
    const watchHistory = await sql`DELETE FROM watch_history WHERE user_id = ${userId}`;
    // Spare currently-live sessions ('ACTIVE'/'PAUSED', the codebase's live-session
    // predicate used for stream-limit counting) so clearing history on one device
    // doesn't yank an in-flight stream on another; terminated sessions are history
    // and get cleared. A surviving live session self-heals into a fresh play row.
    const playSessions = await sql`
        DELETE FROM play_sessions
        WHERE user_id = ${userId} AND status NOT IN ('ACTIVE', 'PAUSED')`;
    const playlistItemWatched =
        await sql`DELETE FROM playlist_item_watched WHERE user_id = ${userId}`;
    return {
        events: events.count,
        state: state.count,
        watchHistory: watchHistory.count,
        playSessions: playSessions.count,
        playlistItemWatched: playlistItemWatched.count,
    };
}

/** Delete all of a user's VOD taste dampers (durable "show less like this" signal). */
export async function clearAllTasteDampers(sql: postgres.Sql, userId: UserId): Promise<number> {
    const deleted = await sql`DELETE FROM user_taste_dampers WHERE user_id = ${userId}`;
    return deleted.count;
}
