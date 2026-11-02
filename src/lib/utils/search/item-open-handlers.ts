// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Item Open Handlers for Search
 *
 * Dispatch map pattern for media type routing in Search.svelte (ref: DL-005).
 * Each media type maps to one exported handler function — independently testable.
 * Adding a new media type requires one new exported function and one map entry.
 *
 * Reactive state: closeSearch closes over Svelte 5 $state signals in Search.svelte.
 * This is safe because Svelte 5 $state is signal-based — the function retains its
 * reactive closure regardless of where it is called (ref: RISK-003).
 */

import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';
import type { ExternalIds } from '$lib/types/api-common';
import { saveReturnPath } from '$lib/stores/playerNavigation';
import { navigateTo } from '$lib/paths';
import {
    openMediaModal,
    openAlbumModal,
    openArtistModal,
    openAlbumForTrack,
} from '$lib/utils/modal-utils';
import { kavitaSeriesUrl } from '$lib/utils/search/media-external-links';
import { getExternalIdFor, hasAnyExternalId } from '$lib/utils/external-ids';
import { imageFromIds } from '$lib/utils/image-utils';
import { isEpisode, isSeries } from '$lib/shared/media-types';
import { resolveMediaPlayTarget } from '$lib/utils/media-play-target';
import { audiobookStartFailureMessage, playAudiobook } from '$lib/services/audiobook-playback';
import { toasts } from '$lib/stores/toast.store';

// =============================================================================
// Helpers Interface
// =============================================================================

/**
 * Callbacks injected into each handler from Search.svelte.
 * Pass closeSearch directly from the component scope — do not wrap or bind it.
 */
export interface ItemOpenHelpers {
    closeSearch: () => void;
}

// =============================================================================
// Individual Handlers
// =============================================================================

export function handleTvChannelOpen(item: UniversalMediaItem, helpers: ItemOpenHelpers): void {
    saveReturnPath();
    // The channel id travels in `externalIds.internal` (the UniversalMediaItem
    // `id` of a search row is prefixed).
    void navigateTo(`/watch/${getExternalIdFor(item.externalIds, 'internal') ?? item.id}`);
    helpers.closeSearch();
}

export function handleAnfragenOpen(item: UniversalMediaItem, _helpers: ItemOpenHelpers): void {
    const requestExternalIds: ExternalIds | undefined = item.externalIds;
    // `requestMediaType` crosses the wire as a plain string (search-item.schemas.ts
    // declares z.string()), so normalise once instead of asserting. isSeries()
    // also catches the canonical 'series', which the `=== 'tv'` check this
    // replaces sent down the movie branch.
    const requestType: 'movie' | 'tv' = isSeries(
        (item.clickData?.requestMediaType as string) || 'movie',
    )
        ? 'tv'
        : 'movie';
    // A request needs a provider id; the internal UUID alone cannot be requested.
    if (hasAnyExternalId(requestExternalIds)) {
        const posterUrl = imageFromIds(requestExternalIds, 'poster', requestType, { size: 'card' });
        openMediaModal(
            {
                externalIds: requestExternalIds,
                mediaType: requestType,
                title: item.title,
                overview: item.overview || '',
                isAvailable: false,
                canRequest: true,
                year: item.year ? String(item.year) : '',
            },
            item.image || posterUrl || '',
        );
    }
    // Search auto-hides via $effect when modal opens; don't call closeSearch()
    // so ?q= is preserved for back-to-search navigation.
}

export function handleAudiobookOpen(item: UniversalMediaItem, _helpers: ItemOpenHelpers): void {
    const target = resolveMediaPlayTarget(item);
    if (target.kind !== 'audiobook') return;
    void playAudiobook(target.mediaId).then((started) => {
        if (!started) toasts.error(audiobookStartFailureMessage());
    });
}

export function handleKavitaOpen(item: UniversalMediaItem, _helpers: ItemOpenHelpers): void {
    // Books/manga/comics live in Kavita, not our catalog, so the row click opens
    // the detail modal fed entirely from the search payload (cover, title,
    // overview) — like audiobooks got. The modal's primary CTA deep-links out to
    // Kavita in a new tab. Deliberately NO externalIds: the Kavita ids are not
    // resolvable catalog ids, and passing them would send the modal's enrichment
    // and image machinery chasing `/api/media/kavita-series-…` URLs.
    const originalItem = item.clickData?.originalItem as
        { mediaId?: string; libraryId?: number; author?: string } | undefined;
    const kavitaSeriesId =
        originalItem?.mediaId || getExternalIdFor(item.externalIds, 'kavita') || undefined;
    if (!kavitaSeriesUrl(kavitaSeriesId, originalItem?.libraryId)) {
        // Kavita not configured (or no id) — nothing the modal's CTA could do;
        // keep the legacy direct-open no-op semantics.
        return;
    }
    openMediaModal(
        {
            title: item.title,
            overview: item.overview,
            mediaType: (item.clickData?.mediaType as string) || 'book',
            isAvailable: true,
            canRequest: false,
            kavitaSeriesId,
            kavitaLibraryId: originalItem?.libraryId,
            author: originalItem?.author,
            year: item.year ? String(item.year) : undefined,
        },
        item.image || '',
    );
    // Search auto-hides via $effect when modal opens; don't call closeSearch()
    // so ?q= is preserved for back-to-search navigation.
}

