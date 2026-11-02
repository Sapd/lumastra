// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serializeBaseItems,
    mapRowToMediaItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { applyFolderUserData } from '$lib/server/proprietary/jellyfin-compat/folder-user-data';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import type { JellyfinItemsResponse } from '$lib/server/proprietary/jellyfin-compat/types';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { getSeriesSeasons } from '$lib/server/database/queries/jellyfin-browse.queries';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context.js';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:ShowSeasons');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, url, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const seriesId = params.seriesId ?? '';
    if (!seriesId || !isUuid(seriesId)) {
        return ApiResponses.badRequest('Invalid series ID');
    }
    const enableUserData = getParam(url, 'EnableUserData') !== 'false';
    const dto = parseDtoOptions(url);

    try {
        if (!(await checkMediaAccess(sql, seriesId, locals.user))) {
            return ApiResponses.notFound();
        }

        const access = await buildJellyfinAccessContext(sql, locals.user);

        const rows = await getSeriesSeasons(sql, {
            seriesId,
            enableUserData,
            userId: locals.user.userId,
            access: access.boundary,
        });

        const items = rows.map(mapRowToMediaItem);
        await applyJellyfinContentLanguage(sql, locals.user.userId, items);
        // Counts always come from the access-scoped aggregate (getSeriesSeasons'
        // own child_count is not library-scoped); without user data nothing is played.
        await applyFolderUserData(
            sql,
            items,
            enableUserData ? locals.user.userId : undefined,
            access.boundary,
        );

        const serialized = serializeBaseItems(items);
        if (dto.enableImages) await enrichItemsWithImages(sql, serialized);
        const response: JellyfinItemsResponse = {
            Items: serialized,
            TotalRecordCount: items.length,
            StartIndex: 0,
        };

        return json(shapeItemsResponse(response, dto));
    } catch (error) {
        logger.error('Show seasons query failed', error as Error);
        return ApiResponses.error('Failed to get seasons');
    }
});
