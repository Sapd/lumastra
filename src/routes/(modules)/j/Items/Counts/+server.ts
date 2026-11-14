// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Items/Counts` (LibraryController.GetItemCounts) → ItemCounts. A literal
 * segment, so SvelteKit matches it before `/Items/[itemId]` (which used to
 * answer it as an unknown item id).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '$lib/server/jellyfin-compat/utils';
import { buildJellyfinAccessContext } from '$lib/server/jellyfin-compat/access-context';
import { getLibraryItemCounts } from '$lib/server/database/queries/jellyfin-browse.queries';

const logger = Logger.for('JellyfinCompat:ItemCounts');

export const GET: RequestHandler = withJellyfinAuth(async ({ locals, url }) => {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const fav = getParam(url, 'IsFavorite')?.trim().toLowerCase();
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const c = await getLibraryItemCounts(sql, {
            access: access.boundary,
            userId: locals.user.userId,
            isFavorite: fav === 'true' ? true : fav === 'false' ? false : null,
        });
        return json({
            MovieCount: c.movie,
            SeriesCount: c.tv,
            EpisodeCount: c.episode,
            ArtistCount: c.artist,
            ProgramCount: 0,
            TrailerCount: 0,
            SongCount: c.track,
            AlbumCount: c.album,
            MusicVideoCount: 0,
            BoxSetCount: 0,
            BookCount: 0,
            ItemCount: c.movie + c.tv + c.episode + c.artist + c.album + c.track,
        });
    } catch (error) {
        logger.error('Item counts query failed', error as Error);
        return ApiResponses.error('Failed to count items');
    }
});
