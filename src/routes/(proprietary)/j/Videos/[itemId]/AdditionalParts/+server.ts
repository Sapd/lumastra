// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Videos/{itemId}/AdditionalParts — parts 2..N of a multi-part movie.
 *
 * Jellyfin's VideosController.GetAdditionalPart: a BaseItemDtoQueryResult with
 * the parts AFTER part 1, each an item of its own. jellyfin-androidtv and
 * jellyfin-web call it when an item has PartCount > 1 and queue
 * `[item, ...Items]`; Swiftfin lists the parts on the detail page.
 *
 * `itemId` is the movie, or — after the version picker — a file id: part 1 of
 * a stack then answers for its own stack. A part's item id is its media_files
 * id (multi-part.ts). An item without parts answers an empty list, as Jellyfin
 * does for a video that is not stacked.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    mapRowToMediaItem,
    serializeBaseItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichPartItemsWithMediaSources } from '$lib/server/proprietary/jellyfin-compat/media-source-enrichment';
import {
    getPartFiles,
    partLayout,
    toPartItem,
} from '$lib/server/proprietary/jellyfin-compat/multi-part';
import type {
    JellyfinBaseItemDto,
    JellyfinItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/types';
import { getJfToken } from '$lib/server/proprietary/jellyfin-compat/utils';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { getItemDetail } from '$lib/server/database/queries/jellyfin-item-detail.queries';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';

const logger = Logger.for('JellyfinCompat:AdditionalParts');

export const GET: RequestHandler = withJellyfinAuth(async ({ params, locals }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!locals.user) return ApiResponses.unauthorized();
    const rawId = params.itemId ?? '';
    if (!isUuid(rawId)) return ApiResponses.notFound('Item not found');
    const itemId = normalizeUuid(rawId);

    try {
        const ownerItemId = await getOwnerItemForFile(sql, itemId);
        const movieId = ownerItemId ?? itemId;
        if (!(await checkMediaAccess(sql, movieId, locals.user))) {
            return ApiResponses.notFound('Item not found');
        }
        const row = await getItemDetail(sql, movieId, locals.user.userId);
        if (!row) return ApiResponses.notFound('Item not found');

        const layout = partLayout(await getPartFiles(sql, movieId));
        // The movie stands for its first source's stack; a file id only for the
        // stack it is part 1 of (part 2..N has no further parts of its own).
        const firstId = ownerItemId ? itemId : layout.sources[0]?.id;
        const stack =
            firstId && layout.partIndex(firstId) === 0 ? layout.stackOf(firstId) : undefined;

        const items: JellyfinBaseItemDto[] = [];
        if (stack) {
            const media = mapRowToMediaItem(row as unknown as Record<string, unknown>);
            media.runtime_seconds = row.runtime_seconds;
            await applyJellyfinContentLanguage(sql, locals.user.userId, [media]);
            const movie = serializeBaseItem(media);
            await enrichItemsWithProviderIds(sql, [movie]);
            for (let i = 1; i < stack.length; i++) items.push(toPartItem(movie, stack, i));
            await enrichPartItemsWithMediaSources(
                sql,
                movieId,
                items,
                getJfToken(locals as unknown as Record<string, unknown>),
            );
        }

        // A part whose file vanished since the layout read has no source; an
        // item without one crashes jellyfin-androidtv (null MediaSource NPE).
        const playable = items.filter((i) => (i.MediaSources?.length ?? 0) > 0);
        const response: JellyfinItemsResponse = {
            Items: playable,
            TotalRecordCount: playable.length,
            StartIndex: 0,
        };
        return json(response);
    } catch (error) {
        logger.error('Additional parts query failed', error as Error, { itemId });
        return ApiResponses.error('Failed to get additional parts');
    }
});
