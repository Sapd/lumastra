// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared item-handler functions for For-You panel components.
 *
 * Both `WatchingStrip.svelte` and `RecommendationFeed.svelte` need to react
 * to card click / play / request / more interactions in the same way, so
 * the handlers live here as plain functions to keep the components free of
 * duplication. Feature-flag values (`requestsEnabled`, `requestUrl`,
 * `hasRequestPermission`) are passed as plain arguments by each consumer
 * because both already derive them from `$page.data` at the call site.
 */

import { modals } from '$lib/stores/modal.store';
import SimilarMoviesModal from '$lib/components/SimilarMoviesModal.svelte';
import { navigateToWatch } from '$lib/stores/watch-navigation';
import type { WatchEntry } from '$lib/stores/watch-entry';
import { handleRequestAction, openAlbumForTrack, openMediaModal } from '$lib/utils/modal-utils';
import { isEpisode, isMusicType, isAudio, isMusic } from '$lib/shared/media-types';
import { musicPlayerStore } from '$lib/stores/music-player.store';
import { musicTrackFromCard } from '$lib/utils/music-track';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
import { buildMediaKey, hasValidExternalId, getExternalIdFor } from '$lib/utils/media-id-helpers';
import { toTmdbMediaType } from '$lib/shared/media-type-domain';
import type { ApiMediaType } from '$lib/types/api-common';
import * as contentApi from '$lib/api/content';
import { continueTargetFor, resolveMediaPlayTarget } from '$lib/utils/media-play-target';
import {
    resolveMediaAvailability,
    resolveMediaRequestability,
} from '$lib/shared/media-availability.js';
// Static import: WebKit only honours play() inside a trusted user gesture and a
// dynamic import loses it (see ModalActions.svelte).
import { playAudiobook, audiobookStartFailureMessage } from '$lib/services/audiobook-playback';
import { toasts } from '$lib/stores/toast.store';

export function handleNavigateToWatch(mediaKey: string, entry?: WatchEntry): void {
    void navigateToWatch(mediaKey, undefined, { entry });
}

/**
 * The entry a rail card opens with (watch-entry.ts): Continue Watching and
 * Next Up are linear watching; any other rail is a pick.
 */
export function entryForSection(section: PageSection, item: UniversalMediaItem): WatchEntry {
    if (section.type !== 'continue-watching' && section.type !== 'next-up') return 'explicit';
    return (item.progress ?? 0) > 0 ? 'resume' : 'next_up';
}

/**
 * True for any music-hierarchy item (track / album / artist / audio / music).
 * Mirrors `UniversalMediaCard`'s `isMusicItem` so the play + similar handlers
 * agree with the card on what counts as music. A hardcoded `=== 'track'` check
 * misses album/artist cards, which then fall through to video-navigation.
 */
function isMusicItem(item: UniversalMediaItem): boolean {
    return isMusicType(item.mediaType) || isAudio(item.mediaType) || isMusic(item.mediaType);
}

export function playMusicItem(item: UniversalMediaItem): void {
    const internalId = isMusicItem(item) ? item.id : getExternalIdFor(item.externalIds, 'internal');
    if (!internalId) return;
    const isRadio = item.clickData?.isRadio === true;
    const track = musicTrackFromCard({
        id: internalId,
        title: item.title,
        artists: [{ id: null, title: item.subtitle ?? (isRadio ? 'Radio' : 'Unknown Artist') }],
        isRadio,
    });
    musicPlayerStore.play(track);
}

