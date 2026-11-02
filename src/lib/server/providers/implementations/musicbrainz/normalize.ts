// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MusicBrainz normalization helpers.
 *
 * MusicBrainz is a music-only metadata provider. Its data model covers
 * artists, albums (releases), and recordings — it has no movie or TV show
 * concept. The legacy plugin's searchMovie / searchSeries / getMovieDetail /
 * getSeriesDetail all return empty arrays or null unconditionally.
 *
 * Both functions here return null to match that legacy behavior. Callers
 * that dispatch to MusicBrainz for movie/tv normalization will receive null
 * and should skip or fall through to another provider.
 *
 * Music-specific enrichment (artist, album, recording) is handled by the
 * MusicBrainz-specific functions exported from the providers/musicbrainz/
 * index (cover-art, lrclib) and the native provider's search/detail methods
 * which use music-shaped types (MusicAlbumCandidate, MusicArtistDetail, etc.).
 */

import type { MetadataCandidate, MediaMetadata } from '$lib/server/providers/types.js';

// ---------------------------------------------------------------------------
// searchResultToCandidate
// ---------------------------------------------------------------------------

/**
 * MusicBrainz has no movie/TV search surface — always returns null.
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
 * MusicBrainz has no movie/TV detail surface — always returns null.
 */
export function detailToMetadata(_raw: unknown, _type: 'movie' | 'tv'): MediaMetadata | null {
    return null;
}
