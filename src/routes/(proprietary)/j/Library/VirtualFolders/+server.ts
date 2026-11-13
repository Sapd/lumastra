// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache';
import {
    MEDIA_TYPE_TO_COLLECTION,
    lastSegment,
} from '$lib/server/proprietary/jellyfin-compat/library-views-utils';

interface LibraryGroupRow {
    library_group_id: string;
    media_type: string;
    group_path: string;
    group_name: string | null;
}

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const groups = await sql<LibraryGroupRow[]>`
        SELECT DISTINCT ON (lp.library_group_id)
            lp.library_group_id,
            lp.media_type,
            lp.path as group_path,
            COALESCE(lg.display_name, lg.name) as group_name
        FROM library_paths lp
        LEFT JOIN library_groups lg ON lg.id = lp.library_group_id
        WHERE lp.enabled = true
        ORDER BY lp.library_group_id, lp.created_at ASC
    `;

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(locals.user));
    const deniedSet = new Set(denied ?? []);

    const folders = [];

    for (const group of groups) {
        if (deniedSet.has(group.library_group_id)) continue;

        const collectionType = MEDIA_TYPE_TO_COLLECTION[group.media_type];
        if (!collectionType) continue;

        const name = group.group_name ?? lastSegment(group.group_path);

        folders.push({
            Name: name,
            Locations: [],
            CollectionType: collectionType,
            ItemId: group.library_group_id,
            LibraryOptions: { EnableRealtimeMonitor: false },
        });
    }

    return json(folders);
});
