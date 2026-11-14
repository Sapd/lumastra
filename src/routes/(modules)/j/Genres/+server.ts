// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Genres` (GenresController.GetGenres): the genres of the items the user
 * can see, scoped by ParentId / IncludeItemTypes / ExcludeItemTypes, filtered
 * by SearchTerm / NameStartsWith(OrGreater) / NameLessThan / IsFavorite,
 * sorted and paged. See genre-lists.ts.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildJellyfinAccessContext } from '$lib/server/jellyfin-compat/access-context';
import { hasValidParentId } from '$lib/server/jellyfin-compat/genres';
import { listGenres } from '$lib/server/jellyfin-compat/genre-lists';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:Genres');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, url }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!hasValidParentId(url)) return ApiResponses.badRequest('ParentId must be a GUID');
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        return json(shapeItemsResponse(await listGenres(sql, url, access), parseDtoOptions(url)));
    } catch (error) {
        logger.error('Failed to get genres', error as Error);
        return ApiResponses.error('Failed to get genres');
    }
});
