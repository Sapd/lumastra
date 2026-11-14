// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json, type RequestEvent } from '@sveltejs/kit';
import { serializeBaseItems, mapRowToMediaItem } from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import type { JellyfinItemsResponse } from './types';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getParam, getSearchTermParam } from './utils';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache';
import {
    denyAllAccess,
    restrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary';
import { listArtists } from './artists-query';
import { enrichItemsWithImages } from './image-enrichment';
import { parseDtoOptions, shapeItemsResponse } from './dto-options';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:Artists');

/**
 * `GET /Artists` and `GET /Artists/AlbumArtists`. Lumastra's artist rows are
 * the artists albums are filed under, i.e. album artists, so both list the
 * same rows (Jellyfin's `/Artists` also lists track-only artists; Lumastra
 * has no rows for those).
 */
export async function handleArtistsRequest(event: RequestEvent): Promise<Response> {
    const { locals, url } = event;
    const dto = parseDtoOptions(url);
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const rawLimit = parseInt(getParam(url, 'Limit') ?? '100', 10);
    const limit = Math.min(Math.max(0, isNaN(rawLimit) ? 100 : rawLimit), 500);
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);

    // Artist favourites are unsupported, like person/studio favourites. Their
    // DTO reports IsFavorite=false; none can match a favourites-only request.
    const filters = (getParam(url, 'Filters') ?? '').split(',').map((f) => f.trim().toLowerCase());
    if (
        getParam(url, 'IsFavorite')?.trim().toLowerCase() === 'true' ||
        filters.includes('isfavorite') ||
        filters.includes('isfavoriteorlikes')
    ) {
        return json(
            shapeItemsResponse({ Items: [], TotalRecordCount: 0, StartIndex: startIndex }, dto),
        );
    }

    // Build the access boundary explicitly. Both axes are stated; there is no
    // permissive default to fall through to.
    //
    // `withJellyfinAuth` sets `locals.user` on every branch that reaches this
    // handler (session and PAT alike), so the no-user case is unreachable in
    // practice — but it is typed as optional, and under the old shape it
    // resolved to ADMIN-EQUIVALENT library scope (`getDeniedLibraryGroups`
    // returns null for `!user`). Resolving it to an explicit denyAll closes that
    // fail-open without affecting any reachable request.
    let access: MediaAccessBoundary;
    if (!locals.user) {
        logger.warn('Artists reached without locals.user; denying all');
        access = denyAllAccess();
    } else {
        const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(locals.user));
        access = restrictedAccess({
            deniedGroupIds: denied ?? [],
            maxAgeRating: locals.user.maxAgeRating ?? null,
            allowUnrated: config.UNRATED_CONTENT_VISIBLE,
        });
    }

    try {
        const { rows, totalCount } = await listArtists(
            sql,
            {
                limit,
                startIndex,
                parentId: getParam(url, 'ParentId'),
                sortBy: getParam(url, 'SortBy') ?? 'SortName',
                sortOrder: getParam(url, 'SortOrder') ?? 'Ascending',
                searchTerm: getSearchTermParam(url),
                nameStartsWith: getParam(url, 'NameStartsWith'),
            },
            access,
        );

        const items = rows.map(mapRowToMediaItem);
        await applyJellyfinContentLanguage(sql, locals.user?.userId, items);

        const serialized = serializeBaseItems(items);
        if (dto.enableImages) await enrichItemsWithImages(sql, serialized);
        const response: JellyfinItemsResponse = {
            Items: serialized,
            TotalRecordCount: totalCount,
            StartIndex: startIndex,
        };

        return json(shapeItemsResponse(response, dto));
    } catch (e) {
        logger.warn('Failed to list artists', { error: e });
        return ApiResponses.error('Failed to list artists');
    }
}
