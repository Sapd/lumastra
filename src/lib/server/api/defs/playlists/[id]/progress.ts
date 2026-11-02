// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/progress.ts — GET /playlists/{id}/progress
 *
 * Get watch progress for all members of a playlist. Returns per-member stats
 * and per-item watcher lists. Only available to accepted members (not public
 * viewers or pending invitees).
 *
 * Auth: authenticated user who is an accepted member.
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/progress/+server.ts (internal surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPlaylistItemIds,
    checkPlaylistMembership,
    getMemberPlaylistProgress,
    getPlaylistItemWatchers,
} from '$lib/server/database/queries/playlists.queries.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { PlaylistProgressResponseSchema } from '$lib/schemas/playlists.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ProgressParams = z.object({
    id: z.coerce.number().int().positive(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    // OpenAPI docs for the /api/v1/playlists/{id}/progress (public/native)
    // surface. Migrated verbatim from the retired
    // src/routes/api/v1/playlists/[id]/progress/_openapi.ts, which re-exported
    // the internal sibling `route`. No `auth`/`stability` fields → security
    // stays NO_AUTH and stability defaults to 'beta' (byte-identical to prior).
    // No `params` slot here: the def's request.params (coerce.number) is a
    // lenient runtime gate that the doc reconciler would drop in favour of the
    // URL-derived `{id}: string` floor — leaving it out keeps the emitted param
    // identical to the pre-migration spec.
    docs: {
        GET: {
            tags: ['Playlists'],
            stability: 'beta',
            summary: 'Get collaborative playlist watch progress',
            description:
                'Returns per-member watch progress and per-item watcher details for collaborative playlists.',
            responses: {
                200: {
                    schema: PlaylistProgressResponseSchema,
                    description: 'Collaborative watch progress',
                },
                404: 'Playlist not found',
            },
        },
    },
    request: {
        params: ProgressParams,
    },
    handlers: {
        /**
         * GET /playlists/{id}/progress
         * Get watch progress for all accepted members of a playlist.
         *
         * Response: bare progress object (members[], itemsWatchedBy{}).
         */
        GET: async (event) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const userId = username ? await getUserIdByUsername(sql, username) : null;

            const { role, visibility } = await getUserRole(sql, playlistId, username || '');
            if (!role && visibility !== 'public') {
                return ApiProblem.notFound('Playlist not found or access denied');
            }

            if (!userId) {
                return ApiProblem.forbidden(
                    'Progress information is only available to playlist members',
                );
            }

            const membershipCheck = await checkPlaylistMembership(sql, playlistId, userId);
            if (membershipCheck.length === 0) {
                return ApiProblem.forbidden(
                    'Progress information is only available to playlist members',
                );
            }

            const playlistItems = await getPlaylistItemIds(sql, playlistId);
            const totalCount = playlistItems.length;

            const membersResult = await getMemberPlaylistProgress(sql, playlistId);
            const playlistItemWatchersResult = await getPlaylistItemWatchers(sql, playlistId);

            const playlistWatchedSet = new Set<string>();
            for (const row of playlistItemWatchersResult) {
                playlistWatchedSet.add(`${row.item_id}-${row.user_id}`);
            }

            const memberUserIds = membersResult.map((row) => row.user_id);
            const itemsWatchedBy: Record<number, { userId: string }[]> = {};
            const memberWatchCounts = new Map<string, number>();

            for (const memberUserId of memberUserIds) {
                memberWatchCounts.set(memberUserId, 0);
            }

            for (const item of playlistItems) {
                const watchers: { userId: string }[] = [];
                for (const memberUserId of memberUserIds) {
                    const playlistKey = `${item.id}-${memberUserId}`;
                    if (playlistWatchedSet.has(playlistKey)) {
                        watchers.push({ userId: memberUserId });
                        memberWatchCounts.set(
                            memberUserId,
                            (memberWatchCounts.get(memberUserId) || 0) + 1,
                        );
                    }
                }
                if (watchers.length > 0) {
                    itemsWatchedBy[item.id] = watchers;
                }
            }

            const members = membersResult
                .map((row) => {
                    const watchedCount = memberWatchCounts.get(row.user_id) || 0;
                    return {
                        userId: row.user_id,
                        watchedCount,
                        totalCount,
                        progressPercent:
                            totalCount > 0 ? Math.round((watchedCount / totalCount) * 100) : 0,
                        lastWatchedAt: row.last_watched_at?.toISOString() ?? null,
                    };
                })
                .sort((a, b) => b.watchedCount - a.watchedCount);

            return json({
                playlistId,
                totalItems: totalCount,
                members,
                itemsWatchedBy,
            });
        },
    },
});
