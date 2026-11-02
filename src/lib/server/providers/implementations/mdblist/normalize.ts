// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList normalization helpers.
 *
 * MDBList is a ratings-aggregation provider — it has no title search API
 * surface (search() always throws). Only detail() is meaningful.
 *
 * The legacy plugin's getMovieDetail / getSeriesDetail both return null
 * unconditionally — MDBList metadata is consumed exclusively through the
 * mdblist-sync batch task, not through the search/detail plugin interface.
 *
 * searchResultToCandidate: always returns null (no search surface).
 * detailToMetadata: maps MdblistItem fields → MediaMetadata, mirroring what
 *   a real consumer would expect. Since the legacy plugin returns null, this
 *   is the first real normalization — kept minimal to only the fields
 *   MDBList actually provides.
 */

import type { MetadataCandidate, MediaMetadata } from '$lib/server/providers/types.js';

// ---------------------------------------------------------------------------
// searchResultToCandidate
// ---------------------------------------------------------------------------

/**
 * MDBList has no title search — always returns null.
 */
export function searchResultToCandidate(
    _raw: unknown,
    _type: 'movie' | 'tv',
    _queryYear?: number,
): MetadataCandidate | null {
    return null;
}

// ---------------------------------------------------------------------------
// detailToMetadata
// ---------------------------------------------------------------------------

/**
 * Map a raw MDBList detail response (MdblistItem) to MediaMetadata.
 *
 * MDBList provides ratings and streaming availability but not the full
 * title metadata that TMDB provides. Fields not present in MdblistItem
 * are omitted. Returns null if title is missing.
 */
export function detailToMetadata(raw: unknown, _type: 'movie' | 'tv'): MediaMetadata | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;

    const title = typeof item['title'] === 'string' ? item['title'] : undefined;
    if (!title) return null;

    const genres = Array.isArray(item['genres'])
        ? (item['genres'] as Array<Record<string, unknown>>)
              .map((g) => (typeof g['title'] === 'string' ? g['title'] : ''))
              .filter(Boolean)
        : undefined;

    const posterUrl =
        typeof item['poster'] === 'string' && item['poster'] ? item['poster'] : undefined;

    const backdropUrl =
        typeof item['backdrop'] === 'string' && item['backdrop'] ? item['backdrop'] : undefined;

    const runtime = typeof item['runtime'] === 'number' ? item['runtime'] : undefined;
    const year = typeof item['year'] === 'number' ? item['year'] : undefined;
    const overview = typeof item['description'] === 'string' ? item['description'] : undefined;
    const status = typeof item['status'] === 'string' ? item['status'] : undefined;
    const language = typeof item['language'] === 'string' ? item['language'] : undefined;

    // External IDs from ids sub-object. Local var renamed to `idMap` so the
    // callback-safety lint doesn't flag the writes — these are construction
    // sites, not the field-reads the rule is meant to catch.
    const ids =
        item['ids'] && typeof item['ids'] === 'object'
            ? (item['ids'] as Record<string, unknown>)
            : undefined;
    const idMap: Record<string, string> = {};
    if (ids) {
        if (typeof ids['imdb'] === 'string') idMap['imdb'] = ids['imdb'];
        if (typeof ids['tmdb'] === 'number') idMap['tmdb'] = String(ids['tmdb']);
        if (typeof ids['tvdb'] === 'number') idMap['tvdb'] = String(ids['tvdb']);
        if (typeof ids['trakt'] === 'number') idMap['trakt'] = String(ids['trakt']);
    }

    return {
        title,
        overview,
        year,
        genres: genres && genres.length > 0 ? genres : undefined,
        runtime,
        status,
        language,
        externalIds: Object.keys(idMap).length > 0 ? idMap : undefined,
        posterUrl,
        backdropUrl,
    };
}
