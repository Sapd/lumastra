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
import type { JellyfinItemsResponse } from '$lib/server/proprietary/jellyfin-compat/types';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getJfToken } from '$lib/server/proprietary/jellyfin-compat/utils';
import { parseNextUpQuery } from '$lib/server/proprietary/jellyfin-compat/next-up-query';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { getNextUpEpisodesPage } from '$lib/server/database/queries/jellyfin-browse.queries';
import { config } from '$lib/server/config.js';
import {
    enrichItemsWithMediaSources,
    dropFilelessPlayables,
} from '$lib/server/proprietary/jellyfin-compat/media-source-enrichment';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import { enrichItemsForList } from '$lib/server/proprietary/jellyfin-compat/item-details-enrichment';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:NextUp');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const q = parseNextUpQuery(url);
    const dto = parseDtoOptions(url);
    if (q.malformedSeriesId) {
        return json({
            Items: [],
            TotalRecordCount: 0,
            StartIndex: q.startIndex,
        } satisfies JellyfinItemsResponse);
    }

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);

        const { rows, totalCount } = await getNextUpEpisodesPage(
            sql,
            locals.user.userId,
            q.limit,
            access.boundary,
            q.seriesId,
            config.NEXT_UP_MAX_AGE_DAYS,
            {
                startIndex: q.startIndex,
                parentId: q.parentId,
                requireUnwatchedNext: q.requireUnwatchedNext,
                excludeResumable: q.excludeResumable,
                minLastWatchedAt: q.minLastWatchedAt,
            },
        );

        const items = rows.map(mapRowToMediaItem);
        await applyJellyfinContentLanguage(sql, locals.user.userId, items);
        const serialized = serializeBaseItems(items);
        // NextUp returns Episodes — they need MediaSources/Container/Path or
        // Infuse silently drops the whole response. Then drop any episode
        // that didn't gain a file (e.g., metadata-only entries from a future
        // air date) — the malformed shape would break the whole array.
        const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
        await enrichItemsWithMediaSources(sql, serialized, apiKey);
        await enrichItemsWithProviderIds(sql, serialized);
        if (dto.enableImages) await enrichItemsWithImages(sql, serialized);
        await enrichItemsForList(sql, serialized, dto);
        const filtered = dropFilelessPlayables(serialized);

        const response: JellyfinItemsResponse = {
            Items: filtered,
            // Rows dropped as fileless on this page leave the total too.
            TotalRecordCount: Math.max(0, totalCount - (serialized.length - filtered.length)),
            StartIndex: q.startIndex,
        };

        return json(shapeItemsResponse(response, dto));
    } catch (error) {
        logger.error('NextUp query failed', error as Error);
        return ApiResponses.error('Failed to get next up episodes');
    }
});
