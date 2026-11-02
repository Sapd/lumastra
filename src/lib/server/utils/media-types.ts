// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-safe media type definitions and utilities (server-side).
 *
 * This module provides centralized constants for media types across different
 * systems (UI, Jellyfin, TMDB) and type-safe comparison functions to prevent
 * case mismatch bugs like comparing 'Episode' vs 'episode'.
 *
 * All media types are standardized to **lowercase** throughout the system.
 * The canonical values match TMDB conventions: 'movie', 'tv', 'episode', 'season'.
 *
 * Usage:
 *   import { UIMediaType, JellyfinType, isEpisode, isMovie, isSeries } from '$lib/server/utils/media-types';
 *
 *   // Instead of: session.media_type === 'Episode' (BUG - wrong case!)
 *   // Use: isEpisode(session.media_type)
 */

// =============================================================================
// RE-EXPORT TYPE GUARDS AND CONSTANTS FROM SHARED
// =============================================================================

import {
    UIMediaType as SharedUIMediaType,
    type UIMediaTypeValue as SharedUIMediaTypeValue,
    isEpisode,
    isMovie,
    isSeries,
    isSeason,
    isExtra,
    isMusic,
    isAudioTrack,
    isAudio,
    isAudiobook,
    isTvChannel,
    isHomeVideo,
    isTraining,
    isEducational,
    isPersonal,
    isNonEntertainment,
    isAlbum,
    isArtist,
    isTrack,
    isMusicType,
    normalizeForComparison,
    mediaTypesMatch,
    ENTERTAINMENT_LIBRARY_TYPES,
    NON_ENTERTAINMENT_LIBRARY_TYPES,
    ALL_LIBRARY_TYPES,
} from '$lib/shared/media-types';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
export type { TmdbMediaType } from '$lib/shared/media-types';
export type { PublicMediaType, PublicMovieSeriesType } from '$lib/schemas/common';

// Every media-type CONVERSION is defined in $lib/shared/media-type-domain (one
// exhaustive table per target vocabulary). Re-exported here so server code has a
// single import path; none of it is implemented in this file or in
// $lib/shared/media-types.
export {
    INTERNAL_MEDIA_TYPES,
    assertNever,
    isInternalMediaType,
    toInternalMediaType,
    publicTypeOf,
    universalTypeOf,
    movieOrSeriesOf,
    detailTypeOf,
    apiTypeOf,
    tmdbTypeOf,
    providerTypeOf,
    isProviderMatchable,
    toPublicMediaType,
    toUniversalMediaType,
    toMovieOrSeries,
    toDetailMediaType,
    toApiMediaType,
    toTmdbMediaType,
    toProviderMediaType,
} from '$lib/shared/media-type-domain';
export type {
    MediaTypeInternal,
    MediaTypeProvider,
    MediaTypeTmdb,
    MediaTypeDetail,
    MediaTypeMovieOrSeries,
} from '$lib/shared/media-type-domain';

export const UIMediaType = SharedUIMediaType;
export type UIMediaTypeValue = SharedUIMediaTypeValue;
export {
    isEpisode,
    isMovie,
    isSeries,
    isSeason,
    isExtra,
    isMusic,
    isAudioTrack,
    isAudio,
    isAudiobook,
    isTvChannel,
    isHomeVideo,
    isTraining,
    isEducational,
    isPersonal,
    isNonEntertainment,
    isAlbum,
    isArtist,
    isTrack,
    isMusicType,
    normalizeForComparison,
    mediaTypesMatch,
    /** @deprecated Import toTmdbMediaType from $lib/shared/media-type-domain. */
    toTmdbType,
    ENTERTAINMENT_LIBRARY_TYPES,
    NON_ENTERTAINMENT_LIBRARY_TYPES,
    ALL_LIBRARY_TYPES,
};

// =============================================================================
// JELLYFIN TYPES (from Jellyfin API - PascalCase)
// =============================================================================

/**
 * Media types from Jellyfin API (PascalCase).
 * Used when interacting with Jellyfin items via item.Type.
 */
export const JellyfinType = {
    Movie: 'Movie',
    Series: 'Series',
    Episode: 'Episode',
    Season: 'Season',
    Audio: 'Audio',
    TvChannel: 'TvChannel',
    MusicAlbum: 'MusicAlbum',
    MusicArtist: 'MusicArtist',
    Person: 'Person',
    Folder: 'Folder',
    CollectionFolder: 'CollectionFolder',
    BoxSet: 'BoxSet',
} as const;

export type JellyfinTypeValue = (typeof JellyfinType)[keyof typeof JellyfinType];

// =============================================================================
// CONVERSION FUNCTIONS
// =============================================================================

/**
 * `jellyfinToUIType()` was REMOVED. It ended in `default: return
 * UIMediaType.MOVIE`, so `Person`, `Folder`, `BoxSet`, `MusicAlbum` and
 * `MusicArtist` all came back as movies — the bug class this refactor exists to
 * delete. It had no callers outside its own test file.
 *
 * Use `toInternalMediaType()` from `$lib/shared/media-type-domain`: it accepts
 * the whole Jellyfin PascalCase vocabulary (`'Series'` → `'tv'`, `'MusicAlbum'`
 * → `'album'`, `'Audio'` → `'audio'`) and returns `null` for the container types
 * Jellyfin reports that are not media items at all.
 */
