// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-safe media type definitions and utilities (client-side).
 *
 * This module provides type-safe comparison functions for media types
 * that work across different case conventions. All canonical media types
 * are **lowercase** matching the database convention.
 *
 * Usage:
 *   import { isEpisode, isMovie, isSeries } from '$lib/utils/media-types';
 *
 *   // Instead of: session.mediaType === 'episode' (potential case mismatch!)
 *   // Use: isEpisode(session.mediaType)
 */

// =============================================================================
// RE-EXPORT TYPE GUARDS AND CONSTANTS FROM SHARED
// =============================================================================

export {
    UIMediaType,
    type UIMediaTypeValue,
    type TmdbMediaType,
    isEpisode,
    isMovie,
    isSeries,
    isSeason,
    isAudio,
    isMusic,
    isAudiobook,
    isTvChannel,
    normalizeForComparison,
    mediaTypesMatch,
    toTmdbType,
} from '$lib/shared/media-types';

// The conversions themselves live in $lib/shared/media-type-domain — one module,
// one exhaustive table per target vocabulary, every result nullable.
export {
    INTERNAL_MEDIA_TYPES,
    assertNever,
    isInternalMediaType,
    toInternalMediaType,
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
    MediaTypeDetail,
    MediaTypeMovieOrSeries,
    MediaTypeTmdb,
} from '$lib/shared/media-type-domain';

// =============================================================================
// CLIENT-SPECIFIC UTILITIES
// =============================================================================

import * as m from '$lib/paraglide/messages.js';

import { isEpisode } from '$lib/shared/media-types';
import { toInternalMediaType, type MediaTypeInternal } from '$lib/shared/media-type-domain';

/**
 * Human-readable label for a media type, in any input case.
 *
 * Built on an exhaustive table of message functions rather than a
 * `switch` with a `default:` arm: adding a media type is a compile error here
 * until someone writes its label. The old `default: return mediaType` silently
 * showed raw DB tokens like `home_video` in the UI.
 *
 * Functions resolve the current locale at display time. Unrecognised input
 * falls back to the raw string (or a localized unknown label) — that is a
 * DISPLAY fallback for data that never passed validation, not a type narrowing.
 *
 * @example
 *   getMediaTypeDisplay('EPISODE'); // 'Episode'
 *   getMediaTypeDisplay('tv');      // 'Series'
 */
const MEDIA_TYPE_LABELS: Readonly<Record<MediaTypeInternal, () => string>> = {
    movie: () => m.media_plain_type_movie(),
    tv: () => m.media_plain_type_tv(),
    episode: () => m.media_plain_type_episode(),
    season: () => m.media_plain_type_season(),
    extra: () => m.media_plain_type_extra(),
    audiobook: () => m.media_plain_type_audiobook(),
    book: () => m.media_plain_type_book(),
    manga: () => m.media_plain_type_manga(),
    comic: () => m.media_plain_type_comic(),
    podcast: () => m.media_plain_type_podcast(),
    artist: () => m.media_plain_type_artist(),
    album: () => m.media_plain_type_album(),
    track: () => m.media_plain_type_track(),
    audio: () => m.media_plain_type_audio(),
    music: () => m.media_plain_type_music(),
    tvchannel: () => m.media_plain_type_tvchannel(),
    radio: () => m.media_plain_type_radio(),
    home_video: () => m.media_plain_type_home_video(),
    training: () => m.media_plain_type_training(),
    educational: () => m.media_plain_type_educational(),
    personal: () => m.media_plain_type_personal(),
    product: () => m.media_type_product(),
    anfragen: () => m.media_type_anfragen(),
    sonarr: () => m.media_type_sonarr(),
    radarr: () => m.media_type_radarr(),
};

export function getMediaTypeDisplay(mediaType: string | undefined | null): string {
    const internal = toInternalMediaType(mediaType);
    if (internal === null) return mediaType || m.misc_unknown();
    return MEDIA_TYPE_LABELS[internal]();
}

