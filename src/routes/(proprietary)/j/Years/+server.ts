// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Years (Jellyfin YearsController.GetYears) — the production years of the
 * items the user can see, as Year items, for the browse-by-year view.
 *
 * Honours `ParentId` (a library or parent item), `IncludeItemTypes`,
 * `ExcludeItemTypes`, `SortOrder` and `StartIndex`/`Limit`. Every sort key
 * Jellyfin accepts here (SortName, Name, ProductionYear, …) orders a year list
 * the same way, by the year, so only the direction matters. Without
 * `IncludeItemTypes` episodes and seasons are left out, as on the Genres view:
 * their years duplicate their series'.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { getDistinctYears } from '$lib/server/database/queries/jellyfin-years.queries';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { serializeYear, typesParam } from '$lib/server/proprietary/jellyfin-compat/years';

const logger = Logger.for('JellyfinCompat:Years');

export const GET: RequestHandler = withJellyfinAuth(async ({ url, locals }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const parentId = getParam(url, 'ParentId');
    if (parentId && !isUuid(parentId)) {
        return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    const limitRaw = getParam(url, 'Limit');
    const limit = limitRaw === null ? null : Math.max(0, parseInt(limitRaw, 10) || 0);
    const descending = (getParam(url, 'SortOrder') ?? '').toLowerCase().startsWith('desc');

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const years = await getDistinctYears(sql, {
            parentId,
            mediaTypes: typesParam(url, 'IncludeItemTypes'),
            excludeMediaTypes: typesParam(url, 'ExcludeItemTypes'),
            access: access.boundary,
        });
        if (descending) years.reverse();
        const page = years.slice(startIndex, limit === null ? undefined : startIndex + limit);
        return json({
            Items: page.map(({ year, itemCount }) => serializeYear(year, itemCount)),
            TotalRecordCount: years.length,
            StartIndex: startIndex,
        });
    } catch (err) {
        logger.error('Year list failed', err as Error);
        return ApiResponses.error('Failed to get years');
    }
});