export async function handleItemClick(data: {
    section: PageSection;
    item: UniversalMediaItem;
}): Promise<void> {
    const { item } = data;
    if (item.mediaType === 'track' || item.mediaType === 'music') {
        // Poster/background click = navigate: open the parent album scrolled
        // to this track. Playing stays on the hover ▶ button (handleItemPlay);
        // click-anywhere-plays replaced the queue on any misclick and broke
        // the "card click opens context" rule album/artist cards follow.
        const internalId = isMusicItem(item)
            ? item.id
            : getExternalIdFor(item.externalIds, 'internal');
        if (!internalId) return;
        const clickAlbumId =
            typeof item.clickData?.albumId === 'string' ? item.clickData.albumId : undefined;
        await openAlbumForTrack(internalId, {
            albumId: clickAlbumId,
            fallback: () => playMusicItem(item),
        });
        return;
    }
    const isEpisodeItem = isEpisode(item.mediaType);
    // For episodes, query the series (tv) not the episode
    const queryMediaType = isEpisodeItem ? 'tv' : item.mediaType;

    try {
        // LOCAL CONTENT: Use local media ID as primary source (TMDB enrichment optional)
        const itemInternalId = getExternalIdFor(item.externalIds, 'internal');
        // `||` (not `??`) so empty strings on item.seriesId don't shadow valid fallbacks.
        // The old `item.jellyfinSeriesId` arm is gone: it was derived from a
        // subquery keyed on the same series row that produces `seriesId`, so it
        // could never be set when `seriesId` wasn't — the arm was unreachable.
        // (The local branch used to key on a Jellyfin id as well; the API no
        // longer sends one, so only a series id selects it.)
        if (item.seriesId) {
            const lookupId = isEpisodeItem ? item.seriesId : itemInternalId;

            if (!lookupId) {
                console.warn('[ForYou] Local item missing media ID:', item.title);
                return;
            }

            const { data: details, error: detailsErr } = await contentApi.getMovieDetails(lookupId);

            if (!details || detailsErr) {
                console.warn('[ForYou] Failed to fetch media details');
                return;
            }

            // `ids` is the new open ID map; build ExternalIds-compatible object
            const detailIds = details.ids as Record<string, string | undefined> | undefined;
            // `type` is the new canonical discriminant ('series' not 'tv')
            const resolvedType =
                details.type === 'series' ? 'tv' : (details.type ?? item.mediaType);

            const media = {
                externalIds: detailIds || item.externalIds,
                mediaType: isEpisodeItem ? 'tv' : resolvedType || item.mediaType,
                title: details.title || item.title,
                overview: details.overview || item.overview || '',
                year: (details.year ?? item.year) as string | number | undefined,
                // `MovieDetailsResponse` has no ratings/rating — use item-level rating
                rating: (typeof item.rating === 'number' ? item.rating : 0) as number,
                duration: details.runtimeMinutes ? details.runtimeMinutes * 60 : undefined,
                genres: details.genres || item.genres || [],
                isAvailable: resolveMediaAvailability(details, item),
                canRequest: resolveMediaRequestability(details, item),
                seriesInternalId: item.seriesId,
                seasonNumber: item.seasonNumber,
                episodeNumber: item.episodeNumber,
            };
            openMediaModal(media, item.image ?? '');
            return;
        }

        // EXTERNAL CONTENT: Use UUID-preferred key for /api/media-details endpoint
        const mediaKey = buildMediaKey(item.externalIds, queryMediaType as ApiMediaType);
        if (!mediaKey) {
            console.warn('[ForYou] External item missing external IDs:', item.title);
            return;
        }
        const { data: mediaData } = await contentApi.getMediaDetailsByQuery(mediaKey);
        // `getMediaDetailsByQuery` returns MediaDetailSchema (new contract: type/ids/images{})
        // Fall back to empty object so downstream fields safely produce undefined.
        const details = mediaData ?? ({} as NonNullable<typeof mediaData>);
        // Resolve new canonical discriminant to legacy 'tv' string for modal props
        const detailTypeResolved =
            details.type === 'series' ? 'tv' : (details.type ?? item.mediaType);
        const media = {
            externalIds: (details.ids as Record<string, string | undefined>) || item.externalIds,
            mediaType: isEpisodeItem ? 'tv' : detailTypeResolved || item.mediaType,
            title: details?.title || item.title,
            overview: details?.overview || item.overview || '',
            // `year` lives only on the MovieDetail arm of the MediaDetail
            // discriminated union (TvDetail carries firstAirDate instead), so
            // read it through an optional-shape cast — the same pattern used
            // for `isAvailable`/`canRequest` below — preserving the prior
            // runtime behaviour of reading `.year` unconditionally.
            year: (details as { year?: string | number }).year ?? item.year,
            // `MediaDetailSchema` has no ratings/rating — use item-level values
            rating: (typeof item.rating === 'number' ? item.rating : 0) as number,
            criticRating: item.criticRating,
            rtCritic: item.criticRating,
            rtAudience: item.audienceRating,
            letterboxdRating: item.letterboxdRating,
            metacriticScore: item.metacriticScore,
            traktScore: item.traktScore,
            mdblistScore: item.mdblistScore,
            genres: details.genres || item.genres || [],
            isAvailable: resolveMediaAvailability(details, item),
            canRequest: resolveMediaRequestability(details, item),
            seriesInternalId: item.seriesId,
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
        };
        openMediaModal(media, item.image ?? '');
    } catch (err) {
        console.error('[ForYou] Error fetching media details:', err);
        openMediaModal(
            {
                externalIds: item.externalIds,
                mediaType: isEpisodeItem ? 'tv' : item.mediaType,
                title: item.title,
                overview: item.overview || '',
                isAvailable: resolveMediaAvailability(item),
                canRequest: item.canRequest,
                seriesInternalId: item.seriesId,
                seasonNumber: item.seasonNumber,
                episodeNumber: item.episodeNumber,
            },
            item.image ?? '',
        );
    }
}

