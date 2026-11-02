// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import {
    serializeBaseItems,
    mapRowToMediaItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { applyFolderUserData } from '$lib/server/proprietary/jellyfin-compat/folder-user-data';
import type { JellyfinItemsResponse } from '$lib/server/proprietary/jellyfin-compat/types';
import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { getUserSuggestions } from '$lib/server/database/queries/suggestion-management.queries';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { enrichMediaItemsByIds } from '$lib/server/database/queries/jellyfin-browse.queries';
import type { MediaType } from '$lib/server/database/queries/suggestion-management.queries';

const logger = Logger.for('JellyfinCompat:Suggestions');

/** Map Jellyfin type param to our media type */
export function mapTypeParam(type: string | null): MediaType | undefined {
    if (!type) return undefined;
    switch (type) {
        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's Type query parameter uses its PascalCase vocabulary.
        case 'Movie':
            return 'movie';
        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's Type query parameter uses its PascalCase vocabulary.
        case 'Series':
            return 'tv';
        default:
            return undefined;
    }
}

export async function handleSuggestions(event: RequestEvent): Promise<Response> {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const limit = Math.min(Math.max(1, parseInt(getParam(url, 'Limit') ?? '20', 10) || 20), 50);
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    const typeFilter = mapTypeParam(getParam(url, 'Type'));

    try {
        // Get pre-computed suggestions from the user_suggestions table
        const suggestions = await getUserSuggestions(sql, locals.user.userId, limit + startIndex, {
            mediaType: typeFilter,
        });

        if (suggestions.length === 0) {
            const response: JellyfinItemsResponse = {
                Items: [],
                TotalRecordCount: 0,
                StartIndex: startIndex,
            };
            return json(response);
        }

        // Enrich with display metadata from media_items + provider_metadata.
        // Hydrate the whole fetched window BEFORE paging: hydration drops rows
        // the caller cannot see or that have no local files, and paging over the
        // unfiltered list would skew pages and report a total nobody can reach.
        const access = await buildJellyfinAccessContext(sql, locals.user);

        const rows = await enrichMediaItemsByIds(
            sql,
            suggestions.map((s) => s.media_id),
            access.boundary,
        );

        // Build a map for ordering by suggestion rank
        const rowMap = new Map(rows.map((r) => [r.id as string, r]));
        const visible = suggestions.filter((s) => rowMap.has(s.media_id));

        const items = visible
            .slice(startIndex, startIndex + limit)
            .map((s) => mapRowToMediaItem(rowMap.get(s.media_id)!));

        await applyJellyfinContentLanguage(sql, locals.user.userId, items);
        await applyFolderUserData(sql, items, locals.user.userId, access.boundary);

        const response: JellyfinItemsResponse = {
            Items: serializeBaseItems(items),
            TotalRecordCount: visible.length,
            StartIndex: startIndex,
        };

        return json(shapeItemsResponse(response, parseDtoOptions(url)));
    } catch (error) {
        logger.error('Suggestions query failed', error as Error);
        return ApiResponses.error('Failed to get suggestions');
    }
}
