// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serializeBaseItems,
    mapRowToMediaItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { enrichItemsWithMediaSources } from '$lib/server/proprietary/jellyfin-compat/media-source-enrichment';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import { enrichItemsForList } from '$lib/server/proprietary/jellyfin-compat/item-details-enrichment';
import type {
    JellyfinBaseItemDto,
    JellyfinItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/types';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam, getJfToken } from '$lib/server/proprietary/jellyfin-compat/utils';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    countSeriesEpisodes,
    getSeriesEpisodePosition,
    getSeriesEpisodes,
} from '$lib/server/database/queries/jellyfin-browse.queries';
import {
    buildJellyfinAccessContext,
    type JellyfinAccessContext,
} from '$lib/server/proprietary/jellyfin-compat/access-context';
import { isSeason, isSeries } from '$lib/server/utils/media-types.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { parseEpisodesLimit } from './episodes-limit';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:ShowEpisodes');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, url, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const rawSeriesId = params.seriesId ?? '';
    if (!rawSeriesId || !isUuid(rawSeriesId)) {
        return ApiResponses.badRequest('Invalid series ID');
    }

    // Swiftfin may send a seasonId in the seriesId path param. We accept any
    // of: a tv/series UUID, a season UUID (we walk up to its series), or
    // anything else (we reject). Without the series-type check below, a
    // movie or episode UUID would silently return zero episodes.
    let seriesId = rawSeriesId;
    const idCheck = await sql<{ media_type: string; parent_id: string | null }[]>`
        SELECT media_type, parent_id FROM media_items
        WHERE id = ${rawSeriesId}::uuid
        LIMIT 1
    `;
    const idRow = idCheck[0];
    if (!idRow) {
        return ApiResponses.notFound('Series not found');
    }
    if (isSeason(idRow.media_type) && idRow.parent_id !== null && isUuid(idRow.parent_id)) {
        // The "seriesId" is actually a season — walk up to its series.
        seriesId = idRow.parent_id;
    } else if (!isSeries(idRow.media_type)) {
        // Not a tv/series and not a season either. This used to 400
        // ('ID does not identify a series or season'), which is itself an
        // existence oracle: distinguishable from BOTH the 404 a nonexistent
        // id gets AND the 200 a real series gets, regardless of the caller's
        // access — three outcomes (exists-wrong-type / exists-denied /
        // doesn't-exist) instead of the two "not found, either way" this
        // surface is built to collapse to. 404 uniformly.
        return ApiResponses.notFound('Series not found');
    }

    // Library access + age gate on the resolved series, matching the sibling
    // Seasons route. Without this, a caller denied every library group the
    // series belongs to (or age-restricted below its rating) got a 200 with
    // an empty Items array instead of the uniform 404 every other handler on
    // this surface returns for a denied id — an existence oracle distinct
    // from "series not found". Must return byte-identical body/status to the
    // not-found branch above.
    if (!(await checkMediaAccess(sql, seriesId, locals.user))) {
        return ApiResponses.notFound('Series not found');
    }

    const seasonId = getParam(url, 'SeasonId');
    if (seasonId && !isUuid(seasonId)) {
        return ApiResponses.badRequest('Invalid SeasonId');
    }
    const seasonNumber = getParam(url, 'Season');
    const limit = parseEpisodesLimit(getParam(url, 'Limit'));
    const requestedStartIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    let startIndex = requestedStartIndex;

    // Android TV sends startItemId when building the play queue from a selected
    // episode. It expects the first item in the response to be that episode, then
    // plays from there. Find its row position across the ordered episode list and
    // use that as startIndex so we return episodes starting from the selection.
    const startItemId = getParam(url, 'startItemId') ?? getParam(url, 'StartItemId');
    let access: JellyfinAccessContext;
    try {
        access = await buildJellyfinAccessContext(sql, locals.user);
    } catch (error) {
        logger.error('Show episodes query failed', error as Error);
        return ApiResponses.error('Failed to get episodes');
    }
    const episodeScope = { seriesId, seasonId, seasonNumber, access: access.boundary };
    const dto = parseDtoOptions(url);
    const serializeEpisodes = async (
        rows: readonly Record<string, unknown>[],
    ): Promise<JellyfinBaseItemDto[]> => {
        const episodeItems = rows.map(mapRowToMediaItem);
        await applyJellyfinContentLanguage(sql, locals.user.userId, episodeItems);
        const serialized = serializeBaseItems(episodeItems);
        const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
        await enrichItemsWithMediaSources(sql, serialized, apiKey);
        await enrichItemsWithProviderIds(sql, serialized);
        if (dto.enableImages) await enrichItemsWithImages(sql, serialized);
        await enrichItemsForList(sql, serialized, dto);
        return serialized;
    };
    if (startItemId && isUuid(startItemId) && startIndex === 0) {
        try {
            const pos = await getSeriesEpisodePosition(sql, {
                ...episodeScope,
                episodeId: startItemId,
            });
            if (pos) startIndex = pos.index;
        } catch {
            // Non-critical — fall back to default startIndex
        }
    }

    // AdjacentTo: the previous, the given and the next episode (Jellyfin
    // UserViewBuilder.FilterForAdjacency, applied last; paging then runs over
    // that window and TotalRecordCount is the window's size). An episode that
    // is not in this listing has no neighbours: an empty result. The window is
    // taken over the whole listing; a startItemId sent with it is ignored.
    const adjacentTo = getParam(url, 'AdjacentTo');
    if (adjacentTo !== null && adjacentTo !== '' && !isUuid(adjacentTo)) {
        return ApiResponses.badRequest('Invalid AdjacentTo');
    }
    let adjacentWindow: { start: number; size: number } | null = null;
    if (adjacentTo) {
        try {
            const pos = await getSeriesEpisodePosition(sql, {
                ...episodeScope,
                episodeId: adjacentTo,
            });
            const start = pos ? Math.max(pos.index - 1, 0) : 0;
            adjacentWindow = pos
                ? { start, size: Math.min(pos.index + 2, pos.total) - start }
                : { start: 0, size: 0 };
        } catch (error) {
            logger.error('Show episodes query failed', error as Error);
            return ApiResponses.error('Failed to get episodes');
        }
    }
    const enableUserData = getParam(url, 'EnableUserData') !== 'false';
    const excludeLocationTypes = getParam(url, 'ExcludeLocationTypes') ?? '';
    const excludeVirtual = excludeLocationTypes
        .split(',')
        .map((t) => t.trim())
        .includes('Virtual');

    // Honor ExcludeLocationTypes=Virtual: drop episodes that didn't gain
    // MediaSources during enrichment (no underlying file = "Virtual" in
    // Jellyfin terms). Without this Infuse rejects the whole array. Both the
    // normal listing and the AdjacentTo window go through it, and the total
    // drops by what was removed.
    // NOTE: TotalRecordCount is approximate when excludeVirtual=true and
    // pagination is in play. We compute the total from the raw episode count
    // up-front, then subtract per-page filtered items. Across pages this can
    // drift if file-less episodes are unevenly distributed. Real Jellyfin does
    // file-presence filtering at SQL level so the count is exact; acceptable
    // for now since Infuse fetches all episodes in one page (no Limit = every
    // episode, see parseEpisodesLimit).
    const dropVirtual = (
        items: JellyfinBaseItemDto[],
        total: number,
    ): { items: JellyfinBaseItemDto[]; total: number } => {
        if (!excludeVirtual) return { items, total };
        const kept = items.filter((i) => (i.MediaSources?.length ?? 0) > 0);
        return { items: kept, total: Math.max(0, total - (items.length - kept.length)) };
    };

    try {
        if (adjacentWindow) {
            const offset = Math.min(requestedStartIndex, adjacentWindow.size);
            const take = Math.min(limit, adjacentWindow.size - offset);
            const rows =
                take > 0
                    ? await getSeriesEpisodes(sql, {
                          ...episodeScope,
                          enableUserData,
                          userId: locals.user.userId,
                          limit: take,
                          startIndex: adjacentWindow.start + offset,
                      })
                    : [];
            const windowed = dropVirtual(await serializeEpisodes(rows), adjacentWindow.size);
            const response: JellyfinItemsResponse = {
                Items: windowed.items,
                TotalRecordCount: windowed.total,
                StartIndex: requestedStartIndex,
            };
            return json(shapeItemsResponse(response, dto));
        }

        // EnableTotalRecordCount=false: no count query (the response reports the page size).
        const totalCount = dto.enableTotalRecordCount
            ? await countSeriesEpisodes(sql, episodeScope)
            : 0;

        const rows = await getSeriesEpisodes(sql, {
            ...episodeScope,
            enableUserData,
            userId: locals.user.userId,
            limit,
            startIndex,
        });

        const listed = dropVirtual(await serializeEpisodes(rows), totalCount);

        const response: JellyfinItemsResponse = {
            Items: listed.items,
            TotalRecordCount: listed.total,
            StartIndex: startIndex,
        };

        return json(shapeItemsResponse(response, dto));
    } catch (error) {
        logger.error('Show episodes query failed', error as Error);
        return ApiResponses.error('Failed to get episodes');
    }
});
