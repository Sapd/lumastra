// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/** Shared public artist DTO handler for internal and v1 music routes. */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import {
    getArtistWithAlbums,
    getArtistTracks,
} from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import {
    getArtistPopularity,
    getTrackPopularityForArtist,
} from '$lib/server/database/queries/popularity.queries.js';
import {
    buildArtistPopularitySummary,
    buildTrackPopularitySummary,
} from '$lib/server/services/popularity/presenter.js';
import type { PopularitySource } from '$lib/server/services/popularity/types.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';
import {
    toMusicTrack,
    toArtist,
    toAlbumSummary,
} from '$lib/server/services/music/track-projection.js';

const logger = Logger.for('MusicArtistDetailAPI');

export interface ArtistDetailOptions {
    surface: ApiSurface;
}

export async function artistDetailCore(
    event: RequestEvent,
    options: ArtistDetailOptions,
): Promise<Response> {
    const { params, locals } = event;
    if (!locals.user) return ApiProblem.unauthorized();

    const sql = await aiDbService.getSql();
    if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

    if (!params.id) return ApiProblem.validationFailed('Missing artist ID');
    const accessCtx = await buildSearchAccessContext(sql, locals.user);
    const accessBoundary = searchAccessBoundary(accessCtx);
    const result = await getArtistWithAlbums(sql, params.id, accessBoundary);

    if (!result) {
        return ApiProblem.notFound('Artist not found');
    }

    // Gate the artist row itself by library + age. The previous code returned
    // the artist (and ALL its albums) unconditionally and only filtered the
    // tracks list by library.
    if (!(await checkMediaAccess(sql, params.id, locals.user))) {
        return ApiProblem.notFound('Artist not found');
    }

    const tracks = result.artist.is_various_artists
        ? []
        : await getArtistTracks(sql, params.id, locals.user.userId, accessBoundary);
    // Catalog-only tracks (no file on disk, so no file_path) can't be played:
    // listing them handed clients a track whose stream 404s.
    const playableTracks = tracks.filter((t) => t.file_path);

    const [accessibleAlbums, accessibleTracks] = await Promise.all([
        filterAccessibleRows(sql, result.albums, accessBoundary),
        filterAccessibleRows(sql, playableTracks, accessBoundary),
    ]);

    const source = config.MUSIC_POPULARITY_PRIMARY_SOURCE as PopularitySource;
    const [artistPop, trackPops] = await Promise.all([
        getArtistPopularity(sql, params.id, source),
        getTrackPopularityForArtist(sql, params.id, source),
    ]);

    const artistPopularity = artistPop
        ? buildArtistPopularitySummary(artistPop, source)
        : undefined;

    const trackPopById = new Map(
        trackPops.map((t) => [t.trackId, buildTrackPopularitySummary(t, source)]),
    );

    logger.debug('Artist detail loaded', {
        username: locals.user.username,
        artistId: params.id,
        albumCount: result.albums.length,
        trackCount: accessibleTracks.length,
        hasPopularity: artistPopularity !== undefined,
        tracksWithPopularity: trackPopById.size,
    });

    const imageSets = await resolveImageSets(sql, options.surface, [
        { id: result.artist.id, mediaType: 'artist' },
        ...accessibleAlbums.map((row) => ({ id: row.id, mediaType: 'album' })),
        ...accessibleTracks.map((row) => ({ id: row.id, mediaType: 'track' })),
    ]);
    return json({
        ...toArtist(
            {
                ...result.artist,
                album_count: accessibleAlbums.length,
                track_count: result.artist.is_various_artists
                    ? accessibleAlbums.reduce((sum, album) => sum + album.track_count, 0)
                    : accessibleTracks.length,
            },
            imageSets.get(result.artist.id) ?? {},
        ),
        popularity: artistPopularity,
        albums: accessibleAlbums.map((album) =>
            toAlbumSummary(album, imageSets.get(album.id) ?? {}),
        ),
        tracks: accessibleTracks.map((t) => ({
            ...toMusicTrack(
                { ...t, artist_id: result.artist.id, artist_title: result.artist.title },
                imageSets.get(t.id) ?? {},
            ),
            popularity: trackPopById.get(t.id),
        })),
    });
}

export function createArtistDetailHandler(options: ArtistDetailOptions): RequestHandler {
    return requireAuth(withErrorHandler((event) => artistDetailCore(event, options)));
}
