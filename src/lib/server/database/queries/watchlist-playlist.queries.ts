// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolving a user's watchlist playlist id.
 *
 * The watchlist is an ordinary `playlists` row with `playlist_type =
 * 'watchlist'` and `is_system = true`, guaranteed unique per user by the
 * partial index `playlists_one_watchlist_per_user`.
 *
 * Both functions below key on `playlist_type` alone, never `is_system` — that
 * is safe ONLY because `playlistTypeSchema` in `$lib/schemas/playlists`
 * (the REQUEST-side enum for POST/PUT /playlists) deliberately excludes
 * `'watchlist'`, so a client can never mint a `playlist_type='watchlist'` row
 * that isn't the server-created system one. That coupling lives in a
 * different file; the next person to widen the request enum (e.g. to let a
 * client filter or explicitly tag something as watchlist-typed) must keep
 * this invariant, or re-key these lookups on `is_system` too.
 *
 * @module queries/watchlist-playlist
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

/** The fixed, unrenameable name of every user's watchlist playlist. */
export const WATCHLIST_PLAYLIST_NAME = 'Watchlist';

/**
 * The user's watchlist playlist id, or null when they have never had one.
 * Never creates. Use this on read paths that must not have a write side
 * effect (browse queries, notification fan-out).
 */
export async function getWatchlistPlaylistId(
    sql: postgres.Sql,
    userId: UserId,
): Promise<number | null> {
    const rows = await sql<{ id: number }[]>`
        SELECT id FROM playlists
        WHERE user_id = ${userId}::uuid AND playlist_type = 'watchlist'
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * The user's watchlist playlist id, creating it if absent. Idempotent and
 * safe under concurrency.
 *
 * The ON CONFLICT clause repeats the partial index's predicate verbatim —
 * Postgres infers a partial unique index only when the predicate matches, and
 * without it two concurrent callers race to a raw 23505. DO NOTHING suppresses
 * RETURNING on the conflict path, hence the follow-up SELECT.
 */
export async function ensureWatchlistPlaylist(sql: postgres.Sql, userId: UserId): Promise<number> {
    const inserted = await sql<{ id: number }[]>`
        INSERT INTO playlists (user_id, name, description, visibility, playlist_type, is_system)
        VALUES (${userId}::uuid, ${WATCHLIST_PLAYLIST_NAME}, NULL, 'private', 'watchlist', true)
        ON CONFLICT (user_id) WHERE playlist_type = 'watchlist' DO NOTHING
        RETURNING id
    `;
    if (inserted[0]) return inserted[0].id;

    const existing = await getWatchlistPlaylistId(sql, userId);
    if (existing === null) {
        throw new Error('ensureWatchlistPlaylist: insert was skipped but no row exists');
    }
    return existing;
}
