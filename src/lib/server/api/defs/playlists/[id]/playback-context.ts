// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/playback-context.ts — GET /playlists/{id}/playback-context
 *
 * Get playback context for a playlist: current item, next/previous navigation,
 * bounded entry projections. Used by the player to determine what plays next.
 *
 * Auth: feature-gated (playlists) + any user with playlist access.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/playback-context/+server.ts (internal surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    playbackContextQuerySchema,
    playbackContextResponseSchema,
} from '$lib/schemas/playlists.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPlaylistItems,
    type PlaylistTypeValue,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    isPlayableVideoEntry,
    transformPlaylistItemRow,
} from '$lib/server/utils/playlist-transforms.js';
import { getPlaylistKindPolicy } from '$lib/server/services/playlist-kind-policy.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const PlaybackContextParams = z.object({
    id: z.coerce.number().int().positive(),
});

interface PlaylistRow {
    id: number;
    name: string;
    user_id: string;
    playlist_type: string | null;
}

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    visibility: 'internal',
    // OpenAPI docs for the /api/v1/playlists/{id}/playback-context
    // (public/native) surface. Migrated verbatim from the retired v1 _openapi.ts
    // (re-export of the internal playback-context/_openapi.ts `route`).
    docs: {
        GET: {
            tags: ['Playlists'],
            stability: 'beta',
            summary: 'Get playback context for playlist',
            description:
                'Returns the selected entry and its adjacent entries. Load the paginated items resource for the sidebar.',
            query: playbackContextQuerySchema,
            responses: {
                200: {
                    schema: playbackContextResponseSchema,
                    description: 'Playback context with navigation',
                },
                404: 'Playlist not found',
            },
        },
    },
    request: {
        params: PlaybackContextParams,
        query: playbackContextQuerySchema,
    },
    handlers: {
        /**
         * GET /playlists/{id}/playback-context
         * Get playback context for a playlist.
         *
         * Exactly one selector: entryId, stored position, or catalog mediaId.
         *
         * Response: bare playback context object.
         */
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;

            const parsed = playbackContextQuerySchema.safeParse(
                Object.fromEntries(event.url.searchParams),
            );
            if (!parsed.success) return ApiProblem.validationFailed(parsed.error.message);
            const selector = parsed.data;

            const { role, visibility } = await getUserRole(sql, playlistId, username || '');
            if (!role && visibility !== 'public') {
                return ApiProblem.notFound('Playlist not found or access denied');
            }

            const playlistResult = await sql<PlaylistRow[]>`
                SELECT id, name, user_id, playlist_type
                FROM playlists
                WHERE id = ${playlistId}
            `;
            if (playlistResult.length === 0) return ApiProblem.notFound('Playlist not found');
            const playlist = playlistResult[0];

            const deniedGroups = await getDeniedLibraryGroups(
                sql,
                toLibraryAccessUser(event.locals.user),
            );
            const access = restrictedAccess({
                deniedGroupIds: deniedGroups ?? [],
                maxAgeRating: event.locals.user?.maxAgeRating ?? null,
                allowUnrated: config.UNRATED_CONTENT_VISIBLE,
            });

            // GET /playlists/{id}/items serves the watchlist newest-first
            // (`added_at_desc`, via the kind policy's `sort`); this endpoint
            // used to always default to `position`, so it served the
            // watchlist oldest-first — a different order for the same
            // playlist depending which endpoint the player asked. Look up
            // the same policy so both surfaces agree.
            const sort = getPlaylistKindPolicy(
                playlist.playlist_type as PlaylistTypeValue | null,
            ).sort;

            const items = await getPlaylistItems(
                sql,
                playlistId,
                event.locals.user?.userId ?? null,
                undefined,
                access,
                { mode: 'offset', availableOnly: true },
                sort,
            );

            if (items.length === 0) return ApiProblem.notFound('Playlist is empty');

            const currentPosition = items.findIndex((item) =>
                selector.entryId !== undefined
                    ? item.id === selector.entryId
                    : selector.mediaId !== undefined
                      ? item.media_id === selector.mediaId.toLowerCase()
                      : item.position === selector.position,
            );
            if (currentPosition < 0) return ApiProblem.notFound('Entry not found in playlist');

            const currentItem = items[currentPosition];
            // Music and unavailable entries (no media_id) must not end video
            // navigation in a mixed list: previous/next skip them.
            const playableIndexes = items.flatMap((item, index) =>
                isPlayableVideoEntry(item) ? [index] : [],
            );
            const nextIndex = playableIndexes.find((index) => index > currentPosition);
            const previousIndex = playableIndexes.findLast((index) => index < currentPosition);
            const nextItem = nextIndex === undefined ? null : items[nextIndex];
            const previousItem = previousIndex === undefined ? null : items[previousIndex];

            return json({
                playlist: { id: playlistId, name: playlist.name, totalItems: items.length },
                current: transformPlaylistItemRow(currentItem, ctx.surface),
                previous: previousItem ? transformPlaylistItemRow(previousItem, ctx.surface) : null,
                next: nextItem ? transformPlaylistItemRow(nextItem, ctx.surface) : null,
            });
        },
    },
});
