// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { getParam, getParamAll } from '$lib/server/jellyfin-compat/utils';
import {
    MAX_IDS_PER_REQUEST,
    MAX_SHARES_PER_REQUEST,
    bodyField,
    cleanPlaylistName,
    createJellyfinPlaylist,
    inferPlaylistType,
    mayPublish,
    parseJellyfinIdList,
    parseShares,
    playlistTypeForMediaType,
    playlistsDisabledResponse,
    readJsonObject,
} from '$lib/server/jellyfin-compat/playlist-service';
import type { JellyfinPlaylistCreationResult } from '$lib/server/jellyfin-compat/types';

const logger = Logger.for('JellyfinCompat:Playlists');

/**
 * POST /j/Playlists — CreatePlaylist.
 *
 * Accepts the `CreatePlaylistDto` body and/or the obsolete query parameters
 * (`name`, `ids`, `userId`, `mediaType`); query values win, as in Jellyfin.
 * Item ids the caller cannot see are skipped, never added.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, url, request } = event;
        const user = locals.user;
        if (!user) return ApiResponses.unauthorized();

        const disabled = playlistsDisabledResponse();
        if (disabled) return disabled;

        const sql = getDb();
        if (!sql) return ApiResponses.error('Database unavailable');

        const body = await readJsonObject(request);
        if (body === null) return ApiResponses.badRequest('Request body must be a JSON object');

        const name = cleanPlaylistName(getParam(url, 'Name') ?? bodyField(body, 'Name'));
        if (!name) return ApiResponses.badRequest('Playlist name is required');

        // A playlist is always created for the caller; Jellyfin lets only an
        // admin name someone else, and Lumastra has no "create on behalf of".
        const rawUserId = getParam(url, 'UserId') ?? bodyField(body, 'UserId');
        if (typeof rawUserId === 'string' && rawUserId !== '') {
            if (!isUuid(rawUserId)) return ApiResponses.badRequest('Invalid user ID');
            if (normalizeUuid(rawUserId) !== user.userId) {
                return ApiResponses.forbidden('Playlists can only be created for yourself');
            }
        }

        let ids = parseJellyfinIdList(getParamAll(url, 'Ids'));
        if (ids === null) return ApiResponses.badRequest('Invalid item ID in ids');
        if (ids.length === 0) {
            const bodyIds = bodyField(body, 'Ids');
            if (bodyIds !== undefined && bodyIds !== null) {
                if (!Array.isArray(bodyIds) || bodyIds.some((v) => typeof v !== 'string')) {
                    return ApiResponses.badRequest('Ids must be an array of item IDs');
                }
                ids = parseJellyfinIdList(bodyIds as string[]);
                if (ids === null) return ApiResponses.badRequest('Invalid item ID in Ids');
            }
        }
        if (ids.length > MAX_IDS_PER_REQUEST) {
            return ApiResponses.badRequest(`At most ${MAX_IDS_PER_REQUEST} items per request`);
        }

        const shares = parseShares(bodyField(body, 'Users'));
        if (shares === null) {
            return ApiResponses.badRequest(
                `Invalid Users (at most ${MAX_SHARES_PER_REQUEST} distinct users)`,
            );
        }

        const rawPublic = getParam(url, 'IsPublic') ?? bodyField(body, 'IsPublic');
        const isPublic = rawPublic === true || rawPublic === 'true';
        if (isPublic && !mayPublish(user)) {
            return ApiResponses.forbidden('You do not have permission to create public playlists');
        }

        const rawMediaType = getParam(url, 'MediaType') ?? bodyField(body, 'MediaType');
        const playlistType =
            playlistTypeForMediaType(typeof rawMediaType === 'string' ? rawMediaType : null) ??
            (await inferPlaylistType(sql, ids));

        try {
            const id = await createJellyfinPlaylist(sql, user, {
                name,
                mediaIds: ids,
                playlistType,
                isPublic,
                shares: shares ?? [],
            });
            const result: JellyfinPlaylistCreationResult = { Id: id };
            return json(result);
        } catch (err) {
            logger.error('Failed to create playlist', err as Error, { username: user.username });
            return ApiResponses.error('Failed to create playlist');
        }
    },
    { mode: 'write' },
);
