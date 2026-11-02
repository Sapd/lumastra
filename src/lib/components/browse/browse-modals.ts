// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse Modal Utilities
 *
 * Handles modal opening logic and media details fetching for the browse page.
 * Extracted from browse/+page.svelte for better separation of concerns.
 */

import { openMediaModal, openSimilarMoviesModal } from '$lib/utils/modal-utils';
import { hasValidExternalId, buildMediaKey } from '$lib/utils/media-id-helpers';
import { imageFromIds } from '$lib/utils/image-utils';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { asInternalUuid } from '$lib/utils/id-patterns';
import { toInternalMediaType } from '$lib/shared/media-types';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { navigateToWatch } from '$lib/stores/watch-navigation';
import { resolveMediaPlayTarget } from '$lib/utils/media-play-target';
import { playAudiobook, audiobookStartFailureMessage } from '$lib/services/audiobook-playback';
import { toasts } from '$lib/stores/toast.store';

/**
 * TMDB namespace for a keyword-browse item.
 *
 * `toImageMediaType()` (a verbatim alias of the old total `toTmdbType`) used to
 * live at these call sites and answered 'movie' for anything it did not
 * recognise. The `?? 'movie'` is retained deliberately and is safe HERE, and the
 * claim is schema-enforced rather than asserted: `KeywordBrowseItemSchema`
 * (src/lib/schemas/api-browse-responses.ts:158) declares
 * `type: z.enum(['movie', 'series'])` — required, two members — and the client
 * validates the whole payload against `BrowseKeywordsResponseSchema` before it
 * gets here ($lib/api/browse.ts:48). An 'audiobook' would fail response
 * validation, not fall through to the substitute. This helper exists so that
 * assumption is stated once instead of three times.
 */
function keywordItemTmdbType(type: string | undefined): 'movie' | 'tv' {
    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- validated keyword items are movie/series only.
    return toTmdbType(type) ?? 'movie';
}
import type { ExternalIds, MediaKey } from '$lib/types/api-common';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { MediaDetail } from '$lib/schemas/media-detail';
import * as contentApi from '$lib/api/content';

/** Browse item */
export interface BrowseItem {
    id: string;
    name: string;
    type?: string;
    year?: number;
    overview?: string;
    communityRating?: number;
    imageId?: string;
    externalIds?: ExternalIds;
    isEpisode?: boolean;
    seriesId?: string;
    seriesExternalIds?: ExternalIds;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    genres?: string[];
    /** Internal: direct image URL from API */
    _imageUrl?: string;
}

/** Keyword browse item (from TMDB) */
export interface KeywordBrowseItem {
    name: string;
    type: 'movie' | 'series';
    overview?: string;
    rating?: number;
    year?: number;
    trailerUrl?: string;
    externalIds?: ExternalIds;
    isAvailable?: boolean;
}

/** Media details payload from API (camelCase per DL-005) */
export interface MediaDetailsPayload {
    criticRating?: number;
    rtCritic?: number;
    rtAudience?: number;
    letterboxdRating?: number;
    letterboxdVotes?: number;
    traktScore?: number;
    metacriticScore?: number;
    mdblistScore?: number;
    duration?: number;
    actors?: unknown;
    directors?: unknown;
}

/**
 * Fetch additional media details (ratings, cast, etc.) from API using composite key
 */
export async function fetchMediaDetailsWithKey(key: string): Promise<MediaDetailsPayload> {
    try {
        const { data } = await contentApi.getMediaDetailsByQuery(key);
        const apiData = data as MediaDetail | null;

        if (apiData) {
            const ratings = apiData.ratings;
            const runtime = apiData.type === 'movie' ? apiData.runtime : undefined;

            return {
                criticRating: ratings?.rtCritic,
                rtCritic: ratings?.rtCritic,
                rtAudience: ratings?.rtAudience,
                letterboxdRating: ratings?.letterboxd,
                traktScore: ratings?.trakt,
                metacriticScore: ratings?.metacritic,
                mdblistScore: ratings?.mdblist,
                duration: runtime ? runtime * 60 : undefined,
                actors: apiData.actors,
                directors: apiData.directors,
            };
        }
    } catch (e) {
        console.error('[Browse] Failed to fetch additional ratings:', e);
    }
    return {};
}

