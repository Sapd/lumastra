// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/items/order.ts — PUT /playlists/{id}/items/order
 *
 * Reorder items in a playlist (after drag-and-drop). Updates all specified
 * item positions atomically in a transaction.
 *
 * Auth: editor or owner.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/items/order/+server.ts (internal surface)
 */

import { config } from '$lib/server/config.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { json } from '@sveltejs/kit';
import { withTx } from '$lib/server/database/with-tx.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { canEdit, getPlaylistContext, getUserRole } from '$lib/server/utils/playlist-utils.js';
import {
    getPlaylistItems,
    getNextPosition,
    touchPlaylist,
    getPlaylistSummary,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    reorderItemsSchema,
    playlistMessageResponseSchema,
    playlistIdParamsSchema,
} from '$lib/schemas/playlists.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// Revision and the complete visible permutation are checked under the playlist lock.
const ReorderBody = reorderItemsSchema;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/playlists/{id}/items/order surface. Migrated
    // verbatim from the retired
    // src/routes/api/playlists/[id]/items/order/_openapi.ts.
    docs: {
        PUT: {
            tags: ['Playlists'],
            stability: 'stable',
            summary: 'Reorder items',
            body: reorderItemsSchema,
            responses: {
                200: {
                    schema: playlistMessageResponseSchema,
                    description: 'Items reordered',
                },
                404: 'Playlist not found',
                409: 'Playlist revision changed; refetch the playlist and retry',
                422: 'Not a full permutation',
            },
        },
    },

    request: {
        body: ReorderBody,
        params: playlistIdParamsSchema,
    },
    handlers: {
        /**
         * PUT /playlists/{id}/items/order
         * Reorder items in a playlist (editor/owner only).
         *
         * Response: 200 + PlaylistSummary.
         */
        PUT: async (event) => {
            const result = await getPlaylistContext(event);
            if ('error' in result) return result.error;

            const { playlistId, sql, role, isSystem, userId } = result.context;

            if (!canEdit(role)) {
                return ApiProblem.forbidden(
                    'You do not have permission to reorder items in this playlist',
                );
            }
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = ReorderBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { expectedRevision, entryIds } = parsed.data;
            return await withTx(sql, async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
                // The permission check above ran before the lock: the playlist
                // may have been deleted, made a system list or the caller's
                // role revoked in between.
                const current = await getUserRole(tx, playlistId, null, userId ?? undefined);
                if (!current.role) return ApiProblem.notFound('Playlist not found');
                if (!canEdit(current.role)) {
                    return ApiProblem.forbidden(
                        'You do not have permission to reorder items in this playlist',
                    );
                }
                if (current.isSystem) {
                    return ApiProblem.conflict('This playlist does not support that operation');
                }
                const summary = await getPlaylistSummary(tx, playlistId);
                if (summary.revision !== expectedRevision) {
                    return ApiProblem.conflict('Playlist changed; reload before reordering', {
                        details: `revision:${summary.revision}`,
                    });
                }
                const denied = await getDeniedLibraryGroups(
                    tx,
                    toLibraryAccessUser(event.locals.user),
                );
                const entries = await getPlaylistItems(
                    tx,
                    playlistId,
                    userId,
                    undefined,
                    restrictedAccess({
                        deniedGroupIds: denied ?? [],
                        maxAgeRating: event.locals.user?.maxAgeRating ?? null,
                        allowUnrated: config.UNRATED_CONTENT_VISIBLE,
                    }),
                    { mode: 'offset', availableOnly: true },
                );
                const ids = new Set(entryIds);
                if (
                    ids.size !== entryIds.length ||
                    entries.length !== entryIds.length ||
                    entries.some((entry) => !ids.has(entry.id))
                ) {
                    return ApiProblem.validationFailed(
                        'entryIds must be a complete permutation of the visible entries',
                    );
                }
                // Reuse visible position slots so no hidden entry is updated.
                // Legacy/concurrent writes may have tied positions. Give those
                // extra visible entries distinct trailing slots so the id tie-break
                // cannot silently undo the client's requested order.
                const positions = [...new Set(entries.map((entry) => entry.position))];
                if (positions.length < entryIds.length) {
                    let nextPosition = await getNextPosition(tx, playlistId);
                    while (positions.length < entryIds.length) positions.push(nextPosition++);
                }
                await tx`
                    UPDATE playlist_items pi
                    SET position = v.position
                    FROM unnest(${entryIds}::int[], ${positions}::int[]) AS v(id, position)
                    WHERE pi.id = v.id AND pi.playlist_id = ${playlistId}
                `;
                await touchPlaylist(tx, playlistId);
                return json(await getPlaylistSummary(tx, playlistId));
            });
        },
    },
});