/** Internal — used by play and request handlers below. */
function onRequestItem(
    item: UniversalMediaItem,
    requestsEnabled: boolean,
    requestUrl: string,
    hasRequestPermission: boolean,
): void {
    // Validation now in handleRequestAction (provider-agnostic)
    handleRequestAction(
        {
            externalIds: item.externalIds,
            mediaType: item.mediaType,
            title: item.title,
            posterPath: item.image,
            year: String(item.year ?? ''),
        },
        requestsEnabled,
        requestUrl,
        hasRequestPermission,
    );
}

export function handleItemPlay(
    data: { section: PageSection; item: UniversalMediaItem },
    requestsEnabled: boolean,
    requestUrl: string,
    hasRequestPermission: boolean,
): void {
    const { item } = data;
    if (isMusicItem(item)) {
        playMusicItem(item);
        return;
    }
    // An audiobook must never reach the `/watch` branch below: that route is the
    // VIDEO player and hard-404s a book. `getPlayableId()` returns a book's UUID
    // exactly like a movie's, so the branch used to swallow it. Continue
    // Watching / "Continue listening" mixes books in with episodes, so this is
    // the rail where it actually happened. No position is threaded — the server
    // answers with AudiobookShelf's own progress (see resolveMediaPlayTarget).
    const target = resolveMediaPlayTarget(item);
    if (target.kind === 'audiobook') {
        if (!resolveMediaAvailability(item)) return;
        void startAudiobook(target.mediaId);
        return;
    }
    if (target.kind === 'watch' && resolveMediaAvailability(item)) {
        const key =
            continueTargetFor(item) ??
            buildMediaKey(item.externalIds, item.mediaType) ??
            target.playbackId;
        handleNavigateToWatch(key, entryForSection(data.section, item));
    } else if (resolveMediaRequestability(item)) {
        onRequestItem(item, requestsEnabled, requestUrl, hasRequestPermission);
    }
}

/**
 * Start the audiobook player mounted by `+layout.svelte`.
 *
 * The toast is the error surface on purpose: both audiobook player surfaces are
 * gated on `book !== null`, so when the book never opens the store's own error
 * state has nowhere to render. Same shape as `ModalActions.startAudiobook()`.
 */
async function startAudiobook(mediaId: string): Promise<void> {
    const started = await playAudiobook(mediaId);
    if (!started) toasts.error(audiobookStartFailureMessage());
}

export function handleItemRequest(
    data: { section: PageSection; item: UniversalMediaItem },
    requestsEnabled: boolean,
    requestUrl: string,
    hasRequestPermission: boolean,
): void {
    const { item } = data;
    onRequestItem(item, requestsEnabled, requestUrl, hasRequestPermission);
}

export async function handleItemMore(data: {
    section: PageSection;
    item: UniversalMediaItem;
}): Promise<void> {
    const { item } = data;
    // Music items have no movie-similarity concept — the video-similarity
    // modal would return irrelevant or empty results for a music UUID.
    if (isMusicItem(item)) return;
    const normalizedType = toTmdbMediaType(item.mediaType);
    if (normalizedType === null || !hasValidExternalId(item.externalIds)) return;

    modals.open(SimilarMoviesModal, {
        sourceMedia: {
            externalIds: item.externalIds,
            name: item.title,
            type: normalizedType,
        },
        similar: [],
        loading: true,
    });
}
