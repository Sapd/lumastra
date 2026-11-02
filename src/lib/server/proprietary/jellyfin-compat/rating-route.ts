// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Shared handler for POST|DELETE /UserItems/{itemId}/Rating and the legacy
 * /Users/{userId}/Items/{itemId}/Rating (Jellyfin UserLibraryController
 * UpdateUserItemRating / DeleteUserItemRating). See user-rating.ts for the
 * likes ↔ rating mapping.
 *
 * Answers the item's `UserItemDataDto` with `Rating`/`Likes` filled in. An
 * unknown or inaccessible item is a 404. POST without a valid `likes` is a
 * 400 — Jellyfin would bind a missing `likes` to null and clear the rating,
 * which a client never means by "like". `userId` is ignored, as on every /j
 * route: this acts for the signed-in user.
 */

import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { readUserItemData } from './user-item-data';
import { parseLikes, setJellyfinLikes, withUserRating } from './user-rating';
import { getParam } from './utils';
import { jellyfinBadRequest } from './bad-request';

const logger = Logger.for('JellyfinCompat:Rating');

export async function handleItemRating(event: RequestEvent, clear: boolean): Promise<Response> {
    const user = event.locals.user;
    if (!user?.userId) return ApiResponses.unauthorized();
    const userId = user.userId;

    const itemId = event.params.itemId ?? '';
    if (!isUuid(itemId)) return ApiResponses.notFound('Item not found');

    let likes: boolean | null = null;
    if (!clear) {
        likes = parseLikes(getParam(event.url, 'Likes'));
        if (likes === null) return jellyfinBadRequest('likes must be true or false');
    }

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    try {
        if (!(await checkMediaAccess(sql, itemId, user))) {
            return ApiResponses.notFound('Item not found');
        }
        if ((await readUserItemData(sql, itemId, userId)) === null) {
            return ApiResponses.notFound('Item not found');
        }
        await setJellyfinLikes(sql, userId, itemId, likes);
        const data = await readUserItemData(sql, itemId, userId);
        if (!data) return ApiResponses.notFound('Item not found');
        return json(await withUserRating(sql, userId, itemId, data));
    } catch (err) {
        logger.error('Rating update failed', err as Error, { itemId, clear });
        return ApiResponses.error('Failed to update rating');
    }
}
