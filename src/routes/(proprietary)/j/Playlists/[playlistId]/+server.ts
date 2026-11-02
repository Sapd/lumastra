// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import {
    MAX_IDS_PER_REQUEST,
    MAX_SHARES_PER_REQUEST,
    bodyField,
    canEditPlaylist,
    cleanPlaylistName,
    getShares,
    getVisibleMediaIds,
    mayPublish,
    parseJellyfinIdList,
    parseShares,
    readJsonObject,
    replaceItems,
    resolvePlaylistAccess,
    setShares,
    updatePlaylistMeta,
} from '$lib/server/proprietary/jellyfin-compat/playlist-service';
import type { JellyfinPlaylistDto } from '$lib/server/proprietary/jellyfin-compat/types';

const logger = Logger.for('JellyfinCompat:Playlists');

/**
 * GET /j/Playlists/{playlistId} — GetPlaylist → PlaylistDto.
 *
 * ItemIds lists only the entries the caller can see (Jellyfin lists every
 * entry; Lumastra never reveals items outside the viewer's library/age scope).
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

    try {
        const [itemIds, shares] = await Promise.all([
            getVisibleMediaIds(sql, access, user),
            getShares(sql, access, user),
        ]);
        const dto: JellyfinPlaylistDto = {
            OpenAccess: access.visibility === 'public',
            Shares: shares,
            ItemIds: itemIds,
        };
        return json(dto);
    } catch (err) {
        logger.error('Failed to get playlist', err as Error, { playlistId: access.playlistId });
        return ApiResponses.error('Failed to get playlist');
    }
});

/**
 * POST /j/Playlists/{playlistId} — UpdatePlaylist (UpdatePlaylistDto).
 * Null/absent fields are left alone. Owner or editor; changing `IsPublic` or
 * `Users` is owner-only (Lumastra's sharing rules), and the system watchlist
 * cannot be renamed, shared or made public.
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

        const body = await readJsonObject(request);
        if (body === null) return ApiResponses.badRequest('Request body must be a JSON object');

        if (!canEditPlaylist(access)) {
            return ApiResponses.forbidden('You do not have permission to edit this playlist');
        }

        const rawName = bodyField(body, 'Name');
        let name: string | undefined;
        if (rawName !== undefined && rawName !== null) {
            const cleaned = cleanPlaylistName(rawName);
            if (!cleaned) return ApiResponses.badRequest('Playlist name cannot be empty');
            name = cleaned;
        }

        const rawPublic = bodyField(body, 'IsPublic');
        if (rawPublic !== undefined && rawPublic !== null && typeof rawPublic !== 'boolean') {
            return ApiResponses.badRequest('IsPublic must be a boolean');
        }
        const isPublic = typeof rawPublic === 'boolean' ? rawPublic : undefined;

        const shares = parseShares(bodyField(body, 'Users'));
        if (shares === null) {
            return ApiResponses.badRequest(
                `Invalid Users (at most ${MAX_SHARES_PER_REQUEST} distinct users)`,
            );
        }

        const rawIds = bodyField(body, 'Ids');
        let ids: string[] | undefined;
        if (rawIds !== undefined && rawIds !== null) {
            if (!Array.isArray(rawIds) || rawIds.some((v) => typeof v !== 'string')) {
                return ApiResponses.badRequest('Ids must be an array of item IDs');
            }
            const parsed = parseJellyfinIdList(rawIds as string[]);
            if (parsed === null) return ApiResponses.badRequest('Invalid item ID in Ids');
            if (parsed.length > MAX_IDS_PER_REQUEST) {
                return ApiResponses.badRequest(`At most ${MAX_IDS_PER_REQUEST} items per request`);
            }
            ids = parsed;
        }

        if (access.isSystem && (name !== undefined || isPublic !== undefined || shares)) {
            return ApiResponses.forbidden('This playlist cannot be renamed, shared or made public');
        }
        if ((isPublic !== undefined || shares) && access.role !== 'owner') {
            return ApiResponses.forbidden('Only the owner can change sharing');
        }
        if (isPublic === true && !mayPublish(user)) {
            return ApiResponses.forbidden('You do not have permission to create public playlists');
        }

        try {
            if (ids) await replaceItems(sql, access, user, ids);
            await updatePlaylistMeta(sql, access, { name, isPublic });
            if (shares) await setShares(sql, access, shares);
            return new Response(null, { status: 204 });
        } catch (err) {
            logger.error('Failed to update playlist', err as Error, {
                playlistId: access.playlistId,
            });
            return ApiResponses.error('Failed to update playlist');
        }
    },
    { mode: 'write' },
);
