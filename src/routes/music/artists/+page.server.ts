// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toArtistSummary } from '$lib/server/services/music/track-projection';

import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getArtists } from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicArtistsPage');

const PAGE_SIZE = 48;

export const load: PageServerLoad = async ({ url, locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql || !locals.user) {
        return { artists: [], hasMore: false };
    }

    const genre = url.searchParams.get('genre') ?? undefined;
    const sort = (url.searchParams.get('sort') as 'recent' | 'alpha' | 'year' | null) ?? undefined;

    try {
        // Same boundary as /api/music/artists, which serves every later page
        // of this grid — see the albums page-load.
        const accessCtx = await buildSearchAccessContext(sql, locals.user);
        const artists = await getArtists(sql, {
            genre,
            sort,
            limit: PAGE_SIZE + 1,
            excludeVariousArtists: true,
            access: searchAccessBoundary(accessCtx),
        });
        const hasMore = artists.length > PAGE_SIZE;
        const imageSets = await resolveImageSets(
            sql,
            'internal',
            (hasMore ? artists.slice(0, PAGE_SIZE) : artists).map((row) => ({
                id: row.id,
                mediaType: 'artist',
            })),
        );
        return {
            artists: (hasMore ? artists.slice(0, PAGE_SIZE) : artists).map((row) =>
                toArtistSummary(row, imageSets.get(row.id) ?? {}),
            ),
            hasMore,
            genre,
            sort,
        };
    } catch (err) {
        logger.error('Failed to load artists', err as Error);
        return { artists: [], hasMore: false, genre, sort };
    }
};
