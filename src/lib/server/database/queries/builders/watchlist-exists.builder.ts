// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared "is this media item in this user's watchlist" predicate.
 *
 * A watchlist row is `playlists.playlist_type = 'watchlist'` (one per user,
 * enforced by a partial unique index) joined to its `playlist_items` rows.
 *
 * MUST stay an EXISTS semi-join, never a plain `JOIN`:
 * `idx_playlist_items_unique_media` is
 * `(playlist_id, media_id, COALESCE(season_number,-1), COALESCE(episode_number,-1))`
 * — weaker than the old `user_watchlist` table's `UNIQUE (user_id, media_id)`.
 * A media item CAN have more than one `playlist_items` row on the same
 * watchlist playlist (different season keys), so a `JOIN` can return more
 * than one row for the same `(media_id, user_id)` pair and inflate a
 * `is_favorite` SELECT-list boolean into duplicate rows, or a `COUNT(*)`.
 *
 * `mediaIdExpr` and `userIdExpr` are themselves `sql` fragments (see
 * postgres.js nested-fragment composition, used throughout this codebase's
 * `builders/` — e.g. `buildLibraryAccessFilter`) so this same predicate
 * composes into either a SELECT-list boolean or a WHERE-clause condition,
 * and accepts either a raw column reference (`` sql`mi.id` ``, when the
 * surrounding query already selects FROM media_items as `mi`) or a bound
 * parameter (`` sql`${internalId}::uuid` ``, when the caller only has a
 * JS-level id and no media_items row in scope — see the three `catalog/`
 * per-item detail defs).
 */

import type postgres from 'postgres';

export function watchlistExistsFragment(
    sql: postgres.Sql,
    mediaIdExpr: postgres.PendingQuery<postgres.Row[]>,
    userIdExpr: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`EXISTS (
        SELECT 1 FROM playlist_items wpi
        JOIN playlists wp ON wp.id = wpi.playlist_id
        WHERE wpi.media_id = ${mediaIdExpr}
          AND wp.user_id = ${userIdExpr}
          AND wp.playlist_type = 'watchlist'
    )`;
}
