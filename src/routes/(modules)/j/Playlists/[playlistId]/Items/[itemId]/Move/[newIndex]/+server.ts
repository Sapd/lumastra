// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { jellyfinToPlaylistEntryId } from '$lib/server/jellyfin-compat/playlist-id';
import {
    canEditPlaylist,
    getVisibleMediaIds,
    moveEntry,
    resolvePlaylistAccess,
} from '$lib/server/jellyfin-compat/playlist-service';

const logger = Logger.for('JellyfinCompat:Playlists');

/**
 * POST /j/Playlists/{playlistId}/Items/{itemId}/Move/{newIndex} — MoveItem.
 *
 * `itemId` is the entry's `PlaylistItemId`; `newIndex` is a position in the
 * list the caller sees. Owner or editor; the system watchlist has no manual
 * order (it is sorted by date added), so moving there is refused.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, params } = event;
        const user = locals.user;
        if (!user) return ApiResponses.unauthorized();
        const sql = getDb();
        if (!sql) return ApiResponses.error('Database unavailable');

        const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
        if ('error' in resolved) return resolved.error;
        const { access } = resolved;

        const entryId = jellyfinToPlaylistEntryId(params.itemId);
        if (entryId === null) return ApiResponses.badRequest('Invalid playlist item ID');
        const rawIndex = params.newIndex ?? '';
        if (!/^\d{1,9}$/.test(rawIndex)) return ApiResponses.badRequest('Invalid index');
        const newIndex = parseInt(rawIndex, 10);

        if (!canEditPlaylist(access)) {
            return ApiResponses.forbidden('You do not have permission to edit this playlist');
        }
        if (access.isSystem) {
            return ApiResponses.forbidden('This playlist cannot be reordered');
        }

        try {
            const visible = new Set(await getVisibleMediaIds(sql, access, user));
            const moved = await moveEntry(sql, access, entryId, newIndex, visible);
            if (!moved) return ApiResponses.notFound('Playlist item not found');
            return new Response(null, { status: 204 });
        } catch (err) {
            logger.error('Failed to move playlist item', err as Error, {
                playlistId: access.playlistId,
            });
            return ApiResponses.error('Failed to move item');
        }
    },
    { mode: 'write' },
);
