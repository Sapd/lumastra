// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import type { JellyfinItemsResponse } from '$lib/server/jellyfin-compat/types';
import { getDb } from '$lib/server/database';
import { buildLibraryViews } from '$lib/server/jellyfin-compat/library-views-utils';
import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/jellyfin-compat/dto-options';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const items = await buildLibraryViews(sql, locals.user);

    const response: JellyfinItemsResponse = {
        Items: items,
        TotalRecordCount: items.length,
        StartIndex: 0,
    };

    return json(shapeItemsResponse(response, parseDtoOptions(url)));
});
