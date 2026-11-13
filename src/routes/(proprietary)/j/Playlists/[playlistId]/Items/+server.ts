// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getParam, getParamAll, getJfToken } from '$lib/server/proprietary/jellyfin-compat/utils';
import { getPlaylistItems } from '$lib/server/database/queries/playlists.queries';
import { getUserRole } from '$lib/server/utils/playlist-utils';
import {
    parseJellyfinPlaylistId,
    playlistEntryIdToJellyfin,
} from '$lib/server/proprietary/jellyfin-compat/playlist-id';
import {
    MAX_IDS_PER_REQUEST,
    addJellyfinItems,
    canEditPlaylist,
    getVisibleMediaIds,
    parseEntryIdList,
    parseJellyfinIdList,
    removeEntries,
    resolvePlaylistAccess,
} from '$lib/server/proprietary/jellyfin-compat/playlist-service';
import { Logger } from '$lib/server/utils/logger';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import {
    serializeBaseItems,
    mapRowToMediaItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { enrichItemsWithMediaSources } from '$lib/server/proprietary/jellyfin-compat/media-source-enrichment';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from '$lib/server/proprietary/jellyfin-compat/music-artists-enrichment';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import { enrichItemsForList } from '$lib/server/proprietary/jellyfin-compat/item-details-enrichment';
import {
    browseMediaItems,
    mapJellyfinTypes,
} from '$lib/server/database/queries/jellyfin-browse.queries';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import type {
    JellyfinBaseItemDto,
    JellyfinItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/types';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:Playlists');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, url, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const rawId = params.playlistId;
    if (!rawId) {
        return ApiResponses.badRequest('Missing playlist ID');
    }
    const playlistId = parseJellyfinPlaylistId(rawId);
    if (playlistId === null) {
        return ApiResponses.badRequest('Invalid playlist ID');
    }

    const limit = Math.min(Math.max(1, parseInt(getParam(url, 'Limit') ?? '150', 10) || 150), 500);
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    const dtoOptions = parseDtoOptions(url);
    const includeItemTypes = getParam(url, 'IncludeItemTypes');
    const apiKey = getJfToken(locals as unknown as Record<string, unknown>);

    try {
        // Playlist IDs are sequential integers (encoded as deterministic UUIDs
        // for the Jellyfin SDK). Without this gate, an authenticated user
        // could enumerate Ids and read items from any private or non-shared
        // playlist. 404 (rather than 403) so existence isn't revealed.
        const { role } = await getUserRole(sql, playlistId, locals.user.username);
        if (!role) {
            return ApiResponses.notFound('Playlist not found');
        }

        const mediaTypes = includeItemTypes ? mapJellyfinTypes(includeItemTypes) : [];
        const playlistItemType = mediaTypes.includes('track')
            ? 'music'
            : mediaTypes.includes('movie') || mediaTypes.includes('episode')
              ? 'video'
              : undefined;

        // Derived ONCE for the whole handler. This used to be computed twice —
        // once here and again inside the `mediaIds.length > 0` branch below —
        // which is exactly the drift the boundary migration removes.
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const playlistItems = await getPlaylistItems(
            sql,
            playlistId,
            locals.user.userId,
            playlistItemType as 'music' | 'video' | undefined,
            access.boundary,
            { mode: 'offset', availableOnly: true },
        );

        const totalCount = playlistItems.length;
        const paged = playlistItems.slice(startIndex, startIndex + limit);

        // Music playlist items have a media_id UUID — look them up as full media items
        // so we can serialize them properly with streams/sources.
        const mediaIds = paged.map((pi) => pi.media_id as string).filter(Boolean);
        // Jellyfin's PlaylistItemId: the entry id clients send back to
        // DELETE /Playlists/{id}/Items?entryIds= and .../Items/{id}/Move/{n}.
        const entryIdByMediaId = new Map(
            paged.map((pi) => [pi.media_id as string, playlistEntryIdToJellyfin(pi.id)]),
        );

        if (mediaIds.length > 0) {
            const { rows } = await browseMediaItems(sql, {
                mediaTypes: [],
                parentId: null,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: true,
                userId: locals.user.userId,
                idList: mediaIds,
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: mediaIds.length,
                startIndex: 0,
                access: access.boundary,
                forceEpisodeOrder: false,
            });

            // Preserve playlist order
            const byId = new Map(rows.map((r) => [String(r.id), r]));
            const ordered = mediaIds
                .map((id) => byId.get(id))
                .filter((r): r is NonNullable<typeof r> => r != null);

            const items = ordered.map(mapRowToMediaItem);
            await applyJellyfinContentLanguage(sql, locals.user.userId, items);
            const serialized = serializeBaseItems(items);
            serialized.forEach((dto, i) => {
                dto.PlaylistItemId = entryIdByMediaId.get(String(ordered[i].id));
            });
            await enrichItemsWithMediaSources(sql, serialized, apiKey);
            await enrichItemsWithProviderIds(sql, serialized);
            await enrichItemsWithMusicArtists(sql, serialized);
            if (dtoOptions.enableImages) await enrichItemsWithImages(sql, serialized);
            await enrichItemsForList(sql, serialized, dtoOptions);

            const response: JellyfinItemsResponse = {
                Items: serialized,
                TotalRecordCount: totalCount,
                StartIndex: startIndex,
            };
            return json(shapeItemsResponse(response, dtoOptions));
        }

        // Fallback: simple shape for items without a media_id (legacy/partial rows)
        const items = paged.map((pi) => ({
            Name: (pi.title as string) ?? 'Unknown',
            Id: pi.media_id as string,
            ServerId: JELLYFIN_SERVER_ID,
            Type: 'Audio' as const,
            RunTimeTicks: 0,
            Artists: pi.artist ? [pi.artist as string] : [],
            AlbumArtist: (pi.artist as string) ?? undefined,
            Album: (pi.series_name as string) ?? undefined,
            AlbumId: (pi.parent_id as string) ?? undefined,
            ImageTags: {},
            BackdropImageTags: [],
            PlaylistItemId: playlistEntryIdToJellyfin(pi.id),
        }));

        return json(
            shapeItemsResponse(
                {
                    Items: items as JellyfinBaseItemDto[],
                    TotalRecordCount: totalCount,
                    StartIndex: startIndex,
                },
                dtoOptions,
            ),
        );
    } catch {
        return ApiResponses.error('Failed to get playlist items');
    }
});

