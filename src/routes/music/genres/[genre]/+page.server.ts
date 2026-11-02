// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toAlbumSummary, toMusicTrack } from '$lib/server/services/music/track-projection';

import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getMusicByGenre, getTracksByGenre } from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { isGenrePinned } from '$lib/server/database/queries/user-pinned-genres.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicGenrePage');

export const load: PageServerLoad = async ({ params, locals }) => {
    const sql = await aiDbService.getSql();
    const genre = decodeURIComponent(params.genre);
    const userId = locals.user?.userId;

    if (!sql || !locals.user) {
        return { albums: [], tracks: [], genre, isPinned: false };
    }

    try {
        // The caller's real boundary — the albums and tracks of a genre are
        // still subject to their library groups and age ratings.
        const access = searchAccessBoundary(await buildSearchAccessContext(sql, locals.user));
        const [albums, tracks, pinned] = await Promise.all([
            getMusicByGenre(sql, genre, access, 200),
            getTracksByGenre(sql, genre, access, 500),
            userId ? isGenrePinned.check(sql, { userId, genre }) : Promise.resolve(false),
        ]);
        const imageSets = await resolveImageSets(sql, 'internal', [
            ...albums.map((row) => ({ id: row.id, mediaType: 'album' })),
            ...tracks.map((row) => ({ id: row.id, mediaType: 'track' })),
        ]);
        return {
            albums: albums.map((a) => toAlbumSummary(a, imageSets.get(a.id) ?? {})),
            tracks: tracks.map((t) => toMusicTrack(t, imageSets.get(t.id) ?? {})),
            genre,
            isPinned: pinned,
        };
    } catch (err) {
        logger.error('Failed to load genre page', err as Error, { genre });
        return { albums: [], tracks: [], genre, isPinned: false };
    }
};
