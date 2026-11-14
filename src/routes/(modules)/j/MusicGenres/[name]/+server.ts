// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /MusicGenres/{genreName} — one music genre as a BaseItemDto of Type
// MusicGenre (MusicGenresController.GetMusicGenre). The segment is `[name]`
// because it shares its level with `/MusicGenres/{name}/InstantMix`. Resolved
// against the genres the caller can see (by name, or by any /j genre Id); 404
// otherwise.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { buildJellyfinAccessContext } from '$lib/server/jellyfin-compat/access-context';
import {
    getMusicGenreCoverAlbumId,
    resolveMusicGenre,
    serializeMusicGenre,
} from '$lib/server/jellyfin-compat/music-genres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:MusicGenre');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }
    const name = params.name?.trim();
    if (!name) {
        return ApiResponses.badRequest('Genre name is required');
    }

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const genre = await resolveMusicGenre(sql, name, access);
        if (!genre) {
            return ApiResponses.notFound('Genre not found');
        }
        const coverAlbumId = await getMusicGenreCoverAlbumId(sql, genre.name, access);
        return json(serializeMusicGenre(genre, coverAlbumId));
    } catch (e) {
        logger.warn('Failed to load music genre', { error: e });
        return ApiResponses.error('Failed to load music genre');
    }
});
