// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /j/Items/{itemId}/Collections — new in Jellyfin 12.x (LibraryController.GetItemCollections):
// the BoxSets that contain the item. Lumastra has no user-curated collections / BoxSets, so
// the answer is always an empty BaseItemDtoQueryResult, as on a Jellyfin server whose item is
// in no collection. Unknown or inaccessible items still 404 (no existence leak).

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getParam } from '$lib/server/jellyfin-compat/utils';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, params, url }) => {
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId;
    if (!itemId || !isUuid(itemId)) {
        return ApiResponses.notFound('Item not found');
    }

    if (!(await checkMediaAccess(sql, itemId, locals.user))) {
        return ApiResponses.notFound('Item not found');
    }
    const exists = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM media_items WHERE id = ${itemId}::uuid AND status = 'active'
    `;
    if (exists.length === 0) {
        return ApiResponses.notFound('Item not found');
    }

    const startIndex = parseInt(getParam(url, 'StartIndex') ?? '0', 10);
    return json({
        Items: [],
        TotalRecordCount: 0,
        StartIndex: Number.isFinite(startIndex) && startIndex > 0 ? startIndex : 0,
    });
});
