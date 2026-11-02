// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/index.ts — GET/PATCH/DELETE /playlists/{id}
 *
 * Auth:
 *   GET    — any authenticated user with access (role or public visibility)
 *   PATCH    — owner or editor; visibility/type changes are owner-only
 *   DELETE — owner only
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/+server.ts (internal surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { canCreatePublicPlaylist } from '$lib/server/config.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPlaylistById,
    deletePlaylist,
    deletePlaylistChatMessages,
    updatePlaylist,
} from '$lib/server/database/queries/playlists.queries.js';
import { playlistWithImages } from '$lib/server/utils/playlist-transforms.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaylistByIdDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const PlaylistIdParams = z.object({
    id: z.coerce.number().int().positive(),
});

const UpdatePlaylistBody = z.object({
    name: z
        .string()
        .min(1, 'Playlist name cannot be empty')
        .max(255, 'Playlist name must be 255 characters or less')
        .transform((s) => s.trim())
        .optional(),
    description: z
        .string()
        .transform((s) => s.trim())
        .optional(),
    visibility: z.enum(['private', 'public']).optional(),
    playlistType: z.enum(['general', 'music', 'video']).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    visibility: 'internal',
    request: {
        params: PlaylistIdParams,
        body: UpdatePlaylistBody,
        bodyMethods: ['PUT'],
    },
    handlers: {
        /**
         * GET /playlists/{id}
         * Get complete playlist metadata.
         *
         * Response: Playlist
         * Accessible to owner, members, and anonymous viewers of public playlists
         * (with library-group and age-rating filters applied).
         */
        GET: async (event, ctx) => {
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

            const { role, visibility } = await getUserRole(sql, playlistId, username || '');

            if (!role && visibility !== 'public') {
                return ApiProblem.notFound('Playlist not found or access denied');
            }

            const playlist = await getPlaylistById(sql, playlistId);
            if (!playlist) return ApiProblem.notFound('Playlist not found');

            return json(await playlistWithImages(sql, playlist, role || 'readonly', ctx.surface));
        },

        /**
         * PATCH /playlists/{id}
         * Update playlist metadata (name, description, visibility, type).
         *
         * Only owner can change visibility or type. Editors can change name/description.
         * Response: 200 + updated playlist object.
         */
        PATCH: async (event, ctx) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const userGroups =
                event.locals.principal?.userGroups ?? event.locals.user?.userGroups ?? [];

            const { role, isSystem } = await getUserRole(sql, playlistId, username);
            if (!role) return ApiProblem.notFound('Playlist not found or access denied');
            if (role === 'readonly') {
                return ApiProblem.forbidden('You do not have permission to edit this playlist');
            }

            let body: unknown;
            try {
                body = ctx.input?.body ?? (await event.request.json());
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = UpdatePlaylistBody.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { name, description, visibility, playlistType } = parsed.data;

            if (
                isSystem &&
                (name !== undefined || visibility !== undefined || playlistType !== undefined)
            ) {
                return ApiProblem.conflict('This playlist cannot be renamed, shared or retyped');
            }

            if (visibility !== undefined && role !== 'owner') {
                return ApiProblem.forbidden('Only the owner can change playlist visibility');
            }
            if (playlistType !== undefined && role !== 'owner') {
                return ApiProblem.forbidden('Only the owner can change playlist type');
            }

            let validVisibility = visibility;
            if (visibility === 'public' && !canCreatePublicPlaylist(userGroups)) {
                logger.info('User not in public playlist groups, keeping private', {
                    username,
                    playlistId,
                });
                validVisibility = 'private';
            }

            const playlist = await updatePlaylist(sql, playlistId, {
                name,
                description,
                visibility: validVisibility,
                playlistType,
            });

            if (!playlist) return ApiProblem.notFound('Playlist not found');

            logger.info('Playlist updated', { playlistId, username });

            const complete = await getPlaylistById(sql, playlistId);
            // Deleted between the update and the re-read.
            if (!complete) return ApiProblem.notFound('Playlist not found');
            return json(await playlistWithImages(sql, complete, role, ctx.surface));
        },

        /**
         * DELETE /playlists/{id}
         * Delete a playlist (owner only).
         *
         * Response: 200 + { message }.
         */
        DELETE: async (event) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const { role, userId, isSystem } = await getUserRole(sql, playlistId, username);
            if (role !== 'owner' || !userId) {
                return ApiProblem.forbidden('Only the owner can delete a playlist');
            }
            if (isSystem) {
                return ApiProblem.conflict('This playlist cannot be deleted');
            }

            const success = await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as typeof sql;
                await deletePlaylistChatMessages(tx, playlistId);
                return await deletePlaylist(tx, playlistId, userId);
            });

            if (!success) return ApiProblem.notFound('Playlist not found');

            logger.info('Playlist deleted', { playlistId, username });

            return json({ message: 'Playlist deleted' });
        },
    },
});