/**
 * Open the detail modal for a grid item.
 *
 * The grid's card-click handler, shared by every route that mounts
 * <AzBrowseView> (/browse in A-Z mode and /browse/filter). Deliberately NOT
 * {@link handleCardClick}: that one takes a Jellyfin-shaped `BrowseItem`
 * (`name`/`id`/`isEpisode`) off the rails, not a `UniversalMediaItem`, and would
 * build the wrong payload.
 */
export function openDetailForGridItem(item: UniversalMediaItem): void {
    openMediaModal(
        {
            // `?? undefined` rather than a 'movie' default: for a type the
            // comparator does not recognise, "unknown" is honest and the modal
            // resolves it from the ids, whereas guessing 'movie' would mislabel
            // a series. A no-op while toTmdbType stays total.
            mediaType: toTmdbType(item.mediaType) ?? undefined,
            title: item.title,
            externalIds: item.externalIds,
            overview: item.overview,
            rating: typeof item.rating === 'number' ? item.rating : undefined,
            year: item.year,
        },
        item.image || '',
    );
}

/**
 * Start playback for a grid item, if it has anything playable.
 *
 * Prefers the composite media key so the player resolves the same identity the
 * rest of the app uses, falling back to the raw playable id.
 */
export function playGridItem(item: UniversalMediaItem): void {
    // An audiobook must not reach /watch — that is the video route, and
    // `getPlayableId()` hands a book's id over quite happily, which is exactly how
    // the Continue Watching popup used to send books there. `resolveMediaPlayTarget`
    // owns that decision for every play surface; see its docblock.
    const target = resolveMediaPlayTarget(item);
    if (target.kind === 'audiobook') {
        // No position is threaded, deliberately: the player omits `positionMs` so
        // AudiobookShelf answers with its own saved progress. A caller that passes
        // one can only be wrong here, and would overwrite progress made in the ABS
        // app. See audiobook-player.store.ts.
        void playAudiobook(target.mediaId).then((started) => {
            if (!started) toasts.error(audiobookStartFailureMessage());
        });
        return;
    }
    if (target.kind === 'delegate') return;
    // Video keeps preferring the composite media key so the player resolves the
    // same identity as the rest of the app.
    void navigateToWatch(buildMediaKey(item.externalIds, item.mediaType) ?? target.playbackId);
}

/**
 * Open similar movies modal for a given item
 */
export function openSimilarForItem(item: UniversalMediaItem): void {
    // Need valid external IDs
    if (!hasValidExternalId(item.externalIds)) return;

    // "Similar" is a TMDB query, so the item must HAVE a TMDB namespace.
    // Series/episodes fold onto 'tv' exactly as the old
    // `isSeries || isEpisode ? 'tv' : 'movie'` did; the difference is that a type
    // TMDB does not catalog (audiobook, track, channel) is now `null` instead of
    // being asked for "movies similar to this audiobook".
    const mediaType = toTmdbType(item.mediaType);
    if (mediaType === null) return;

    // Open modal with loading state - modal handles fetching
    openSimilarMoviesModal(
        {
            externalIds: item.externalIds,
            name: item.title,
            mediaType,
        },
        [],
        true,
    );
}

/**
 * Build media data for modal from Jellyfin browse item
 */
export function buildJellyfinMediaData(
    item: BrowseItem,
    additionalDetails?: MediaDetailsPayload,
): Record<string, unknown> {
    // Determine media type - episodes show as 'episode' to trigger season display.
    // `isEpisode` is an independent wire flag and wins. Everything else goes
    // through the domain module: toInternalMediaType reproduces this function's
    // previous output vocabulary EXACTLY ('movie' | 'tv' | 'episode' |
    // 'tvchannel' — note it emits legacy 'tv', which is what the modal expects
    // here) while stopping the old if/else chain from labelling an audiobook, a
    // track or a home video 'movie'. `?? undefined` on an unrecognised type
    // follows openDetailForGridItem above: unknown is honest, the modal resolves
    // the entity from its ids.
    const mediaType =
        item.isEpisode === true ? 'episode' : (toInternalMediaType(item.type) ?? undefined);

    const baseData: Record<string, unknown> = {
        externalIds: { internal: asInternalUuid(item.id), ...item.externalIds },
        mediaType,
        title: item.name,
        overview: item.overview,
        rating: item.communityRating || 0,
        year: item.year,
        isAvailable: true,
        availabilitySource: 'lumastra',
        genres: item.genres,
        // Episode-specific data for showing series seasons
        seriesInternalId: item.seriesId,
        seriesExternalIds: item.seriesExternalIds,
        seriesName: item.seriesName,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
    };

    return additionalDetails ? { ...baseData, ...additionalDetails } : baseData;
}

