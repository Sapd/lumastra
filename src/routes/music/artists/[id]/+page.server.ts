// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toAlbumSummary, toArtist } from '$lib/server/services/music/track-projection';

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getArtistWithAlbums } from '$lib/server/database/queries/music.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';

const logger = Logger.for('MusicArtistDetailPage');

export const load: PageServerLoad = async ({ params, locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql) {
        error(503, 'Database unavailable');
    }

    try {
        const accessCtx = await buildSearchAccessContext(sql, locals.user);
        const result = await getArtistWithAlbums(sql, params.id, searchAccessBoundary(accessCtx));
        if (!result) {
            error(404, 'Artist not found');
        }
        // Library + age gate on the artist. Without this the page reveals
        // artist + album metadata for any caller who knows the UUID.
        if (!(await checkMediaAccess(sql, params.id, locals.user))) {
            error(404, 'Artist not found');
        }
        const accessibleAlbums = await filterAccessibleRows(
            sql,
            result.albums,
            searchAccessBoundary(accessCtx),
        );
        const imageSets = await resolveImageSets(sql, 'internal', [
            { id: result.artist.id, mediaType: 'artist' },
            ...accessibleAlbums.map((row) => ({ id: row.id, mediaType: 'album' })),
        ]);
        return {
            artist: toArtist(result.artist, imageSets.get(result.artist.id) ?? {}),
            albums: accessibleAlbums.map((a) => toAlbumSummary(a, imageSets.get(a.id) ?? {})),
        };
    } catch (err: unknown) {
        if (err !== null && typeof err === 'object' && 'status' in err) {
            throw err;
        }
        logger.error('Failed to load artist', err as Error, {
            artistId: params.id,
        });
        error(500, 'Failed to load artist');
    }
};
