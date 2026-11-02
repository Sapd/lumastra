// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Modal utilities for consistent modal opening across components
 */

import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { pickVariant } from '$lib/utils/image-utils';
import { browser } from '$app/environment';
import { modals } from '$lib/stores/modal.store';
import {
    imageFromIds,
    getCatalogPosterUrl,
    createPlaceholderDataUrl,
} from '$lib/utils/image-utils';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';
import type { ExternalIds } from '$lib/types/api-common';
import { buildMediaKey, hasValidExternalId } from '$lib/utils/media-id-helpers';
import {
    getExternalIdFor,
    createExternalIds,
    getPreferredExternalId,
    hasAnyExternalId,
    getLegacyJellyfinId,
    withoutLegacyJellyfinId,
} from '$lib/utils/external-ids';
import { canRequestMedia, getRequestFailureMessage } from '$lib/utils/request-utils';
import { buildEpisodeSlug, buildTitleSlug, slugKindForMediaType } from '$lib/utils/url-slugs';
import { fetchTmdbDetails } from '$lib/utils/modal-data';
import type { ContextSimilarItem } from '$lib/schemas/api-media-context-response';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import { isRecord } from '$lib/utils/data-extraction';
import { isSeries, isEpisode, isSeason, isAudiobook } from '$lib/shared/media-types';
import {
    resolveMediaAvailability,
    resolveMediaRequestability,
} from '$lib/shared/media-availability.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import * as contentApi from '$lib/api/content';

