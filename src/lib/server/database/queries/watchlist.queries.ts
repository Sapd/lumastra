// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watchlist Queries Module
 *
 * Pure SQL queries for watchlist add/remove operations.
 *
 * @module queries/watchlist
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { ensureWatchlistPlaylist, getWatchlistPlaylistId } from './watchlist-playlist.queries.js';
import { touchPlaylist } from './playlists.queries.js';
import { getPlaylistKindPolicy } from '$lib/server/services/playlist-kind-policy.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Thrown by `upsertWatchlistItem` when `mediaId` resolves to a real
 * `media_items` row whose `media_type` is outside
 * `getPlaylistKindPolicy('watchlist').allowedMediaTypes` (movie/tv/audiobook).
 *
 * This is the enforcement point for callers that do NOT go through
 * `WatchlistManager.addItem` (which already only accepts those three types
 * and resolves+gates through them) — chiefly the Jellyfin-compat
 * `/j/Users/{userId}/FavoriteItems/{itemId}` route, which hands this
 * function an arbitrary caller-supplied media UUID with no type check of
 * its own. Callers should catch this and degrade to a 4xx, not let it
 * surface as a 500.
 */
export class WatchlistMediaTypeNotAllowedError extends Error {
    readonly mediaType: string;
    constructor(mediaType: string) {
        super(`Media type "${mediaType}" is not allowed on the watchlist`);
        this.name = 'WatchlistMediaTypeNotAllowedError';
        this.mediaType = mediaType;
    }
}

export interface WatchlistUpsertRow {
    id: number;
    /**
     * True when this call INSERTED the row, false when it was already
     * present.
     *
     * Derived from whether `ON CONFLICT DO NOTHING` returned a row: a hit
     * means a fresh insert (`inserted: true`); a miss falls through to a
     * follow-up `SELECT id FROM playlist_items … LIMIT 1`, which — for an
     * ordinary repeat add — finds the existing row and returns
     * `inserted: false`. Either way `upsertWatchlistItem`'s result array is
     * non-empty, so `WatchlistResult.saved` (`watchlist-manager.service.ts`)
     * is still unconditionally true for a repeat add; `inserted` is the sole
     * field that discriminates "added" from "was already there". The result
     * array comes back EMPTY only in the one race where the media row itself
     * vanished between resolve and insert — that is the sole path to
     * `defs/watchlist/index.ts`'s "Already on watchlist" branch actually
     * NOT firing (it fires on `saved: false` there, not on this field).
     *
     * Optional so existing test doubles that stub `[{ id: 1 }]` keep
     * type-checking; consumers must treat `undefined` as "unknown", never as
     * "already present".
     */
    inserted?: boolean;
}

export interface MediaTitleRow {
    title: string;
}

