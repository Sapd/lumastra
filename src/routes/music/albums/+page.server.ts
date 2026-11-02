// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toAlbumSummary } from '$lib/server/services/music/track-projection';

import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getAlbums } from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicAlbumsPage');

const PAGE_SIZE = 48;

export const load: PageServerLoad = async ({ url, locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql || !locals.user) {
        return { albums: [], hasMore: false };
    }

    const genre = url.searchParams.get('genre') ?? undefined;
    const artist = url.searchParams.get('artist') ?? undefined;
    const sort = (url.searchParams.get('sort') as 'recent' | 'alpha' | 'year' | null) ?? undefined;

    try {
        // Same boundary as /api/music/albums, which serves every later page of
        // this grid: an unfiltered first page showed denied-group and
        // over-age albums that the next page would then (correctly) hide.
        const accessCtx = await buildSearchAccessContext(sql, locals.user);
        const albums = await getAlbums(sql, {
            genre,
            artist,
            sort,
            limit: PAGE_SIZE + 1,
            access: searchAccessBoundary(accessCtx),
        });
        const hasMore = albums.length > PAGE_SIZE;
        const imageSets = await resolveImageSets(
            sql,
            'internal',
            (hasMore ? albums.slice(0, PAGE_SIZE) : albums).map((row) => ({
                id: row.id,
                mediaType: 'album',
            })),
        );
        return {
            albums: (hasMore ? albums.slice(0, PAGE_SIZE) : albums).map((row) =>
                toAlbumSummary(row, imageSets.get(row.id) ?? {}),
            ),
            hasMore,
            genre,
            artist,
            sort,
        };
    } catch (err) {
        logger.error('Failed to load albums', err as Error);
        return { albums: [], hasMore: false, genre, artist, sort };
    }
};
