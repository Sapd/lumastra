// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /Search/Hints` (SearchController.GetSearchHints). jellyfin-androidtv-family
 * clients (Moonfin) call this — not `/Items?searchTerm=` — for their native
 * search screen. See search-hints.ts.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { hasValidParentId } from '$lib/server/proprietary/jellyfin-compat/genres';
import { searchHints } from '$lib/server/proprietary/jellyfin-compat/search-hints';

const logger = Logger.for('JellyfinCompat:SearchHints');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, url }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!hasValidParentId(url)) return ApiResponses.badRequest('ParentId must be a GUID');
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        return json(await searchHints(sql, url, locals.user, access));
    } catch (error) {
        logger.error('Search hints query failed', error as Error);
        return ApiResponses.error('Failed to search hints');
    }
});
