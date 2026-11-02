// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/view-state.ts — PUT /playlists/{id}/view-state
 *
 * Persist the requesting user's collapsed series/season groups for this
 * playlist. Any user with access (owner, editor, readonly, or authenticated
 * public viewer) may save their own personal view state.
 *
 * This does NOT call touchPlaylist — it only writes the caller's own row and
 * never mutates the playlist itself.
 *
 * Auth: feature-gated (playlists) + authenticated user with playlist access.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/view-state/+server.ts (internal surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getPlaylistContext } from '$lib/server/utils/playlist-utils.js';
import { upsertPlaylistViewState } from '$lib/server/database/queries/playlists.queries.js';
import { saveViewStateSchema, viewStateResponseSchema } from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistViewStateDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// Body validation uses the shared named schema (saveViewStateSchema) — the same
// object the retired _openapi.ts $ref'd — so the emitted spec keeps the
// #/components/schemas/saveViewState reference (byte-identical). It is
// structurally identical to the previous local ViewStateBody.
const ViewStateBody = saveViewStateSchema;

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/playlists/{id}/view-state surface. Migrated
    // verbatim from the retired
    // src/routes/api/playlists/[id]/view-state/_openapi.ts.
    docs: {
        PUT: {
            tags: ['Playlists'],
            stability: 'beta',
            summary: 'Save the requesting user’s collapsed series/season groups',
            body: saveViewStateSchema,
            responses: {
                200: {
                    schema: viewStateResponseSchema,
                    description: 'View state saved',
                },
                404: 'Playlist not found or access denied',
            },
        },
    },

    request: {
        body: ViewStateBody,
    },
    handlers: {
        /**
         * PUT /playlists/{id}/view-state
         * Save the caller's collapsed group preferences for this playlist.
         *
         * Response: 200 + { collapsedGroups } (echoes what was saved).
         */
        PUT: async (event) => {
            const result = await getPlaylistContext(event);
            if ('error' in result) return result.error;

            const { playlistId, userId, sql, username } = result.context;
            // An anonymous viewer has no identity to persist against.
            if (!userId) return ApiProblem.unauthorized();

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = ViewStateBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { collapsedGroups } = parsed.data;

            await upsertPlaylistViewState(sql, playlistId, userId, collapsedGroups);

            logger.debug('Saved playlist view state', {
                playlistId,
                username,
                seriesCollapsed: collapsedGroups.series.length,
                seasonCollapsed: collapsedGroups.season.length,
            });

            return json({ collapsedGroups });
        },
    },
});
