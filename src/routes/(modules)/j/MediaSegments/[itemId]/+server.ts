// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getParam, getParamAll } from '$lib/server/jellyfin-compat/utils';
import { getDb } from '$lib/server/database';
import { secondsToTicks } from '$lib/server/jellyfin-compat/constants';
import { getSegmentsByMediaId } from '$lib/server/database/queries/media-segments.queries';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { ApiResponses } from '$lib/server/utils/api-responses';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { params, url, locals } = event;
    const sql = getDb();
    if (!sql) {
        return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }

    const itemId = params.itemId;
    if (!itemId) {
        return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }

    if (!(await checkMediaAccess(sql, itemId, locals.user))) {
        return ApiResponses.notFound();
    }

    // Parse requested segment types (Intro, Outro, etc.)
    const requestedTypes = getParamAll(url, 'includeSegmentTypes[]');
    // Also handle non-array format
    const singleType = getParam(url, 'includeSegmentTypes');
    if (singleType) requestedTypes.push(singleType);

    const rows = await getSegmentsByMediaId(sql, itemId);

    // Map DB types to Jellyfin segment types
    const typeMap: Record<string, string> = {
        intro: 'Intro',
        outro: 'Outro',
        recap: 'Recap',
        preview: 'Preview',
    };

    const items = rows
        .map((row) => {
            const jellyfinType =
                typeMap[(row.type as string).toLowerCase()] ?? (row.type as string);
            return {
                Id: row.id as string,
                ItemId: itemId,
                Type: jellyfinType,
                StartTicks: secondsToTicks(row.start_time as number),
                EndTicks: secondsToTicks(row.end_time as number),
            };
        })
        .filter((item) => requestedTypes.length === 0 || requestedTypes.includes(item.Type));

    return json({
        Items: items,
        TotalRecordCount: items.length,
        StartIndex: 0,
    });
});
