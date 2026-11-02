// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/items/bulk-delete.ts — POST /playlists/{id}/items/bulk-delete
 *
 * Remove multiple items from a playlist in a single request.
 *
 * Auth: editor or owner. Rate-limited via Valkey (20 req/60 s), enforced by
 * mount() through this def's `rateLimit` field below — the SAME budget is
 * shared with the sibling bulk-add def (key: `playlist-bulk:${username}`), on
 * BOTH the internal and v1 mounts. This handler itself is only 3 queries (no
 * per-item amplification); the limit exists so the two bulk mutation
 * endpoints share one combined abuse budget rather than each getting its own.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/items/bulk-delete/+server.ts (internal surface)
 */

import { json } from '@sveltejs/kit';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { canEdit, getPlaylistContext } from '$lib/server/utils/playlist-utils.js';
import {
    bulkDeletePlaylistItems,
    recalculatePositions,
    touchPlaylist,
    getPlaylistSummary,
    getPlaylistType,
} from '$lib/server/database/queries/playlists.queries.js';
import { cacheInvalidation } from '$lib/server/cache';
import {
    bulkDeleteItemsSchema,
    bulkDeleteResponseSchema,
    playlistIdParamsSchema,
} from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistBulkDeleteDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// Body validation uses the shared named schema (bulkDeleteItemsSchema) — the
// same object the retired _openapi.ts $ref'd — so the emitted spec keeps the
// #/components/schemas/bulkDeleteItems reference (byte-identical). The shared
// itemIds element is `z.coerce.number().int().positive()` vs the previous local
// `z.number().int().positive()`; the coercion only widens what the mount gate
// accepts, and the handler re-validates the raw body with its own strict parse
// below, so end-to-end behaviour is unchanged.
const BulkDeleteBody = bulkDeleteItemsSchema;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // Shared budget with the sibling bulk-add def — same limit, same key
    // namespace, on both the internal and v1 mounts. See the docstring above.
    rateLimit: {
        limit: 20,
        windowSec: 60,
        keyBy: (event) =>
            `playlist-bulk:${event.locals.principal?.username ?? event.locals.user?.username}`,
    },

    // OpenAPI docs for the /api/v1/playlists/{id}/items/bulk-delete surface.
    // Migrated verbatim from the retired
    // src/routes/api/playlists/[id]/items/bulk-delete/_openapi.ts.
    docs: {
        POST: {
            tags: ['Playlists'],
            stability: 'stable',
            summary: 'Bulk delete items',
            body: bulkDeleteItemsSchema,
            responses: {
                200: {
                    schema: bulkDeleteResponseSchema,
                    description: 'Items deleted in bulk',
                },
                404: 'Playlist not found',
            },
        },
    },

    request: {
        body: BulkDeleteBody,
        params: playlistIdParamsSchema,
    },
    handlers: {
        /**
         * POST /playlists/{id}/items/bulk-delete
         * Remove multiple items from a playlist atomically (editor/owner only).
         *
         * Response: 200 + { message, deletedCount, playlistSummary }.
         */
        POST: async (event) => {
            const result = await getPlaylistContext(event);
            if ('error' in result) return result.error;

            const { playlistId, username, sql, role } = result.context;

            if (!canEdit(role)) {
                return ApiProblem.forbidden(
                    'You do not have permission to remove items from this playlist',
                );
            }

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = BulkDeleteBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { entryIds: itemIds } = parsed.data;

            // Resolve the playlist's kind (and, for a watchlist, the
            // media_ids about to be removed) BEFORE deleting — once the rows
            // are gone there is nothing left to look them up from. Scoped to
            // watchlist playlists only so an ordinary-playlist bulk-delete
            // pays nothing extra.
            const playlistType = await getPlaylistType(sql, playlistId);
            let watchlistMediaIds: string[] = [];
            if (playlistType === 'watchlist') {
                const rows = await sql<{ media_id: string }[]>`
                    SELECT media_id::text AS media_id FROM playlist_items
                    WHERE playlist_id = ${playlistId} AND id = ANY(${itemIds}::int[])
                `;
                watchlistMediaIds = rows.map((r) => r.media_id);
            }

            const mutation = await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
                const count = await bulkDeletePlaylistItems(tx, playlistId, itemIds);
                if (count === 0) return null;
                await recalculatePositions(tx, playlistId);
                await touchPlaylist(tx, playlistId);
                return {
                    deletedCount: count,
                    playlistSummary: await getPlaylistSummary(tx, playlistId),
                };
            });

            if (!mutation) {
                return ApiProblem.notFound('No items found to delete');
            }

            const { deletedCount, playlistSummary } = mutation;

            // Watchlist writes through this route bypass WatchlistManager
            // (and its own cacheInvalidation.onWatchlistChange call) entirely,
            // so suggestion/similar-content caches would otherwise keep
            // pre-change contents. Best-effort — a cache-layer failure must
            // not fail the request.
            const invalidatingUserId = event.locals.user?.userId;
            if (watchlistMediaIds.length > 0 && invalidatingUserId) {
                for (const mediaId of watchlistMediaIds) {
                    try {
                        await cacheInvalidation.onWatchlistChange(invalidatingUserId, mediaId);
                    } catch (error) {
                        logger.warn('Failed to invalidate cache after watchlist bulk-delete', {
                            playlistId,
                            mediaId,
                            error: String(error),
                        });
                    }
                }
            }

            logger.info('Items bulk deleted from playlist', {
                playlistId,
                deletedCount,
                requestedCount: itemIds.length,
                username,
            });

            return json(playlistSummary);
        },
    },
});
