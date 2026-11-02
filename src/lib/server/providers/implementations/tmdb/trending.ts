// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB trending + cross-reference helpers.
 *
 * Top-level helpers for routes that want pre-shaped trending lists. These are
 * NOT part of the SDK's `ProviderDefinition` contract — TMDB-specific surface
 * relocated here from the legacy plugin's `index.ts` during Phase 3.
 *
 * `getTrendingMovies` / `getTrendingTVShows` wrap `tmdbApi.getTrendingMovies` /
 * `getTrendingTVShows` and normalize each result into the legacy `MediaMetadata`
 * shape (same `transformSearchResultToMetadata` logic the old plugin used).
 *
 * `getCrossReferences` walks `external_ids` on a TMDB detail response and
 * returns `[{ provider, id }]` pairs for IMDB / TVDB cross-referencing.
 */

import { tmdbApi } from './client.js';
import type { MediaMetadata } from '$lib/server/providers/types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isMovie } from '$lib/server/utils/media-types.js';

const logger = Logger.for('TmdbTrending');

export interface TmdbTrendingItem {
    externalId: string;
    mediaType: 'movie' | 'tv';
    metadata: MediaMetadata;
}

function parseReleaseYear(dateStr?: string): number | undefined {
    if (!dateStr) return undefined;
    const year = parseInt(dateStr.substring(0, 4), 10);
    return Number.isFinite(year) ? year : undefined;
}

/**
 * Convert a raw TMDB search/trending result into the `MediaMetadata` shape.
 * Mirrors the legacy plugin's `transformSearchResultToMetadata` exactly.
 */
function searchResultToMetadata(result: {
    media_type: string;
    title?: string;
    name?: string;
    original_title?: string;
    original_name?: string;
    release_date?: string;
    first_air_date?: string;
    overview?: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
    vote_average?: number;
    vote_count?: number;
    popularity?: number;
}): MediaMetadata {
    const isMovieType = isMovie(result.media_type);
    return {
        title: isMovieType ? (result.title ?? '') : (result.name ?? ''),
        originalTitle: isMovieType ? result.original_title : result.original_name,
        year: parseReleaseYear(isMovieType ? result.release_date : result.first_air_date),
        releaseDate: isMovieType ? result.release_date : result.first_air_date,
        overview: result.overview,
        posterUrl: result.poster_path
            ? `https://image.tmdb.org/t/p/original${result.poster_path}`
            : undefined,
        backdropUrl: result.backdrop_path
            ? `https://image.tmdb.org/t/p/original${result.backdrop_path}`
            : undefined,
        voteAverage: result.vote_average,
        voteCount: result.vote_count,
        popularity: result.popularity,
    } as MediaMetadata & Record<string, unknown>;
}

export async function getTrendingMovies(page = 1): Promise<TmdbTrendingItem[]> {
    try {
        const response = await tmdbApi.getTrendingMovies(page);
        return response.results.map((movie) => ({
            externalId: String(movie.id),
            mediaType: 'movie' as const,
            metadata: searchResultToMetadata({
                ...movie,
                media_type: 'movie',
            }),
        }));
    } catch (error) {
        logger.error('TMDB getTrendingMovies failed', error instanceof Error ? error : undefined, {
            page,
        });
        return [];
    }
}

export async function getTrendingTVShows(page = 1): Promise<TmdbTrendingItem[]> {
    try {
        const response = await tmdbApi.getTrendingTVShows(page);
        return response.results.map((show) => ({
            externalId: String(show.id),
            mediaType: 'tv' as const,
            metadata: searchResultToMetadata({
                ...show,
                media_type: 'tv',
            }),
        }));
    } catch (error) {
        logger.error('TMDB getTrendingTVShows failed', error instanceof Error ? error : undefined, {
            page,
        });
        return [];
    }
}

/**
 * Cross-reference a TMDB id to other providers (IMDB, TVDB).
 *
 * Mirrors the legacy `getCrossReferences` helper. Returns an empty array on
 * lookup failure so callers can treat "no cross-references" the same as
 * "lookup failed".
 */
export async function getCrossReferences(
    externalId: string,
    mediaType: 'movie' | 'tv',
): Promise<Array<{ provider: string; id: string }>> {
    const tmdbId = parseInt(externalId, 10);
    if (isNaN(tmdbId)) return [];
    try {
        const details = isMovie(mediaType)
            ? await tmdbApi.getMovieDetails(tmdbId)
            : await tmdbApi.getTVShowDetails(tmdbId);
        const refs: Array<{ provider: string; id: string }> = [];
        const ext = (
            details as {
                external_ids?: Record<string, string | number | null>;
            }
        ).external_ids;
        if (ext?.imdb_id) {
            refs.push({ provider: 'imdb', id: String(ext.imdb_id) });
        }
        // TVDB ids are 1-indexed; treat 0/'0' as "no id" so we don't write
        // '0' as a cross-reference.
        const tvdbId = ext?.tvdb_id;
        if (tvdbId != null && tvdbId !== 0 && tvdbId !== '0') {
            refs.push({ provider: 'tvdb', id: String(tvdbId) });
        }
        return refs;
    } catch (error) {
        logger.warn(
            'TMDB getCrossReferences failed',
            { externalId, mediaType },
            error instanceof Error ? error : undefined,
        );
        return [];
    }
}
