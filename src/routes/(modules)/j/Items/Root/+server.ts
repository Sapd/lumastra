// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Items/Root` (UserLibraryController.GetRootFolder) → the user's root
 * folder. A literal segment, so SvelteKit matches it before `/Items/[itemId]`.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildUserRootFolder } from '$lib/server/jellyfin-compat/root-folder';

const logger = Logger.for('JellyfinCompat:RootFolder');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    try {
        return json(await buildUserRootFolder(sql, locals.user));
    } catch (error) {
        logger.error('Root folder failed', error as Error);
        return ApiResponses.error('Failed to load the root folder');
    }
});
