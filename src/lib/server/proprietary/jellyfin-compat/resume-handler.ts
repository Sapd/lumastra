// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /UserItems/Resume` (+ legacy `/Users/{userId}/Items/Resume`), Jellyfin's
 * ItemsController.GetResumeItems: `MediaTypes` (a "continue listening" row asks
 * for Audio and must not get videos), `IncludeItemTypes` / `ExcludeItemTypes`,
 * `ParentId`, `SearchTerm`, `StartIndex` / `Limit` and `EnableTotalRecordCount`.
 *
 * Without MediaTypes / IncludeItemTypes the row stays movies + episodes (what
 * every video client asks for); audio tracks are listed only when asked for.
 * One in-progress episode per series, newest first (Lumastra's Continue
 * Watching rule).
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam, getJfToken, getSearchTermParam } from './utils';
import { buildJellyfinAccessContext } from './access-context';
import { mapRowToMediaItem, serializeBaseItems } from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import { enrichItemsWithMediaSources, dropFilelessPlayables } from './media-source-enrichment';
import { enrichItemsWithProviderIds } from './provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from './music-artists-enrichment';
import { enrichItemsWithImages } from './image-enrichment';
import { parseDtoOptions, shapeItemsResponse } from './dto-options';
import { enrichItemsForList } from './item-details-enrichment';
import { USER_ROOT_FOLDER_ID } from './constants';
import type { JellyfinItemsResponse } from './types';
import {
    getResumeItemsPage,
    mapJellyfinMediaTypes,
    mapJellyfinTypes,
    type ResumeFilters,
} from '$lib/server/database/queries/jellyfin-browse.queries';

const logger = Logger.for('JellyfinCompat:Resume');

const RESUMABLE = ['movie', 'episode', 'track'];
const DEFAULT_TYPES = ['movie', 'episode'];
const MAX_LIMIT = 100;

export interface ResumeQuery {
    limit: number;
    filters: ResumeFilters & { mediaTypes: string[]; startIndex: number };
    enableTotalRecordCount: boolean;
}

export function parseResumeQuery(url: URL): ResumeQuery {
    const limit = Math.min(
        Math.max(1, parseInt(getParam(url, 'Limit') ?? '20', 10) || 20),
        MAX_LIMIT,
    );
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    const mediaTypesParam = getParam(url, 'MediaTypes');
    const include = getParam(url, 'IncludeItemTypes');
    const exclude = new Set(mapJellyfinTypes(getParam(url, 'ExcludeItemTypes') ?? ''));
    const byMedia = mediaTypesParam ? new Set(mapJellyfinMediaTypes(mediaTypesParam)) : null;
    const byType = include ? new Set(mapJellyfinTypes(include)) : null;
    const base = byMedia || byType ? RESUMABLE : DEFAULT_TYPES;
    const mediaTypes = base.filter(
        (t) => (!byMedia || byMedia.has(t)) && (!byType || byType.has(t)) && !exclude.has(t),
    );
    const rawParent = getParam(url, 'ParentId');
    const parentId =
        rawParent && rawParent.replace(/-/g, '').toLowerCase() !== USER_ROOT_FOLDER_ID
            ? rawParent
            : null;
    return {
        limit,
        filters: {
            mediaTypes,
            parentId,
            searchTerm: getSearchTermParam(url),
            startIndex,
        },
        enableTotalRecordCount:
            (getParam(url, 'EnableTotalRecordCount') ?? '').toLowerCase() !== 'false',
    };
}

export async function handleResumeRequest(event: RequestEvent): Promise<Response> {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const q = parseResumeQuery(url);
    const dto = parseDtoOptions(url);
    const empty: JellyfinItemsResponse = {
        Items: [],
        TotalRecordCount: 0,
        StartIndex: q.filters.startIndex,
    };
    if (q.filters.mediaTypes.length === 0) return json(shapeItemsResponse(empty, dto));

    const access = await buildJellyfinAccessContext(sql, locals.user);

    try {
        const { rows, totalCount } = await getResumeItemsPage(
            sql,
            locals.user.userId,
            q.limit,
            access.boundary,
            q.filters,
            q.enableTotalRecordCount,
        );

        const items = rows.map(mapRowToMediaItem);
        await applyJellyfinContentLanguage(sql, locals.user.userId, items);
        const serialized = serializeBaseItems(items);
        // Resume items are playable — they need MediaSources or Infuse
        // silently drops the response. Same shape contract as the browse +
        // search paths.
        const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
        await enrichItemsWithMediaSources(sql, serialized, apiKey);
        await enrichItemsWithProviderIds(sql, serialized);
        await enrichItemsWithMusicArtists(sql, serialized);
        if (dto.enableImages) await enrichItemsWithImages(sql, serialized);
        await enrichItemsForList(sql, serialized, dto);
        const filtered = dropFilelessPlayables(serialized);

        const response: JellyfinItemsResponse = {
            Items: filtered,
            TotalRecordCount: Math.max(0, totalCount - (serialized.length - filtered.length)),
            StartIndex: q.filters.startIndex,
        };
        return json(shapeItemsResponse(response, dto));
    } catch (error) {
        logger.error('Resume items query failed', error as Error);
        return ApiResponses.error('Failed to get resume items');
    }
}
