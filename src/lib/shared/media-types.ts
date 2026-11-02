// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-safe media type **guard** functions — `isMovie`, `isSeries`, … .
 *
 * These are pure case-insensitive string comparisons with no server
 * dependencies, safe for use in `.svelte` files and client-side `.ts` modules.
 *
 * ## Where the conversions went
 *
 * Every media-type *conversion* now lives in ONE module,
 * {@link file://./media-type-domain.ts} (`$lib/shared/media-type-domain`), which
 * owns the canonical internal union and every mapping between vocabularies as an
 * exhaustive lookup table. This file re-exports the conversions for
 * backwards-compatible import paths but defines none of them.
 *
 * The conversions that used to live here — `toPublicMovieOrSeries`,
 * `toPublicDetailType`, `toImageMediaType` and the old total `toTmdbType` — all
 * ended in `return 'movie'`, i.e. they spelled "I don't know" as "movie". Their
 * replacements return `| null`; see the domain module's header for why.
 *
 * The server-side entry point is `$lib/server/utils/media-types.ts`, which
 * re-exports everything here plus the Jellyfin vocabulary.
 */

import type {
    MediaTypeInternal,
    MediaTypeTmdb,
    RawMediaTypeComparatorInput,
    VideoMediaTypeComparatorInput,
    EpisodeMediaTypeComparatorInput,
    SeasonMediaTypeComparatorInput,
    AudiobookMediaTypeComparatorInput,
} from './media-type-domain';
import { toTmdbMediaType } from './media-type-domain';

// Backwards-compatible import path for the conversions. They are DEFINED in
// ./media-type-domain — this is a re-export so the ~100 existing
// `from '$lib/shared/media-types'` / `from '$lib/server/utils/media-types'`
// imports keep working. There is exactly one implementation of each.
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
} from './media-type-domain';
export type {
    MediaTypeInternal,
    MediaTypeProvider,
    MediaTypeProviderProjection,
    MediaTypeTmdb,
    MediaTypeDetail,
    MediaTypeMovieOrSeries,
    EpisodeMediaTypeComparatorInput,
    SeasonMediaTypeComparatorInput,
    AudiobookMediaTypeComparatorInput,
} from './media-type-domain';

/**
 * Canonical media type constants (lowercase), for code that prefers a named
 * constant over a bare literal.
 *
 * ⚠️ NOT the source of truth for the vocabulary — {@link INTERNAL_MEDIA_TYPES}
 * in `./media-type-domain` is, and it is checked against the DB CHECK
 * constraint. The `satisfies` clause below keeps this object from drifting into
 * values the database cannot store; it deliberately does NOT have to be
 * complete.
 */
export const UIMediaType = {
    MOVIE: 'movie',
    SERIES: 'tv',
    EPISODE: 'episode',
    SEASON: 'season',
    AUDIOBOOK: 'audiobook',
    AUDIO: 'audio',
    TVCHANNEL: 'tvchannel',
    BOOK: 'book',
    MANGA: 'manga',
    COMIC: 'comic',
    ANFRAGEN: 'anfragen',
    SONARR: 'sonarr',
    RADARR: 'radarr',
    PODCAST: 'podcast',
    MUSIC: 'music',
    ARTIST: 'artist',
    ALBUM: 'album',
    TRACK: 'track',
    HOME_VIDEO: 'home_video',
    TRAINING: 'training',
    EDUCATIONAL: 'educational',
    PERSONAL: 'personal',
} as const satisfies Readonly<Record<string, MediaTypeInternal>>;

export type UIMediaTypeValue = (typeof UIMediaType)[keyof typeof UIMediaType];

export function normalizeForComparison(value: string | undefined | null): string {
    if (!value) return '';
    return value.toUpperCase();
}

/**
 * Check if two media types are equivalent (case-insensitive).
 *
 * @example
 *   mediaTypesMatch('EPISODE', 'Episode'); // true
 *   mediaTypesMatch('movie', 'MOVIE');     // true
 */
export function mediaTypesMatch(
    type1: string | undefined | null,
    type2: string | undefined | null,
): boolean {
    return normalizeForComparison(type1) === normalizeForComparison(type2);
}

/**
 * TMDB's binary vocabulary. Re-exported from the domain module.
 */
export type TmdbMediaType = MediaTypeTmdb;

/**
 * Project a media type onto TMDB's binary vocabulary — or `null` when TMDB has
 * no such entity.
 *
 * This is an alias of {@link toTmdbMediaType}; the mapping table lives in the
 * domain module. Series/episodes/seasons fold onto `'tv'` (an episode's TMDB
 * identity IS the parent series' `tv` entity).
 *
 * ⚠️ **It returns `null` now.** It used to end in `return 'movie'`, which sent
 * audiobook, track, album and channel rows to `/3/movie/{id}` and built
 * `…/poster?type=movie` image paths for them. A `null` means *do not call TMDB
 * and do not build a TMDB path for this row* — handle it, don't `?? 'movie'` it
 * back into the bug unless the surface genuinely cannot receive those types.
 *
 * @example
 *   toTmdbType('Movie')     // 'movie'  (Jellyfin PascalCase)
 *   toTmdbType('Series')    // 'tv'
 *   toTmdbType('episode')   // 'tv'
 *   toTmdbType('audiobook') // null     (was 'movie')
 */
/**
 * @deprecated Import `toTmdbMediaType` from `$lib/shared/media-type-domain`.
 * Kept only for external/legacy callers of this compatibility facade.
 */
