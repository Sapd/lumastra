// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Setting a Jellyfin "favourite" for the /j surface. Shared by
 * `/Users/{userId}/FavoriteItems/{itemId}` (and its userless twin) and
 * `POST /UserItems/{itemId}/UserData` with `IsFavorite`.
 *
 * - A Live TV channel (for a user with Live TV permission) is a channel
 *   favourite (`livetv_channel_favorites`), never a watchlist row.
 * - Anything else is the user's watchlist. Adding needs library access (a
 *   denial is `not_found`, never a 403 that would leak existence); removing
 *   does not — clearing a saved entry the user can no longer see is the safer
 *   default. An id that is no media item (e.g. an EPG program) is a no-op.
 * - The watchlist holds movies, series and audiobooks only; other types
 *   (episodes, tracks, …) come back as `type_not_allowed` for the caller to map.
 */

import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    upsertWatchlistItem,
    deleteWatchlistItem,
    WatchlistMediaTypeNotAllowedError,
} from '$lib/server/database/queries/watchlist.queries';
import {
    healNullFavoriteOrder,
    setChannelFavorite,
} from '$lib/server/database/queries/livetv-channels.queries';
import { cacheInvalidation } from '$lib/server/cache';
import {
    lockSimpleModeRow,
    simpleModeLocksFavorites,
} from '$lib/server/database/queries/livetv-simple-mode.queries.js';

export type JellyfinFavoriteResult =
    | { status: 'ok'; target: 'channel' | 'media' }
    /** Not a media item (e.g. an EPG program): nothing to favourite. */
    | { status: 'noop'; target: 'media' }
    | { status: 'not_found' }
    | { status: 'type_not_allowed'; mediaType: string };

async function isLiveTvChannel(sql: postgres.Sql, itemId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM livetv_channels WHERE id = ${itemId}::uuid LIMIT 1
    `;
    return rows.length > 0;
}

/** Throws on database errors; every expected outcome is a result. */
export async function setJellyfinFavorite(
    sql: postgres.Sql,
    user: UserContext,
    itemId: string,
    isFavorite: boolean,
): Promise<JellyfinFavoriteResult> {
    const userId = user.userId;

    if (user.hasLiveTvPermission && (await isLiveTvChannel(sql, itemId))) {
        // Locked Live TV simple mode: its channels are these favorites and
        // only the helper may change them. Jellyfin apps have no error UI for
        // this, so it is a quiet no-op. Checked under the simple-mode row lock
        // inside the write.
        await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await lockSimpleModeRow(tx, userId);
            if (await simpleModeLocksFavorites(tx, userId)) return;
            if (isFavorite) {
                await healNullFavoriteOrder(tx, userId);
            }
            await setChannelFavorite(tx, userId, itemId, isFavorite);
        });
        return { status: 'ok', target: 'channel' };
    }

    if (!isFavorite) {
        await deleteWatchlistItem(sql, userId, itemId);
        await cacheInvalidation.onWatchlistChange(userId, itemId).catch(() => {});
        return { status: 'ok', target: 'media' };
    }

    if (!(await checkMediaAccess(sql, itemId, user))) return { status: 'not_found' };

    try {
        // `INSERT … SELECT FROM media_items WHERE id = …`: a non-media id selects
        // zero rows (no FK violation) and comes back as `[]`.
        const upserted = await upsertWatchlistItem(sql, userId, itemId);
        if (upserted.length === 0) return { status: 'noop', target: 'media' };
    } catch (err) {
        if (err instanceof WatchlistMediaTypeNotAllowedError) {
            return { status: 'type_not_allowed', mediaType: err.mediaType };
        }
        throw err;
    }
    await cacheInvalidation.onWatchlistChange(userId, itemId).catch(() => {});
    return { status: 'ok', target: 'media' };
}
