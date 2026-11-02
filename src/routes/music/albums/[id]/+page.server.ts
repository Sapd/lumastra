// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toAlbum, toMusicTrack } from '$lib/server/services/music/track-projection';

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getAlbumWithTracks } from '$lib/server/database/queries/music.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';

const logger = Logger.for('MusicAlbumDetailPage');

export const load: PageServerLoad = async ({ params, locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql) {
        error(503, 'Database unavailable');
    }

    try {
        const result = await getAlbumWithTracks(sql, params.id);
        if (!result) {
            error(404, 'Album not found');
        }
        if (!(await checkMediaAccess(sql, params.id, locals.user))) {
            error(404, 'Album not found');
        }
        const accessCtx = await buildSearchAccessContext(sql, locals.user);
        // Catalog-only tracks (no file on disk) can't be played; don't list them.
        const accessibleTracks = await filterAccessibleRows(
            sql,
            result.tracks.filter((t) => t.file_path),
            searchAccessBoundary(accessCtx),
        );
        const imageSets = await resolveImageSets(sql, 'internal', [
            { id: result.album.id, mediaType: 'album' },
            ...accessibleTracks.map((row) => ({ id: row.id, mediaType: 'track' })),
        ]);
        return {
            album: toAlbum(result.album, imageSets.get(result.album.id) ?? {}),
            tracks: accessibleTracks.map((t) => toMusicTrack(t, imageSets.get(t.id) ?? {})),
        };
    } catch (err: unknown) {
        if (err !== null && typeof err === 'object' && 'status' in err) {
            throw err;
        }
        logger.error('Failed to load album', err as Error, {
            albumId: params.id,
        });
        error(500, 'Failed to load album');
    }
};