/**
 * POST /j/Playlists/{playlistId}/Items?ids=&position= — AddItemToPlaylist.
 * Owner or editor. Ids the caller cannot see are skipped; series, seasons and
 * albums expand to their episodes/tracks; `position` inserts instead of
 * appending. Items already in the playlist are not added twice.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, url, params } = event;
        const user = locals.user;
        if (!user) return ApiResponses.unauthorized();
        const sql = getDb();
        if (!sql) return ApiResponses.error('Database unavailable');

        const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
        if ('error' in resolved) return resolved.error;
        const { access } = resolved;

        const ids = parseJellyfinIdList(getParamAll(url, 'Ids'));
        if (ids === null) return ApiResponses.badRequest('Invalid item ID in ids');
        if (ids.length > MAX_IDS_PER_REQUEST) {
            return ApiResponses.badRequest(`At most ${MAX_IDS_PER_REQUEST} items per request`);
        }

        const rawPosition = getParam(url, 'Position');
        let position: number | null = null;
        if (rawPosition !== null && rawPosition !== '') {
            if (!/^-?\d+$/.test(rawPosition)) return ApiResponses.badRequest('Invalid position');
            position = parseInt(rawPosition, 10);
        }

        const rawUserId = getParam(url, 'UserId');
        if (
            rawUserId &&
            rawUserId.replace(/-/g, '').toLowerCase() !== user.userId.replace(/-/g, '')
        ) {
            return ApiResponses.forbidden('Items can only be added as yourself');
        }

        if (!canEditPlaylist(access)) {
            return ApiResponses.forbidden('You do not have permission to edit this playlist');
        }

        try {
            await addJellyfinItems(sql, access, user, ids, position);
            return new Response(null, { status: 204 });
        } catch (err) {
            logger.error('Failed to add playlist items', err as Error, {
                playlistId: access.playlistId,
            });
            return ApiResponses.error('Failed to add items');
        }
    },
    { mode: 'write' },
);

/**
 * DELETE /j/Playlists/{playlistId}/Items?entryIds= — RemoveItemFromPlaylist.
 * Owner or editor. `entryIds` are `PlaylistItemId`s from GET .../Items; ids
 * that are not entries of this playlist are ignored, as in Jellyfin.
 */
export const DELETE: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, url, params } = event;
        const user = locals.user;
        if (!user) return ApiResponses.unauthorized();
        const sql = getDb();
        if (!sql) return ApiResponses.error('Database unavailable');

        const resolved = await resolvePlaylistAccess(sql, params.playlistId, user);
        if ('error' in resolved) return resolved.error;
        const { access } = resolved;

        const entryIds = parseEntryIdList(getParamAll(url, 'EntryIds'));
        if (entryIds === null) return ApiResponses.badRequest('Invalid entry ID in entryIds');
        if (entryIds.length > MAX_IDS_PER_REQUEST) {
            return ApiResponses.badRequest(`At most ${MAX_IDS_PER_REQUEST} entries per request`);
        }

        if (!canEditPlaylist(access)) {
            return ApiResponses.forbidden('You do not have permission to edit this playlist');
        }

        try {
            const visible = new Set(await getVisibleMediaIds(sql, access, user));
            await removeEntries(sql, access, user, entryIds, visible);
            return new Response(null, { status: 204 });
        } catch (err) {
            logger.error('Failed to remove playlist items', err as Error, {
                playlistId: access.playlistId,
            });
            return ApiResponses.error('Failed to remove items');
        }
    },
    { mode: 'write' },
);
