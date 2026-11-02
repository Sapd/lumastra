// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /Genres/{genreName}` (GenresController.GetGenre): one genre as a
 * BaseItemDto of Type Genre with its item counts. Resolved like Jellyfin — by
 * name, case-insensitively, or by its slug spelling (`-` for `&`, `/`, `?`) —
 * and by any /j genre Id, against the genres the caller can see. Jellyfin
 * answers an unknown name with an empty Genre; here it is a 404, so a genre
 * that only exists in a denied library is indistinguishable from none.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { resolveGenre, serializeGenre } from '$lib/server/proprietary/jellyfin-compat/genres';

const logger = Logger.for('JellyfinCompat:Genre');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, params }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const name = params.genreName?.trim();
    if (!name) return ApiResponses.badRequest('Genre name is required');
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const genre = await resolveGenre(sql, name, access);
        if (!genre) return ApiResponses.notFound('Genre not found');
        return json(serializeGenre(genre, true));
    } catch (error) {
        logger.error('Failed to get genre', error as Error);
        return ApiResponses.error('Failed to get genre');
    }
});
