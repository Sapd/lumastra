// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /Items/{itemId}/Images — the item's images as `ImageInfo[]` (see
 * item-images.ts). Unlike the image bytes themselves, the list is
 * authenticated as in Jellyfin, and an unknown item or one the user may not
 * see is the same 404.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getDb } from '$lib/server/database';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getItemDetail } from '$lib/server/database/queries/jellyfin-item-detail.queries';
import {
    mapRowToMediaItem,
    serializeBaseItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import { buildItemImageInfos } from '$lib/server/proprietary/jellyfin-compat/item-images';

const logger = Logger.for('JellyfinCompat:ItemImages');

export const GET: RequestHandler = withJellyfinAuth(async ({ params, locals }) => {
    const itemId = params.itemId ?? '';
    if (!isUuid(itemId)) return ApiResponses.notFound('Item not found');

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    try {
        if (!(await checkMediaAccess(sql, itemId, locals.user))) {
            return ApiResponses.notFound('Item not found');
        }
        const row = await getItemDetail(sql, itemId, locals.user.userId);
        if (!row) return ApiResponses.notFound('Item not found');
        const dto = serializeBaseItem(mapRowToMediaItem(row as unknown as Record<string, unknown>));
        await enrichItemsWithImages(sql, [dto]);
        return json(buildItemImageInfos(dto));
    } catch (err) {
        logger.error('Item image list failed', err as Error, { itemId });
        return ApiResponses.error('Failed to list item images');
    }
});