import { getModalComponent } from '$lib/stores/modal-registry.store';
import { bumpModalLoading, dropModalLoading } from '$lib/stores/modal-loading.store';
import type { RatingBundle } from '$lib/schemas/modal-props';
import { UUID_RE, UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
import type { z } from 'zod';
import type { PersonCreditsSchema } from '$lib/schemas/api-person-responses';

/**
 * UI element ID prefixes that should NOT be treated as real media IDs.
 * These are synthetic IDs created for Svelte {#each} keys.
 */
const UI_ELEMENT_PREFIXES = [
    'tmdb-',
    'binge-',
    'fresh-',
    'anime-',
    'short-',
    'fulfilled-',
    'similar-',
    'hero-',
    'trending-',
    'popular-',
];

/**
 * Returns false for synthetic UI element IDs (e.g. 'tmdb-123', 'binge-456').
 * These are Svelte {#each} keys, not real media IDs.
 */
export function isValidMediaId(id: string | undefined | null): boolean {
    if (!id) return false;
    return !UI_ELEMENT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Open a detail modal for a similar-item card.
 * Enriches data via the provider-agnostic media endpoint (UUID-first, composite-key fallback).
 * Falls back to the item's existing data on error.
 */
export async function openSimilarItemModal(item: UniversalMediaItem): Promise<void> {
    // `originalMovie` is now a ContextSimilarItem (new contract):
    // `type` discriminator (not `mediaType`), `ids` map (not `externalIds`)
    const originalMovie = item.clickData?.originalMovie as ContextSimilarItem | undefined;
    if (!originalMovie) return;

    const isTv = isSeries(originalMovie.type);
    // `ids` is the new open external-ID map; cast for downstream helpers
    const externalIds = originalMovie.ids as Record<string, string | undefined>;
    // Prefer images{} href; fall back to legacy helper
    const imageUrl =
        pickVariant(originalMovie.images?.poster, 'card') ??
        imageFromIds(externalIds, 'poster', isTv ? 'tv' : 'movie', { size: 'card' }) ??
        '';

    bumpModalLoading();
    try {
        const details = externalIds
            ? await fetchTmdbDetails(externalIds, isTv ? 'tv' : 'movie')
            : null;

        const mediaData = details
            ? {
                  ...details,
                  isAvailable: resolveMediaAvailability(details, originalMovie),
                  canRequest: resolveMediaRequestability(details, originalMovie),
              }
            : {
                  externalIds,
                  mediaType: isTv ? 'tv' : 'movie',
                  title: originalMovie.title,
                  isAvailable: resolveMediaAvailability(originalMovie),
                  availabilitySource: originalMovie.isAvailable ? 'lumastra' : undefined,
                  canRequest: resolveMediaRequestability(originalMovie),
              };

        openMediaModal(mediaData, imageUrl);
    } catch (error) {
        console.error(
            '[modal-utils] Failed to enrich similar item, opening with existing data:',
            error,
        );
        // Fall back to data already present on the item
        openMediaModal(
            {
                externalIds,
                mediaType: isTv ? 'tv' : 'movie',
                title: originalMovie.title,
                isAvailable: resolveMediaAvailability(originalMovie),
                canRequest: resolveMediaRequestability(originalMovie),
            },
            imageUrl,
        );
    } finally {
        dropModalLoading();
    }
}

/**
 * Open the "similar movies" modal from a similar-item card's "more" action.
 */
export function openSimilarItemMoreModal(item: UniversalMediaItem): void {
    // `originalMovie` is now a ContextSimilarItem (new contract): `type` + `ids`
    const originalMovie = item.clickData?.originalMovie as ContextSimilarItem | undefined;
    // `ids` is the new open external-ID map; fall back to item.externalIds for legacy callers
    const externalIds =
        (originalMovie?.ids as Record<string, string | undefined>) ?? item.externalIds;
    const name = originalMovie?.title || item.title;
    // `type` is the new canonical discriminant; map to legacy 'movie'|'tv' for the modal
    const mediaType = originalMovie?.type
        ? isSeries(originalMovie.type)
            ? 'tv'
            : 'movie'
        : item.mediaType;
    if (!hasValidExternalId(externalIds)) return;
    openSimilarMoviesModal({ externalIds, name, mediaType }, [], true);
}

const getResponseData = <T>(value: unknown): T | null => {
    if (isRecord(value) && 'data' in value) {
        const data = value.data;
        if (isRecord(data) || Array.isArray(data)) {
            return data as T;
        }
        return null;
    }
    if (isRecord(value) || Array.isArray(value)) {
        return value as T;
    }
    return null;
};

/**
 * Response from /api/media/[id] endpoint (new contract)
 * Note: The server now returns `type` (not `mediaType`) and `ids` (not `externalIds`).
 * Legacy fields are kept optional for any residual callers while migration completes.
 */
interface MediaDetailResponse {
    // New contract fields (canonical)
    /** Canonical media type discriminant (replaces legacy `mediaType`) */
    type?: 'movie' | 'series' | 'season' | 'episode' | 'track' | 'album' | 'artist' | 'audiobook';
    /** Open external-ID map (replaces legacy `externalIds`) */
    ids?: Record<string, string>;
    // Legacy field aliases — kept for gradual migration
    /** @deprecated Use `type` instead */
    mediaType?: 'movie' | 'tv' | 'episode' | 'season' | 'audiobook';
    /** @deprecated Use `ids` instead */
    externalIds?: ExternalIds;
    // Shared fields
    id?: string;
    title?: string;
    originalTitle?: string;
    englishTitle?: string;
    overview?: string;
    year?: number;
    rating?: number;
    genres?: string[];
    actors?: Array<
        string | { name: string; character?: string; personId?: string | null; profileUrl?: string }
    >;
    directors?: string[];
    isAvailable?: boolean;
    canRequest?: boolean;
    availability?: {
        isAvailable?: boolean;
        canRequest?: boolean;
        hasFile?: boolean;
        hasFiles?: boolean;
        has_files?: boolean;
    };
    /**
     * Rich detail fields (genres/cast/ratings/runtime) — only present on a
     * movie/series node when the request passes `?include=details`
     * (MediaNodeDetailsSchema). Absent by default; the flat fields above/below
     * (`genres`, `actors`, `directors`, `ratings`, `rating`) are legacy
     * fallbacks the current API no longer populates at the top level.
     */
    credits?: z.infer<typeof PersonCreditsSchema>;
    details?: {
        genres?: string[];
        /** ActorSchema — objects with character/profile info */
        actors?: Array<{ name: string; character?: string; images?: ImageSet }>;
        /** DirectorSchema — objects; map to names for the string[] modal fields */
        directors?: Array<{ name: string; job?: string; images?: ImageSet }>;
        ratings?: Record<string, number>;
        rating?: number;
        runtime?: number;
    };
    /** Owning series' internal UUID (episode/season media only). */
    seriesId?: string;
    // All ratings keyed by source name (from buildRatingsMap)
    ratings?: Record<string, number>;
    // Episode context (when resolved from episode → series)
    seasonNumber?: number;
    episodeNumber?: number;
    // Legacy TMDB fields (for backwards compatibility)
    name?: string;
    first_air_date?: string;
    release_date?: string;
    vote_average?: number;
    is_available?: boolean;
}

// Internal type for series modal data building
// Supports multiple property formats from different sources (local library, TMDB, our app)
interface SeriesModalData {
    // IDs - provider-agnostic
    id?: string;
    Id?: string; // PascalCase (legacy API format)
    externalIds?: ExternalIds;
    sonarrSeriesId?: number;
    ProviderIds?: { Tmdb?: string; Imdb?: string; Tvdb?: string };

    // Names
    title?: string;
    Name?: string; // PascalCase (legacy API format)

    // Descriptions
    overview?: string;
    Overview?: string; // PascalCase (legacy API format)

    // Dates/Year
    year?: number | string;
    Year?: number;
    PremiereDate?: string;

    // Ratings
    rating?: number;
    CommunityRating?: number;
    criticRating?: number;
    CriticRating?: number;

    // Genres
    genres?: string[];
    Genres?: string[];

    // Series info
    ChildCount?: number;
    seasonCount?: number;
    seriesChildCount?: number;

    // Type & availability
    mediaType?: string;
    isAvailable?: boolean;
    canRequest?: boolean;

    // Cast & crew
    actors?: string[];
    directors?: string[];

    // MDBList ratings
    letterboxd_rating?: number;
    rt_rating?: number;
    rt_audience_score?: number;
    mdblist_score?: number;
    trakt_score?: number;
    metacritic_score?: number;
    mal_score?: number;

    // Duration & runtime
    duration?: number;
    RunTimeTicks?: number;

    // Studio
    studio?: string;
    Studios?: Array<{ Name?: string }>;

    // Trailers
    remoteTrailers?: string;
    RemoteTrailers?: Array<{ Url?: string }>;
}

// Similar movie type for modal
interface SimilarMovieItem {
    externalIds?: ExternalIds;
    name?: string;
    title?: string;
    overview?: string;
    vote_average?: number;
    poster_path?: string;
}

/**
 * Get modal state from URL
 * Returns externalIds and mediaType
 *
 * URL formats:
 * - UUID: ?modal=a3f5e8c7-1234-5678-90ab-cdef12345678
 * - Composite: ?modal=tmdb:550:movie
 */
export function getModalFromUrl(): {
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
} | null {
    if (!browser) return null;

    const url = new URL(window.location.href);
    const modalParam = url.searchParams.get('modal');
    if (!modalParam) return null;

    // Check if it's a UUID (internal ID)
    if (UUID_RE_LOOSE.test(modalParam)) {
        return {
            externalIds: { internal: modalParam },
            mediaType: 'movie', // Default, will be resolved from API
        };
    }

    // Parse composite key (e.g., tmdb:550:movie)
    const keyParts = modalParam.split(':');
    if (keyParts.length === 3) {
        const [provider, id, type] = keyParts;
        const validProviders = ['internal', 'tmdb', 'imdb', 'tvdb', 'trakt', 'mal', 'jellyfin'];
        const validTypes = ['movie', 'tv'];

        if (validProviders.includes(provider) && validTypes.includes(type)) {
            const externalIds: ExternalIds = {
                [provider as keyof ExternalIds]: id,
            };
            return {
                externalIds,
                // `validTypes` above admits exactly these two, so this is a
                // rewrite of the same value rather than a narrowing assertion.
                mediaType: type === 'tv' ? 'tv' : 'movie',
            };
        }
    }

    return null;
}

/**
 * Get actor modal state from URL
 */
export function getActorFromUrl(): {
    actorId: number | string;
    actorName?: string;
} | null {
    if (!browser) return null;

    const url = new URL(window.location.href);
    const actorId = url.searchParams.get('actor');
    const actorName = url.searchParams.get('actorName');

    if (actorId && /^(?:tmdb:)?[0-9]+$/.test(actorId)) {
        return {
            actorId,
            actorName: actorName || undefined,
        };
    }

    return null;
}

/**
 * Open media modal from URL parameters by fetching media data
 * @param urlSeasonNumber - Season number from URL (preserved for back-navigation)
 * @param urlEpisodeNumber - Episode number from URL (preserved for back-navigation)
 */
export async function openMediaModalFromUrl(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
    urlSeasonNumber?: number,
    urlEpisodeNumber?: number,
): Promise<boolean> {
    bumpModalLoading();
    try {
        // Fetch movie/show details from our provider-agnostic API
        // Note: mediaType is just a hint for composite keys (e.g., tmdb:123:movie)
        // For UUIDs, the API will return the correct media type
        // A legacy `?modal=jellyfin:<id>:<type>` deep link (older shares and
        // bookmarks): the server maps a Jellyfin item id to the internal item
        // through the database, so the bare id is the key. It maps to nothing
        // on a standalone install and the modal simply does not open.
        const legacyJellyfinId = getLegacyJellyfinId(externalIds);
        const mediaKey =
            buildMediaKey(externalIds, mediaType) ??
            (legacyJellyfinId && UUID_RE_LOOSE.test(legacyJellyfinId) ? legacyJellyfinId : null);
        if (!mediaKey) {
            console.warn('[ModalUtils] Could not build media key for modal:', externalIds);
            return false;
        }
        // Rich details and credits are included by default.
        const { data: apiData, error: apiError } = await contentApi.getMediaDetails(mediaKey);
        if (apiError || !apiData) {
            console.warn('[ModalUtils] Failed to fetch media data for modal:', externalIds);
            return false;
        }

        const data = getResponseData<MediaDetailResponse>(apiData);

        if (!data) {
            return false;
        }

        // If the API returned an episode or season (no usable series context on
        // its own), resolve to the parent series via multi-stage lookup.
        // Episodes/seasons need series context (seasons picker, play button)
        // to display properly in modals.
        // `type` is the new canonical discriminant; fall back to legacy `mediaType`
        const resolvedMediaType = data.type ?? data.mediaType;
        const isEpisodeData = isEpisode(resolvedMediaType);
        const isSeasonData = isSeason(resolvedMediaType);
        // `ids` is the new open external-ID map; fall back to legacy `externalIds`
        const resolvedIds = (data.ids ?? data.externalIds) as ExternalIds | undefined;
        if (isEpisodeData || isSeasonData) {
            const requestedSeason = urlSeasonNumber ?? data.seasonNumber;
            const requestedEpisode = urlEpisodeNumber ?? data.episodeNumber;
            const requestedDifferentEpisode =
                isEpisodeData &&
                urlSeasonNumber != null &&
                urlEpisodeNumber != null &&
                data.seasonNumber != null &&
                data.episodeNumber != null &&
                (urlSeasonNumber !== data.seasonNumber || urlEpisodeNumber !== data.episodeNumber);

            if (requestedDifferentEpisode) {
                const requested = `S${String(urlSeasonNumber).padStart(2, '0')}E${String(urlEpisodeNumber).padStart(2, '0')}`;
                toasts.info(m.toast_different_episode_opened({ episode: requested }), 6000);
            }

            await openSeriesModalFromEpisode({
                seriesName: data.title || data.name,
                // Pass the API-reported seriesId (the parent series' internal
                // UUID, distinct from ids.jellyfin/ids.internal which are the
                // episode/season's own IDs). This lets the series-modal opener
                // short-circuit the multi-stage name-based lookup via Stage 0.
                seriesInternalId: data.seriesId,
                externalIds: resolvedIds,
                seasonNumber: requestedSeason,
                episodeNumber: requestedEpisode,
            });

            if (browser) {
                const topModal = modals.stack[modals.stack.length - 1];
                const topProps = topModal?.props as
                    | {
                          externalIds?: ExternalIds;
                          title?: string;
                          mediaType?: string;
                      }
                    | undefined;
                const topExternalIds = topProps?.externalIds;
                const topMediaType = topProps?.mediaType;
                const seriesKey =
                    topExternalIds && topMediaType
                        ? buildMediaKey(topExternalIds, topMediaType)
                        : null;

                if (seriesKey) {
                    const url = new URL(window.location.href);
                    url.searchParams.set('modal', seriesKey);
                    if (requestedSeason != null) {
                        url.searchParams.set('season', String(requestedSeason));
                    } else {
                        url.searchParams.delete('season');
                    }
                    if (requestedEpisode != null) {
                        url.searchParams.set('episode', String(requestedEpisode));
                    } else {
                        url.searchParams.delete('episode');
                    }
                    const slug =
                        requestedSeason != null && requestedEpisode != null && topProps?.title
                            ? buildEpisodeSlug(topProps.title, requestedSeason, requestedEpisode)
                            : buildTitleSlug('tv', topProps?.title);
                    if (slug) {
                        url.searchParams.set('slug', slug);
                    } else {
                        url.searchParams.delete('slug');
                    }
                    // URL-only canonicalization must retain SvelteKit's navigation indexes.
                    window.history.replaceState(window.history.state, '', url.toString());
                }
            }
            return true;
        }

        // Merge externalIds from response with provided ones. Prefer the
        // canonical `ids` map (`resolvedIds`, computed above) over the legacy
        // `externalIds` field — the API no longer populates `externalIds`, so
        // reading it here silently dropped every provider id (tmdb/imdb/
        // jellyfin) except whatever internal UUID was already in the URL.
        // hasValidExternalId() requires a real provider/jellyfin id, so this
        // was hiding the rating/watchlist/request actions entirely.
        // Never carry a legacy Jellyfin id into the modal.
        const mergedExternalIds: ExternalIds = withoutLegacyJellyfinId({
            ...externalIds,
            ...resolvedIds,
        });

        // IMPORTANT: Use the ACTUAL media type from API response, not the parameter
        // The parameter is just a hint/default - UUIDs don't encode media type
        // This prevents TMDB ID collision bugs (e.g., ID 1429 = movie "25th Hour" vs series "Attack on Titan")
        // `resolvedMediaType` reads the canonical `type` field first — the
        // legacy `mediaType` field is no longer sent by the API and was always
        // undefined here, silently defaulting every series to 'movie'.
        const actualMediaType: 'movie' | 'tv' = isSeries(resolvedMediaType) ? 'tv' : 'movie';

        /**
         * The type handed to the MODAL must be the real one.
         *
         * `actualMediaType` deliberately stays `'movie' | 'tv'` — it is the image
         * lookup / series hint and is fed to `isSeries()` below. But passing it as
         * the modal's `mediaType` collapses `'audiobook'` to `'movie'`, and
         * `ModalMovie` gates BOTH the Listen button and the audiobook detail block
         * on `isAudiobook(mediaType)`. So a deep link — a shared URL, or just F5
         * with the modal open, since `modal-url-sync` always writes `?modal=` —
         * silently turned a book into a movie: "Watch Movie" and "Mark Movie as
         * watched" instead of Listen, and no author/narrator/chapters.
         */
        const modalMediaType: 'movie' | 'tv' | 'audiobook' = isAudiobook(resolvedMediaType)
            ? 'audiobook'
            : actualMediaType;

        // Canonicalize the modal URL to use the internal UUID.
        // If the URL had a Jellyfin hex ID or other non-UUID format,
        // silently replace it so the URL always shows the canonical UUID.
        if (browser && mergedExternalIds.internal) {
            const url = new URL(window.location.href);
            const currentModal = url.searchParams.get('modal');
            const season = actualMediaType === 'tv' ? urlSeasonNumber : undefined;
            const episode = actualMediaType === 'tv' ? urlEpisodeNumber : undefined;
            // Slug "kind" is cosmetic (the modal itself resolves from the
            // `modal=<uuid>` param, never from `slug`), but it should still
            // reflect the real media type rather than collapsing every
            // non-TV type to 'movie'. `actualMediaType` itself stays
            // 'movie' | 'tv' (used for image lookups and
            // gating above) — check the raw `resolvedMediaType` for
            // audiobook so e.g. an audiobook doesn't end up with a
            // `slug=movie-...` URL.
            const slugKind =
                actualMediaType === 'tv' ? 'tv' : slugKindForMediaType(resolvedMediaType);
            const slug =
                actualMediaType === 'tv' &&
                season != null &&
                episode != null &&
                (data.title || data.name)
                    ? buildEpisodeSlug(data.title || data.name, season, episode)
                    : buildTitleSlug(slugKind, data.title || data.name);

            if (currentModal && currentModal !== mergedExternalIds.internal) {
                url.searchParams.set('modal', mergedExternalIds.internal);
            }
            if (actualMediaType === 'tv' && season != null && episode != null) {
                url.searchParams.set('season', String(season));
                url.searchParams.set('episode', String(episode));
            } else {
                url.searchParams.delete('season');
                url.searchParams.delete('episode');
            }
            if (slug) {
                url.searchParams.set('slug', slug);
            } else {
                url.searchParams.delete('slug');
            }
            // Keep router metadata and unrelated application state on this history entry.
            window.history.replaceState(window.history.state, '', url.toString());
        }

        // Open the modal with fetched data - use provider-agnostic image URL with CORRECT media type
        const imageUrl =
            imageFromIds(mergedExternalIds, 'poster', actualMediaType, { size: 'card' }) || '';

        // Year: prefer our API format (number), fall back to legacy date strings
        let mediaYear = '';
        if (data.year) {
            mediaYear = String(data.year);
        } else {
            const yearSource = data.release_date || data.first_air_date || '';
            if (typeof yearSource === 'string' && yearSource.length >= 4) {
                mediaYear = yearSource.substring(0, 4);
            }
        }

        // Genres: rich detail fields are nested under `data.details` (only
        // present with ?include=details); fall back to the legacy flat field.
        const genres = Array.isArray(data.details?.genres)
            ? data.details.genres
            : Array.isArray(data.genres)
              ? data.genres
              : [];

        // Use our API's availability info
        const isAvailable = resolveMediaAvailability(data);
        const canRequest = resolveMediaRequestability(data);

        openMediaModal(
            {
                // Provider-agnostic external IDs (merged)
                externalIds: mergedExternalIds,
                title: data.title || data.name,
                overview: data.overview,
                // Use ACTUAL media type from API response
                mediaType: modalMediaType,
                year: mediaYear,
                rating: data.details?.rating ?? data.rating ?? data.vote_average,
                genres,
                isAvailable,
                canRequest,
                // Episode context: auto-select season/episode when resolved from episode URL
                // Fall back to URL params (preserved from back-navigation)
                seasonNumber: data.seasonNumber ?? urlSeasonNumber,
                episodeNumber: data.episodeNumber ?? urlEpisodeNumber,
                // Cast and crew (nested under `details` — see genres above)
                actors: data.credits?.cast.map(({ person, character }) => ({
                    name: person.name,
                    character,
                    personId: person.id,
                    profileUrl: person.images?.primary?.href,
                })),
                directors: data.credits?.crew
                    .filter((credit) => credit.job === 'Director')
                    .map((credit) => credit.person.name),
                // Extended ratings from nested ratings map
                rt_critic: (data.details?.ratings ?? data.ratings)?.rtCritic,
                rt_audience: (data.details?.ratings ?? data.ratings)?.rtAudience,
                letterboxd_rating: (data.details?.ratings ?? data.ratings)?.letterboxd,
                letterboxd_votes: undefined,
                mdblist_score: (data.details?.ratings ?? data.ratings)?.mdblist,
                metacritic_score: (data.details?.ratings ?? data.ratings)?.metacritic,
                trakt_score: (data.details?.ratings ?? data.ratings)?.trakt,
            },
            imageUrl,
        );

        return true;
    } catch (error) {
        console.error('[ModalUtils] Error opening modal from URL:', error);
        return false;
    } finally {
        dropModalLoading();
    }
}

/**
 * Open actor modal from URL parameters
 */
export function openActorModalFromUrl(
    actorId: number | string,
    actorName?: string,
): { id: string; closed: Promise<void> } {
    return openActorModal(actorId, actorName || m.modal_loading());
}

/**
 * TMDB Genre ID to Name mapping (combined movies and TV)
 */
const TMDB_GENRE_MAP: Record<number, string> = {
    // Movie genres
    28: m.genre_action(),
    12: m.genre_adventure(),
    16: m.genre_animation(),
    35: m.genre_comedy(),
    80: m.genre_crime(),
    99: m.genre_documentary(),
    18: m.genre_drama(),
    10751: m.genre_family(),
    14: m.genre_fantasy(),
    36: m.genre_history(),
    27: m.genre_horror(),
    10402: m.genre_music(),
    9648: m.genre_mystery(),
    10749: m.genre_romance(),
    878: m.genre_science_fiction(),
    10770: m.genre_tv_movie(),
    53: m.genre_thriller(),
    10752: m.genre_war(),
    37: m.genre_western(),
    // TV genres (additional)
    10759: m.genre_action_adventure(),
    10762: m.genre_kids(),
    10763: m.genre_news(),
    10764: m.genre_reality(),
    10765: m.genre_scifi_fantasy(),
    10766: m.genre_soap(),
    10767: m.genre_talk(),
    10768: m.genre_war_politics(),
};

/**
 * Convert genre ID to name, or return the string if already a name
 */
function convertGenre(genre: string | number): string {
    if (typeof genre === 'number') {
        if (Number.isNaN(genre)) return '';
        return TMDB_GENRE_MAP[genre] || String(genre);
    }
    // If it's a string that looks like a number, try to convert it
    const numericGenre = parseInt(genre, 10);
    if (!Number.isNaN(numericGenre) && TMDB_GENRE_MAP[numericGenre]) {
        return TMDB_GENRE_MAP[numericGenre];
    }
    return genre;
}

/**
 * Media item interface for modal opening
 */
export interface MediaItem {
    title?: string;
    matchedTitle?: string;
    overview?: string;
    /** External IDs from various providers */
    externalIds?: ExternalIds;
    mediaType?: 'movie' | 'tv' | 'episode' | 'audiobook' | 'sonarr' | 'radarr' | string;
    rating?: number;
    /** TMDB vote count backing `rating`, when the source has resolved one (see pickDisplayRating). */
    voteCount?: number;
    year?: string | number;
    genres?: number[] | string[];
    /** Internal UUID of the parent series. */
    seriesInternalId?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeNumberEnd?: number;
    sonarrAbsoluteEpisode?: number;
    sonarrSeriesId?: number;
    sonarrNetwork?: string;
    sonarrQuality?: string;
    sonarrHasFile?: boolean;
    sonarrAirDate?: string;
    remoteTrailers?: string;
    duration?: number;
    studio?: string;
    author?: string;
    imageBackdropId?: string;
    canRequest?: boolean;
    isAvailable?: boolean;
    // Cast and crew - actors can be simple strings or objects with character info (or mixed)
    actors?: Array<
        string | { name: string; character?: string; personId?: string | null; profileUrl?: string }
    >;
    directors?: string[];
    // Additional ratings (snake_case for backwards compat with existing callers)
    rt_critic?: number;
    rt_audience?: number;
    letterboxd_rating?: number;
    letterboxd_votes?: number;
    trakt_score?: number;
    metacritic_score?: number;
    mdblist_score?: number;
    // camelCase aliases (preferred, normalized at openMediaModal boundary)
    rtCritic?: number;
    rtAudience?: number;
    letterboxdRating?: number;
    letterboxdVotes?: number;
    traktScore?: number;
    metacriticScore?: number;
    mdblistScore?: number;
    criticRating?: number;
    availabilitySource?: string;
    // Non-entertainment custom metadata
    customMetadata?: Record<string, unknown>;
    // Kavita deep link (book/manga/comic rows — external, not catalog-backed)
    kavitaSeriesId?: string;
    kavitaLibraryId?: number;
}

/**
 * Opens a movie/TV show modal using the ModalMovie component
 *
 * CAMELCASE NORMALIZATION BOUNDARY (DL-005):
 * Accepts MediaItem with both snake_case and camelCase rating fields.
 * Normalizes all to camelCase before passing to ModalMovie.
 *
 * @param media - Media item to display
 * @param imageUrl - URL to the poster image
 *
 * @example
 * const imageUrl = imageFromIds(movie.externalIds, 'poster', 'movie') ?? '';
 * openMediaModal(movie, imageUrl);
 */
/**
 * Stable trail key for a media entity (see the modal "trail" model).
 *
 * Episodes and seasons of a series all share the SERIES key so browsing within
 * a title swaps the card in place rather than stacking. Movies and top-level
 * series key on their own media identity. Returns null when nothing identifies
 * the media (the modal then behaves like a plain, non-trail open).
 */
export function trailKeyForMedia(
    externalIds: ExternalIds | undefined,
    mediaType: string | undefined,
    seriesInternalId?: string,
): string | null {
    const type = mediaType ?? '';

    // Episodes/seasons anchor on their parent series so every card within a
    // title shares one key. A series card anchors on its OWN identity — which,
    // for a library series, is the same bare id the episodes carry as
    // seriesInternalId (mirrors modal-url-sync's series-id unification), so the
    // series card and its episodes collapse onto a single `series:` key.
    if (isEpisode(type) || isSeason(type)) {
        return seriesInternalId ? `series:${seriesInternalId}` : null;
    }
    if (isSeries(type)) {
        const seriesId = seriesInternalId || buildMediaKey(externalIds ?? {}, 'tv');
        return seriesId ? `series:${seriesId}` : null;
    }

    const key = buildMediaKey(externalIds ?? {}, 'movie');
    return key ? `media:${key}` : null;
}

export function openMediaModal(
    media: MediaItem,
    imageUrl?: string,
    options?: {
        playlistContext?: { playlistId: number; position: number };
        /**
         * When true, opens an episode modal directly without rerouting to the
         * parent series modal. Used by in-modal "show episode details" flows
         * (e.g. ModalMovie's split-view picker → handleSplitShowEpisodeDetails)
         * where the user is already in a series modal and wants a quick
         * episode-detail sub-modal on top.
         *
         * For all external episode card clicks (UpcomingEpisodes, Continue
         * Watching, Search results, etc.), this stays false — episodes
         * always reroute to the parent series modal so users get a
         * consistent experience (seasons picker, play button) regardless
         * of whether the caller happened to include seriesInternalId.
         */
        subModal?: boolean;
    },
): { id: string; closed: Promise<void> } {
    // Episode payloads always reroute to the parent series modal (where the
    // user gets seasons picker, play button, and series-level metadata) —
    // unless the caller explicitly opts in to a sub-modal. Without this rule,
    // identical user actions (clicking an episode card) would produce
    // different modal layouts depending on whether the upstream payload
    // happened to include seriesInternalId.
    if (isEpisode(media.mediaType) && !options?.subModal) {
        openSeriesModalFromEpisode({
            seriesInternalId: media.seriesInternalId,
            seriesName: media.seriesName ?? media.title,
            externalIds: media.externalIds,
            seasonNumber: media.seasonNumber,
            episodeNumber: media.episodeNumber,
        }).catch((e) => {
            console.error(
                '[openMediaModal] Episode reroute to openSeriesModalFromEpisode failed',
                e,
            );
        });
        return { id: '', closed: Promise.resolve() };
    }

    const mediaType = (media.mediaType || 'movie').toUpperCase();

    // Build externalIds from media item
    const externalIds: ExternalIds = {
        ...(media.externalIds || {}),
    };

    // Normalize snake_case rating fields to camelCase at boundary (DL-005)
    const {
        rtCritic,
        rtAudience,
        letterboxdRating,
        letterboxdVotes,
        traktScore,
        metacriticScore,
        mdblistScore,
    } = normalizeRatingFields(media);

    const genres = (media.genres || []).map(convertGenre).filter(Boolean);

    // Trail model: same-entity opens (series ↔ its seasons/episodes) swap in
    // place; a different entity pushes a new trail step. This replaces the old
    // episode-only `useReplace` guard so the series→first-episode transition
    // also swaps instead of stacking.
    const trailKey = trailKeyForMedia(externalIds, media.mediaType, media.seriesInternalId);
    const trailLabel = media.seriesName || media.title || m.modal_unknown_title();

    return modals.openEntity(
        getModalComponent('movie'),
        {
            title: media.title || m.modal_unknown_title(),
            matchedTitle: media.matchedTitle,
            body: media.overview || '',
            image: imageUrl ?? '',
            mediaType,
            // Provider-agnostic external IDs
            externalIds,
            year: media.year || '',
            rating: media.rating || 0,
            criticRating: media.criticRating,
            genres,
            seriesInternalId: media.seriesInternalId,
            // Series/Episode info
            seriesName: media.seriesName,
            seasonNumber: media.seasonNumber,
            episodeNumber: media.episodeNumber,
            episodeNumberEnd: media.episodeNumberEnd,
            sonarrAbsoluteEpisode: media.sonarrAbsoluteEpisode,
            sonarrSeriesId: media.sonarrSeriesId,
            // Sonarr info
            sonarrNetwork: media.sonarrNetwork,
            sonarrQuality: media.sonarrQuality,
            sonarrHasFile: media.sonarrHasFile,
            sonarrAirDate: media.sonarrAirDate,
            // Other info
            remoteTrailers: media.remoteTrailers,
            duration: media.duration,
            studio: media.studio,
            author: media.author,
            imageBackdropId: media.imageBackdropId,
            canRequest: media.canRequest,
            isAvailable: media.isAvailable,
            availabilitySource: media.availabilitySource,
            // Cast and crew
            actors: media.actors,
            directors: media.directors,
            // Non-entertainment custom metadata
            customMetadata: media.customMetadata,
            // Kavita deep link (book/manga/comic)
            kavitaSeriesId: media.kavitaSeriesId,
            kavitaLibraryId: media.kavitaLibraryId,
            // Additional ratings (normalized to camelCase, bundled as RatingBundle)
            ratings: {
                rtCritic,
                rtAudience,
                letterboxdRating,
                letterboxdVotes,
                traktScore,
                metacriticScore,
                mdblistScore,
            } satisfies RatingBundle,
            // Playlist context for play-from-playlist navigation
            ...(options?.playlistContext && {
                playlistContext: options.playlistContext,
            }),
        },
        { trailKey: trailKey ?? undefined, trailLabel, backdropClosesTrail: true },
    );
}

/**
 * Opens a similar movies modal
 * @param sourceMedia - Media item to find similar items for
 * @param similarMovies - List of similar movies (optional, will show loading state if not provided)
 *
 * @example
 * openSimilarMoviesModal(movie, similarMoviesList);
 */
export function openSimilarMoviesModal(
    sourceMedia: {
        /** External IDs */
        externalIds?: ExternalIds;
        name?: string;
        title?: string;
        type?: string;
        mediaType?: string;
    },
    similarMovies?: SimilarMovieItem[],
    loading = false,
): { id: string; closed: Promise<void> } {
    const externalIds: ExternalIds = sourceMedia.externalIds ? { ...sourceMedia.externalIds } : {};

    const name = sourceMedia.name || sourceMedia.title;
    const mediaType = sourceMedia.type || sourceMedia.mediaType;

    return modals.open(getModalComponent('similarMovies'), {
        sourceMedia: {
            externalIds,
            name,
            type: isSeries(mediaType) ? 'tv' : 'movie',
        },
        similar: similarMovies || [],
        loading,
    });
}

/**
 * Closes the current modal
 */
export async function closeModal(): Promise<void> {
    await modals.close();
}

/**
 * Extracts ExternalIds from a SeriesModalData-like object.
 * Prefers typed `externalIds`; falls back to PascalCase ProviderIds format.
 */
function extractExternalIdsFromSeriesData(data: {
    externalIds?: ExternalIds;
    ProviderIds?: { Tmdb?: string; Imdb?: string; Tvdb?: string };
}): ExternalIds | undefined {
    if (data.externalIds) {
        return data.externalIds;
    }
    if (data.ProviderIds) {
        return createExternalIds({
            tmdb: data.ProviderIds.Tmdb,
            imdb: data.ProviderIds.Imdb,
            tvdb: data.ProviderIds.Tvdb,
        });
    }
    return undefined;
}

/**
 * Normalizes snake_case rating fields to camelCase at the openMediaModal boundary (DL-005).
 * Reads camelCase first (preferred), falls back to snake_case.
 */
function normalizeRatingFields(
    source: Pick<
        MediaItem,
        | 'rtCritic'
        | 'rt_critic'
        | 'rtAudience'
        | 'rt_audience'
        | 'letterboxdRating'
        | 'letterboxd_rating'
        | 'letterboxdVotes'
        | 'letterboxd_votes'
        | 'traktScore'
        | 'trakt_score'
        | 'metacriticScore'
        | 'metacritic_score'
        | 'mdblistScore'
        | 'mdblist_score'
    >,
): {
    rtCritic: number | undefined;
    rtAudience: number | undefined;
    letterboxdRating: number | undefined;
    letterboxdVotes: number | undefined;
    traktScore: number | undefined;
    metacriticScore: number | undefined;
    mdblistScore: number | undefined;
} {
    return {
        rtCritic: source.rtCritic ?? source.rt_critic ?? undefined,
        rtAudience: source.rtAudience ?? source.rt_audience ?? undefined,
        letterboxdRating: source.letterboxdRating ?? source.letterboxd_rating ?? undefined,
        letterboxdVotes: source.letterboxdVotes ?? source.letterboxd_votes ?? undefined,
        traktScore: source.traktScore ?? source.trakt_score ?? undefined,
        metacriticScore: source.metacriticScore ?? source.metacritic_score ?? undefined,
        mdblistScore: source.mdblistScore ?? source.mdblist_score ?? undefined,
    };
}

/**
 * Stage 1: Search for series in AI database by name
 * Returns series data from our AI database if found. The match is identified
 * by its internal UUID (`externalIds.internal`).
 */
async function findSeriesInDatabase(seriesName: string): Promise<{
    seriesData: SeriesModalData | null;
    externalIds?: ExternalIds;
}> {
    if (!seriesName || seriesName === m.modal_unknown_series()) {
        return { seriesData: null };
    }

    try {
        const { data: searchResult, error: searchError } = await contentApi.search(seriesName, {
            types: 'series',
            limit: 10,
        });
        if (searchError || !searchResult) {
            return { seriesData: null };
        }

        // v1 contract: { items, page }. Each item is a V1SearchResultItem
        // (type ∈ movie|series|episode|track|album|artist, with an open `ids{}`
        // map and no flat externalIds/rating). Keep only series items.
        const items = (searchResult.items ?? []).filter((item) => item.type === 'series');

        // Find the best match (case-insensitive exact match or first result)
        const searchLower = seriesName.toLowerCase().trim();
        const exactMatch = items.find(
            (item) =>
                typeof item.title === 'string' && item.title.toLowerCase().trim() === searchLower,
        );
        const match = exactMatch || items[0];

        if (!match) {
            return { seriesData: null };
        }

        console.log('[openSeriesModalFromEpisode] Found series in AI database:', match.title);

        // The canonical id is the internal UUID; carry it under `internal` so
        // downstream image/detail lookups work.
        const matchExternalIds: ExternalIds = {
            ...(match.ids as ExternalIds),
            internal: match.ids?.internal ?? match.id,
        };

        return {
            seriesData: {
                title: match.title,
                overview: match.overview || '',
                mediaType: 'tv',
                year: match.year,
                rating: 0,
                externalIds: matchExternalIds,
                isAvailable: resolveMediaAvailability(match),
                canRequest: resolveMediaRequestability(match),
            },
            externalIds: matchExternalIds,
        };
    } catch (error) {
        console.error('Failed to search series in AI database:', error);
        return { seriesData: null };
    }
}

/**
 * Stage 2: Search for series by name
 * Returns series data from search results
 */
async function searchSeriesByName(seriesName: string): Promise<{
    seriesData: SeriesModalData | null;
    externalIds?: ExternalIds;
}> {
    if (!seriesName || seriesName === m.modal_unknown_series()) {
        return { seriesData: null };
    }

    try {
        const { data: searchResult, error: searchError } =
            await contentApi.searchSeries(seriesName);
        if (searchError || !searchResult) {
            return { seriesData: null };
        }

        const data = getResponseData<SeriesModalData>(searchResult);
        if (!data) {
            return { seriesData: null };
        }

        // data.id is the internal UUID (UUID-first); carry it under `internal`
        // unless the result's own id map already names it.
        const extracted = extractExternalIdsFromSeriesData(data);
        const internalId =
            extracted?.internal ?? (data.id && UUID_RE.test(data.id) ? data.id : undefined);
        const externalIds: ExternalIds | undefined = internalId
            ? { ...extracted, internal: internalId }
            : extracted;

        return {
            seriesData: data,
            externalIds,
        };
    } catch (error) {
        console.error('Failed to search series by name:', error);
        return { seriesData: null };
    }
}

/**
 * Stage 3: Enrich series data with provider metadata (TMDB/MDBList)
 * Returns enriched series data if external IDs are available
 */
async function enrichWithProviderData(
    externalIds: ExternalIds,
    existingData?: SeriesModalData,
): Promise<SeriesModalData | null> {
    if (!hasValidExternalId(externalIds)) {
        return null;
    }

    if (existingData && existingData.overview) {
        // Already have sufficient data
        return null;
    }

    try {
        const enrichMediaKey = buildMediaKey(externalIds, 'tv');
        const enrichResult = enrichMediaKey
            ? await contentApi.getMediaDetails(enrichMediaKey)
            : null;

        if (!enrichResult || enrichResult.error || !enrichResult.data) {
            return null;
        }

        const enrichedData = getResponseData<MediaDetailResponse>(enrichResult.data);
        if (!enrichedData) {
            return null;
        }

        console.log(
            '[openSeriesModalFromEpisode] Enriched with media data:',
            enrichedData.name || enrichedData.title,
        );

        // Genres/cast/rating are nested under `details` (only present with
        // ?include=details); fall back to the legacy flat fields.
        const rawGenres = enrichedData.details?.genres ?? enrichedData.genres;
        const genreStrings: string[] = Array.isArray(rawGenres)
            ? rawGenres.map((g) => (typeof g === 'string' ? g : ''))
            : [];
        const enrichedRating = enrichedData.details?.rating ?? enrichedData.rating;
        const enrichedActors = enrichedData.credits?.cast.map(({ person, character }) => ({
            name: person.name,
            character,
            personId: person.id,
            profileUrl: person.images?.primary?.href,
        }));
        const enrichedDirectors = enrichedData.credits?.crew
            .filter((credit) => credit.job === 'Director')
            .map((credit) => credit.person.name);
        const firstAirDate =
            typeof enrichedData.first_air_date === 'string' ? enrichedData.first_air_date : '';

        return {
            ...existingData,
            title: existingData?.title || enrichedData.name || enrichedData.title,
            overview: existingData?.overview || enrichedData.overview,
            year:
                existingData?.year ||
                (enrichedData.year ? String(enrichedData.year) : firstAirDate.substring(0, 4)),
            rating: existingData?.rating || enrichedRating || enrichedData.vote_average || 0,
            genres: existingData?.genres || genreStrings,
            externalIds,
            mediaType: 'tv',
            actors:
                existingData?.actors ||
                enrichedActors?.slice(0, 10).map((a) => (typeof a === 'string' ? a : a.name)) ||
                [],
            directors: existingData?.directors || enrichedDirectors || [],
            isAvailable: resolveMediaAvailability(enrichedData, existingData),
            canRequest: resolveMediaRequestability(enrichedData, existingData),
        };
    } catch (error) {
        console.error('Failed to fetch enriched media data:', error);
        return null;
    }
}

/**
 * Opens the parent series modal from an episode
 * Fetches series data and opens a new modal replacing the current one
 * @param episodeData - Current episode data containing series info
 */
export async function openSeriesModalFromEpisode(episodeData: {
    seriesName?: string;
    /** Internal UUID of the parent series. */
    seriesInternalId?: string;
    sonarrSeriesId?: number;
    /** External IDs */
    externalIds?: ExternalIds;
    seasonNumber?: number;
    episodeNumber?: number;
}): Promise<void> {
    bumpModalLoading();
    try {
        await openSeriesModalFromEpisodeInner(episodeData);
    } finally {
        dropModalLoading();
    }
}

async function openSeriesModalFromEpisodeInner(episodeData: {
    seriesName?: string;
    seriesInternalId?: string;
    sonarrSeriesId?: number;
    externalIds?: ExternalIds;
    seasonNumber?: number;
    episodeNumber?: number;
}): Promise<void> {
    const seriesName = episodeData.seriesName || m.modal_unknown_series();
    const sonarrSeriesId = episodeData.sonarrSeriesId;

    let externalIds: ExternalIds = episodeData.externalIds ? { ...episodeData.externalIds } : {};

    let seriesData: SeriesModalData | null = null;
    let imageUrl = '';
    // Internal UUID of the SERIES once something resolved it. `externalIds`
    // starts out as the EPISODE's ids, so its `internal` is not trustworthy
    // until a lookup has overwritten it.
    let resolvedSeriesId: string | undefined;
    // False once Stage 0 proved the caller's UUID is NOT a series. A failed or
    // empty lookup (network error, timeout) leaves it true, and the caller's id
    // is then still the best series id we have.
    // Only a dashed media_items UUID is an internal id; a dashless (Jellyfin-
    // style) id is never kept as one.
    let callerSeriesIdUsable =
        !!episodeData.seriesInternalId && UUID_RE.test(episodeData.seriesInternalId);

    // Stage 0: UUID short-circuit. If caller passes the series UUID directly, skip
    // the multi-stage name lookup and fetch series details by UUID. An explicit
    // series UUID is always more trustworthy than a fuzzy name search: a caller
    // that knew the series but only had the EPISODE title as a name (e.g. an
    // active-stream "Die Brigade" session) would otherwise fuzzy-match an
    // unrelated series ("Galaxy Angel") while episodes still loaded from the
    // correct series — a mismatched modal.
    if (episodeData.seriesInternalId) {
        try {
            const { data: result, error } = await contentApi.getMediaDetails(
                episodeData.seriesInternalId,
            );
            if (!error && result) {
                const detail = getResponseData<MediaDetailResponse>(result);
                // Only treat as series if the UUID actually resolved to one. A
                // mistakenly-passed movie/episode/season UUID would otherwise be
                // rendered as a series — wrong picker, wrong queries. The
                // `/api/media/{id}` response always sets `type` on success (the
                // server maps `media_type` to `type` or returns null entirely),
                // so a missing `type` here is treated as "not confirmed series"
                // rather than defaulted to series — falls through to the
                // name-based lookup instead.
                // `type` is the new canonical discriminant; fall back to `mediaType`
                const detailType = detail?.type ?? detail?.mediaType;
                // `ids` is the new open ID map; fall back to `externalIds`
                const detailIds = detail?.ids ?? detail?.externalIds;
                // The record answered and is not a confirmed series (typed or
                // untyped): the caller's id is wrong, not just unreachable.
                if (detail && !(detailType && isSeries(detailType))) {
                    callerSeriesIdUsable = false;
                }
                if (detail && detailType && isSeries(detailType)) {
                    // Merge UUID into externalIds so downstream rendering uses it
                    externalIds = {
                        ...externalIds,
                        ...detailIds,
                        internal: episodeData.seriesInternalId,
                    };
                    resolvedSeriesId = episodeData.seriesInternalId;
                    seriesData = {
                        // Fall back to the caller-supplied seriesName so the title bar
                        // is never blank when the API record is missing both fields.
                        title: detail.title || detail.name || seriesName,
                        overview: detail.overview,
                        mediaType: 'tv',
                        year:
                            detail.year != null
                                ? String(detail.year)
                                : typeof detail.first_air_date === 'string'
                                  ? detail.first_air_date.substring(0, 4)
                                  : undefined,
                        rating: detail.details?.rating ?? detail.rating ?? detail.vote_average,
                        genres: Array.isArray(detail.details?.genres)
                            ? detail.details.genres
                            : Array.isArray(detail.genres)
                              ? detail.genres
                              : [],
                        externalIds,
                        actors: detail.credits?.cast
                            .map(({ person, character }) => ({
                                name: person.name,
                                character,
                                personId: person.id,
                                profileUrl: person.images?.primary?.href,
                            }))
                            ?.map((a) => (typeof a === 'string' ? a : a.name)),
                        directors: detail.credits?.crew
                            .filter((credit) => credit.job === 'Director')
                            .map((credit) => credit.person.name),
                        isAvailable: resolveMediaAvailability(detail),
                        canRequest: resolveMediaRequestability(detail),
                    };
                } else if (detail && detailType) {
                    console.warn(
                        '[openSeriesModalFromEpisode] UUID short-circuit: provided UUID resolved to non-series mediaType; falling back to name-based lookup',
                        {
                            uuid: episodeData.seriesInternalId,
                            mediaType: detailType,
                        },
                    );
                }
            }
        } catch (e) {
            console.warn(
                '[openSeriesModalFromEpisode] UUID short-circuit failed, falling back to name-based lookup',
                e,
            );
        }
        if (!seriesData) {
            console.warn(
                '[openSeriesModalFromEpisode] UUID short-circuit yielded no series data; falling back to name-based lookup',
                { uuid: episodeData.seriesInternalId },
            );
        }
    }

    // Stage 1: DB-first name search (only when no UUID resolved)
    if (!seriesData) {
        const dbResult = await findSeriesInDatabase(seriesName);
        if (dbResult.seriesData) {
            seriesData = dbResult.seriesData;
            if (dbResult.externalIds) {
                externalIds = { ...externalIds, ...dbResult.externalIds };
                resolvedSeriesId = getExternalIdFor(dbResult.externalIds, 'internal') || undefined;
            }
        }
    }

    // Stage 2: Search series by name
    if (!seriesData) {
        const searchResult = await searchSeriesByName(seriesName);
        if (searchResult.seriesData) {
            seriesData = searchResult.seriesData;
            if (searchResult.externalIds) {
                externalIds = { ...externalIds, ...searchResult.externalIds };
                resolvedSeriesId =
                    getExternalIdFor(searchResult.externalIds, 'internal') || undefined;
            }
        }
    }

    // Nothing resolved, but the caller named the series and nothing disproved
    // it: keep its id, or the modal would key on the episode's own UUID.
    if (!resolvedSeriesId && callerSeriesIdUsable) {
        resolvedSeriesId = episodeData.seriesInternalId;
    }
    // `externalIds` was seeded with the episode's ids; its `internal` must be
    // the series UUID once we know it, and must not survive as the episode's
    // UUID when we don't (poster, availability and the modal would key on it).
    if (resolvedSeriesId) {
        externalIds = { ...externalIds, internal: resolvedSeriesId };
    } else if (getExternalIdFor(externalIds, 'internal')) {
        externalIds = Object.fromEntries(
            Object.entries(externalIds).filter(([provider]) => provider !== 'internal'),
        ) as typeof externalIds;
    }

    // Set image URL using the catalog proxy if we have an internal UUID
    const internalUuid = getExternalIdFor(externalIds, 'internal');
    if (internalUuid) {
        imageUrl = getCatalogPosterUrl(internalUuid, { size: 'card' });
    }

    // Stage 3: Provider enrichment
    const enrichedData = await enrichWithProviderData(externalIds, seriesData ?? undefined);
    if (enrichedData) {
        seriesData = {
            ...enrichedData,
            isAvailable: resolveMediaAvailability(enrichedData, seriesData),
            canRequest: resolveMediaRequestability(enrichedData, seriesData),
        };
        if (!imageUrl) {
            const catalogId = getExternalIdFor(externalIds, 'internal');
            if (catalogId) {
                imageUrl = getCatalogPosterUrl(catalogId, { size: 'card' });
            } else if (hasValidExternalId(externalIds)) {
                imageUrl = imageFromIds(externalIds, 'poster', 'tv', { size: 'card' }) || '';
            }
        }
    }

    // Create minimal series data if we still don't have any
    if (!seriesData) {
        seriesData = {
            title: seriesName,
            mediaType: 'tv',
            sonarrSeriesId,
            externalIds,
        };
        toasts.warning(m.toast_series_details_not_loaded({ title: seriesName }));
    }

    // Determine image URL with fallbacks
    if (!imageUrl) {
        const finalCatalogId = getExternalIdFor(externalIds, 'internal');
        if (finalCatalogId) {
            imageUrl = getCatalogPosterUrl(finalCatalogId, { size: 'card' });
        } else if (hasValidExternalId(externalIds)) {
            imageUrl = imageFromIds(externalIds, 'poster', 'tv', { size: 'card' }) || '';
        } else if (sonarrSeriesId) {
            imageUrl = `/api/image/sonarr/${sonarrSeriesId}/poster`;
        }
    }

    // Last resort: generate a placeholder image
    if (!imageUrl) {
        imageUrl = createPlaceholderDataUrl(
            250,
            375,
            seriesName?.substring(0, 20) || m.modal_placeholder_series(),
        );
    }

    // Trail key so in-modal episode clicks (which key on the same series) swap
    // this series card in place instead of stacking a new modal on top.
    const seriesTrailKey = trailKeyForMedia(externalIds, 'tv', resolvedSeriesId);

    // Open the series modal via the trail model: going "up to series" from an
    // episode of the SAME series (same trail key) swaps the card in place — no
    // remount, so the backdrop stays put and the page doesn't flicker. From an
    // episode card elsewhere (empty/other stack) it opens fresh.
    modals.openEntity(
        getModalComponent('movie'),
        {
            title: seriesData.title || seriesData.Name || seriesName,
            body: seriesData.overview || seriesData.Overview || '',
            image: imageUrl,
            mediaType: 'tv',
            externalIds,
            year:
                seriesData.year ||
                seriesData.Year ||
                seriesData.PremiereDate?.substring(0, 4) ||
                '',
            rating: seriesData.rating || seriesData.CommunityRating || 0,
            criticRating: seriesData.criticRating || seriesData.CriticRating,
            genres: seriesData.genres || seriesData.Genres || [],
            seriesInternalId: resolvedSeriesId,
            sonarrSeriesId: sonarrSeriesId,
            seriesChildCount:
                seriesData.ChildCount || seriesData.seasonCount || seriesData.seriesChildCount,
            remoteTrailers: seriesData.remoteTrailers || seriesData.RemoteTrailers?.[0]?.Url,
            duration:
                seriesData.duration ||
                (seriesData.RunTimeTicks
                    ? Math.round(seriesData.RunTimeTicks / 10000000)
                    : undefined),
            studio: seriesData.studio || seriesData.Studios?.[0]?.Name,
            actors: seriesData.actors,
            directors: seriesData.directors,
            canRequest: resolveMediaRequestability(seriesData),
            isAvailable: resolveMediaAvailability(seriesData),
            initialSeason: episodeData.seasonNumber,
            initialEpisode: episodeData.episodeNumber,
        },
        {
            trailKey: seriesTrailKey ?? undefined,
            trailLabel: seriesName,
            backdropClosesTrail: true,
        },
    );
}

/**
 * Opens an actor modal showing details and filmography
 * @param actorId - TMDB person ID
 * @param actorName - Actor's name (for display while loading)
 *
 * @example
 * openActorModal(287, 'Brad Pitt');
 */
export function openActorModal(
    actorId: number | string,
    actorName: string,
): { id: string; closed: Promise<void> } {
    // Validate actorId
    if (!actorId || (typeof actorId === 'number' && actorId <= 0)) {
        console.error('[openActorModal] Invalid actorId:', actorId, 'for actor:', actorName);
        throw new Error('Invalid actorId');
    }

    return modals.openEntity(
        getModalComponent('actor'),
        {
            actorId,
            actorName,
        },
        { trailKey: `actor:${actorId}`, trailLabel: actorName, backdropClosesTrail: true },
    );
}

/**
 * Open the album detail modal
 */
export function openAlbumModal(
    albumId: string,
    options?: {
        onAdd?: (item: Record<string, unknown>) => void;
        sonicEnabled?: boolean;
        highlightTrackId?: string;
    },
): { id: string; closed: Promise<void> } {
    if (!albumId) {
        console.error('[openAlbumModal] Invalid albumId:', albumId);
        return { id: '', closed: Promise.resolve() };
    }
    return modals.openEntity(
        getModalComponent('album'),
        {
            albumId,
            onAdd: options?.onAdd,
            sonicEnabled: options?.sonicEnabled ?? false,
            highlightTrackId: options?.highlightTrackId,
        },
        { kind: 'music', trailKey: `album:${albumId}` },
    );
}

/**
 * Tracks with an album resolution currently in flight. Unlike the synchronous
 * modal opens (where the freshly-pushed backdrop swallows a double-click's
 * second click), openAlbumForTrack may spend a few hundred ms in the
 * track-detail fetch with the card still clickable — without this guard a
 * fast double-click stacks two identical album modals.
 */
const albumForTrackInFlight = new Set<string>();

/**
 * Open the album modal FOR a music track — the "click a track card's poster"
 * navigation. Resolves the parent album from `albumId` when the caller
 * already has it (card `clickData`), otherwise via one track-detail fetch,
 * and highlights + scrolls to the track inside the tracklist.
 *
 * Tracks without a parent album (loose files) fall back to the caller's
 * `fallback` — typically "just play it", preserving the old behavior.
 */
export async function openAlbumForTrack(
    trackId: string,
    options?: {
        albumId?: string;
        sonicEnabled?: boolean;
        fallback?: () => void;
    },
): Promise<void> {
    if (albumForTrackInFlight.has(trackId)) return;
    albumForTrackInFlight.add(trackId);
    try {
        let albumId = options?.albumId;
        if (!albumId) {
            try {
                const { getTrack } = await import('$lib/api/music');
                const { data } = await getTrack(trackId);
                albumId = data?.track.album?.id;
            } catch {
                // Resolution failed — fall through to the fallback below.
            }
        }
        if (!albumId) {
            options?.fallback?.();
            return;
        }
        openAlbumModal(albumId, {
            sonicEnabled: options?.sonicEnabled,
            highlightTrackId: trackId,
        });
    } finally {
        albumForTrackInFlight.delete(trackId);
    }
}

/**
 * Open the artist detail modal
 */
export function openArtistModal(
    artistId: string,
    options?: { sonicEnabled?: boolean },
): {
    id: string;
    closed: Promise<void>;
} {
    if (!artistId) {
        console.error('[openArtistModal] Invalid artistId:', artistId);
        return { id: '', closed: Promise.resolve() };
    }
    return modals.openEntity(
        getModalComponent('artist'),
        {
            artistId,
            sonicEnabled: options?.sonicEnabled ?? false,
        },
        { kind: 'music', trailKey: `artist:${artistId}` },
    );
}

/**
 * Open the similar tracks modal for a music track.
 *
 * @param trackId     - Internal UUID of the track.
 * @param sonicEnabled - When true the modal uses MSCLAP cosine similarity and
 *   shows a "% match" badge. Pass `$page.data?.features?.sonicEmbeddings === true`.
 */
export function openSimilarTracksModal(
    trackId: string,
    sonicEnabled = false,
): {
    id: string;
    closed: Promise<void>;
} {
    if (!trackId) {
        console.error('[openSimilarTracksModal] Invalid trackId:', trackId);
        return { id: '', closed: Promise.resolve() };
    }
    // Dynamically import to avoid circular deps and keep the music modal
    // out of the main bundle for non-music pages.
    const openAsync = async (): Promise<void> => {
        const { default: SimilarTracksModal } =
            await import('$lib/components/music/SimilarTracksModal.svelte');
        modals.open(SimilarTracksModal, { trackId, sonicEnabled }, { kind: 'music' });
    };
    void openAsync();
    return { id: '', closed: Promise.resolve() };
}

/**
 * Go back to the previous modal in the stack
 * @returns true if navigated back, false if no previous modal
 */
export async function goBackModal(): Promise<boolean> {
    if (modals.count > 1) {
        await modals.close();
        return true;
    }
    return false;
}

/**
 * Media request parameters
 */
export interface RequestMediaParams {
    /** External IDs from various providers */
    externalIds?: ExternalIds;
    mediaType?: string;
    type?: string;
    title?: string;
    name?: string;
    posterPath?: string;
    image?: string;
    year?: string;
    overview?: string;
    /** For TV shows: specific seasons to request */
    seasons?: number[];
}

/**
 * Opens a request modal for Jellyseerr requests
 * @param media - Media item with external IDs and type
 *
 * @example
 * openRequestModal({
 *   externalIds: { tmdb: '12345' },
 *   mediaType: 'movie',
 *   title: 'Daydream',
 *   posterPath: '/poster.jpg',
 *   year: '2010'
 * });
 */
export function openRequestModal(media: RequestMediaParams): {
    id: string;
    closed: Promise<void>;
} {
    const externalIds = media.externalIds || {};
    const rawType = media.mediaType || media.type || 'movie';
    // Emit canonical 'series' (not legacy 'tv') — RequestModal.Props expects
    // 'movie'|'series'.
    //
    // `null` means the caller passed something that is not a requestable
    // catalog entity. Requests only exist for movies and series (Radarr /
    // Sonarr / Jellyseerr have no notion of requesting an audiobook, a track or
    // an episode), so a null here is a CALLER bug, not a case to model — the
    // request-capable surfaces only ever open this modal for movie/series
    // cards. It is logged rather than silently coerced, because the old
    // `toPublicMovieOrSeries` clamp made exactly this mistake invisible.
    const narrowedType = toMovieOrSeries(rawType);
    if (narrowedType === null) {
        console.warn(
            '[openRequestModal] media type is not requestable, defaulting to movie:',
            rawType,
        );
    }
    const mediaType = narrowedType ?? 'movie';
    const title = media.title || media.name || m.modal_unknown_title();
    const posterPath = media.posterPath || media.image || null;
    const year = media.year || '';
    const overview = media.overview || '';
    const seasons = media.seasons;

    // A request needs a provider id; the internal UUID alone cannot be requested.
    if (!hasAnyExternalId(externalIds)) {
        console.error('[openRequestModal] No valid external ID provided for media:', media);
        throw new Error('No valid external ID provided');
    }

    return modals.open(getModalComponent('request'), {
        externalIds,
        mediaType,
        title,
        posterPath,
        year,
        overview,
        seasons,
    });
}

/**
 * Handles media request action - opens modal if enabled and user has permission,
 * otherwise opens external Jellyseerr URL or shows nothing if no permission.
 *
 * @param media - Media item with TMDB ID and type
 * @param requestsEnabled - Whether the internal request modal feature is enabled
 * @param requestUrl - External Jellyseerr URL (used when requestsEnabled is false)
 * @param hasRequestPermission - Whether the user has permission to make requests (default: true)
 *
 * @example
 * // In a Svelte component:
 * import { handleRequestAction } from '$lib/utils/modal-utils';
 * import { page } from '$app/stores';
 * import { env } from '$env/dynamic/public';
 *
 * $: requestsEnabled = $page.data?.features?.requests === true;
 * $: hasRequestPermission = $page.data?.user?.hasRequestPermission !== false;
 * const requestUrl = env.PUBLIC_REQUESTURL || '';
 *
 * function onRequest(item) {
 *   handleRequestAction(item, requestsEnabled, requestUrl, hasRequestPermission);
 * }
 */
export function handleRequestAction(
    media: RequestMediaParams,
    requestsEnabled: boolean,
    requestUrl: string,
    hasRequestPermission: boolean = true,
): void {
    // Check permission first
    if (!hasRequestPermission) {
        console.debug('[handleRequestAction] User does not have request permission');
        if (browser) {
            toasts.info('Requests are not available for your account');
        }
        return;
    }

    const externalIds = media.externalIds || {};
    const rawType = media.mediaType || media.type || 'movie';
    const mediaType = isSeries(rawType) ? 'tv' : 'movie';

    // Validate using centralized request validation logic
    const validation = canRequestMedia(externalIds, requestsEnabled, requestUrl);

    if (!validation.canRequest) {
        if (browser && validation.reason) {
            toasts.info(getRequestFailureMessage(validation.reason));
        }
        if (validation.reason === 'no_external_ids') {
            console.error('[handleRequestAction] No valid external ID provided for media:', media);
        } else {
            console.warn(`[handleRequestAction] Cannot request: ${validation.reason}`, media);
        }
        return;
    }

    // Modal path (provider-agnostic - server resolves any provider to TMDB)
    if (requestsEnabled) {
        // TV shows need season selection first
        if (isSeries(mediaType)) {
            const title = media.title || media.name || m.modal_unknown_title();
            const posterPath = media.posterPath || media.image || undefined;
            modals.open(getModalComponent('seasonSelector'), {
                externalIds,
                title,
                overview: media.overview || '',
                year: media.year || undefined,
                posterPath: externalIds
                    ? imageFromIds(externalIds, 'poster', 'tv', { size: 'card' }) || posterPath
                    : posterPath,
            });
        } else {
            openRequestModal(media);
        }
    }
    // External URL path — server resolves any provider to TMDB via redirect
    else {
        const preferred = getPreferredExternalId(externalIds);
        if (requestUrl && preferred) {
            const compositeKey = `${preferred.provider}:${preferred.id}:${mediaType}`;
            window.open(`/api/request/redirect?id=${encodeURIComponent(compositeKey)}`, '_blank');
        }
    }
}

/**
 * Show confirmation dialog
 * Returns promise that resolves on confirm, rejects on cancel
 */
export function confirmDialog(options: {
    title?: string;
    body: string;
    confirmText?: string;
    cancelText?: string;
    confirmVariant?: 'primary' | 'danger';
}): Promise<void> {
    return new Promise((resolve, reject) => {
        modals.open(getModalComponent('confirm'), {
            title: options.title || m.dialog_confirm_title(),
            body: options.body,
            confirmText: options.confirmText || m.dialog_confirm_button(),
            cancelText: options.cancelText || m.dialog_cancel_button(),
            confirmVariant: options.confirmVariant || 'primary',
            onConfirm: resolve,
            onCancel: reject,
        });
    });
}

/**
 * Coerce a `sonarrSeriesId` to a genuine Sonarr integer, or `undefined`.
 *
 * The field carries two id namespaces under one name: the live Sonarr path
 * emits a real integer, while the DB-backed calendar has always emitted a
 * `media_items` UUID string. Consumers that build `/api/image/sonarr/{id}`
 * need the integer.
 *
 * A bare `Number(x)` is the wrong tool for that: `Number('974d7f8d-…')` is
 * `NaN`, and the usual `x ? Number(x) : undefined` guard does not catch it
 * because the UUID string is truthy. The NaN then reaches the URL as the
 * literal `/api/image/sonarr/NaN/poster`. Returning `undefined` lets callers
 * fall back to a poster source that works instead of requesting a broken one.
 */
export function toSonarrSeriesId(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
    if (typeof value !== 'string' || value === '') return undefined;
    // Reject anything that is not purely digits BEFORE Number(): '12abc' is NaN
    // but ' 12 ' is 12, and a UUID beginning with digits must never sneak through.
    if (!/^\d+$/.test(value.trim())) return undefined;
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : undefined;
}
