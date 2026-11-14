// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { watchManager } from '$lib/server/services/watch-manager.service';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    syntheticUserItemData,
    userItemDataAfterWrite,
} from '$lib/server/jellyfin-compat/user-item-data';

const logger = Logger.for('JellyfinCompat:UserPlayedItems');

// POST /j/UserPlayedItems/{itemId} — mark as watched. Both verbs answer the
// item's UserItemDataDto read back from the database (not a hand-built one).
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, params } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        const itemId = params.itemId ?? '';
        if (!itemId || !isUuid(itemId)) {
            return json(syntheticUserItemData(itemId, { Played: true }));
        }

        const sql = getDb();
        if (sql && !(await checkMediaAccess(sql, itemId, locals.user))) {
            return ApiResponses.notFound('Item not found');
        }

        try {
            await watchManager.markWatched({ userId, mediaId: itemId });
            logger.debug('Marked watched via UserPlayedItems', {
                username,
                itemId,
            });
            return json(await userItemDataAfterWrite(sql, itemId, locals.user, { Played: true }));
        } catch (err) {
            logger.error('Failed to mark watched', err as Error, {
                username,
                itemId,
            });
            return ApiResponses.error('Failed to mark watched');
        }
    },
    { pat: 'deny', mode: 'write' },
);

// DELETE /j/UserPlayedItems/{itemId} — mark as unwatched
export const DELETE: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals, params } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        const itemId = params.itemId ?? '';
        if (!itemId || !isUuid(itemId)) {
            return json(syntheticUserItemData(itemId, { Played: false }));
        }

        const sql = getDb();
        if (sql && !(await checkMediaAccess(sql, itemId, locals.user))) {
            return ApiResponses.notFound('Item not found');
        }

        try {
            await watchManager.markUnwatched({ userId, mediaId: itemId });
            logger.debug('Marked unwatched via UserPlayedItems', {
                username,
                itemId,
            });
            return json(await userItemDataAfterWrite(sql, itemId, locals.user, { Played: false }));
        } catch (err) {
            logger.error('Failed to mark unwatched', err as Error, {
                username,
                itemId,
            });
            return ApiResponses.error('Failed to mark unwatched');
        }
    },
    { pat: 'deny', mode: 'write' },
);
