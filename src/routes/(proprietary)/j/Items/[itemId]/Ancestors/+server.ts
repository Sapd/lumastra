// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /j/Items/{itemId}/Ancestors — Jellyfin compat.
//
// Real Jellyfin returns the item's parent chain as BaseItemDtos, nearest
// first: for an episode [Season, Series, CollectionFolder, UserRootFolder].
// Discord rich-presence clients poll this every few seconds to resolve which
// library the playing item belongs to (library allow/block lists).
//
// We return the media-item ancestors plus the library CollectionFolder. The
// shim has no UserRootFolder concept (no stable id another endpoint could
// resolve), so that trailing entry is omitted — clients scan the chain for
// names / CollectionFolder rather than requiring the root.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serializeBaseItem,
    mapRowToMediaItem,
    type MediaItemForSerialization,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import type { JellyfinBaseItemDto } from '$lib/server/proprietary/jellyfin-compat/types';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import {
    MEDIA_TYPE_TO_COLLECTION,
    lastSegment,
} from '$lib/server/proprietary/jellyfin-compat/library-views-utils';
import { uuidToPlaylistId } from '$lib/server/proprietary/jellyfin-compat/playlist-id';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from '$lib/server/proprietary/jellyfin-compat/music-artists-enrichment';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import {
    getItemDetail,
    getAncestorItemIds,
    getLibraryGroupForItem,
    getLibraryGroupInfo,
} from '$lib/server/database/queries/jellyfin-item-detail.queries';

const logger = Logger.for('JellyfinCompat:Ancestors');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }

    // Playlists are flat containers in the shim — no ancestor chain.
    if (uuidToPlaylistId(itemId) !== null) {
        return json([]);
    }

    if (!isUuid(itemId)) {
        return ApiResponses.notFound('Item not found');
    }

    try {
        // Mirror the item-detail route: clients may pass a MediaSource.Id
        // (media_files UUID) — resolve it to the owning media item.
        const ownerItemId = await getOwnerItemForFile(sql, itemId);
        const resolvedItemId = ownerItemId ?? itemId;

        // Library access + age gate — 404 (not 403) to avoid existence leak.
        const allowed = await checkMediaAccess(sql, resolvedItemId, locals.user);
        if (!allowed) {
            return ApiResponses.notFound('Item not found');
        }

        const item = await getItemDetail(sql, resolvedItemId, locals.user.userId);
        if (!item) {
            return ApiResponses.notFound('Item not found');
        }

        // Media-item ancestors, nearest first (episode → season → series).
        const ancestorRows = await getAncestorItemIds(sql, resolvedItemId);
        const ancestorMediaItems: MediaItemForSerialization[] = [];
        for (const ancestor of ancestorRows) {
            const row = await getItemDetail(sql, ancestor.id, locals.user.userId);
            if (row) {
                ancestorMediaItems.push(mapRowToMediaItem(row as Record<string, unknown>));
            }
        }
        await applyJellyfinContentLanguage(sql, locals.user.userId, ancestorMediaItems);
        const items: JellyfinBaseItemDto[] = ancestorMediaItems.map(serializeBaseItem);
        await enrichItemsWithProviderIds(sql, items);
        await enrichItemsWithMusicArtists(sql, items);
        await enrichItemsWithImages(sql, items);

        // Library CollectionFolder — same shape /j/UserViews and the item-detail
        // library branch emit. checkMediaAccess above already established the
        // caller may see this library (groupId is derived FROM resolvedItemId,
        // which the gate above already verified), so `null` here is a deliberate
        // "already gated upstream," not an omitted check.
        const groupId = await getLibraryGroupForItem(sql, resolvedItemId);
        if (groupId) {
            const lib = await getLibraryGroupInfo(sql, groupId, null);
            if (lib) {
                items.push({
                    Name: lib.group_name ?? lastSegment(lib.path),
                    Id: lib.library_group_id,
                    ServerId: JELLYFIN_SERVER_ID,
                    Type: 'CollectionFolder',
                    CollectionType: MEDIA_TYPE_TO_COLLECTION[lib.media_type] ?? 'movies',
                    IsFolder: true,
                    MediaType: 'Unknown',
                    LocationType: 'FileSystem',
                    LocalTrailerCount: 0,
                    SpecialFeatureCount: 0,
                    PlayAccess: 'Full',
                    UserData: {
                        PlaybackPositionTicks: 0,
                        PlayedPercentage: 0,
                        PlayCount: 0,
                        IsFavorite: false,
                        Played: false,
                        Key: lib.library_group_id,
                        ItemId: lib.library_group_id,
                    },
                    // No ImageTags/BackdropImageTags: /j/Items/{itemId}/Images
                    // never serves the library mosaic (removed 2026-09-18 fix
                    // plan 4 task 6 review round 1, CRITICAL 1 — that route can
                    // never see locals.user and always falls through to the
                    // placeholder). Advertising a tag for art the route will
                    // never return costs every /j client a wasted round-trip
                    // per library tile on every render.
                    ImageTags: {},
                    BackdropImageTags: [],
                });
            }
        }

        return json(items);
    } catch (error) {
        logger.error('Failed to build ancestors', { itemId, error });
        return ApiResponses.error('Failed to retrieve ancestors');
    }
});
