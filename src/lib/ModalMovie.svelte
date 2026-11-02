<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ModalMovie - Main media modal component
     *
     * Features:
     * - Self-healing: Auto-fetches missing data when opened with minimal info
     * - Sub-components for cleaner organization
     * - Uses useModalData composable for all data fetching and state management
     * - Mobile: fullscreen with backdrop strip, sticky footer, swipe gestures
     */
    import { asInternalUuid } from '$lib/utils/id-patterns';
    import { onMount, tick, untrack } from 'svelte';
    import { ChevronDown, ChevronUp, Icon } from 'svelte-hero-icons';
    import { page } from '$app/stores';
    import { get } from 'svelte/store';
    import { modals, modalCount, modalStack, topModal, trailPrev } from '$lib/stores/modal.store';
    import { youtube_parser } from '../utility';

    // Sub-components
    import {
        ModalHeader,
        ModalActions,
        ModalAudiobookDetails,
        ModalAudiobookSeries,
        ModalBody,
        ModalSeasons,
        SetSeriesProgressModal,
    } from '$lib/components/modal';
    import { SeriesEpisodePicker } from '$lib/components/media';
    import ModalTrailerOverlay from '$lib/components/modal/ModalTrailerOverlay.svelte';
    import BrandedPlayIcon from '$lib/icons/BrandedPlayIcon.svelte';

    // Composable (data layer)
    import { useModalData } from '$lib/composables/use-modal-data.svelte';
    import { bumpModalLoading, dropModalLoading } from '$lib/stores/modal-loading.store';

    // Utilities (UI-local only)
    import { isEpisode as checkIsEpisode } from '$lib/utils/media-types';
    import {
        openSeriesModalFromEpisode,
        isValidMediaId,
        openSimilarItemModal,
        openSimilarItemMoreModal,
        openMediaModal,
        toSonarrSeriesId,
    } from '$lib/utils/modal-utils';
    import {
        imageFromIds,
        getCatalogThumbUrl,
        getCatalogPosterSrcSet,
        getCatalogBackdropSrcSet,
        getCatalogThumbSrcSet,
    } from '$lib/utils/image-utils';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import * as playbackApi from '$lib/api/playback';

    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import * as aiApi from '$lib/api/ai';

    // Types
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import type { ExternalIds } from '$lib/types/api-common';
    import type { RatingBundle } from '$lib/schemas/modal-props';
    import {
        hasValidExternalId,
        buildMediaKey,
        getExternalIdFor,
    } from '$lib/utils/media-id-helpers';
    import { isAudiobook, isNonEntertainment } from '$lib/shared/media-types';
    import { getAudiobookResourceBooks } from '$lib/api/audiobooks';
    import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
    import { stripNarratorSuffix } from '$lib/shared/audiobook-title';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates';
    import { requireValue } from '$lib/utils/runtime-validation';
    import { formatDuration, runTimeTicksToSeconds } from '$lib/utils/time-formatting';
    import { playerStore } from '$lib/components/player/playerStore.svelte';
    import type { TimelineChapter } from '$lib/schemas/playback-types';
    import { resolve } from '$lib/paths';
    import {
        buildPluginDetailItem,
        chapterWatchPath,
        classifySwipe,
        formatCustomMetadataValue,
        isPlainLeftClick,
        isTrailerShortcut,
        parseYear,
        shouldBulkToggleSeries,
    } from '$lib/components/modal/modal-movie-helpers';

    // Local type for split-mode episode event handlers
    type SplitEpisode = {
        id: string;
        name?: string;
        seasonNumber: number;
        episodeNumber: number;
        episodeNumberEnd?: number;
        overview?: string;
        imageTag?: string;
        runTimeTicks?: number;
        played?: boolean;
        externalIds?: Record<string, string | undefined>;
    };

    import { secondaryTitle } from '$lib/utils/search/matched-title';

    interface Props {
        seasonCount?: number;
        episodeCount?: number;
        availableEpisodeCount?: number;
        watchedEpisodeCount?: number;
        unwatchedEpisodeCount?: number;
        // Props (all passed from modal-utils.ts openMediaModal)
        parent?: { regionFooter?: string };
        // Injected by ModalContainer - kept for potential future use with closeById()
        modalId: string;
        // Basic info
        title: string;
        matchedTitle?: string;
        body: string;
        image: string;
        mediaType: string;
        // External IDs
        externalIds?: ExternalIds | undefined;
        // Metadata
        year?: string | number;
        rating?: number | undefined;
        criticRating?: number | undefined;
        genres?: string[];
        seriesInternalId?: string | undefined;
        // Series/Episode info
        seriesName?: string | undefined;
        seasonNumber?: number | undefined;
        episodeNumber?: number | undefined;
        episodeNumberEnd?: number | undefined;
        sonarrAbsoluteEpisode?: number | undefined;
        sonarrSeriesId?: number | undefined;
        initialSeason?: number | undefined;
        initialEpisode?: number | undefined;
        // Sonarr info
        sonarrNetwork?: string | undefined;
        sonarrQuality?: string | undefined;
        sonarrHasFile?: boolean | undefined;
        sonarrAirDate?: string | undefined;
        // Other info
        duration?: number | undefined;
        studio?: string | undefined;
        author?: string | undefined;
        imageBackdropId?: string | undefined;
        canRequest?: boolean | undefined;
        isAvailable?: boolean | undefined;
        availabilitySource?: string | undefined;
        // Cast and crew
        actors?: Array<string | { name: string; character?: string }> | undefined;
        directors?: string[] | undefined;
        // Additional ratings (bundled)
        ratings?: RatingBundle | undefined;
        overview?: string | undefined;
        seriesChildCount?: number | undefined;
        // Non-entertainment custom metadata
        customMetadata?: Record<string, unknown> | undefined;
        // Playlist context for play-from-playlist navigation
        playlistContext?: { playlistId: number; position: number } | undefined;
        // Kavita deep link (book/manga/comic rows — external, not catalog-backed)
        kavitaSeriesId?: string | undefined;
        kavitaLibraryId?: number | undefined;
    }

    let {
        parent = {},
        modalId,
        title,
        matchedTitle = undefined,
        body,
        image,
        mediaType,
        externalIds = undefined,
        year = '',
        rating = undefined,
        criticRating = undefined,
        genres = [],
        seriesInternalId = undefined,
        seriesName = undefined,
        seasonNumber = undefined,
        episodeNumber = undefined,
        episodeNumberEnd = undefined,
        sonarrAbsoluteEpisode = undefined,
        sonarrSeriesId = undefined,
        initialSeason = undefined,
        initialEpisode = undefined,
        sonarrNetwork = undefined,
        sonarrQuality = undefined,
        sonarrHasFile = undefined,
        sonarrAirDate = undefined,
        duration = undefined,
        studio = undefined,
        author = undefined,
        imageBackdropId = undefined,
        canRequest = undefined,
        isAvailable = undefined,
        availabilitySource = undefined,
        actors = undefined,
        directors = undefined,
        ratings = undefined,
        overview = undefined,
        seriesChildCount = undefined,
        seasonCount,
        episodeCount,
        availableEpisodeCount,
        watchedEpisodeCount,
        unwatchedEpisodeCount,
        customMetadata = undefined,
        playlistContext = undefined,
        kavitaSeriesId = undefined,
        kavitaLibraryId = undefined,
    }: Props = $props();

    // =========================================================================
    // Feature Flags & Global State
    // =========================================================================

    let socialEnabled = $derived($page.data?.features?.social !== false);
    let isAgeRestricted = $derived($page.data?.user?.isAgeRestricted === true);
    let hasHistory = $derived($modalCount > 1);
    // Context-aware back label: the entity the previous trail step returns to
    // (e.g. "Malcolm in the Middle"), falling back to a generic "Back".
    let backLabel = $derived($trailPrev?.options?.trailLabel || m.back());
    // Modal stack renders EVERY entry mounted (only the top one is visually
    // active — background entries sit dimmed behind the backdrop). Global
    // key handlers (the `T` trailer shortcut below) must check this before
    // acting, or a background instance fires alongside the foreground one.
    let isTopModal = $derived($topModal?.id === modalId);
    // =========================================================================
    // Data Layer (composable handles all fetching, enrichment, and effects)
    // =========================================================================

    const dataLayer = useModalData(
        () => ({
            modalId,
            title,
            body,
            image,
            mediaType,
            externalIds,
            seriesInternalId,
            overview,
            year,
            rating,
            criticRating,
            genres,
            duration,
            studio,
            author,
            seriesName,
            seasonNumber,
            episodeNumber,
            episodeNumberEnd,
            sonarrAbsoluteEpisode,
            sonarrSeriesId,
            initialSeason,
            initialEpisode,
            seriesChildCount,
            seasonCount,
            episodeCount,
            availableEpisodeCount,
            watchedEpisodeCount,
            unwatchedEpisodeCount,
            rtCritic: ratings?.rtCritic,
            rtAudience: ratings?.rtAudience,
            letterboxdRating: ratings?.letterboxdRating,
            letterboxdVotes: ratings?.letterboxdVotes,
            traktScore: ratings?.traktScore,
            metacriticScore: ratings?.metacriticScore,
            mdblistScore: ratings?.mdblistScore,
            sonarrNetwork,
            sonarrQuality,
            sonarrHasFile,
            sonarrAirDate,
            imageBackdropId,
            canRequest,
            isAvailable,
            availabilitySource,
            actors,
            directors,
        }),
        {
            getSocialEnabled: () => socialEnabled,
            getIsAgeRestricted: () => isAgeRestricted,
        },
    );

    // Convenience aliases from composable for template bindings
    let modalValue = $derived(dataLayer.modalValue);
    let enrichedData = $derived(dataLayer.enrichedData);
    let similarSection = $derived(dataLayer.similarSection);
    let socialActivities = $derived(dataLayer.socialActivities);
    let mediaDbId = $derived(dataLayer.mediaDbId);

    let userRating = $derived(dataLayer.userRating);
    let isWatched = $derived(dataLayer.isWatched);
    let watchedLoading = $derived(dataLayer.watchedLoading);
    let nextEpisodeId = $derived(dataLayer.nextEpisodeId);
    let nextEpisode = $derived(dataLayer.nextEpisode);
    let isSeries = $derived(dataLayer.isSeries);
    let isMovie = $derived(dataLayer.isMovie);
    let currentExternalIds = $derived(dataLayer.currentExternalIds);
    let apiMediaType = $derived(dataLayer.apiMediaType);
    let enrichmentError = $derived(dataLayer.enrichmentError);
    let nextEpisodeLoading = $derived(dataLayer.nextEpisodeLoading);

    // Season/episode to pre-select in the picker. Prefer explicit deep-link
    // context (opened from an episode/URL); fall back to the "continue
    // watching" next episode (S3E12 in the "Watch S3 E12" button) so opening
    // the modal from the series card itself also lands the picker on the
    // right season/episode instead of always defaulting to Season 1.
    let effectiveInitialSeason = $derived(
        modalValue?.initialSeason ?? modalValue?.seasonNumber ?? nextEpisode?.seasonNumber,
    );
    let effectiveInitialEpisode = $derived(
        modalValue?.initialEpisode ?? modalValue?.episodeNumber ?? nextEpisode?.episodeNumber,
    );

    // Surface modal data-fetch progress to the global NavigationProgressBar.
    // While enrichment is running, the modal is mounted but its data is incomplete —
    // showing the bar gives the user a "still loading" signal during that gap.
    $effect(() => {
        if (dataLayer.enrichmentInProgress) {
            bumpModalLoading();
            return () => dropModalLoading();
        }
    });

    // =========================================================================
    // Local State
    // =========================================================================

    // Trailer overlay: pill + `T` shortcut, mounted over the hero/poster
    // region. Availability requires either a local trailer file (Task 5's
    // `hasLocalTrailer`) or a YouTube trailer URL.
    let trailerOpen = $state(false);
    // Read from the MERGED modalValue (props + enrichment): props-supplied
    // values (deep-link opens map data.details) and enriched values (card
    // opens, where the gate fetches on unknown hasLocalTrailer) both count.
    // The overlay mounts on the internal id, so without one there is nothing to
    // open — offering the pill then would flip trailerOpen and render nothing.
    let trailerAvailable = $derived(
        !!mediaDbId &&
            (modalValue?.hasLocalTrailer === true ||
                (!!modalValue?.remoteTrailers &&
                    youtube_parser(modalValue.remoteTrailers) !== false)),
    );
    // Close the trailer when the modal switches to a DIFFERENT item, or when it
    // stops being available — otherwise it stays open over another item. Only a
    // change between two resolved ids counts: enrichment resolving the id of
    // the same item (empty → id) must not close a trailer being watched.
    let trailerItemId: string | null = null;
    $effect(() => {
        const id = mediaDbId ?? null;
        if (id && trailerItemId && id !== trailerItemId) trailerOpen = false;
        if (id) trailerItemId = id;
    });
    $effect(() => {
        if (!trailerAvailable) trailerOpen = false;
    });

    // Extras section: file-backed trailers/behind-the-scenes/featurettes.
    // Trailer is excluded — it already has the dedicated pill/cinema overlay.
    let extrasToShow = $derived(
        (modalValue?.extras ?? []).filter((extra) => extra.extraType !== 'trailer'),
    );

    // Tracks the episode just marked watched so we can offer a one-click undo
    // before the next-episode advances. Cleared when the media item changes.
    let justMarkedEpisode = $state<{
        id: string;
        seasonNumber: number;
        episodeNumber: number;
    } | null>(null);

    $effect(() => {
        // Reactive dependencies: clear undo state when the user switches modals
        // OR when the URL's selected season/episode changes (browser back/forward
        // without unmounting the modal can change props while the same series
        // UUID is still loaded).
        void currentExternalIds?.internal;
        void modalValue?.seasonNumber;
        void modalValue?.episodeNumber;
        justMarkedEpisode = null;
    });

    // =========================================================================
    // Local Derived Values (UI concerns not in composable)
    // =========================================================================

    let isEpisode = $derived(checkIsEpisode(mediaType));
    // For episode sub-modals opened from within a series modal, track the parent series UUID.
    // Used to surface series-level watched management (hover chip, right-click menu) even
    // though the modal's own mediaType is 'episode' and isSeries is false.
    let episodeSeriesId = $derived(isEpisode ? (modalValue?.seriesInternalId ?? null) : null);
    let isNonEnt = $derived(isNonEntertainment(mediaType));
    let nonEntTemplate = $derived(isNonEnt ? getLibraryTypeTemplate(mediaType) : undefined);
    // `mediaType` arrives UPPER-CASED from openMediaModal, so this MUST go through
    // the comparator — `mediaType === 'audiobook'` never fires here.
    let isAudiobookItem = $derived(isAudiobook(mediaType));
    // Author/narrator/chapter block. Absent until the detail fetch lands, which is
    // also what gates the narrator-suffix title trim below.
    let audiobookDetail = $derived(modalValue?.audiobook);
    /**
     * Book length in ms, for the resume CTA.
     *
     * `durationMs` is the catalog listening length. Zero disables the
     * resume CTA rather than producing a "0m left" that is worse than "Listen".
     */
    let audiobookSeries = $state<{ id: string; books: AudiobookPreview[] } | null>(null);
    $effect(() => {
        const id = audiobookDetail?.series?.id;
        let active = true;
        if (id) {
            void (async () => {
                const books: AudiobookPreview[] = [];
                let offset = 0;
                while (active) {
                    const result = await getAudiobookResourceBooks('series', id, offset);
                    if (!active || !result.data || result.error) return;
                    books.push(...result.data.items);
                    audiobookSeries = { id, books: [...books] };
                    if (!result.data.page.hasMore || result.data.items.length === 0) return;
                    offset = (result.data.page.offset ?? offset) + result.data.items.length;
                }
            })().catch(() => {
                /* The optional series rail stays absent. */
            });
        }
        return () => {
            active = false;
        };
    });
    let audiobookTotalMs = $derived(audiobookDetail?.durationMs ?? 0);
    // Set once the listener marks the book finished here. The detail payload was
    // read before that, and finishing clears the listening position.
    let audiobookMarkedFinished = $state(false);
    let audiobookFinishing = $state(false);
    // Per item: a reused instance showing another book must not inherit it.
    let audiobookIdentity = $derived(currentExternalIds?.internal ?? '');
    $effect(() => {
        void audiobookIdentity;
        audiobookMarkedFinished = false;
    });
    let audiobookFinished = $derived(
        audiobookMarkedFinished || (audiobookDetail?.progress?.finished ?? false) || isWatched,
    );
    let audiobookResumeMs = $derived(
        audiobookMarkedFinished ? 0 : (audiobookDetail?.progress?.positionMs ?? 0),
    );
    /**
     * Display title.
     *
     * AudiobookShelf bakes the narrator into the title ("… - Gesprochen von Rufus
     * Beck"), which is what made the modal header truncate mid-credit. The trim is
     * driven by the narrator names we just fetched (never by a phrase list) and is
     * a no-op unless the trailing segment ends in one of them — see
     * stripNarratorSuffix. DISPLAY ONLY: the stored title, the slug and every id
     * are untouched, so this can differ from the browse card's label.
     */
    let displayTitle = $derived.by(() => {
        const base = enrichedData?.title || title || m.modal_title_missing();
        if (!isAudiobookItem) return base;
        return stripNarratorSuffix(
            base,
            audiobookDetail?.narrators.map((person) => person.name),
        );
    });
    let searchMatch = $derived(secondaryTitle(matchedTitle, displayTitle));
    // Resolve images from the HEALED external IDs (modalValue.externalIds), which
    // backfill internal/jellyfin from the enriched item, rather than the RAW
    // props.externalIds (currentExternalIds) — so an item opened with only a
    // provider id still recovers a poster/backdrop once enrichment heals the ids.
    let imageExternalIds = $derived(modalValue?.externalIds ?? currentExternalIds);
    // Identity handed to plugin detail widgets. Built from the HEALED external
    // ids (modalValue) with the opening props as fallback, so a widget opened
    // from a sparse card still gets whatever the modal later resolved. Null
    // until there is an internal id — that id is the only stable key a plugin
    // may store, and handing over a half-identity invites keying on the title.
    let pluginDetailItem = $derived(
        buildPluginDetailItem({
            internalId: mediaDbId,
            mediaType,
            title: enrichedData?.title || title,
            year: modalValue?.year ?? year,
            externalIds: imageExternalIds,
        }),
    );
    // For episodes, prefer the episode's own still/thumb (landscape) over poster.
    // 'thumb' is the only type that resolves to the episode's OWN artwork —
    // 'backdrop' has no per-episode source and always inherits the season/series
    // art (or 404s to the popcorn placeholder if the series has none either).
    let displayImage = $derived.by(() => {
        if (isAudiobookItem)
            return (
                audiobookDetail?.images?.primary?.variants?.card ??
                audiobookDetail?.images?.primary?.href ??
                image
            );
        if (isEpisode && imageExternalIds) {
            const thumbUrl = imageFromIds(imageExternalIds, 'thumb', 'tv', { size: 'card' });
            if (thumbUrl) return thumbUrl;
        }
        // For series/movies, resolve poster from the healed external ids directly
        // rather than using the image prop, which may be an episode-level catalog
        // URL when the modal was opened from a Continue Watching card click. Using
        // the series UUID skips the ancestor chain and avoids picking the wrong
        // ancestor poster.
        if (!isEpisode && imageExternalIds) {
            const hint = (apiMediaType || mediaType || 'movie').toLowerCase();
            const mediaHint: 'movie' | 'tv' = isSeries || hint === 'tv' ? 'tv' : 'movie';
            const posterUrl = imageFromIds(imageExternalIds, 'poster', mediaHint, { size: 'card' });
            if (posterUrl) return posterUrl;
        }
        return image;
    });
    // Landscape image for mobile backdrop strip (prefer backdrop over poster).
    // Episodes again resolve via 'thumb' (their own still), matching displayImage.
    let backdropImage = $derived.by(() => {
        // An audiobook has exactly one image (the cover, 'poster' role). Asking
        // for 'backdrop' 302s to the popcorn placeholder, and because a 302
        // resolves to a 200 the `onerror` recovery below NEVER fires — the
        // placeholder just sits there as the mobile modal hero. Use the cover.
        if (isAudiobookItem) return displayImage;
        if (isEpisode && imageExternalIds) {
            const thumbUrl = imageFromIds(imageExternalIds, 'thumb', 'tv', { size: 'card' });
            if (thumbUrl) return thumbUrl;
        }
        if (!isEpisode && imageExternalIds) {
            // `apiMediaType` is the TMDB namespace and is null for rows TMDB does
            // not catalog. Audiobooks return above (`isAudiobookItem`), and every
            // other type reaching this backdrop branch is a movie/series/season, so
            // 'movie' here is a reviewed default for a TMDB image path — not a
            // classification of an unknown type.
            const mediaTypeHint = apiMediaType ?? 'movie';
            const backdropUrl = imageFromIds(imageExternalIds, 'backdrop', mediaTypeHint, {
                size: 'card',
            });
            if (backdropUrl) return backdropUrl;
        }
        return displayImage;
    });
    // Catalog UUID (internal) used to build responsive srcsets
    // for the poster + mobile backdrop. Mirrors imageFromIds' id priority so
    // every srcset candidate resolves the SAME underlying catalog image as the
    // single `src`. Absent for provider-only (tmdb) items — srcset then stays
    // undefined and the browser uses `src`, exactly like UniversalMediaCard's
    // internalUuid guard.
    let imageCatalogId = $derived(getExternalIdFor(imageExternalIds, 'internal') ?? null);
    // Poster srcset: episodes render their own landscape still (see displayImage),
    // everything else a portrait poster — match the source type so a chosen
    // srcset candidate never swaps thumb<->poster vs the `src`.
    let displayImageSrcSet = $derived.by(() => {
        if (isAudiobookItem) return undefined;
        if (!imageCatalogId) return undefined;
        return isEpisode
            ? getCatalogThumbSrcSet(imageCatalogId)
            : getCatalogPosterSrcSet(imageCatalogId);
    });
    let backdropImageSrcSet = $derived.by(() => {
        if (!imageCatalogId) return undefined;
        // Must agree with `backdropImage` above on the ROLE, or the browser picks
        // a backdrop srcset candidate (→ popcorn) while `src` points at the cover.
        if (isAudiobookItem) return undefined;
        return isEpisode
            ? getCatalogThumbSrcSet(imageCatalogId)
            : getCatalogBackdropSrcSet(imageCatalogId);
    });
    // Only show seasons for series/episodes, never for movies
    let canShowSeasons = $derived(
        !isMovie && (isSeries || (isEpisode && !!modalValue?.seriesInternalId)),
    );
    // Resolvable media ID for admin API calls (backend resolves any format)
    let editMediaId = $derived(
        buildMediaKey(currentExternalIds, apiMediaType || mediaType || 'movie'),
    );

    // Series picker data
    let seriesPickerData = $derived(
        (() => {
            if (!modalValue || !canShowSeasons) {
                return null;
            }
            const seriesId =
                modalValue.seriesInternalId ||
                // For episode modals, externalIds.internal is the EPISODE's ID,
                // not the series' — using it would query the wrong record. Only
                // fall back to it for series modals.
                (isSeries ? modalValue.externalIds?.internal : undefined);
            // Only show seasons if we have a valid ID (not a UI element ID)
            if (!seriesId || !isValidMediaId(seriesId)) {
                return null;
            }
            return {
                seriesId: seriesId,
                name: modalValue.seriesName || title || m.modal_placeholder_series(),
                imageUrl: image,
            };
        })(),
    );

    // =========================================================================
    // Combined Episode Chapters (segment play buttons)
    // =========================================================================

    let segmentChapters = $state<Array<{ name: string; startMs: number }>>([]);
    // Sequence counter to discard stale chapter responses on rapid modal swap.
    let chaptersReqSeq = 0;

    // Primitives, so an enrichment pass (a new modalValue object for the same
    // item) does not re-run the effect below and refetch. Keyed by the media
    // key (internal UUID first) — a Jellyfin id is never needed for chapters.
    let segmentMediaKey = $derived(
        modalValue
            ? buildMediaKey(modalValue.externalIds, apiMediaType || mediaType || 'episode')
            : null,
    );
    const activeTimelineFileId = $derived(
        playerStore.itemId === segmentMediaKey || playerStore.itemId === mediaDbId
            ? playerStore.currentMediaSource?.id
            : undefined,
    );
    let segmentEpisodeEnd = $derived(modalValue?.episodeNumberEnd ?? null);

    $effect(() => {
        const mediaKey = segmentMediaKey;
        const epEnd = segmentEpisodeEnd;
        void activeTimelineFileId;
        if (!mediaKey || epEnd == null) {
            // Invalidate an in-flight response too, or it lands on this item.
            ++chaptersReqSeq;
            segmentChapters = [];
            return;
        }
        // The key's inputs are read untracked: enrichment healing the ids must
        // not refetch the chapters of the same item.
        const key = untrack(
            () =>
                buildMediaKey(currentExternalIds, apiMediaType || mediaType || 'episode') ??
                mediaKey,
        );
        void fetchSegmentChapters(key);
    });

    async function fetchSegmentChapters(key: string): Promise<void> {
        const seq = ++chaptersReqSeq;
        try {
            const { data, error } = await playbackApi.getTimeline(key, activeTimelineFileId);
            // Stale guard: discard if a newer fetch superseded this one.
            if (seq !== chaptersReqSeq) return;
            if (error || !data) {
                segmentChapters = [];
                return;
            }
            const chapters = data.chapters;
            // Filter to content chapters (skip Opening, Credits, Ending, etc.)
            const skipNames = new Set(['Opening', 'Credits', 'Ending', 'Intro', 'Outro']);
            segmentChapters = chapters.filter(
                (ch) =>
                    typeof ch.name === 'string' &&
                    Number.isFinite(ch.startMs) &&
                    ch.startMs >= 0 &&
                    !skipNames.has(ch.name),
            );
        } catch (e) {
            if (seq !== chaptersReqSeq) return;
            console.warn('[ModalMovie] Failed to load segment chapters', e);
            segmentChapters = [];
        }
    }

    // =========================================================================
    // Movie chapters
    // =========================================================================

    let movieChapters = $state<TimelineChapter[]>([]);
    let movieChaptersExpanded = $state(false);
    let failedMovieChapterImages = $state<Set<number>>(new Set());
    let movieChaptersForKey = '';
    let movieChaptersReqSeq = 0;
    let movieChapterKey = $derived(
        isMovie
            ? (buildMediaKey(currentExternalIds, apiMediaType || mediaType || 'movie') ?? '')
            : '',
    );

    $effect(() => {
        const key = movieChapterKey;
        const fileId = activeTimelineFileId;
        if (!key) {
            // Invalidate an in-flight response when the modal closes or switches
            // away from a movie; otherwise it could repopulate this rail late.
            ++movieChaptersReqSeq;
            movieChapters = [];
            movieChaptersForKey = '';
            return;
        }
        const requestKey = `${key}:${fileId ?? ''}`;
        if (requestKey === movieChaptersForKey) return;

        movieChaptersForKey = requestKey;
        movieChaptersExpanded = false;
        movieChapters = [];
        failedMovieChapterImages = new Set();
        void fetchMovieChapters(key);
    });

    async function fetchMovieChapters(itemId: string): Promise<void> {
        const seq = ++movieChaptersReqSeq;
        try {
            const { data, error } = await playbackApi.getTimeline(itemId, activeTimelineFileId);
            if (seq !== movieChaptersReqSeq || error || !data) return;
            movieChapters = data.chapters.filter(
                (chapter): chapter is TimelineChapter =>
                    Number.isInteger(chapter.index) &&
                    typeof chapter.name === 'string' &&
                    Number.isFinite(chapter.startMs) &&
                    chapter.startMs >= 0,
            );
        } catch (error) {
            if (seq !== movieChaptersReqSeq) return;
            console.warn('[ModalMovie] Failed to load movie chapters', error);
        }
    }

    function chapterImageUrl(chapter: TimelineChapter): string | null {
        return chapter.image?.href ?? null;
    }

    function markMovieChapterImageFailed(index: number): void {
        failedMovieChapterImages = new Set([...failedMovieChapterImages, index]);
    }

    // =========================================================================
    // Episode Layout (split view vs single scroll)
    // =========================================================================
    const EPISODE_LAYOUT_KEY = 'lumastra:modal:episodeLayout';

    const PAGE_MODE_QUERY = '(max-width: 1023px), (max-height: 719px)';
    const SPLIT_MIN_WIDTH = 1200;

    let episodeLayout = $state<'single' | 'split'>('split');
    // Both start from the viewport (the modal only mounts in the browser), so a
    // phone never paints one frame of the desktop poster/split layout first.
    let splitCapableWidth = $state(
        typeof window !== 'undefined' && window.innerWidth >= SPLIT_MIN_WIDTH,
    );
    // Fullscreen "page" layout on small/short viewports — declared here so
    // effectiveSplit can gate on it; kept in sync with matchMedia further below.
    let pageMode = $state(
        typeof window !== 'undefined' && !!window.matchMedia?.(PAGE_MODE_QUERY).matches,
    );

    /**
     * "r, g, b" sampled from the poster's bottom edge — drives the ambient
     * gradient under the desktop poster so the art bleeds into the panel.
     * Null (e.g. cross-origin taint, load failure) falls back to black.
     */
    let posterEdgeRgb = $state<string | null>(null);
    /**
     * True once the loaded poster image turns out to be landscape (the
     * `popcorn.jpg` no-artwork placeholder is 800×533) rather than the
     * portrait shape real poster art has. `object-fit: contain` on a fixed,
     * narrow, tall pane shrinks a landscape image down to a small strip at
     * the top, leaving a large gap the ambient gradient (tuned for a
     * real poster's sampled edge color) does not read as intentional — a
     * visible grey/blank band under the placeholder. Covering the frame
     * instead reads as a deliberate background rather than an unfilled box.
     */
    let posterIsPlaceholder = $state(false);

    function samplePosterEdgeColor(img: HTMLImageElement): string | null {
        try {
            if (!img.naturalWidth || !img.naturalHeight) return null;
            const w = 24;
            const h = 8;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            // Average the bottom ~12% strip of the art.
            const stripH = Math.max(1, Math.floor(img.naturalHeight * 0.12));
            ctx.drawImage(img, 0, img.naturalHeight - stripH, img.naturalWidth, stripH, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            let r = 0;
            let g = 0;
            let b = 0;
            const n = data.length / 4;
            for (let i = 0; i < data.length; i += 4) {
                r += data[i];
                g += data[i + 1];
                b += data[i + 2];
            }
            r /= n;
            g /= n;
            b /= n;
            // Mute bright edges (white posters) so the panel stays dark and the
            // tint reads as ambience, not glow.
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const maxLum = 80;
            if (lum > maxLum) {
                const k = maxLum / lum;
                r *= k;
                g *= k;
                b *= k;
            }
            return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
        } catch {
            // Canvas tainted by a cross-origin poster — fall back to black.
            return null;
        }
    }

    let effectiveSplit = $derived(
        episodeLayout === 'split' &&
            splitCapableWidth &&
            !pageMode &&
            !!canShowSeasons &&
            !!seriesPickerData,
    );

    // =========================================================================
    // UI-Local State
    // =========================================================================

    type ModalAction = 'idle' | 'setProgressOpen' | 'navigatingToPlayer' | 'loadingSeriesModal';
    let modalAction = $state<ModalAction>('idle');
    let loadingSimilarClick = $state(false);

    // =========================================================================
    // Swipe Gesture State (mobile)
    // =========================================================================

    let scrollAreaEl = $state<HTMLElement | null>(null);
    let modalRootEl = $state<HTMLElement | null>(null);
    let swipeType = $state<'none' | 'down' | 'back'>('none');
    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeScrollTopAtStart = 0;
    let gestureDecided = true;
    let swipeDelta = $state(0);
    // Failure is per URL: when enrichment heals the ids the src changes, and the
    // new image must get its chance (an imperative display:none never undid).
    let failedBackdropSrc = $state<string | null>(null);
    let backdropFailed = $derived(
        failedBackdropSrc !== null && failedBackdropSrc === backdropImage,
    );
    let failedPosterSrc = $state<string | null>(null);
    let posterFailed = $derived(failedPosterSrc !== null && failedPosterSrc === displayImage);

    // Register non-passive touchmove handler for swipe gestures
    $effect(() => {
        const el = modalRootEl;
        if (!el) return;

        function onTouchStart(e: TouchEvent) {
            const touch = e.touches[0];
            swipeDelta = 0;
            swipeType = 'none';
            // Overlays inside the modal (trailer, progress dialog) own their
            // touches; a second finger is a pinch, not a swipe.
            gestureDecided =
                !touch || e.touches.length > 1 || trailerOpen || modalAction === 'setProgressOpen';
            if (!touch) return;
            swipeStartX = touch.clientX;
            swipeStartY = touch.clientY;
            // Swipe-down needs the content at the top when the touch STARTS —
            // scrolling back up to the top mid-drag must stay a scroll.
            swipeScrollTopAtStart = scrollAreaEl ? scrollAreaEl.scrollTop : 0;
        }

        function onTouchMove(e: TouchEvent) {
            const touch = e.touches[0];
            if (!touch) return;
            const dx = touch.clientX - swipeStartX;
            const dy = touch.clientY - swipeStartY;

            // Decide the gesture ONCE per touch, on the first movement past
            // the dead zone; a touch classified as a scroll stays a scroll.
            if (!gestureDecided) {
                const decided = classifySwipe({
                    startX: swipeStartX,
                    dx,
                    dy,
                    hasHistory,
                    scrollTopAtStart: swipeScrollTopAtStart,
                });
                if (decided === null) return; // dead zone
                gestureDecided = true;
                swipeType = decided;
            }

            if (swipeType === 'back') {
                e.preventDefault();
                swipeDelta = Math.max(0, dx);
            } else if (swipeType === 'down') {
                e.preventDefault();
                swipeDelta = Math.max(0, dy);
            }
        }

        function onTouchEnd() {
            const THRESHOLD = 100;
            if (swipeType === 'down' && swipeDelta > THRESHOLD) {
                void handleClose();
            } else if (swipeType === 'back' && swipeDelta > THRESHOLD) {
                void handleBack();
            }
            swipeType = 'none';
            swipeDelta = 0;
        }

        // An interrupted touch (OS gesture, incoming call) never fires
        // touchend; without this the modal stays translated and faded.
        function onTouchCancel() {
            swipeType = 'none';
            swipeDelta = 0;
            gestureDecided = true;
        }

        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        el.addEventListener('touchcancel', onTouchCancel, { passive: true });

        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchCancel);
        };
    });

    // Compute swipe transform style (disables CSS transition during drag for instant response)
    let swipeStyle = $derived.by(() => {
        if (swipeType === 'none' || swipeDelta === 0) return '';
        const opacity = Math.max(0.2, 1 - swipeDelta / 300);
        const noTransition = 'transition: none;';
        if (swipeType === 'down') {
            return `${noTransition} transform: translateY(${swipeDelta}px); opacity: ${opacity};`;
        }
        if (swipeType === 'back') {
            return `${noTransition} transform: translateX(${swipeDelta}px); opacity: ${opacity};`;
        }
        return '';
    });

    // Initialize episodeLayout from localStorage and register resize listener
    onMount(() => {
        try {
            const stored = localStorage.getItem(EPISODE_LAYOUT_KEY);
            if (stored === 'single') episodeLayout = 'single';
        } catch {
            // localStorage may throw SecurityError in private browsing or when quota is exceeded
        }

        splitCapableWidth = window.innerWidth >= SPLIT_MIN_WIDTH;
        const handleResize = () => {
            splitCapableWidth = window.innerWidth >= SPLIT_MIN_WIDTH;
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    });

    // =========================================================================
    // Page Mode (fullscreen "page" layout on small/short viewports)
    // =========================================================================
    // Use the fullscreen page layout whenever the viewport is narrow (<1024px)
    // OR short (<720px). Tailwind prefixes are width-only and can't express the
    // OR, so this is driven from matchMedia and kept in sync with the CSS media
    // queries in this component AND ModalContainer's positioner. The <640px
    // phone experience is a subset of this band. (pageMode is declared next to
    // the episode-layout state above.)
    $effect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia(PAGE_MODE_QUERY);
        pageMode = mq.matches;
        const onChange = (e: MediaQueryListEvent) => (pageMode = e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    // Collapsing hero → compact sticky title bar (page mode only). An
    // IntersectionObserver on the hero strip toggles heroVisible; when the hero
    // scrolls out of the modal scroll container the compact bar fades in. Using
    // an observer (not a scroll listener) keeps this cheap.
    let heroStripEl = $state<HTMLElement | null>(null);
    let heroVisible = $state(true);
    $effect(() => {
        if (!pageMode) {
            heroVisible = true;
            return;
        }
        const hero = heroStripEl;
        const root = scrollAreaEl;
        if (!hero || !root) return;
        const io = new IntersectionObserver(
            (entries) => {
                const entry = entries[entries.length - 1];
                if (entry) heroVisible = entry.isIntersecting;
            },
            { root, threshold: 0 },
        );
        io.observe(hero);
        return () => io.disconnect();
    });

    // =========================================================================
    // Event Handlers
    // =========================================================================

    // Opens/closes the trailer cinema layer (modal-wide overlay — no scroll
    // gymnastics needed; it covers the modal regardless of scroll position).
    // Element focused before the trailer opened; focus returns there on close.
    let trailerReturnFocus: HTMLElement | null = null;
    let trailerDialogEl = $state<HTMLElement | null>(null);

    function toggleTrailer() {
        if (!trailerAvailable) return;
        trailerOpen = !trailerOpen;
    }

    // Move focus into the trailer dialog when it opens and back to the trigger
    // when it closes; the content underneath is `inert` while it is open.
    $effect(() => {
        if (trailerOpen) {
            untrack(() => {
                const active = document.activeElement;
                trailerReturnFocus = active instanceof HTMLElement ? active : null;
            });
            void tick().then(() => trailerDialogEl?.focus());
            return;
        }
        const target = trailerReturnFocus;
        trailerReturnFocus = null;
        if (!target) return;
        // The pill that opened it is re-created on close, so the saved node is
        // gone; fall back to the new pill rather than dropping focus to <body>.
        void tick().then(() => {
            const fallback = modalRootEl?.querySelector<HTMLElement>('[data-trailer-pill]');
            (target.isConnected ? target : fallback)?.focus();
        });
    });

    /**
     * Close this modal and hand over to the player. Re-entrancy guarded: a
     * double tap must not close two trail steps or push two history entries.
     */
    async function goToPlayer(navigate?: () => Promise<void>): Promise<void> {
        if (modalAction === 'navigatingToPlayer') return;
        // Explicit user action: going to the player always wins over an open trailer.
        trailerOpen = false;
        modalAction = 'navigatingToPlayer';
        try {
            await modals.close();
            // close() returns quietly when a beforeClose hook vetoes it. Then
            // this modal is still open: do not navigate under it.
            if (get(modalStack).some((entry) => entry.id === modalId)) {
                modalAction = 'idle';
                return;
            }
            await navigate?.();
            modalAction = 'idle';
        } catch (e) {
            console.warn('[ModalMovie] Opening the player failed', e);
            modalAction = 'idle';
            toasts.error(m.error_generic());
        }
    }

    // ModalActions navigates to the player itself; this only closes the modal.
    async function handleWatchClick(_detail: { itemId: string }) {
        await goToPlayer();
    }

    function handleMovieChapterClick(e: MouseEvent, startSeconds: number): void {
        // Modified clicks (new tab/window) keep the plain link behaviour.
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        const key = movieChapterKey;
        void goToPlayer(() => navigateToWatch(key, apiMediaType ?? mediaType, { startSeconds }));
    }

    // Hand a LOCAL extra item (trailer, behind-the-scenes, featurette, …) to
    // the full player — real controls/seeking/fullscreen. Extras are
    // first-class library items, so /watch/{id} plays them directly;
    // navigateToWatch saves the return path so Back reopens this modal.
    // Shared by the trailer cinema overlay and the Extras section below.
    async function openItemInFullPlayer(itemId: string) {
        await goToPlayer(() => navigateToWatch(itemId));
    }

    /** Humanize a DB `extra_type` (snake_case) into a display label. */
    function humanizeExtraType(extraType: string): string {
        return extraType
            .split('_')
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    /** Format a runtime in seconds as a compact "N min" label. */
    function formatExtraRuntime(runtimeSeconds: number): string {
        return m.modal_extras_runtime_min({ minutes: String(Math.round(runtimeSeconds / 60)) });
    }

    async function handleGoToSeries() {
        if (!modalValue) return;
        modalAction = 'loadingSeriesModal';
        try {
            await openSeriesModalFromEpisode({
                seriesName: modalValue.seriesName,
                seriesInternalId: modalValue.seriesInternalId,
                sonarrSeriesId: toSonarrSeriesId(modalValue.sonarrSeriesId),
                externalIds: modalValue.externalIds,
                seasonNumber: modalValue.seasonNumber,
                episodeNumber: modalValue.episodeNumber,
            });
        } catch (e) {
            console.warn('[ModalMovie] Opening the series failed', e);
            toasts.error(m.toast_media_details_unavailable());
        } finally {
            modalAction = 'idle';
        }
    }

    /**
     * Rating from the review form. Only reflected locally once the server took
     * it; a row with no TMDB namespace has nothing to rate server-side (it used
     * to be submitted as a 'movie' rating carrying this item's ids), so there
     * the rating stays local as before.
     */
    async function handleReviewFormRated(r: number): Promise<void> {
        const ids = currentExternalIds;
        if (ids && (hasValidExternalId(ids) || !!ids.internal) && apiMediaType) {
            try {
                const { error } = await aiApi.submitRating(
                    ids,
                    apiMediaType,
                    r,
                    `User rated "${title}" from review form`,
                );
                if (error) throw error;
            } catch (e) {
                console.warn('[ModalMovie] Saving the review rating failed', e);
                toasts.error(m.card_rate_failed());
                return;
            }
        }
        dataLayer.handleRated(r);
    }

    function handleRated(detail: { rating: number; title?: string }) {
        dataLayer.handleRated(detail.rating);
    }

    function handleRatingCleared() {
        dataLayer.handleRatingCleared();
    }

    async function handleClose() {
        // X / swipe-down = "Done": leave the whole trail, not just this step.
        await modals.closeAll();
    }

    async function handleBack() {
        // ← / swipe-back = step one trail step back to the previous entity.
        await modals.close();
    }

    // Watched status toggle.
    //
    // For series (and partially-watched series), the "Mark watched" button
    // opens the SetSeriesProgressModal episode picker. The picker handles
    // every flow the user might intend: per-episode toggling (default —
    // matches the "I just watched one episode" intent), through-episode
    // marking (catching up to a point), and one-click "mark entire series"
    // / "unwatch entire series" quick actions. This replaces the previous
    // Primary action for series: mark the next unwatched episode.
    // Falls back to toggling the whole series when all episodes are done.
    // The SetSeriesProgressModal is now the secondary affordance (right-click / long-press / hover).
    async function handleWatchedClick() {
        const itemId = currentExternalIds?.internal;
        if (!itemId) return;

        if (isSeries && !isMovie) {
            if (justMarkedEpisode) {
                // Undo the last mark — unwatch the episode and return to normal state.
                const success = await dataLayer.markEpisodeUnwatched(justMarkedEpisode.id);
                if (success) justMarkedEpisode = null;
                return;
            }
            const epId = nextEpisodeId;
            if (epId) {
                const ep = nextEpisode; // capture before reload clears it
                const success = await dataLayer.markNextEpisodeWatched(epId);
                if (success && ep) {
                    justMarkedEpisode = { id: epId, ...ep };
                }
            } else if (
                shouldBulkToggleSeries(modalValue?.seasonNumber, modalValue?.episodeNumber)
            ) {
                // Only bulk-toggle when no specific episode is in context.
                // If props have a season/episode that simply wasn't found in
                // the DB (future/TMDB-only episode), don't mark the whole series.
                await performWatchedToggle(itemId);
                dataLayer.reloadNextEpisode();
            }
            return;
        }

        await performWatchedToggle(itemId);
    }

    async function handleMarkAllWatched() {
        // For episode sub-modals, toggle the parent series, not just this episode.
        const itemId = episodeSeriesId ?? currentExternalIds?.internal;
        if (!itemId) return;
        justMarkedEpisode = null;
        await performWatchedToggle(itemId);
        // performWatchedToggle keys watchedState on itemId. For episode sub-modals
        // we just wrote series-level state under the series UUID, but the modal's
        // mediaIdentifier is the episode UUID — reset so the fallback re-fetches
        // the episode's state instead of leaving a stale series-keyed value.
        dataLayer.reloadWatchedStatus();
        dataLayer.reloadNextEpisode();
    }

    async function performWatchedToggle(itemId: string) {
        // Only the progress dialog is superseded by a direct toggle; a running
        // player navigation or series load keeps its state.
        if (modalAction === 'setProgressOpen') modalAction = 'idle';
        await dataLayer.performWatchedToggle(itemId, isWatched, {
            externalIds: currentExternalIds,
            // Omitted rather than defaulted when TMDB has no namespace for the row.
            // The watched toggle is not offered for audiobooks in the first place
            // (ModalActions gates it on `!isAudiobook`), and the sync target is
            // resolved from `externalIds`, so an absent hint is correct where a
            // fabricated 'movie' would mark the wrong Jellyfin item.
            mediaType: apiMediaType ?? undefined,
            title: title,
        });
    }

    /**
     * Mark an audiobook finished. Same watched write as the Continue Watching
     * card's "Mark as watched"; the AudiobookShelf sync pushes it upstream as
     * `isFinished: true`. ModalActions confirms first.
     */
    async function handleAudiobookMarkFinished(): Promise<void> {
        const itemId = currentExternalIds?.internal;
        // A second click while the write runs, or while the watched state is
        // still loading, must not toggle the book back to unfinished.
        if (!itemId || audiobookFinished || audiobookFinishing || watchedLoading) return;
        audiobookFinishing = true;
        try {
            const nowWatched = await dataLayer.performWatchedToggle(itemId, isWatched, {
                externalIds: currentExternalIds,
                title,
            });
            if (nowWatched) {
                audiobookMarkedFinished = true;
                toasts.success(m.modal_audiobook_marked_finished({ title: displayTitle }));
            } else {
                toasts.error(m.modal_audiobook_mark_finished_failed());
            }
        } catch (e) {
            console.warn('[ModalMovie] Marking the audiobook finished failed', e);
            toasts.error(m.modal_audiobook_mark_finished_failed());
        } finally {
            audiobookFinishing = false;
        }
    }

    function closeSetProgress() {
        modalAction = 'idle';
    }

    function onSetProgressSaved() {
        justMarkedEpisode = null;
        dataLayer.reloadWatchedStatus();
        dataLayer.reloadNextEpisode();
    }

    // Similar item click handler - opens new modal in stack for back navigation
    async function handleSimilarItemClick(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }) {
        if (loadingSimilarClick) return;
        loadingSimilarClick = true;
        try {
            await openSimilarItemModal(data.item);
        } catch (e) {
            console.warn('[ModalMovie] Opening the similar item failed', e);
            toasts.error(m.toast_media_details_unavailable());
        } finally {
            loadingSimilarClick = false;
        }
    }

    // Similar item "more" button handler - opens SimilarMoviesModal for that item
    function handleSimilarItemMore(data: { section: PageSection; item: UniversalMediaItem }) {
        openSimilarItemMoreModal(data.item);
    }

    // Seasons component handlers
    async function handleSeasonsClose() {
        await modals.close();
    }

    function handleLayoutChange(layout: 'single' | 'split') {
        episodeLayout = layout;
        try {
            localStorage.setItem(EPISODE_LAYOUT_KEY, layout);
        } catch {
            // localStorage may throw SecurityError in private browsing or when quota is exceeded
        }
    }

    async function handleSplitEpisodeSelect(episode: SplitEpisode) {
        if (!episode?.id) return;
        await goToPlayer(() => navigateToWatch(episode.id));
    }

    function handleEpisodeWatchedChange(): void {
        // Picker actions invalidate the undo affordance — the user did
        // something else, so the "S?E? watched — undo?" pointer is stale.
        justMarkedEpisode = null;
        dataLayer.reloadWatchedStatus();
        dataLayer.reloadNextEpisode();
    }

    function handleSplitShowEpisodeDetails(episode: SplitEpisode) {
        if (!episode?.id) return;
        const episodeImageUrl = episode.imageTag
            ? getCatalogThumbUrl(episode.id, { size: 'full' })
            : seriesPickerData?.imageUrl || '';
        openMediaModal(
            {
                mediaType: 'episode',
                externalIds: { internal: asInternalUuid(episode.id), ...episode.externalIds },
                title: episode.name || m.episode({ number: String(episode.episodeNumber) }),
                overview: episode.overview || '',
                seriesName: seriesPickerData?.name,
                seriesInternalId: seriesPickerData?.seriesId,
                seasonNumber: episode.seasonNumber,
                episodeNumber: episode.episodeNumber,
                episodeNumberEnd: episode.episodeNumberEnd,
                // SECONDS — see runTimeTicksToSeconds. This value wins over the
                // enriched one in mergeModalValue, so a minutes value here made
                // every sub-hour episode render as "00m".
                duration: runTimeTicksToSeconds(episode.runTimeTicks),
                // Intentional: `episode` always comes from the split-episode
                // picker, which lists episodes fetched from the library for
                // this series (fetchEpisodes -> getSeriesEpisodes) — every
                // entry here is a real, locally
                // playable file, so it's always available.
                isAvailable: true,
            },
            episodeImageUrl,
            // In-modal episode details click — open as sub-modal on top of
            // the series modal instead of rerouting back to series.
            { subModal: true },
        );
    }
</script>

<svelte:window
    onkeydown={(e) => {
        if (!isTrailerShortcut(e)) return;
        // The progress dialog sits on top of this modal and owns the keyboard.
        if (modalAction === 'setProgressOpen') return;
        // Every stacked modal instance stays mounted (only the top one is
        // visually active) — without this guard, `T` would toggle trailers
        // in background instances too, letting them steal preview audio.
        if (!isTopModal) return;
        const t = e.target as HTMLElement | null;
        if (
            t &&
            (t.tagName === 'INPUT' ||
                t.tagName === 'TEXTAREA' ||
                t.tagName === 'SELECT' ||
                t.isContentEditable ||
                t.getAttribute('role') === 'textbox')
        )
            return;
        if (!trailerAvailable) return;
        e.preventDefault();
        toggleTrailer();
    }} />

<!-- Shared by the split and single layouts, so a prop added to one cannot
     silently miss the other. -->
{#snippet customMetadataList()}
    {#if nonEntTemplate && customMetadata}
        <div class="space-y-3">
            {#each nonEntTemplate.metadataFields.filter((f) => f.showInDetail) as field (field.key)}
                {#if customMetadata[field.key] != null && customMetadata[field.key] !== ''}
                    <div class="flex gap-2 text-sm">
                        <span class="text-surface-400 shrink-0">{field.label}:</span>
                        <span class="text-surface-200">
                            {formatCustomMetadataValue(customMetadata[field.key], field.type, {
                                yes: m.library_metadata_boolean_yes(),
                                no: m.library_metadata_boolean_no(),
                            })}
                        </span>
                    </div>
                {/if}
            {/each}
        </div>
    {/if}
{/snippet}

{#snippet detailBody(layout: 'split' | 'single')}
    <ModalBody
        pluginItem={pluginDetailItem}
        hidePrimaryMetadata={isMovie || isSeries || isEpisode}
        season={modalValue?.seasonNumber}
        episode={modalValue?.episodeNumber}
        absoluteEpisode={modalValue?.sonarrAbsoluteEpisode}
        seriesChildCount={modalValue?.seriesChildCount}
        {isSeries}
        {isEpisode}
        year={modalValue?.year}
        rating={modalValue?.rating}
        criticRating={modalValue?.criticRating || modalValue?.rtCritic}
        rtAudience={modalValue?.rtAudience}
        letterboxdRating={modalValue?.letterboxdRating}
        letterboxdVotes={modalValue?.letterboxdVotes}
        traktScore={modalValue?.traktScore}
        metacriticScore={modalValue?.metacriticScore}
        mdblistScore={modalValue?.mdblistScore}
        duration={modalValue?.duration}
        genres={modalValue?.genres}
        studio={modalValue?.studio}
        author={modalValue?.author}
        sonarrNetwork={modalValue?.sonarrNetwork}
        sonarrQuality={modalValue?.sonarrQuality}
        sonarrHasFile={modalValue?.sonarrHasFile}
        actors={modalValue?.actors}
        {similarSection}
        showSimilar={(isMovie || isSeries || isEpisode) && !isAgeRestricted}
        {socialActivities}
        isAudiobook={isAudiobookItem}
        showSocialActivity={socialEnabled}
        showReviews={$page.data?.features?.socialReviews !== false &&
            $page.data?.user?.hasReviewPermission === true}
        episodeLayout={layout}
        {mediaDbId}
        currentUserId={$page.data?.user?.userId}
        currentUserRating={userRating}
        isAdmin={$page.data?.user?.isModerator === true}
        onreviewchange={() => dataLayer.refreshSocialActivity()}
        onrated={handleReviewFormRated}
        onsimilarItemClick={handleSimilarItemClick}
        onsimilarItemMore={handleSimilarItemMore} />

    <!-- Extras: file-backed trailers/behind-the-scenes/featurettes belonging to
         this item. Trailer is excluded — it already has the dedicated trailer
         pill/cinema overlay. -->
    {#if extrasToShow.length > 0}
        <div class="mt-4">
            <h3 class="text-sm font-semibold text-surface-200 mb-2">
                {m.modal_extras_section()}
            </h3>
            <div class="space-y-1.5">
                {#each extrasToShow as extra (extra.id)}
                    <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-lg bg-surface-900/50 px-3 py-1.5 text-sm text-surface-300 backdrop-blur-sm transition-colors hover:bg-surface-600/80 hover:text-surface-100"
                        onclick={() => openItemInFullPlayer(extra.id)}>
                        <BrandedPlayIcon size="w-4 h-4" color="text-white" />
                        <span class="flex-1 truncate text-left">{extra.title}</span>
                        <span class="shrink-0 text-xs text-surface-400">
                            {humanizeExtraType(extra.extraType)}
                        </span>
                        {#if extra.durationMs}
                            <span class="shrink-0 text-xs text-surface-500">
                                {formatExtraRuntime(extra.durationMs / 1000)}
                            </span>
                        {/if}
                    </button>
                {/each}
            </div>
        </div>
    {/if}
{/snippet}

<!-- Modal is always rendered when component is mounted -->
{#if modalValue}
    <div
        id={modalId}
        class="modal-root card shadow-xl relative z-10 modal-mobile-fullscreen"
        class:modal-page-mode={pageMode}
        class:audiobook-modal={isAudiobookItem}
        style={swipeStyle}
        bind:this={modalRootEl}>
        {#if pageMode && (heroVisible || backdropFailed || isAudiobookItem)}
            <button
                type="button"
                class="absolute top-2 right-2 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-surface-900/70 text-white backdrop-blur-sm"
                inert={trailerOpen}
                onclick={handleClose}
                aria-label={m.modal_close_aria()}>
                <svg
                    class="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        {/if}
        <!-- Desktop poster: full-height left column.
             Lives directly under modal-root (not inside scroll-area or
             actions-bar) so it spans top→bottom of the modal, including
             the empty left side of the actions bar. Hidden in page mode —
             the phone layout uses the backdrop hero instead. -->
        {#if !pageMode && !isAudiobookItem}
            <div
                class="poster-pane hidden md:block absolute left-0 top-0 bottom-0 overflow-hidden rounded-l-lg"
                style:--poster-edge-rgb={posterEdgeRgb}>
                <!-- Ambient gradient fill below the poster so the column reads as
                     a full-height panel without cover-cropping the sharp poster
                     (which mutilated 2:3 art at common sizes). The tint samples
                     the poster's bottom edge (muted) so the art bleeds into the
                     background; falls back to plain black alpha. A gradient (not
                     a blurred copy of the art) because light posters blurred
                     into a washed-out smear that read as a broken image. -->
                <div class="poster-gradient-fill" aria-hidden="true"></div>
                <!-- Sharp poster at the top, aspect ratio preserved (contain)
                     for real portrait art; the no-artwork placeholder covers
                     the frame instead (see posterIsPlaceholder above). -->
                <img
                    class="poster-sharp rounded-tl-lg"
                    class:poster-sharp--placeholder={posterIsPlaceholder}
                    style:display={posterFailed ? 'none' : undefined}
                    src={displayImage}
                    srcset={displayImageSrcSet}
                    sizes="200px"
                    width={isEpisode ? 356 : 200}
                    height={isEpisode ? 200 : 300}
                    decoding="async"
                    alt="{title ?? ''} poster"
                    onload={(e) => {
                        const img = e.currentTarget as HTMLImageElement;
                        posterEdgeRgb = samplePosterEdgeColor(img);
                        posterIsPlaceholder =
                            img.naturalWidth > 0 &&
                            img.naturalHeight > 0 &&
                            img.naturalWidth / img.naturalHeight > 1.1;
                    }}
                    onerror={() => {
                        failedPosterSrc = displayImage;
                        posterEdgeRgb = null;
                        posterIsPlaceholder = false;
                    }} />
            </div>
        {/if}

        <!-- Scrollable content area -->
        <div class="modal-scroll-area" inert={trailerOpen} bind:this={scrollAreaEl}>
            <!-- Compact sticky title bar: fades in once the hero scrolls away in
                 page mode, giving orientation + a close affordance. -->
            {#if pageMode && !backdropFailed && !isAudiobookItem}
                <div class="compact-header-bar" class:visible={!heroVisible}>
                    <p class="compact-header-title truncate" aria-hidden={heroVisible}>
                        {displayTitle}
                    </p>
                    <button
                        type="button"
                        class="compact-header-close"
                        disabled={heroVisible}
                        onclick={handleClose}
                        aria-label={m.modal_close_aria()}>
                        <svg
                            class="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            {/if}
            <!-- Backdrop hero with overlaid title (page mode, scrolls with content) -->
            {#if !backdropFailed && pageMode && !isAudiobookItem}
                <div class="mobile-backdrop-strip" bind:this={heroStripEl}>
                    <img
                        src={backdropImage}
                        srcset={backdropImageSrcSet}
                        sizes="100vw"
                        width={640}
                        height={360}
                        decoding="async"
                        alt=""
                        class="w-full h-full object-cover"
                        onerror={() => {
                            failedBackdropSrc = backdropImage;
                        }} />
                    <div class="mobile-backdrop-gradient"></div>
                    <!-- Swipe indicator pill -->
                    <div
                        class="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-white/30 z-10">
                    </div>
                    <!-- Title overlaid on gradient -->
                    <div class="mobile-backdrop-title">
                        {#if modalValue.libraryNames?.length}
                            <p class="text-xs text-surface-300 mb-2">
                                {modalValue.libraryNames.join(' · ')}
                            </p>
                        {/if}
                        <h1 class="text-2xl font-bold text-white break-words mobile-title-shadow">
                            {displayTitle}
                        </h1>
                        {#if searchMatch}
                            <p class="text-sm text-surface-200 mt-1 mobile-title-shadow">
                                {searchMatch}
                            </p>
                        {/if}
                        {#if modalValue?.seriesName}
                            <p class="text-sm text-surface-200 mt-0.5 mobile-title-shadow">
                                {modalValue.seriesName}
                            </p>
                        {/if}
                    </div>
                    <!-- Back button inside backdrop (when navigated from another modal) -->
                    {#if hasHistory}
                        <button
                            class="absolute top-2 left-2 p-2 rounded-full hover:bg-surface-600/80 transition-colors z-20 flex items-center gap-1 text-sm text-surface-300 hover:text-surface-100 bg-surface-900/50 backdrop-blur-sm"
                            onclick={handleBack}
                            aria-label={backLabel}>
                            <svg
                                class="w-5 h-5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden="true">
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                    {/if}
                    {#if trailerAvailable && !trailerOpen}
                        <button
                            type="button"
                            class="absolute bottom-3 left-3 z-10 flex items-center gap-1.5 rounded-full bg-surface-900/50 px-3 py-1.5 text-sm text-surface-300 backdrop-blur-sm transition-colors hover:bg-surface-600/80 hover:text-surface-100"
                            data-trailer-pill
                            onclick={toggleTrailer}>
                            <BrandedPlayIcon size="w-4 h-4" color="text-white" />
                            {m.modal_watch_trailer()}
                        </button>
                    {/if}
                </div>
            {/if}

            <!-- Back button (shown outside page mode, or in page mode when the
                 hero — which carries its own back button — is absent). -->
            {#if hasHistory && (!pageMode || backdropFailed || isAudiobookItem)}
                <button
                    class="absolute top-2 left-2 p-2 rounded-full hover:bg-surface-600/80 transition-colors z-20 flex items-center gap-1 text-sm text-surface-300 hover:text-surface-100 bg-surface-900/50 backdrop-blur-sm max-w-[min(60vw,20rem)]"
                    onclick={handleBack}
                    aria-label={backLabel}>
                    <svg
                        class="w-5 h-5 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M15 19l-7-7 7-7" />
                    </svg>
                    <span class="hidden sm:inline truncate">{backLabel}</span>
                </button>
            {/if}
            {#if effectiveSplit && seriesPickerData}
                <!-- Split layout: left info pane + right episodes pane -->
                <div class="split-content-wrapper">
                    <!-- Poster spacer (reserves space for absolutely-positioned poster) -->
                    <div class="imagecontainer shrink-0 mr-4 hidden md:block"></div>

                    <!-- Left pane: condensed info + toggle -->
                    <div class="split-left-pane min-w-0">
                        <ModalHeader
                            seriesCounts={modalValue}
                            title={displayTitle}
                            tagline={modalValue.tagline}
                            year={isMovie || isSeries || isEpisode ? modalValue.year : undefined}
                            duration={isMovie || isSeries || isEpisode
                                ? modalValue.duration
                                : undefined}
                            certification={modalValue.certification}
                            genres={isMovie || isSeries || isEpisode
                                ? modalValue.genres
                                : undefined}
                            libraryNames={modalValue.libraryNames}
                            {matchedTitle}
                            originalTitle={enrichedData?.originalTitle}
                            englishTitle={enrichedData?.englishTitle}
                            seriesName={modalValue?.seriesName}
                            overview={enrichedData?.overview || body}
                            {mediaType}
                            hideTitleOnMobile={pageMode && !backdropFailed}
                            episode={modalValue?.episodeNumber}
                            episodeNumberEnd={modalValue?.episodeNumberEnd}
                            episodeTitle={title || enrichedData?.title}
                            originalLanguage={modalValue?.originalLanguage}
                            audioLanguages={modalValue?.audioLanguages}
                            subtitleLanguages={modalValue?.subtitleLanguages}
                            quality={modalValue?.quality}
                            ongoToSeries={isEpisode ? handleGoToSeries : undefined}
                            seriesLoading={modalAction === 'loadingSeriesModal'} />

                        <!-- mt-auto: when the pane has spare height, park the
                             meta/tags/similar block at the bottom instead of
                             leaving a void under it (collapses to pt-4 when the
                             pane is full and scrolls). -->
                        <div class="mt-auto pt-4 mb-4 max-w-full">
                            {#if isNonEnt && nonEntTemplate && customMetadata}
                                {@render customMetadataList()}
                            {:else}
                                {@render detailBody('split')}
                            {/if}
                        </div>
                    </div>

                    <!-- Right pane: dedicated episode browser -->
                    <div class="split-right-pane flex flex-col min-h-0">
                        <ModalSeasons
                            seriesId={seriesPickerData.seriesId}
                            seriesName={seriesPickerData.name}
                            imageUrl={seriesPickerData.imageUrl}
                            showWatchedToggle={true}
                            initialSeason={effectiveInitialSeason}
                            initialEpisode={effectiveInitialEpisode}
                            episodeLayout="split"
                            isSplitCapable={splitCapableWidth}
                            canToggleLayout={!pageMode}
                            onepisodeLayoutChange={handleLayoutChange}
                            onwatchedChange={handleEpisodeWatchedChange}
                            onclose={handleSeasonsClose} />
                        <div class="split-episodes-scroll min-h-0 flex-1">
                            <SeriesEpisodePicker
                                series={{
                                    seriesId: seriesPickerData.seriesId,
                                    name: seriesPickerData.name,
                                    imageUrl: seriesPickerData.imageUrl,
                                }}
                                inline={true}
                                showWatchedToggle={true}
                                initialSeason={effectiveInitialSeason}
                                initialEpisode={effectiveInitialEpisode}
                                onselectEpisode={handleSplitEpisodeSelect}
                                onshowEpisodeDetails={handleSplitShowEpisodeDetails}
                                onwatchedChange={handleEpisodeWatchedChange} />
                        </div>
                    </div>
                </div>
            {:else}
                <div class="flex flex-col sm:flex-row mb-2 modal-content">
                    <!-- Spacer reserves horizontal room for the absolutely-positioned
                     poster pane (rendered as a sibling of the scroll area). -->
                    <div class="imagecontainer shrink-0 mr-4 hidden md:block"></div>

                    <div class="flex flex-col justify-between min-w-0 flex-1">
                        <!-- Header: Title, series name, overview -->
                        <ModalHeader
                            seriesCounts={modalValue}
                            title={displayTitle}
                            tagline={modalValue.tagline}
                            year={isMovie || isSeries || isEpisode ? modalValue.year : undefined}
                            duration={isMovie || isSeries || isEpisode
                                ? modalValue.duration
                                : undefined}
                            certification={modalValue.certification}
                            genres={isMovie || isSeries || isEpisode
                                ? modalValue.genres
                                : undefined}
                            libraryNames={modalValue.libraryNames}
                            audiobook={isAudiobookItem}
                            coverImage={displayImage}
                            creator={isAudiobookItem
                                ? audiobookDetail?.authors.map((person) => person.name).join(' · ')
                                : undefined}
                            audiobookProgress={isAudiobookItem && audiobookDetail
                                ? {
                                      positionMs: audiobookResumeMs,
                                      durationMs: audiobookTotalMs,
                                      finished: audiobookFinished,
                                      chapters: audiobookDetail.chapters,
                                  }
                                : undefined}
                            {matchedTitle}
                            originalTitle={enrichedData?.originalTitle}
                            englishTitle={enrichedData?.englishTitle}
                            seriesName={modalValue?.seriesName}
                            overview={enrichedData?.overview || body}
                            {mediaType}
                            hideTitleOnMobile={pageMode && !backdropFailed && !isAudiobookItem}
                            episode={modalValue?.episodeNumber}
                            episodeNumberEnd={modalValue?.episodeNumberEnd}
                            episodeTitle={title || enrichedData?.title}
                            originalLanguage={modalValue?.originalLanguage}
                            audioLanguages={modalValue?.audioLanguages}
                            subtitleLanguages={modalValue?.subtitleLanguages}
                            quality={modalValue?.quality}
                            ongoToSeries={isEpisode ? handleGoToSeries : undefined}
                            seriesLoading={modalAction === 'loadingSeriesModal'} />

                        {#if enrichmentError && !body && !enrichedData?.overview}
                            <p class="text-xs text-yellow-400/70 mt-1">
                                {m.toast_series_details_not_loaded({ title: displayTitle })}
                                <button
                                    type="button"
                                    class="underline hover:text-yellow-300/90"
                                    onclick={() => dataLayer.retryEnrichment()}>
                                    {m.common_retry()}
                                </button>
                            </p>
                        {/if}

                        <!-- Audiobook identity: author, narrator, series position,
                             publisher, table of contents. Rendered above the
                             generic metadata row because for a book these ARE the
                             metadata — the row below only has year/duration to
                             offer. -->
                        <!-- Shaped like Similar Movies, but it is a SEQUENCE,
                             not a ranking — see the component. Declared as a
                             snippet so it renders ABOVE the parts list rather
                             than after it. -->
                        {#snippet seriesRail()}
                            <ModalAudiobookSeries
                                books={audiobookSeries &&
                                audiobookSeries.id === audiobookDetail?.series?.id
                                    ? audiobookSeries.books
                                    : []}
                                currentMediaId={modalValue?.externalIds?.internal}
                                onopen={(book) =>
                                    openMediaModal(
                                        {
                                            title: book.title,
                                            mediaType: 'audiobook',
                                            externalIds: { internal: book.id },
                                            isAvailable: true,
                                            canRequest: false,
                                        },
                                        book.images.primary?.href ?? '',
                                    )} />
                        {/snippet}

                        {#if isAudiobookItem && audiobookDetail}
                            <div class="mt-3">
                                <ModalAudiobookDetails
                                    expandChapters={!body}
                                    authors={audiobookDetail.authors}
                                    narrators={audiobookDetail.narrators}
                                    publisher={audiobookDetail.publisher}
                                    series={audiobookDetail.series}
                                    abridged={audiobookDetail.abridged}
                                    year={parseYear(modalValue?.year)}
                                    durationMs={audiobookDetail.durationMs}
                                    chapterCount={audiobookDetail.chapterCount}
                                    chapters={audiobookDetail.chapters}
                                    afterIdentity={seriesRail} />
                            </div>
                        {/if}

                        <!-- Seasons Section -->
                        {#if canShowSeasons && seriesPickerData}
                            <ModalSeasons
                                seriesId={seriesPickerData.seriesId}
                                seriesName={seriesPickerData.name}
                                imageUrl={seriesPickerData.imageUrl}
                                showWatchedToggle={true}
                                defaultExpanded={isSeries ? true : undefined}
                                initialSeason={effectiveInitialSeason}
                                initialEpisode={effectiveInitialEpisode}
                                {episodeLayout}
                                isSplitCapable={splitCapableWidth && !pageMode}
                                canToggleLayout={!pageMode}
                                onepisodeLayoutChange={handleLayoutChange}
                                onwatchedChange={handleEpisodeWatchedChange}
                                onclose={handleSeasonsClose} />
                        {/if}

                        <!-- Body: Metadata, actors, similar, social -->
                        <div class="mt-4 mb-4 max-w-full overflow-hidden flex-1">
                            {#if isNonEnt && nonEntTemplate && customMetadata}
                                {@render customMetadataList()}
                            {:else}
                                <!-- Keep the compact disclosure ahead of long metadata and
                                     similar-content rails so it is visible without scrolling. -->
                                {#if isMovie && movieChapters.length > 0}
                                    <section class="mb-4">
                                        <button
                                            type="button"
                                            class="flex w-full items-center justify-between text-left text-sm font-semibold text-surface-200"
                                            aria-expanded={movieChaptersExpanded}
                                            aria-controls="movie-chapters"
                                            onclick={() =>
                                                (movieChaptersExpanded = !movieChaptersExpanded)}>
                                            <span
                                                >{m.media_files_chapters_title()} ({movieChapters.length})</span>
                                            <Icon
                                                src={movieChaptersExpanded
                                                    ? ChevronUp
                                                    : ChevronDown}
                                                size="16" />
                                        </button>

                                        {#if movieChaptersExpanded}
                                            <div
                                                id="movie-chapters"
                                                class="mt-2 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
                                                {#each movieChapters as chapter (chapter.index)}
                                                    {@const startSeconds = Math.floor(
                                                        chapter.startMs / 1000,
                                                    )}
                                                    {@const thumbnail = chapterImageUrl(chapter)}
                                                    <a
                                                        class="group w-28 shrink-0 snap-start overflow-hidden rounded-md bg-surface-800/80 text-left transition-colors hover:bg-surface-700 sm:w-36"
                                                        href={resolve(
                                                            chapterWatchPath(
                                                                movieChapterKey,
                                                                startSeconds,
                                                            ),
                                                        )}
                                                        onclick={(e) =>
                                                            handleMovieChapterClick(
                                                                e,
                                                                startSeconds,
                                                            )}
                                                        aria-label={m.modal_play_chapter_aria({
                                                            name: chapter.name,
                                                        })}>
                                                        <div class="aspect-video bg-surface-700">
                                                            {#if thumbnail && !failedMovieChapterImages.has(chapter.index)}
                                                                <img
                                                                    src={thumbnail}
                                                                    alt=""
                                                                    onerror={() =>
                                                                        markMovieChapterImageFailed(
                                                                            chapter.index,
                                                                        )}
                                                                    class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" />
                                                            {:else}
                                                                <div
                                                                    class="flex h-full items-center justify-center bg-gradient-to-br from-surface-700 to-surface-900 text-xs text-surface-400">
                                                                    {formatDuration(startSeconds)}
                                                                </div>
                                                            {/if}
                                                        </div>
                                                        <div class="px-2 py-1.5">
                                                            <p
                                                                class="truncate text-xs font-medium text-surface-100">
                                                                {chapter.name}
                                                            </p>
                                                            <p class="text-[11px] text-surface-400">
                                                                {formatDuration(startSeconds)}
                                                            </p>
                                                        </div>
                                                    </a>
                                                {/each}
                                            </div>
                                        {/if}
                                    </section>
                                {/if}

                                {@render detailBody('single')}
                            {/if}
                        </div>
                    </div>
                </div>
            {/if}
        </div>

        <!-- Actions: Watch, Watchlist, Rating, Watched, Close -->
        <!-- On mobile: sticky footer outside scroll area. On desktop: flows naturally. -->
        <div class="modal-actions-bar" inert={trailerOpen}>
            <ModalActions
                externalIds={modalValue?.externalIds}
                {mediaType}
                title={title || ''}
                overview={body || ''}
                year={modalValue?.year}
                rating={modalValue?.rating}
                criticRating={modalValue?.criticRating}
                isAvailable={modalValue?.isAvailable}
                canRequest={modalValue?.canRequest}
                sonarrHasFile={modalValue?.sonarrHasFile}
                {isSeries}
                seasonNumber={modalValue?.seasonNumber}
                episodeNumber={modalValue?.episodeNumber}
                seriesName={modalValue?.seriesName}
                seriesInternalId={modalValue?.seriesInternalId}
                audiobookResumePositionMs={audiobookResumeMs}
                audiobookDurationMs={audiobookTotalMs}
                {audiobookFinished}
                onaudiobookfinished={handleAudiobookMarkFinished}
                {kavitaSeriesId}
                {kavitaLibraryId}
                {segmentChapters}
                {nextEpisodeId}
                {nextEpisode}
                {nextEpisodeLoading}
                {justMarkedEpisode}
                {isWatched}
                {watchedLoading}
                {userRating}
                isNavigatingToPlayer={modalAction === 'navigatingToPlayer'}
                parentRegionFooter={parent.regionFooter ?? ''}
                sonarrSeriesId={toSonarrSeriesId(modalValue?.sonarrSeriesId)}
                genres={modalValue?.genres}
                sonarrQuality={modalValue?.sonarrQuality}
                sonarrNetwork={modalValue?.sonarrNetwork}
                sonarrAirDate={modalValue?.sonarrAirDate}
                {playlistContext}
                onwatch={handleWatchClick}
                onrated={handleRated}
                oncleared={handleRatingCleared}
                onclose={handleClose}
                onclick={handleWatchedClick}
                hasSeriesContext={!!episodeSeriesId}
                onsetprogress={() => {
                    modalAction = 'setProgressOpen';
                }}
                onmarkallwatched={handleMarkAllWatched} />
        </div>

        <!-- Desktop trailer pill. Lives at modal-root level (NOT inside the
             poster pane): the pane's z-index:0 creates a stacking context, so
             a pill inside it gets covered by the later-DOM actions-bar footer
             wherever they overlap — only the pill's bottom sliver was
             clickable. Same visual spot (modal's bottom-left corner). -->
        {#if !pageMode && trailerAvailable && !trailerOpen}
            <button
                type="button"
                class="absolute bottom-3 left-3 z-30 hidden md:flex items-center gap-1.5 rounded-full bg-surface-900/50 px-3 py-1.5 text-sm text-surface-300 backdrop-blur-sm transition-colors hover:bg-surface-600/80 hover:text-surface-100"
                data-trailer-pill
                onclick={toggleTrailer}>
                <BrandedPlayIcon size="w-4 h-4" color="text-white" />
                {m.modal_watch_trailer()}
            </button>
        {/if}

        <!-- Trailer cinema layer: one modal-wide overlay (desktop + page mode)
             instead of squeezing a 16:9 trailer into the 2:3 poster column.
             Centered aspect-video box over a dimmed backdrop; the player
             letterboxes (object-contain) inside it. -->
        {#if trailerOpen && mediaDbId}
            <!-- A modal dialog of its own: focus moves in on open and back to the
                 trigger on close (see the trailerOpen effect); everything
                 underneath is `inert` meanwhile. -->
            <div
                class="absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
                role="dialog"
                aria-modal="true"
                aria-label={m.modal_watch_trailer()}
                tabindex="-1"
                bind:this={trailerDialogEl}>
                <div
                    class="relative aspect-video max-h-full w-[min(100%,60rem)] overflow-hidden rounded-lg bg-black shadow-2xl">
                    <ModalTrailerOverlay
                        internalId={mediaDbId}
                        hasLocalTrailer={modalValue?.hasLocalTrailer === true}
                        trailerUrl={modalValue?.remoteTrailers}
                        onClose={() => (trailerOpen = false)}
                        onOpenInPlayer={openItemInFullPlayer} />
                </div>
            </div>
        {/if}

        <!--
            Series-level watched-status manager. Opens via the "Mark
            watched" button in ModalActions for series. Defaults to the
            per-episode tab so users who clicked thinking they'd mark a
            single episode land in the right view; "Through episode" tab
            and the bulk quick-action buttons inside the modal cover the
            other intents (catching up to a point, mark/unmark all).
        -->
        {#if (isSeries || episodeSeriesId) && (currentExternalIds?.internal || episodeSeriesId)}
            <SetSeriesProgressModal
                open={modalAction === 'setProgressOpen'}
                seriesId={episodeSeriesId ??
                    requireValue(
                        currentExternalIds?.internal,
                        'currentExternalIds.internal must exist when episodeSeriesId is absent',
                    )}
                seriesTitle={isSeries ? title || '' : modalValue?.seriesName || title || ''}
                defaultMode="per"
                onClose={closeSetProgress}
                onSaved={() => void onSetProgressSaved()} />
        {/if}
    </div>
{/if}

<style>
    /* =========================================================================
     * Modal Root — flex column on all sizes
     * ========================================================================= */
    .modal-root {
        /* Width of the desktop poster column. Single source of truth: the
           absolutely-positioned .poster-pane, the in-flow .imagecontainer
           spacer that reserves its width, the poster image itself, and the
           action bar's left offset all derive from this. They must agree --
           if the spacer and the action bar disagree, the primary button stops
           lining up with the title. */
        --poster-col-w: 200px;
        display: flex;
        flex-direction: column;
        max-width: 1300px;
        overflow: hidden;
        transition:
            transform 0.15s ease-out,
            opacity 0.15s ease-out;
    }

    /* Enlarge artwork only; keep the panel, text and controls stationary.
       No source-card coordinates or persistent animation fill are needed. */
    .poster-sharp,
    .mobile-backdrop-strip > img {
        animation: poster-open 200ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    @keyframes poster-open {
        from {
            scale: 0.88;
        }
        to {
            scale: 1;
        }
    }

    /* Desktop card: centered with max height. Only outside page mode —
       i.e. wide (>=1024px) AND tall (>=720px). Narrower/shorter viewports use
       the fullscreen page layout below. */
    @media (min-width: 1024px) and (min-height: 720px) {
        .modal-root {
            width: 95vw;
            max-height: 95vh;
            padding: 1rem;
        }
    }

    /* =========================================================================
     * Mobile Backdrop Strip — edge-to-edge with title overlay
     * ========================================================================= */
    .mobile-backdrop-strip {
        position: relative;
        height: 220px;
        overflow: hidden;
        /* Counteract scroll area padding to go edge-to-edge */
        margin-left: -1rem;
        margin-right: -1rem;
        /* Override the wildcard max-width: 100% !important on .modal-mobile-fullscreen * */
        max-width: none !important;
        width: calc(100% + 2rem) !important;
    }

    .mobile-backdrop-gradient {
        position: absolute;
        inset: 0;
        background:
            linear-gradient(90deg, rgba(0, 0, 0, 0.25), transparent 65%),
            linear-gradient(
                to bottom,
                transparent 0%,
                rgb(var(--color-surface-900-rgb, 24 24 27) / 0.25) 40%,
                rgb(var(--color-surface-900-rgb, 24 24 27) / 0.75) 75%,
                rgb(var(--color-surface-900-rgb, 24 24 27) / 1) 100%
            );
    }

    .mobile-backdrop-title {
        position: absolute;
        bottom: 0.75rem;
        left: 1rem;
        right: 3.5rem;
        z-index: 5;
    }

    .mobile-title-shadow {
        text-shadow:
            0 1px 4px rgba(0, 0, 0, 0.8),
            0 2px 8px rgba(0, 0, 0, 0.5);
    }

    /* =========================================================================
     * Scrollable Content Area
     * ========================================================================= */
    .modal-scroll-area,
    .split-left-pane,
    .split-episodes-scroll {
        scrollbar-width: thin;
        scrollbar-color: rgb(var(--color-surface-400-rgb) / 0.45) transparent;
    }

    /* Fallback for browsers without CSS Scrollbars support. */
    .modal-scroll-area::-webkit-scrollbar,
    .split-left-pane::-webkit-scrollbar,
    .split-episodes-scroll::-webkit-scrollbar {
        width: 6px;
    }

    .modal-scroll-area::-webkit-scrollbar-track,
    .split-left-pane::-webkit-scrollbar-track,
    .split-episodes-scroll::-webkit-scrollbar-track {
        background: transparent;
    }

    .modal-scroll-area::-webkit-scrollbar-thumb,
    .split-left-pane::-webkit-scrollbar-thumb,
    .split-episodes-scroll::-webkit-scrollbar-thumb {
        background: rgb(var(--color-surface-400-rgb) / 0.45);
        border-radius: 999px;
    }

    .modal-scroll-area {
        flex: 1;
        min-height: 0; /* allow flex shrink */
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        padding: 0 1rem;
    }

    .audiobook-modal .imagecontainer {
        display: none;
    }
    .audiobook-modal .modal-actions-bar :global(footer.modal-footer) {
        padding-left: 0;
    }
    .audiobook-modal.modal-page-mode .modal-scroll-area {
        padding-top: 3rem;
    }

    @media (min-width: 1024px) and (min-height: 720px) {
        .modal-scroll-area {
            padding: 0;
            overscroll-behavior: auto;
        }
    }

    /* Split view layout */
    .modal-scroll-area:has(.split-content-wrapper) {
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .split-content-wrapper {
        display: flex;
        flex: 1;
        min-height: 0;
    }

    .split-left-pane {
        flex: 0 0 40%;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        padding-bottom: 1rem;
        min-height: 0;
    }

    .split-right-pane {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        border-left: 1px solid rgb(var(--color-surface-700-rgb) / 0.4);
        padding-left: 1rem;
    }

    .split-episodes-scroll {
        overflow-y: auto;
    }

    /* =========================================================================
     * Actions Bar — sticky footer on mobile, normal flow on desktop
     * ========================================================================= */
    .modal-actions-bar {
        flex-shrink: 0;
        padding: 0.75rem 1rem;
        padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        background: rgb(var(--color-surface-900-rgb, 24 24 27) / 0.95);
        backdrop-filter: blur(8px);
    }

    @media (min-width: 1024px) and (min-height: 720px) {
        .modal-actions-bar {
            padding: 0.75rem 0 0;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            background: none;
            backdrop-filter: none;
        }
    }

    /* Indent the action bar past the poster column so the primary button
       (Watch / Listen / Request) lines up with the title and overview rather
       than floating under the artwork. The poster pane deliberately spans the
       full modal height, so without this the button sits inside the poster's
       column -- visually attached to the image instead of to the content it
       acts on.

       The offset is the spacer's exact footprint: column width + the `mr-4`
       gutter that .imagecontainer carries. Both derive from --poster-col-w, so
       the button cannot drift out of alignment with the title.

       md and up only, matching the `hidden md:block` on the poster pane and
       its spacer -- below that there is no poster column to clear. */
    @media (min-width: 768px) {
        .modal-actions-bar :global(footer.modal-footer) {
            padding-left: calc(var(--poster-col-w) + 1rem);
        }

        /* Page mode drops the poster column entirely (.imagecontainer is
           display:none there), so there is nothing to clear. */
        .modal-page-mode .modal-actions-bar :global(footer.modal-footer) {
            padding-left: 0;
        }
    }

    /* =========================================================================
     * Desktop poster
     * ========================================================================= */
    .imagecontainer {
        width: var(--poster-col-w);
    }
    /* Full-height poster pane on the modal's left side.
       Sibling of scroll-area so it spans modal-root top→bottom, including
       the empty left side of the actions bar. */
    .poster-pane {
        width: var(--poster-col-w);
        z-index: 0;
    }
    /* Sharp poster: full pane width, natural aspect (no cover-crop). The
       bottom ~18% dissolves via mask into the ambient tint behind it, so the
       art melts into the panel instead of ending on a hard edge. */
    .poster-sharp {
        position: absolute;
        top: 0;
        left: 0;
        width: var(--poster-col-w);
        height: auto;
        max-height: 100%;
        object-fit: contain;
        z-index: 1;
        -webkit-mask-image: linear-gradient(to bottom, black 82%, transparent 100%);
        mask-image: linear-gradient(to bottom, black 82%, transparent 100%);
    }
    /* The no-artwork placeholder is landscape (800×533) — cover the full pane
       instead of leaving most of it to the ambient gradient fallback. */
    .poster-sharp--placeholder {
        height: 100%;
        object-fit: cover;
        -webkit-mask-image: none;
        mask-image: none;
    }
    /* Ambient tint below the uncropped poster so the column reads as a
       grounded panel: the poster's (muted) edge color bleeds downward,
       dissolving into the modal surface. Falls back to black alpha when no
       edge color could be sampled. (Not a surface-colored gradient — that
       matched the card background and was invisible.) */
    .poster-gradient-fill {
        position: absolute;
        inset: 0;
        background: linear-gradient(
            to bottom,
            rgba(var(--poster-edge-rgb, 0, 0, 0), 0.6) 0%,
            rgba(var(--poster-edge-rgb, 0, 0, 0), 0.35) 45%,
            rgba(var(--poster-edge-rgb, 0, 0, 0), 0) 100%
        );
    }

    /* Page mode: no desktop poster column — hide the spacer that reserves its
       width so the single-column content spans the full modal. */
    .modal-page-mode .imagecontainer {
        display: none !important;
    }
    /* Page mode: the header title lives in the backdrop hero — suppress the
       in-flow title block (ModalHeader marks it `.mobile-hidden` whenever the
       backdrop is present). */
    .modal-page-mode :global(.mobile-hidden) {
        display: none;
    }

    /* =========================================================================
     * Compact sticky header bar (page mode) — appears when the hero scrolls off
     * ========================================================================= */
    .compact-header-bar {
        position: sticky;
        top: 0;
        z-index: 25;
        height: 52px;
        /* Don't consume layout space: overlay the top of the hero below it. */
        margin-bottom: -52px;
        margin-left: -1rem;
        margin-right: -1rem;
        width: calc(100% + 2rem) !important;
        max-width: none !important;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0 0.75rem;
        background: rgb(var(--color-surface-900-rgb, 24 24 27) / 0.85);
        backdrop-filter: blur(10px);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        opacity: 0;
        transform: translateY(-6px);
        pointer-events: none;
        transition:
            opacity 180ms ease,
            transform 180ms ease;
    }
    .compact-header-bar.visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
    }
    .compact-header-title {
        flex: 1;
        min-width: 0;
        font-size: 1rem;
        font-weight: 600;
        color: rgb(var(--color-surface-100-rgb));
    }
    .compact-header-close {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        border-radius: 9999px;
        color: rgb(var(--color-surface-200-rgb));
        background: rgba(255, 255, 255, 0.06);
        transition: background 120ms ease;
    }
    .compact-header-close:hover {
        background: rgba(255, 255, 255, 0.12);
    }
    @media (prefers-reduced-motion: reduce) {
        .poster-sharp,
        .mobile-backdrop-strip > img {
            animation: none;
        }
        .compact-header-bar {
            transition: none;
            transform: none;
        }
        .compact-header-bar.visible {
            transform: none;
        }
    }

    /* =========================================================================
     * Page-Mode Fullscreen Overrides — narrow (<1024px) OR short (<720px).
     * The <640px phone experience is a subset of this band.
     * ========================================================================= */
    @media (max-width: 1023px), (max-height: 719px) {
        :global(.modal-mobile-fullscreen) {
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            max-width: 100vw !important;
            max-height: none !important;
            border-radius: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            box-sizing: border-box !important;
        }

        :global(.modal-mobile-fullscreen *) {
            max-width: 100% !important;
            box-sizing: border-box !important;
        }
    }

    /* PWA standalone mode */
    @media (display-mode: standalone) {
        .modal-scroll-area {
            padding-top: env(safe-area-inset-top, 0px);
        }
        .modal-actions-bar {
            padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
        }
    }
</style>
