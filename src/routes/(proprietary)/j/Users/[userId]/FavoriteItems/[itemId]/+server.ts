// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getDb } from '$lib/server/database';
import { setJellyfinFavorite } from '$lib/server/proprietary/jellyfin-compat/favorites';
import {
    syntheticUserItemData,
    userItemDataAfterWrite,
} from '$lib/server/proprietary/jellyfin-compat/user-item-data';

const logger = Logger.for('JellyfinCompat:FavoriteItems');

// POST   /j/Users/{userId}/FavoriteItems/{itemId} — add to favorites (watchlist)
// DELETE /j/Users/{userId}/FavoriteItems/{itemId} — remove from favorites
// Both answer the item's UserItemDataDto, read back from the database.
function favoriteHandler(isFavorite: boolean): RequestHandler {
    return withJellyfinAuth(
        async (event) => {
            const { locals, params } = event;

            const username = locals.user?.username;
            if (!username || !locals.user) return ApiResponses.unauthorized();

            const itemId = params.itemId ?? '';
            if (!itemId || !isUuid(itemId)) {
                return json(syntheticUserItemData(itemId, { IsFavorite: isFavorite }));
            }

            const sql = getDb();
            if (!sql) return ApiResponses.error('Database unavailable');

            try {
                const result = await setJellyfinFavorite(sql, locals.user, itemId, isFavorite);
                switch (result.status) {
                    case 'not_found':
                        return ApiResponses.notFound('Item not found');
                    case 'type_not_allowed':
                        // The watchlist is a strict set of movie/tv/audiobook.
                        // jellyfin-androidtv lets users favorite ANY item type
                        // (episodes, seasons, albums, tracks), so this is an
                        // expected, client-driven case, not a server fault: a
                        // clean 4xx (`badRequest` maps to 422 problem+json — not a
                        // shape Jellyfin itself emits here).
                        logger.debug('Rejected favorite: media type not allowed on watchlist', {
                            username,
                            itemId,
                            mediaType: result.mediaType,
                        });
                        return ApiResponses.badRequest(
                            `Items of type "${result.mediaType}" cannot be added to the watchlist`,
                        );
                    case 'noop':
                        // Not a media item (jellyfin-androidtv favorites EPG
                        // entries): acknowledge so the UI stays consistent.
                        logger.debug('Favorite no-op (non-media item, e.g. EPG program)', {
                            username,
                            itemId,
                        });
                        return json(syntheticUserItemData(itemId, { IsFavorite: isFavorite }));
                    case 'ok':
                        logger.debug(isFavorite ? 'Added to favorites' : 'Removed from favorites', {
                            username,
                            itemId,
                            target: result.target,
                        });
                        // A channel's favourite lives outside the item row the
                        // read-back sees; answer it with what was set.
                        return json(
                            result.target === 'channel'
                                ? syntheticUserItemData(itemId, { IsFavorite: isFavorite })
                                : await userItemDataAfterWrite(sql, itemId, locals.user, {
                                      IsFavorite: isFavorite,
                                  }),
                        );
                }
            } catch (err) {
                logger.error(
                    isFavorite ? 'Failed to add favorite' : 'Failed to remove favorite',
                    err as Error,
                    { username, itemId },
                );
                return ApiResponses.error(
                    isFavorite ? 'Failed to add favorite' : 'Failed to remove favorite',
                );
            }
        },
        { pat: 'deny', mode: 'write' },
    );
}

export const POST: RequestHandler = favoriteHandler(true);
export const DELETE: RequestHandler = favoriteHandler(false);
