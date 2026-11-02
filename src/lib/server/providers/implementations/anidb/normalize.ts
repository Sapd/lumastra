// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AniDB normalization helpers.
 *
 * AniDB is an anime-only provider (type: 'tv' — no movie shape exists in
 * the AniDB data model). The native provider's search() already returns
 * MetadataCandidate[] and detail() already returns MediaMetadata, so these
 * helpers are thin pass-throughs that validate the shape and return null on
 * invalid input.
 *
 * Logic mirrors the legacy anidb plugin's searchSeries / searchMovie /
 * getSeriesDetail / getMovieDetail implementations:
 *   - searchMovie: delegates to searchByTitle, maps type → 'movie' (unusual
 *     but matches legacy behavior of accepting movie queries on anime data)
 *   - searchSeries: delegates to searchByTitle, maps type → 'tv'
 *   - getSeriesDetail / getMovieDetail: both call getAnimeDetail().metadata
 */

import type { MetadataCandidate, MediaMetadata } from '$lib/server/providers/types.js';

// ---------------------------------------------------------------------------
// searchResultToCandidate
// ---------------------------------------------------------------------------

/**
 * Map a raw AniDB search item to MetadataCandidate.
 *
 * The native provider's search() already emits MetadataCandidate-shaped
 * objects. This function validates the shape and applies the legacy plugin's
 * type mapping (the legacy searchMovie sets mediaType: 'movie', searchSeries
 * sets 'tv'; the `type` param mirrors that).
 *
 * Returns null if externalId or title is missing.
 */
export function searchResultToCandidate(
    raw: unknown,
    type: 'movie' | 'tv',
    queryYear?: number,
): MetadataCandidate | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const externalId = typeof r['externalId'] === 'string' ? r['externalId'] : undefined;
    const title = typeof r['title'] === 'string' ? r['title'] : undefined;
    if (!externalId || !title) return null;

    const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : 0.5;

    return {
        externalId,
        provider: 'anidb',
        title,
        year: (typeof r['year'] === 'number' ? r['year'] : undefined) ?? queryYear,
        mediaType: type,
        confidence,
        overview: typeof r['overview'] === 'string' ? r['overview'] : undefined,
        posterUrl: typeof r['posterUrl'] === 'string' ? r['posterUrl'] : undefined,
    };
}

// ---------------------------------------------------------------------------
// detailToMetadata
// ---------------------------------------------------------------------------

/**
 * Map a raw AniDB detail response to MediaMetadata.
 *
 * The native provider's detail() already emits MediaMetadata-shaped objects
 * (parsed from XML). This function validates the shape and returns it.
 * The `type` param is ignored — AniDB detail is type-agnostic.
 *
 * Returns null if title is missing.
 */
export function detailToMetadata(raw: unknown, _type: 'movie' | 'tv'): MediaMetadata | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const title = typeof r['title'] === 'string' ? r['title'] : undefined;
    if (!title) return null;

    return {
        title,
        overview: typeof r['overview'] === 'string' ? r['overview'] : undefined,
        year: typeof r['year'] === 'number' ? r['year'] : undefined,
        releaseDate: typeof r['releaseDate'] === 'string' ? r['releaseDate'] : undefined,
        genres: Array.isArray(r['genres']) ? (r['genres'] as string[]) : undefined,
        externalIds:
            r['externalIds'] && typeof r['externalIds'] === 'object'
                ? (r['externalIds'] as Record<string, string>)
                : undefined,
    };
}
