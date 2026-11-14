// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Items/Filters` (FilterController.GetQueryFiltersLegacy) →
 * QueryFiltersLegacy: genres, tags, official ratings and years over the items
 * the user can see under `ParentId`, narrowed by `IncludeItemTypes` /
 * `MediaTypes`. A literal segment, so it outranks `/Items/[itemId]`.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildJellyfinAccessContext } from '$lib/server/jellyfin-compat/access-context';
import { hasValidParentId } from '$lib/server/jellyfin-compat/genres';
import { getLegacyQueryFilters } from '$lib/server/jellyfin-compat/item-filters';

const logger = Logger.for('JellyfinCompat:ItemFilters');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, url }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!hasValidParentId(url)) return ApiResponses.badRequest('ParentId must be a GUID');
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        return json(await getLegacyQueryFilters(sql, url, access));
    } catch (error) {
        logger.error('Failed to compute item filters', error as Error);
        return ApiResponses.error('Failed to get filters');
    }
});
