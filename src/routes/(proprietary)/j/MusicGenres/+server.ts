// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /MusicGenres` (MusicGenresController.GetMusicGenres): the music genres
 * (track genre tags) the user can see, with the same parameters as `/Genres`.
 * Unscoped lists come from the cached genre list behind /MusicGenres/{name}
 * and the genre mixes, so every Id here resolves there. See genre-lists.ts.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { Logger } from '$lib/server/utils/logger';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { hasValidParentId } from '$lib/server/proprietary/jellyfin-compat/genres';
import { listMusicGenres } from '$lib/server/proprietary/jellyfin-compat/genre-lists';

import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';

const logger = Logger.for('JellyfinCompat:MusicGenres');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, url }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!hasValidParentId(url)) return ApiResponses.badRequest('ParentId must be a GUID');
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        return json(
            shapeItemsResponse(await listMusicGenres(sql, url, access), parseDtoOptions(url)),
        );
    } catch (err) {
        logger.error('Failed to fetch music genres', undefined, { error: err });
        return ApiResponses.error('Failed to fetch music genres');
    }
});
