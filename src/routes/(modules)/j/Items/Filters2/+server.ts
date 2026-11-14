// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Items/Filters2` (FilterController.GetQueryFilters) → QueryFilters:
 * genres (`{Name, Id}`) and tags over the items the user can see under
 * `ParentId` (recursive unless `Recursive=false` under a folder), narrowed by
 * `IncludeItemTypes` and the program flags. A literal segment, so it outranks
 * `/Items/[itemId]`, which used to answer it as an unknown item id.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildJellyfinAccessContext } from '$lib/server/jellyfin-compat/access-context';
import { hasValidParentId } from '$lib/server/jellyfin-compat/genres';
import { getQueryFilters } from '$lib/server/jellyfin-compat/item-filters';

const logger = Logger.for('JellyfinCompat:ItemFilters2');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, url }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!hasValidParentId(url)) return ApiResponses.badRequest('ParentId must be a GUID');
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        return json(await getQueryFilters(sql, url, access));
    } catch (error) {
        logger.error('Failed to compute item filters', error as Error);
        return ApiResponses.error('Failed to get filters');
    }
});
