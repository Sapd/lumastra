// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/items/[entryId].ts — DELETE /playlists/{id}/items/{entryId}
 *
 * Remove a single item from a playlist (editor/owner only).
 *
 * Note: The SvelteKit route uses two nested [id] segments:
 *   /playlists/[id]/items/[entryId]
 * The inner [id] is the item id. getPlaylistItemContext reads the playlist id
 * from the URL pathname to work around the SvelteKit param collision.
 *
 * Auth: editor or owner.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/items/[entryId]/+server.ts (internal surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { playlistMessageResponseSchema } from '$lib/schemas/playlists.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { canEdit, getPlaylistItemContext } from '$lib/server/utils/playlist-utils.js';
import { playlistItemManager } from '$lib/server/services/playlist-item-manager.service.js';
import { getPlaylistType } from '$lib/server/database/queries/playlists.queries.js';
import { cacheInvalidation } from '$lib/server/cache';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistItemDeleteDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// The inner [id] segment (item id) is what SvelteKit surfaces as params.id
// when there are two nested [id] segments. The outer (playlist id) is read
// from the URL pathname inside getPlaylistItemContext.
const ItemDeleteParams = z.object({
    id: z.coerce.number().int().positive(),
    entryId: z.coerce.number().int().positive().max(2147483647),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    // OpenAPI docs for the /api/v1/playlists/{id}/items/{entryId} (public/native)
    // surface. Migrated verbatim from the retired v1 _openapi.ts (re-export of
    // the internal items/[entryId]/_openapi.ts `route`). No `auth`/`stability` fields.
    docs: {
        DELETE: {
            tags: ['Playlists'],
            stability: 'stable',
            summary: 'Remove item from playlist',
            responses: {
                200: {
                    schema: playlistMessageResponseSchema,
                    description: 'Item removed',
                },
                404: 'Playlist or item not found',
            },
        },
    },
    request: {
        params: ItemDeleteParams,
    },
    handlers: {
        /**
         * DELETE /playlists/{id}/items/{entryId}
         * Remove an item from a playlist (editor/owner only).
         *
         * Response: 200 + { message, playlistSummary }.
         */
        DELETE: async (event) => {
            const result = await getPlaylistItemContext(event);
            if ('error' in result) return result.error;

            const { playlistId, itemId, username, sql, role } = result.context;

            if (!canEdit(role)) {
                return ApiProblem.forbidden(
                    'You do not have permission to remove items from this playlist',
                );
            }

            // Read the media_id (and the playlist's kind) BEFORE deleting —
            // once the row is gone there is nothing left to look it up from.
            // Scoped to watchlist playlists only so an ordinary-playlist
            // delete pays nothing extra.
            const playlistType = await getPlaylistType(sql, playlistId);
            let watchlistMediaId: string | null = null;
            if (playlistType === 'watchlist') {
                const [row] = await sql<{ media_id: string }[]>`
                    SELECT media_id::text AS media_id FROM playlist_items
                    WHERE id = ${itemId} AND playlist_id = ${playlistId}
                `;
                watchlistMediaId = row?.media_id ?? null;
            }

            const playlistSummary = await playlistItemManager.removeEntry({
                sql,
                playlistId,
                itemId,
                username,
            });

            if (!playlistSummary) return ApiProblem.notFound('Item not found in playlist');

            // Watchlist writes through this route bypass WatchlistManager
            // (and its own cacheInvalidation.onWatchlistChange call) entirely,
            // so suggestion/similar-content caches would otherwise keep
            // pre-change contents. Best-effort — a cache-layer failure must
            // not fail the request.
            if (watchlistMediaId && event.locals.user?.userId) {
                try {
                    await cacheInvalidation.onWatchlistChange(
                        event.locals.user.userId,
                        watchlistMediaId,
                    );
                } catch (error) {
                    logger.warn('Failed to invalidate cache after watchlist item removal', {
                        playlistId,
                        itemId,
                        error: String(error),
                    });
                }
            }

            return json(playlistSummary);
        },
    },
});
