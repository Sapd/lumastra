// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/** Shared public album DTO handler for internal and v1 music routes. */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { getAlbumWithTracks } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import {
    getArtistPopularity,
    getTrackPopularityForAlbum,
} from '$lib/server/database/queries/popularity.queries.js';
import {
    buildArtistPopularitySummary,
    buildTrackPopularitySummary,
} from '$lib/server/services/popularity/presenter.js';
import type { PopularitySource } from '$lib/server/services/popularity/types.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';
import { toMusicTrack, toAlbum } from '$lib/server/services/music/track-projection.js';

const logger = Logger.for('MusicAlbumDetailAPI');

export interface AlbumDetailOptions {
    surface: ApiSurface;
}

export async function albumDetailCore(
    event: RequestEvent,
    options: AlbumDetailOptions,
): Promise<Response> {
    const { params, locals } = event;
    if (!locals.user) return ApiProblem.unauthorized();

    const sql = await aiDbService.getSql();
    if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

    if (!params.id) return ApiProblem.validationFailed('Missing album ID');
    const result = await getAlbumWithTracks(sql, params.id);

    if (!result) {
        return ApiProblem.notFound('Album not found');
    }

    // Gate the album itself by library + age. Previously the album row was
    // always returned and only the tracks were filtered (library only). A
    // restricted user could read restricted album metadata via params.id
    // even if all the tracks vanished from `tracks`.
    if (!(await checkMediaAccess(sql, params.id, locals.user))) {
        return ApiProblem.notFound('Album not found');
    }

    const accessCtx = await buildSearchAccessContext(sql, locals.user);
    // Catalog-only tracks (no file on disk, so no file_path) can't be played:
    // listing them handed clients a track whose stream 404s.
    const accessibleTracks = await filterAccessibleRows(
        sql,
        result.tracks.filter((t) => t.file_path),
        searchAccessBoundary(accessCtx),
    );

    const source = config.MUSIC_POPULARITY_PRIMARY_SOURCE as PopularitySource;
    const artistId = result.album.artist_id;
    const [artistPop, trackPops] = await Promise.all([
        artistId ? getArtistPopularity(sql, artistId, source) : Promise.resolve(null),
        getTrackPopularityForAlbum(sql, params.id, source),
    ]);

    const artistPopularity = artistPop
        ? buildArtistPopularitySummary(artistPop, source)
        : undefined;
    const trackPopById = new Map(
        trackPops.map((t) => [t.trackId, buildTrackPopularitySummary(t, source)]),
    );

    logger.debug('Album detail loaded', {
        username: locals.user.username,
        albumId: params.id,
        trackCount: accessibleTracks.length,
        hasArtistPopularity: artistPopularity !== undefined,
        tracksWithPopularity: trackPopById.size,
    });

    const imageSets = await resolveImageSets(sql, options.surface, [
        { id: result.album.id, mediaType: 'album' },
        ...accessibleTracks.map((row) => ({ id: row.id, mediaType: 'track' })),
    ]);
    return json({
        ...toAlbum(result.album, imageSets.get(result.album.id) ?? {}),
        popularity: artistPopularity,
        tracks: accessibleTracks.map((t) => ({
            ...toMusicTrack(
                {
                    ...t,
                    album_id: result.album.id,
                    album_custom_poster_url: result.album.custom_poster_url,
                    album_title: result.album.title,
                    artist_id: result.album.artist_id,
                    artist_title: result.album.artist_title,
                    album_artist_id: result.album.artist_id,
                    album_artist_title: result.album.artist_title,
                },
                imageSets.get(t.id) ?? {},
            ),
            popularity: trackPopById.get(t.id),
        })),
    });
}

export function createAlbumDetailHandler(options: AlbumDetailOptions): RequestHandler {
    return requireAuth(withErrorHandler((event) => albumDetailCore(event, options)));
}
