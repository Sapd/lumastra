// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/items/[entryId]/watched.ts — PUT /playlists/{id}/items/{entryId}/watched
 *
 * Toggle the watched status of an item in a playlist for the authenticated user.
 * Only playlist owners and accepted members may record watched status — public
 * viewers cannot write watch state.
 *
 * Auth: feature-gated (playlists) + authenticated user.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/items/[entryId]/watched/+server.ts (internal surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getPlaylistItemContext } from '$lib/server/utils/playlist-utils.js';
import {
    verifyItemExists,
    upsertWatchedStatus,
    touchPlaylist,
    getPlaylistSummary,
    checkPlaylistMembership,
} from '$lib/server/database/queries/playlists.queries.js';
import { updateWatchedStatusSchema, toggleWatchedResponseSchema } from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistWatchedDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// Body validation uses the shared named schema (updateWatchedStatusSchema) — the
// same object the retired _openapi.ts $ref'd — so the emitted spec keeps the
// #/components/schemas/updateWatchedStatus reference (byte-identical). It is
// structurally identical to the previous local WatchedBody.
const WatchedBody = updateWatchedStatusSchema;

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/playlists/{id}/items/{entryId}/watched surface.
    // Migrated verbatim from the retired
    // src/routes/api/playlists/[id]/items/[entryId]/watched/_openapi.ts.
    docs: {
        PUT: {
            tags: ['Playlists'],
            stability: 'stable',
            summary: 'Update watched status',
            body: updateWatchedStatusSchema,
            responses: {
                200: {
                    schema: toggleWatchedResponseSchema,
                    description: 'Watched status updated',
                },
                404: 'Playlist or item not found',
            },
        },
    },

    request: {
        body: WatchedBody,
    },
    handlers: {
        /**
         * PUT /playlists/{id}/items/{entryId}/watched
         * Toggle watched status for an item (any accepted member, for themselves).
         *
         * Response: 200 + { watched, watchedAt?, playlistSummary }.
         */
        PUT: async (event) => {
            const result = await getPlaylistItemContext(event);
            if ('error' in result) return result.error;

            const { playlistId, itemId, userId, sql, username } = result.context;
            if (!userId) return ApiProblem.unauthorized();

            // Only owner or an ACCEPTED member may record watched status.
            // A public playlist's non-member viewer also gets 'readonly' role but
            // must not write watch state — checkPlaylistMembership enforces this.
            const membership = await checkPlaylistMembership(sql, playlistId, userId);
            if (membership.length === 0) {
                return ApiProblem.forbidden('Only playlist members can update watched status');
            }

            const exists = await verifyItemExists(sql, itemId, playlistId);
            if (!exists) return ApiProblem.notFound('Item not found in playlist');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = WatchedBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { watched } = parsed.data;

            const status = await upsertWatchedStatus(sql, playlistId, itemId, userId, watched);
            const watchedAt =
                status.watched_at instanceof Date
                    ? status.watched_at.toISOString()
                    : (status.watched_at ?? undefined);

            await touchPlaylist(sql, playlistId, false);
            const playlistSummary = await getPlaylistSummary(sql, playlistId);

            logger.info('Item watched status updated', {
                playlistId,
                itemId,
                username,
                watched,
            });

            return json({ watched: status.watched, watchedAt, playlistSummary });
        },
    },
});