/**
 * Build media data for modal from keyword (TMDB) browse item
 */
export function buildKeywordMediaData(
    item: KeywordBrowseItem,
    additionalDetails?: MediaDetailsPayload,
): Record<string, unknown> {
    const mediaType = keywordItemTmdbType(item.type);

    const baseData: Record<string, unknown> = {
        externalIds: item.externalIds,
        mediaType,
        title: item.name,
        overview: item.overview,
        rating: item.rating || 0,
        year: item.year,
        isAvailable: item.isAvailable,
        availabilitySource: item.isAvailable ? 'lumastra' : 'tmdb',
        canRequest: !item.isAvailable,
    };

    return additionalDetails ? { ...baseData, ...additionalDetails } : baseData;
}

/**
 * Get image URL for a browse item (provider-agnostic)
 */
export function getItemImageUrl(item: BrowseItem): string {
    const externalIds = {
        ...item.externalIds,
        internal:
            getExternalIdFor(item.externalIds, 'internal') ??
            asInternalUuid(item.imageId || item.id),
    };
    // The internal id takes priority; use the item's TMDB namespace if the
    // image resolver ever has to fall back to an external id.
    return (
        imageFromIds(externalIds, 'poster', toTmdbType(item.type) ?? undefined, {
            size: 'full',
        }) || ''
    );
}

/**
 * Get image URL for keyword item
 */
export function getKeywordItemImageUrl(item: KeywordBrowseItem): string {
    return (
        imageFromIds(item.externalIds, 'poster', keywordItemTmdbType(item.type), {
            size: 'card',
        }) || ''
    );
}

/**
 * Handle click on a Jellyfin browse item - opens modal with details
 */
export async function handleCardClick(item: BrowseItem): Promise<void> {
    const imageUrl = getItemImageUrl(item);

    // Build initial media data
    let mediaData = buildJellyfinMediaData(item);

    // Determine the composite-key media type for the details fetch. This was two
    // stacked collapses — `let mediaType = 'movie'` + `isSeries(mediaType) ||
    // isEpisode(mediaType) ? 'tv' : 'movie'` — whose only distinct outputs were
    // 'tv' and 'movie'. toTmdbType() reproduces them exactly (episode and series
    // both → 'tv') and returns null for a type TMDB has no entity for, in which
    // case there are no external ratings to fetch.
    const apiMediaType = item.isEpisode === true ? 'tv' : toTmdbType(item.type);

    // Fetch additional ratings from media-details API if we have external IDs
    if (apiMediaType && hasValidExternalId(item.externalIds)) {
        const key = buildMediaKey(item.externalIds, apiMediaType);
        if (key) {
            const details = await fetchMediaDetailsWithKey(key);
            mediaData = { ...mediaData, ...details };
        }
    }

    openMediaModal(mediaData, imageUrl);
}

/**
 * Handle click on a keyword (TMDB) browse item - opens modal with details
 */
export async function handleKeywordItemClick(item: KeywordBrowseItem): Promise<void> {
    // Guard: skip opening modal if no valid external IDs
    if (!hasValidExternalId(item.externalIds)) {
        console.warn(
            '[Browse] Keyword item has no valid external IDs, skipping modal open',
            item.name,
        );
        return;
    }

    const imageUrl = getKeywordItemImageUrl(item);
    const apiMediaType = keywordItemTmdbType(item.type);

    // Build initial media data
    let mediaData = buildKeywordMediaData(item);

    // Fetch additional ratings if we have valid external IDs
    if (hasValidExternalId(item.externalIds)) {
        const key = buildMediaKey(item.externalIds, apiMediaType) as MediaKey;
        if (key) {
            const details = await fetchMediaDetailsWithKey(key);
            mediaData = { ...mediaData, ...details };
        }
    }

    openMediaModal(mediaData, imageUrl);
}