export function handleAlbumOpen(item: UniversalMediaItem, _helpers: ItemOpenHelpers): void {
    // Album search rows carry the album's internal UUID in ids.internal
    // (the server maps it identically to the top-level id). The UniversalMediaItem
    // `id` is prefixed `search-…`, so always read the UUID from externalIds.
    // Like the movie modal, we do NOT closeSearch(): Search auto-hides via its
    // $hasModals $effect when the modal opens, preserving ?q= for back-to-search.
    const albumId = getExternalIdFor(item.externalIds, 'internal');
    if (albumId) {
        openAlbumModal(albumId);
    }
}

export function handleArtistOpen(item: UniversalMediaItem, _helpers: ItemOpenHelpers): void {
    // Artist rows: ids.internal is the artist's internal UUID.
    const artistId = getExternalIdFor(item.externalIds, 'internal');
    if (artistId) {
        openArtistModal(artistId);
    }
}

export function handleTrackOpen(item: UniversalMediaItem, helpers: ItemOpenHelpers): void {
    // Track rows open the PARENT album modal, scrolled to + highlighting the
    // track. ids.internal is the track UUID; the parent album UUID rides on
    // clickData.originalItem.albumId (server populates it for every track).
    const originalItem = item.clickData?.originalItem as V1SearchResultItem | undefined;
    const trackId = getExternalIdFor(item.externalIds, 'internal');
    if (!trackId) return;
    void openAlbumForTrack(trackId, {
        albumId: originalItem?.albumId,
        fallback: () => {
            // Loose track with no resolvable parent album (the server populates
            // albumId for every track, so this is near-unreachable for search
            // results). There is no album to show and no track-only modal, so
            // just dismiss the overlay — a synchronous closeSearch() avoids the
            // history-mutation race a fire-and-forget navigateTo() would create.
            helpers.closeSearch();
        },
    });
}

export function handleDefaultOpen(item: UniversalMediaItem, _helpers: ItemOpenHelpers): void {
    const originalItem = item.clickData?.originalItem as V1SearchResultItem | undefined;
    const mediaType = item.clickData?.mediaType as string;
    // For episodes, prefer backdrop (landscape thumbnail from video frame extraction)
    const imageUrl = isEpisode(mediaType) ? item.backdrop || item.image : item.image;
    openMediaModal(
        {
            ...(originalItem || {}),
            externalIds: item.externalIds,
            mediaType,
            title: item.title,
            overview: item.overview,
            isAvailable: item.isAvailable,
            canRequest: item.canRequest,
            availabilitySource: item.isAvailable ? 'lumastra' : undefined,
        },
        imageUrl ?? '',
    );
    // Search auto-hides via $effect when modal opens; don't call closeSearch()
    // so ?q= is preserved for back-to-search navigation.
}

// =============================================================================
// Dispatch Map
// =============================================================================

const ITEM_OPEN_DISPATCH: Record<
    string,
    (item: UniversalMediaItem, helpers: ItemOpenHelpers) => void
> = {
    tvchannel: handleTvChannelOpen,
    anfragen: handleAnfragenOpen,
    audiobook: handleAudiobookOpen,
    book: handleKavitaOpen,
    manga: handleKavitaOpen,
    comic: handleKavitaOpen,
    // Music results carry per-item mediaType 'album' | 'artist' | 'track'
    // (v1TypeToUiMediaType passes these through unchanged) — NOT 'music'/'audio',
    // which is only the visual grouping key. Keying on the real per-item types
    // is what stops music falling through to handleDefaultOpen → ModalMovie.
    album: handleAlbumOpen,
    artist: handleArtistOpen,
    track: handleTrackOpen,
};

/**
 * Return the handler for the given media type, falling back to handleDefaultOpen.
 */
export function getItemOpenHandler(
    mediaType: string,
): (item: UniversalMediaItem, helpers: ItemOpenHelpers) => void {
    return ITEM_OPEN_DISPATCH[mediaType] ?? handleDefaultOpen;
}
