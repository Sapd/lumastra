// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET|POST /UserItems/{itemId}/UserData (Jellyfin ItemsController.GetItemUserData /
 * UpdateItemUserData).
 *
 * GET answers the item's UserItemDataDto — the same `UserData` /Items/{id} shows.
 * POST takes an UpdateUserItemDataDto, applies only the fields it sets (non-null)
 * and answers the re-read dto, as Jellyfin does. What Lumastra can apply:
 *
 * - `IsFavorite` → the user's favourites (watchlist, or a Live TV channel
 *   favourite), the same write as /UserFavoriteItems.
 * - `Played` → mark watched / unwatched (watchManager). Played=true wins over a
 *   position in the same request: a watched item has no resume point.
 * - `PlaybackPositionTicks` → the resume point (0 clears it).
 *
 * Accepted and ignored: `PlayCount` and `LastPlayedDate` (derived from watch
 * events here, not settable), `Rating` and `Likes` (Lumastra's ratings feed the
 * taste profile; a client toggle must not train it silently), and the
 * read-only `PlayedPercentage`, `UnplayedItemCount`, `Key`, `ItemId`. Music
 * items keep their play state in the music subsystem, so `Played` and the
 * position are skipped for them. A field that does not apply to the item is
 * skipped rather than failing the request; the answer shows the real state.
 *
 * `userId` is ignored: like every /j route this acts for the signed-in user.
 * An unknown or inaccessible item is a 404.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { watchManager } from '$lib/server/services/watch-manager.service';
import {
    getMediaType,
    isMusicMediaType,
} from '$lib/server/database/queries/media-type-cache.queries';
import { readUserItemData } from '$lib/server/jellyfin-compat/user-item-data';
import { setJellyfinFavorite } from '$lib/server/jellyfin-compat/favorites';
import { ticksToMs } from '$lib/server/jellyfin-compat/constants';
import type { UserContext } from '$lib/server/types';

const logger = Logger.for('JellyfinCompat:UserItemData');

/** The UpdateUserItemDataDto fields Lumastra applies; absent = leave as is. */
interface UserDataUpdate {
    isFavorite?: boolean;
    played?: boolean;
    positionTicks?: number;
}

function field(body: Record<string, unknown>, name: string): unknown {
    // Jellyfin's JSON binding is case-insensitive.
    const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : body[key];
}

function parseUpdate(body: unknown): UserDataUpdate {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
    const b = body as Record<string, unknown>;
    const update: UserDataUpdate = {};
    const fav = field(b, 'IsFavorite');
    if (typeof fav === 'boolean') update.isFavorite = fav;
    const played = field(b, 'Played');
    if (typeof played === 'boolean') update.played = played;
    const ticks = field(b, 'PlaybackPositionTicks');
    if (typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0) {
        update.positionTicks = Math.floor(ticks);
    }
    return update;
}

async function handle(event: RequestEvent, write: boolean): Promise<Response> {
    const { locals, params } = event;
    const user = locals.user;
    if (!user?.userId) return ApiResponses.unauthorized();

    const itemId = params.itemId ?? '';
    if (!isUuid(itemId)) return ApiResponses.notFound('Item not found');

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    if (!(await checkMediaAccess(sql, itemId, user))) {
        return ApiResponses.notFound('Item not found');
    }

    try {
        if (write) {
            let body: unknown;
            try {
                body = await readBoundedJson(event.request);
            } catch {
                return ApiResponses.badRequest('Body must be a UserItemDataDto (JSON)');
            }
            // Existence only: the row alone, no access context or folder counts.
            if ((await readUserItemData(sql, itemId, user.userId)) === null) {
                return ApiResponses.notFound('Item not found');
            }
            await applyUpdate(sql, user, itemId, parseUpdate(body));
        }

        const data = await readUserItemData(sql, itemId, user);
        if (!data) return ApiResponses.notFound('Item not found');
        return json(data);
    } catch (err) {
        logger.error('User data request failed', err as Error, { itemId, write });
        return ApiResponses.error('Failed to update user data');
    }
}

async function applyUpdate(
    sql: NonNullable<ReturnType<typeof getDb>>,
    user: UserContext,
    itemId: string,
    update: UserDataUpdate,
): Promise<void> {
    const userId = user.userId;

    if (update.isFavorite !== undefined) {
        const result = await setJellyfinFavorite(sql, user, itemId, update.isFavorite);
        if (result.status === 'type_not_allowed') {
            logger.debug('IsFavorite skipped: type cannot be a favourite', {
                itemId,
                mediaType: result.mediaType,
            });
        }
    }

    if (update.played === undefined && update.positionTicks === undefined) return;
    if (isMusicMediaType(await getMediaType(sql, itemId))) {
        logger.debug('Played/position skipped for a music item', { itemId });
        return;
    }

    if (update.played === true) {
        await watchManager.markWatched({ userId, mediaId: itemId });
        return;
    }
    if (update.played === false) {
        await watchManager.markUnwatched({ userId, mediaId: itemId });
    }
    if (update.positionTicks !== undefined) {
        await watchManager.setResumePosition({
            userId,
            mediaId: itemId,
            positionMs: ticksToMs(update.positionTicks),
        });
    }
}

export const GET: RequestHandler = withJellyfinAuth((event) => handle(event, false), {
    pat: 'deny',
});
export const POST: RequestHandler = withJellyfinAuth((event) => handle(event, true), {
    pat: 'deny',
    mode: 'write',
});