export const toTmdbType = toTmdbMediaType;

/** Check if a media type represents a movie. */
export function isMovie(mediaType: VideoMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'MOVIE';
}

/** Check if a media type represents a series/TV show. */
export function isSeries(mediaType: VideoMediaTypeComparatorInput | undefined | null): boolean {
    const normalized = normalizeForComparison(mediaType);
    return normalized === 'SERIES' || normalized === 'TV';
}

/** Check if a media type represents an episode. */
export function isEpisode(mediaType: EpisodeMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'EPISODE';
}

/** Check if a media type represents a season. */
export function isSeason(mediaType: SeasonMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'SEASON';
}

/** Check if a media type represents an extra (trailer, featurette, …). */
export function isExtra(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'EXTRA';
}

/** Check if a media type represents a music library root or legacy music type. */
export function isMusic(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    const normalized = normalizeForComparison(mediaType);
    return normalized === 'MUSIC' || normalized === 'ARTIST';
}

/** Check if a media type represents a music artist. */
export function isArtist(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'ARTIST';
}

/** Check if a media type represents a music album. */
export function isAlbum(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'ALBUM';
}

/** Check if a media type represents a music track. */
export function isTrack(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'TRACK';
}

/** Check if a media type is any music-hierarchy type (artist, album, or track). */
export function isMusicType(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    const normalized = normalizeForComparison(mediaType);
    return normalized === 'ARTIST' || normalized === 'ALBUM' || normalized === 'TRACK';
}

/** Check if a media type represents an audio track (leaf playable item). */
export function isAudioTrack(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    const normalized = normalizeForComparison(mediaType);
    return normalized === 'AUDIO' || normalized === 'TRACK';
}

/** Check if a media type represents audio content. */
export function isAudio(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    const normalized = normalizeForComparison(mediaType);
    return normalized === 'AUDIO' || normalized === 'TRACK';
}

/** Check if a media type represents an audiobook. */
export function isAudiobook(
    mediaType: AudiobookMediaTypeComparatorInput | undefined | null,
): boolean {
    return normalizeForComparison(mediaType) === 'AUDIOBOOK';
}

/** Check if a media type represents a TV channel. */
export function isTvChannel(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'TVCHANNEL';
}

/** Check if a media type is a Kavita book-family type (book, manga, or comic). */
export function isBookMediaType(
    mediaType: RawMediaTypeComparatorInput | undefined | null,
): boolean {
    const normalized = normalizeForComparison(mediaType);
    return normalized === 'BOOK' || normalized === 'MANGA' || normalized === 'COMIC';
}

/** Check if a media type represents home video content. */
export function isHomeVideo(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'HOME_VIDEO';
}

/** Check if a media type represents training content. */
export function isTraining(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'TRAINING';
}

/** Check if a media type represents educational content. */
export function isEducational(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'EDUCATIONAL';
}

/** Check if a media type represents personal/uncategorized content. */
export function isPersonal(mediaType: RawMediaTypeComparatorInput | undefined | null): boolean {
    return normalizeForComparison(mediaType) === 'PERSONAL';
}

/** Check if a media type is a non-entertainment type (no provider matching). */
export function isNonEntertainment(
    mediaType: RawMediaTypeComparatorInput | undefined | null,
): boolean {
    return (
        isHomeVideo(mediaType) ||
        isTraining(mediaType) ||
        isEducational(mediaType) ||
        isPersonal(mediaType)
    );
}

/** Library category — entertainment types that use provider matching. */
export const ENTERTAINMENT_LIBRARY_TYPES = ['movie', 'tv', 'anime', 'music', 'audiobook'] as const;

/** Library category — non-entertainment types that skip provider matching. */
export const NON_ENTERTAINMENT_LIBRARY_TYPES = [
    'home_video',
    'training',
    'educational',
    'personal',
    'product',
] as const;

/** All valid library path media types. */
export const ALL_LIBRARY_TYPES = [
    ...ENTERTAINMENT_LIBRARY_TYPES,
    ...NON_ENTERTAINMENT_LIBRARY_TYPES,
] as const;

/**
 * `ENTERTAINMENT_LIBRARY_TYPES` / `NON_ENTERTAINMENT_LIBRARY_TYPES` above are
 * **library-path** categories, not `media_items.media_type` values (note
 * `'anime'`, which is a library label folded onto `'tv'` by
 * `toInternalMediaType`). Do not use them as a media-type vocabulary — use
 * `INTERNAL_MEDIA_TYPES` / `isProviderMatchable()` from `./media-type-domain`.
 *
 * ---
 *
 * The three converters that used to close this file are GONE. Their
 * replacements live in `./media-type-domain` and all return `| null`:
 *
 * | removed                      | use instead              | why |
 * | ---------------------------- | ------------------------ | --- |
 * | `toImageMediaType(x)`        | `toTmdbType(x)`          | It was a verbatim alias of `toTmdbType`; two names for one projection hid that image paths and API endpoints share the failure mode. |
 * | `toPublicMovieOrSeries(x)`   | `toMovieOrSeries(x)`     | `isSeries(x) ? 'series' : 'movie'` answered `'movie'` for audiobooks, tracks, channels and home videos — the original production bug, across 28 call sites. |
 * | `toPublicDetailType(x)`      | `toDetailMediaType(x)`   | Built on `toPublicMovieOrSeries`, so it inherited the same clamp for every type outside {movie, series, audiobook}. |
 *
 * On `null`, drop the item rather than substituting: a card the client cannot
 * open is worse than no card.
 */