/**
 * TMDB-namespace `'movie' | 'tv'` → the card vocabulary a `UniversalMediaItem`
 * emits (`UniversalMediaType` dropped `'tv'` in favour of `'series'`).
 *
 * Client-side twin of `MOVIE_OR_TV_TO_CARD` in `server/utils/section-builder.ts`
 * — the same table, for the .svelte transformers that build cards in the browser
 * instead of on the server. Deliberately a table over the narrow union rather
 * than `toUniversalMediaType()`: the converter's `null` arm would need a
 * meaningless fallback at every call site, whereas this becomes a compile error
 * if a source type ever widens past `'movie' | 'tv'`.
 *
 * Do NOT feed the result to `mediaCompositeKey()` / `imageFromIds()` / any TMDB
 * URL builder — those interpolate the token verbatim and want the raw `'tv'`.
 * Map at the `mediaType:` field only.
 */
export const MOVIE_OR_TV_TO_CARD: Readonly<Record<'movie' | 'tv', 'movie' | 'series'>> = {
    movie: 'movie',
    tv: 'series',
};

// =============================================================================
// PROVIDER-AGNOSTIC COMPOSITE KEY UTILITIES
// =============================================================================

import type { ExternalIds } from '$lib/types/api-common';
import { getPreferredExternalId } from '$lib/utils/external-ids';

/**
 * Creates a provider-agnostic composite key in format: provider:id:mediaType
 *
 * @example
 *   mediaKey('tmdb', '550', 'movie')     // 'tmdb:550:movie'
 *   mediaKey('imdb', 'tt0137523', 'movie') // 'imdb:tt0137523:movie'
 */
export function mediaKey(provider: string, externalId: string | number, mediaType: string): string {
    return `${provider}:${externalId}:${mediaType}`;
}

/**
 * Parses a composite media key into its components.
 *
 * @example
 *   parseMediaKey('tmdb:550:movie')
 *   // { provider: 'tmdb', externalId: '550', mediaType: 'movie' }
 */
export function parseMediaKey(key: string): {
    provider: string;
    externalId: string;
    mediaType: string;
} | null {
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    return {
        provider: parts[0],
        externalId: parts[1],
        mediaType: parts[2],
    };
}

/**
 * Creates the best composite key from a media item's available identifiers.
 * Prefers UUID if it looks like a UUID, otherwise creates provider:id:mediaType.
 *
 * @example
 *   // With UUID
 *   getMediaKey({ id: '550e8400-...', mediaType: 'movie' })
 *   // Returns: '550e8400-...'
 *
 *   // With externalIds
 *   getMediaKey({ id: 'temp-123', externalIds: { tmdb: '550' }, mediaType: 'movie' })
 *   // Returns: 'tmdb:550:movie'
 */
export function getMediaKey(item: {
    id?: string;
    externalIds: ExternalIds;
    mediaType?: string | undefined | null;
}): string {
    const safeMediaType = item.mediaType || 'movie';

    // If id is a UUID, use it directly (UUIDs are unique)
    if (
        item.id &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
    ) {
        return item.id;
    }

    // Try externalIds in priority order using provider-agnostic helper
    const preferred = getPreferredExternalId(item.externalIds, {
        includeUuids: false,
    });
    if (preferred) {
        return mediaKey(preferred.provider, preferred.id, safeMediaType);
    }

    // Last resort: use the id as-is (could be a composite key already)
    return item.id || `unknown:${Date.now()}:${safeMediaType}`;
}

/**
 * Creates a unique key for episode items including season/episode numbers.
 * Use this for playlist keys where episodes need to be distinguished.
 *
 * @example
 *   getEpisodeKey({ externalIds: { tmdb: '1399' }, mediaType: 'episode', seasonNumber: 1, episodeNumber: 1 })
 *   // Returns: 'tmdb:1399:episode:1:1'
 */
export function getEpisodeKey(item: {
    externalIds: ExternalIds;
    mediaType: string;
    seasonNumber?: number;
    episodeNumber?: number;
}): string {
    // Use provider-agnostic helper to get the best available external ID
    const preferred = getPreferredExternalId(item.externalIds, {
        includeUuids: false,
    });

    if (
        isEpisode(item.mediaType) &&
        item.seasonNumber !== undefined &&
        item.episodeNumber !== undefined &&
        preferred
    ) {
        return `${preferred.provider}:${preferred.id}:episode:${item.seasonNumber}:${item.episodeNumber}`;
    }

    if (preferred) {
        return `${preferred.provider}:${preferred.id}:${item.mediaType}`;
    }

    return `unknown:${Date.now()}:${item.mediaType}`;
}
