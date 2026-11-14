// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import {
    bodyField,
    getShareFor,
    readJsonObject,
    removeShare,
    resolvePlaylistAccess,
    upsertShare,
} from '$lib/server/jellyfin-compat/playlist-service';
import { toJellyfinId } from '$lib/server/jellyfin-compat/serializers/user';
import type { JellyfinPlaylistUserPermissions } from '$lib/server/jellyfin-compat/types';

const logger = Logger.for('JellyfinCompat:Playlists');

function parseUserId(raw: string | undefined): string | null {
    return raw && isUuid(raw) ? normalizeUuid(raw) : null;
}

/**
 * GET /j/Playlists/{playlistId}/Users/{userId} — GetPlaylistUser.
 *
 * Clients call this with their own id to learn whether they may edit. The
 * owner gets `CanEdit: true` for themselves and may look up any share; anyone
 * else may only look up their own (Lumastra's member list is owner-only, so an
 * editor does not get to probe other users the way Jellyfin allows).
 */
export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const user = locals.user;
    if (!user) return ApiResponses.unauthorized();
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
    if ('error' in resolved) return resolved.error;
    const { access } = resolved;

    const targetUserId = parseUserId(params.userId);
    if (!targetUserId) return ApiResponses.badRequest('Invalid user ID');

    if (access.role === 'owner' && targetUserId === user.userId) {
        const self: JellyfinPlaylistUserPermissions = {
            UserId: toJellyfinId(user.userId),
            CanEdit: true,
        };
        return json(self);
    }
    if (access.role !== 'owner' && targetUserId !== user.userId) {
        return ApiResponses.forbidden('You can only view your own playlist permissions');
    }

    const share = await getShareFor(sql, access, targetUserId);
    if (!share) return ApiResponses.notFound('User permissions not found');
    return json(share);
});

/**
 * POST /j/Playlists/{playlistId}/Users/{userId} — UpdatePlaylistUser.
 * Owner only. Shares the playlist with the user (an invite they accept in
 * Lumastra) or changes an existing member's role; `CanEdit` absent = false.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, params, request } = event;
        const user = locals.user;
        if (!user) return ApiResponses.unauthorized();
        const sql = getDb();
        if (!sql) return ApiResponses.error('Database unavailable');

        const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
        if ('error' in resolved) return resolved.error;
        const { access } = resolved;

        const targetUserId = parseUserId(params.userId);
        if (!targetUserId) return ApiResponses.badRequest('Invalid user ID');

        const body = await readJsonObject(request);
        if (body === null) return ApiResponses.badRequest('Request body must be a JSON object');
        const canEdit = bodyField(body, 'CanEdit');
        if (canEdit !== undefined && canEdit !== null && typeof canEdit !== 'boolean') {
            return ApiResponses.badRequest('CanEdit must be a boolean');
        }

        if (access.role !== 'owner') {
            return ApiResponses.forbidden('Only the owner can share this playlist');
        }
        if (access.isSystem) {
            return ApiResponses.forbidden('This playlist cannot be shared');
        }

        try {
            const result = await upsertShare(sql, access, targetUserId, canEdit === true);
            if (result === 'self') return ApiResponses.badRequest('The owner cannot be added');
            if (result === 'user_not_found') return ApiResponses.notFound('User not found');
            return new Response(null, { status: 204 });
        } catch (err) {
            logger.error('Failed to update playlist user', err as Error, {
                playlistId: access.playlistId,
            });
            return ApiResponses.error('Failed to update playlist user');
        }
    },
    { mode: 'write' },
);

/**
 * DELETE /j/Playlists/{playlistId}/Users/{userId} — RemoveUserFromPlaylist.
 * The owner may remove anyone; a member may remove themselves (leave).
 * Jellyfin also lets editors remove others — Lumastra keeps that owner-only.
 */
export const DELETE: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, params } = event;
        const user = locals.user;
        if (!user) return ApiResponses.unauthorized();
        const sql = getDb();
        if (!sql) return ApiResponses.error('Database unavailable');

        const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
        if ('error' in resolved) return resolved.error;
        const { access } = resolved;

        const targetUserId = parseUserId(params.userId);
        if (!targetUserId) return ApiResponses.badRequest('Invalid user ID');

        if (access.role !== 'owner' && targetUserId !== user.userId) {
            return ApiResponses.forbidden('Only the owner can remove other users');
        }

        try {
            const removed = await removeShare(sql, access, targetUserId);
            if (!removed) return ApiResponses.notFound('User permissions not found');
            return new Response(null, { status: 204 });
        } catch (err) {
            logger.error('Failed to remove playlist user', err as Error, {
                playlistId: access.playlistId,
            });
            return ApiResponses.error('Failed to remove playlist user');
        }
    },
    { mode: 'write' },
);