export interface WatchlistDeleteRow {
    id: number;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Add a media item to the user's watchlist playlist, creating that playlist on
 * first use.
 *
 * `inserted` now comes from whether `ON CONFLICT DO NOTHING` returned a row,
 * rather than the old `xmax = 0` trick. A miss on that clause falls through
 * to a follow-up `SELECT … LIMIT 1` (below) that finds the pre-existing row
 * and returns it with `inserted: false` — so this function's result is still
 * a non-empty array for an ordinary repeat add, exactly as the old
 * `DO UPDATE … RETURNING` was. `WatchlistResult.saved` therefore stays
 * unconditionally true for a repeat add, and `POST /watchlist`'s "Already on
 * watchlist" message stays unreachable in normal operation — this preserves
 * `/api/watchlist`'s response byte-for-byte, which is the point (see the
 * design spec). The one case that DOES make that branch fire is the follow-up
 * SELECT also coming back empty: the media row vanished between resolve and
 * insert. See `WatchlistUpsertRow.inserted` for the full breakdown.
 *
 * kind-policy enforcement: the INSERT's own `FROM media_items` filters on
 * `mi.media_type = ANY(...)` against `getPlaylistKindPolicy('watchlist')`, so
 * a disallowed type is excluded from the source set in the same statement
 * that would otherwise insert it — no extra round trip on the common path.
 * `WatchlistManager.addItem` (the POST /watchlist path) is unaffected in
 * practice: `WatchlistAddParams.mediaType` is already typed `'movie' | 'tv' |
 * 'audiobook'` and resolved+gated through that type, so it can never hand
 * this function a disallowed id. The check exists for the ONE caller that
 * bypasses the manager entirely — the Jellyfin-compat
 * `/j/Users/{userId}/FavoriteItems/{itemId}` route, which calls this
 * function directly with an arbitrary caller-supplied media UUID gated only
 * by `checkMediaAccess` (existence + visibility, not media type). Without
 * this filter, favoriting an episode/season/album/track in a Jellyfin
 * client silently added it to the watchlist playlist, which now renders it
 * in the pinned Watchlist card and its detail page. When the id resolves to
 * a real, disallowed-type row, this throws `WatchlistMediaTypeNotAllowedError`
 * instead of silently no-op'ing, so a caller cannot mistake "rejected" for
 * "already present" or "media item vanished".
 *
 * NOTE — non-atomic position assignment: the `(SELECT COALESCE(MAX(position),
 * -1) + 1 ...)` subselect is NOT atomic under READ COMMITTED. Two concurrent
 * adds for the same user can both read the same MAX(position) and insert
 * with the same value, producing a tied `position` across two rows. This is
 * contained rather than fixed: watchlist reads always order by `added_at
 * DESC, pi.id DESC` (see `getPlaylistItems`'s `added_at_desc` branch), a
 * total order that never consults `position`, so a tie here has no visible
 * effect on the watchlist itself. It mirrors the pre-existing
 * `insertPlaylistItem`'s no-explicit-`position` overload in
 * `playlists.queries.ts`, which this function was told to reuse unchanged —
 * do not "fix" this without also revisiting that shared pattern.
 */
export async function upsertWatchlistItem(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
): Promise<WatchlistUpsertRow[]> {
    const playlistId = await ensureWatchlistPlaylist(sql, userId);
    const policy = getPlaylistKindPolicy('watchlist');
    // `WATCHLIST_POLICY.allowedMediaTypes` is always a concrete Set, never
    // 'all' — but guard the type anyway rather than assume it.
    const allowedMediaTypes =
        policy.allowedMediaTypes === 'all' ? null : [...policy.allowedMediaTypes];

    const rows = await sql<{ id: number }[]>`
        INSERT INTO playlist_items (
            playlist_id, media_id, season_number, episode_number,
            title, series_name, overview, poster_path, position
        )
        SELECT
            ${playlistId}, ${mediaId}::uuid, NULL, NULL,
            COALESCE(mi.title, 'Untitled'), NULL, NULL, NULL,
            (SELECT COALESCE(MAX(position), -1) + 1
             FROM playlist_items WHERE playlist_id = ${playlistId})
        FROM media_items mi
        WHERE mi.id = ${mediaId}::uuid
        ${allowedMediaTypes ? sql`AND mi.media_type = ANY(${sql.array(allowedMediaTypes)})` : sql``}
        ON CONFLICT (playlist_id, media_id, COALESCE(season_number, -1), COALESCE(episode_number, -1))
        DO NOTHING
        RETURNING id
    `;

    if (rows.length > 0) {
        await touchPlaylist(sql, playlistId);
        return [{ id: rows[0].id, inserted: true }];
    }

    // Already present — return the existing row so callers still see a row and
    // can distinguish "added" from "was already there".
    const existing = await sql<{ id: number }[]>`
        SELECT id FROM playlist_items
        WHERE playlist_id = ${playlistId} AND media_id = ${mediaId}::uuid
        LIMIT 1
    `;
    if (existing.length > 0) {
        return existing.map((r) => ({ id: r.id, inserted: false }));
    }

    // Nothing was inserted AND nothing was already there. Either mediaId
    // doesn't resolve to any media_items row (vanished between resolve and
    // insert — the legacy, expected case), or it resolves to a row the type
    // filter above excluded. Distinguish them so a rejected type surfaces as
    // a typed error a caller can turn into a clean 4xx, rather than being
    // silently swallowed as "media item vanished".
    if (allowedMediaTypes) {
        const mediaRow = await sql<{ media_type: string }[]>`
            SELECT media_type FROM media_items WHERE id = ${mediaId}::uuid
        `;
        if (mediaRow.length > 0 && !allowedMediaTypes.includes(mediaRow[0].media_type)) {
            throw new WatchlistMediaTypeNotAllowedError(mediaRow[0].media_type);
        }
    }

    return [];
}

/**
 * Get the title of a media item by its internal UUID.
 */
export async function getMediaTitle(
    sql: postgres.Sql,
    mediaId: string,
): Promise<string | undefined> {
    const rows = await sql<MediaTitleRow[]>`
        SELECT mi.title FROM media_items mi WHERE mi.id = ${mediaId}::uuid
    `;
    return rows[0]?.title;
}

/**
 * Remove a media item from the user's watchlist playlist.
 *
 * Bumps `playlists.updated_at` when a row was actually deleted, for
 * symmetry with `upsertWatchlistItem`'s add path (which already calls
 * `touchPlaylist` on a fresh insert) — before this, a removal left the
 * playlist's `updated_at` stale.
 */
export async function deleteWatchlistItem(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
): Promise<WatchlistDeleteRow[]> {
    const playlistId = await getWatchlistPlaylistId(sql, userId);
    if (playlistId === null) return [];

    const rows = await sql<WatchlistDeleteRow[]>`
        DELETE FROM playlist_items
        WHERE playlist_id = ${playlistId} AND media_id = ${mediaId}::uuid
        RETURNING id
    `;

    if (rows.length > 0) {
        await touchPlaylist(sql, playlistId);
    }

    return rows;
}
