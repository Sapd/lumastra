<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { tryJoinUpstreamUrl } from '$lib/shared/upstream-url.js';
    /**
     * ModalActions - Action buttons for media modals
     *
     * Handles:
     * - Watch/Play button
     * - AI Rating button
     * - Watchlist button
     * - Mark as Watched button
     * - Close button
     *
     * Uses externalIds for provider-agnostic ID handling.
     */
    import { withWatchEntry } from '$lib/stores/watch-entry';
    import {
        Icon,
        Film,
        Check,
        CodeBracket,
        Cog6Tooth,
        EllipsisHorizontal,
        Eye,
        EyeSlash,
    } from 'svelte-hero-icons';
    import { onMount } from 'svelte';
    import type { ExternalIds } from '$lib/types/api-common';
    import { WatchlistButton, SendToTVButton, Tooltip } from '$lib/components/ui';
    import { PlaylistButton } from '$lib/components/playlist';
    import AIRatingButton from '$lib/components/AIRatingButton.svelte';
    import BrandedPlayIcon from '$lib/icons/BrandedPlayIcon.svelte';
    import { env } from '$env/dynamic/public';
    import { canPlayDirectly } from '$lib/utils/modal-data';
    import { page } from '$app/stores';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { modals } from '$lib/stores/modal.store';
    import { requestNotifications } from '$lib/stores/request-notifications';
    import { getStatusLabel } from '$lib/shared/request-status';
    import { base } from '$app/paths';
    import { isPWAInstalled } from '$lib/pwa';
    import { buildMediaShareId } from '$lib/utils/media-context-actions';
    import { shareOrCopy } from '$lib/utils/web-share';
    import {
        saveReturnPath,
        setNavigatingToPlayer,
        clearNavigatingToPlayer,
    } from '$lib/stores/playerNavigation';
    import { openRequestModal, confirmDialog } from '$lib/utils/modal-utils';
    import {
        hasValidExternalId,
        buildMediaKey,
        getPlayableId,
        getExternalIdFor,
    } from '$lib/utils/media-id-helpers';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { getPreferredExternalId } from '$lib/utils/external-ids';
    import SeasonSelectorModal from '$lib/components/SeasonSelectorModal.svelte';
    import DebugPanel from './DebugPanel.svelte';
    import ActionPopover from './ActionPopover.svelte';
    import * as m from '$lib/paraglide/messages';
    import {
        isAudiobook,
        isBookMediaType,
        isMovie,
        isSeries as isSeriesType,
        isEpisode as isEpisodeType,
    } from '$lib/shared/media-types';
    import { kavitaSeriesUrl } from '$lib/utils/search/media-external-links';
    import {
        toTmdbMediaType as toTmdbType,
        toUniversalMediaType,
    } from '$lib/shared/media-type-domain';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import { longPress } from '$lib/utils/long-press';
    import { audiobookStartFailureMessage, playAudiobook } from '$lib/services/audiobook-playback';
    import { toasts } from '$lib/stores/toast.store';
    import { apiUrl } from '$lib/shared/api-urls.js';
    import * as contentApi from '$lib/api/content.js';
    import { UUID_RE } from '$lib/utils/id-patterns.js';

    interface Props {
        // Props - Media data (uses externalIds for provider-agnostic ID handling)
        externalIds?: ExternalIds | undefined;
        mediaType?: string | undefined;
        title?: string;
        overview?: string;
        year?: string | number | undefined;
        rating?: number | undefined;
        criticRating?: number | undefined;
        // Props - Availability
        isAvailable?: boolean;
        canRequest?: boolean;
        sonarrHasFile?: boolean;
        // Props - Series/Episode specific
        isSeries?: boolean;
        seasonNumber?: number | undefined;
        episodeNumber?: number | undefined;
        seriesName?: string | undefined;
        seriesInternalId?: string | undefined;
        // Props - Audiobook progress (drives the primary CTA's three states)
        audiobookResumePositionMs?: number;
        audiobookDurationMs?: number;
        audiobookFinished?: boolean;
        /** Marks the audiobook finished. Called after the user confirms. */
        onaudiobookfinished?: () => Promise<void>;
        // Props - Kavita deep link (book/manga/comic rows — external, not catalog-backed)
        kavitaSeriesId?: string | undefined;
        kavitaLibraryId?: number | undefined;
        // Props - Combined episode segment chapters
        segmentChapters?: Array<{ name: string; startMs: number }>;
        nextEpisodeId?: string | null;
        nextEpisode?: {
            seasonNumber: number;
            episodeNumber: number;
            /** False when the episode has no file yet: Watch is shown disabled */
            playable?: boolean;
        } | null;
        nextEpisodeLoading?: boolean;
        // Props - State
        isWatched?: boolean;
        watchedLoading?: boolean;
        userRating?: number | null;
        isNavigatingToPlayer?: boolean;
        // Props - Parent
        parentRegionFooter?: string;
        // Props - Debug info
        sonarrSeriesId?: number | undefined;
        genres?: string[];
        sonarrQuality?: string | undefined;
        sonarrNetwork?: string | undefined;
        sonarrAirDate?: string | undefined;
        // Playlist context for play-from-playlist navigation
        playlistContext?: { playlistId: number; position: number } | undefined;
        // Callbacks
        onwatch?: (detail: { itemId: string }) => void;
        onrated?: (detail: {
            externalIds: ExternalIds;
            mediaType: 'movie' | 'tv';
            rating: number;
            title: string;
        }) => void;
        oncleared?: (detail: {
            externalIds: ExternalIds;
            mediaType: 'movie' | 'tv';
            title: string;
        }) => void;
        onclose?: () => void;
        onclick?: () => void;
        /**
         * Series-only escape hatch — opens the "Set my progress" episode
         * picker. When omitted the hover affordance is hidden and the
         * watched button stays a plain mark-all toggle.
         */
        onsetprogress?: () => void;
        /** Context-menu "Mark all watched/unwatched" action for series. */
        onmarkallwatched?: () => void;
        /** True when this is an episode modal with a known parent series.
         *  Enables the hover chip and right-click menu even though isSeries is false. */
        hasSeriesContext?: boolean;
        /** Episode just marked watched — triggers undo label/style on the button. */
        justMarkedEpisode?: {
            seasonNumber: number;
            episodeNumber: number;
        } | null;
    }

    let {
        externalIds = undefined,
        mediaType = undefined,
        title = '',
        overview = '',
        year = undefined,
        rating = undefined,
        criticRating = undefined,
        isAvailable = false,
        canRequest = false,
        sonarrHasFile = false,
        isSeries = false,
        seasonNumber = undefined,
        episodeNumber = undefined,
        seriesName = undefined,
        seriesInternalId = undefined,
        audiobookResumePositionMs = 0,
        audiobookDurationMs = 0,
        audiobookFinished = false,
        onaudiobookfinished,
        kavitaSeriesId = undefined,
        kavitaLibraryId = undefined,
        segmentChapters = undefined,
        nextEpisodeId = null,
        nextEpisode = null,
        nextEpisodeLoading = false,
        isWatched = false,
        watchedLoading = false,
        userRating = null,
        isNavigatingToPlayer = false,
        parentRegionFooter = '',
        sonarrSeriesId = undefined,
        genres = undefined,
        sonarrQuality = undefined,
        sonarrNetwork = undefined,
        sonarrAirDate = undefined,
        playlistContext = undefined,
        onwatch,
        onrated,
        oncleared,
        onclose,
        onclick,
        onsetprogress,
        onmarkallwatched,
        hasSeriesContext = false,
        justMarkedEpisode = null,
    }: Props = $props();

    // AudiobookShelf library-item id, for the deep link out to ABS.
    let audiobookshelfId = $derived(getExternalIdFor(externalIds, 'audiobookshelf'));
    let audiobookItemUrl = $derived.by(() => {
        const base = tryJoinUpstreamUrl(env.PUBLIC_AUDIOBOOKURL ?? '', '');
        if (!base || !audiobookshelfId) return null;
        // Keep the historical public-link default for an origin-only URL.
        // An explicit base path already names the ABS mount and is used as-is.
        const prefix = new URL(base, 'http://localhost').pathname === '/' ? '/audiobookshelf' : '';
        return tryJoinUpstreamUrl(base, `${prefix}/item/${encodeURIComponent(audiobookshelfId)}`);
    });
    let playableId = $derived(getPlayableId({ externalIds }));

    // Starting a book is one round trip (open the AudiobookShelf session, write
    // the play_sessions row, mint a stream token) before anything is audible,
    // so the button has to say so or it reads as dead.
    let audiobookStarting = $state(false);

    /**
     * "Listen" is a lie on a book you are twenty hours into.
     *
     * Three states, in the order they matter to someone opening the modal:
     * mid-book (offer to continue, and say how much is left), finished (offer
     * to start over, so the button is not silently the same as never-started),
     * and untouched.
     */
    const audiobookRemainingMs = $derived(
        audiobookDurationMs > 0 && audiobookResumePositionMs > 0
            ? Math.max(0, audiobookDurationMs - audiobookResumePositionMs)
            : 0,
    );
    const audiobookInProgress = $derived(
        !audiobookFinished && audiobookRemainingMs > 0 && audiobookResumePositionMs > 0,
    );
    const audiobookCta = $derived(
        audiobookInProgress
            ? m.modal_audiobook_resume({ remaining: formatRemaining(audiobookRemainingMs) })
            : audiobookFinished
              ? m.modal_audiobook_relisten()
              : m.modal_listen(),
    );

    /** `22h 47m` / `47m` — the same shape the modal already prints for length. */
    function formatRemaining(ms: number): string {
        const minutes = Math.max(1, Math.round(ms / 60_000));
        const h = Math.floor(minutes / 60);
        const min = minutes % 60;
        return h > 0 ? `${h}h ${min}m` : `${min}m`;
    }
    let audiobookSharing = $state<{
        shared: boolean;
        globallyShared: boolean;
        effectiveShared: boolean;
    } | null>(null);
    let audiobookSharingLoading = $state(false);

    async function loadAudiobookSharing(): Promise<void> {
        const mediaId = externalIds?.internal;
        if (!mediaId || !isAudiobook(mediaType)) return;
        try {
            const { data, error } = await contentApi.getListeningSharing(mediaId);
            if (!error && data) audiobookSharing = data;
        } catch {
            // Optional privacy affordance stays absent if the preference read fails.
        }
    }

    let audiobookFinishing = $state(false);

    // Finishing clears the listening position here and in AudiobookShelf, and
    // there is no "unfinish" (the sync never pushes isFinished: false), so ask.
    async function markAudiobookFinished(): Promise<void> {
        if (!onaudiobookfinished || audiobookFinishing) return;
        try {
            await confirmDialog({
                title: m.modal_audiobook_confirm_finished_title(),
                body: m.modal_audiobook_confirm_finished_body({ title }),
                confirmText: m.modal_audiobook_mark_finished(),
            });
        } catch {
            return;
        }
        audiobookFinishing = true;
        try {
            await onaudiobookfinished();
        } finally {
            audiobookFinishing = false;
        }
    }

    let audiobookSharingTooltip = $derived(
        !audiobookSharing
            ? ''
            : !audiobookSharing.globallyShared
              ? m.modal_audiobook_sharing_off()
              : audiobookSharing.shared
                ? m.modal_audiobook_sharing_shared_tooltip()
                : m.modal_audiobook_sharing_private_tooltip(),
    );

    async function toggleAudiobookSharing(): Promise<void> {
        const mediaId = externalIds?.internal;
        if (!mediaId || !audiobookSharing || audiobookSharingLoading) return;
        // Not `disabled` when sharing is off in Settings, so the tooltip that
        // explains why still shows on hover. The click just does nothing.
        if (!audiobookSharing.globallyShared) return;
        const previous = audiobookSharing;
        const shared = !previous.shared;
        audiobookSharing = {
            ...previous,
            shared,
            effectiveShared: shared && previous.globallyShared,
        };
        audiobookSharingLoading = true;
        try {
            const { data, error } = await contentApi.updateListeningSharing(mediaId, shared);
            if (error || !data) {
                audiobookSharing = previous;
                toasts.error(m.modal_audiobook_sharing_error());
            } else {
                audiobookSharing = data;
                toasts.success(m.modal_audiobook_sharing_updated());
            }
        } catch {
            audiobookSharing = previous;
            toasts.error(m.modal_audiobook_sharing_error());
        } finally {
            audiobookSharingLoading = false;
        }
    }

    /**
     * Share button — installed PWA only. There is no address bar in an
     * installed app, so the link to a title cannot be copied by hand; in a
     * normal browser tab the button would be redundant. Hands over the same
     * `?modal=` deep link the card context menu copies, so a recipient lands
     * on this detail modal. Resolved in onMount — isPWAInstalled() reads
     * `window`.
     */
    let isInstalledPWA = $state(false);
    // `mediaType` arrives here as a loose string (the prop accepts any), while
    // buildMediaShareId takes the UniversalMediaItem union. Convert through the
    // sanctioned domain converter rather than asserting: an unrecognised value
    // becomes undefined, the builder returns null, and sharing is simply not
    // offered — instead of minting a share id with a bogus type in it.
    let shareId = $derived(
        externalIds
            ? buildMediaShareId({
                  externalIds,
                  mediaType: toUniversalMediaType(mediaType) ?? undefined,
              })
            : null,
    );
    let canShare = $derived(isInstalledPWA && !!shareId);

    function handleShare(): void {
        if (!shareId) return;
        const url = new URL(`${base}/`, window.location.origin);
        url.searchParams.set('modal', shareId);
        void shareOrCopy({ title: title || shareId, url: url.toString() });
    }

    onMount(() => {
        isInstalledPWA = isPWAInstalled();
        void loadAudiobookSharing();
    });

    /**
     * `playAudiobook` is imported STATICALLY on purpose.
     *
     * A `await import(...)` here would be the tidier-looking option and is the
     * pattern used elsewhere in this file, but WebKit refuses both `play()` and
     * `AudioContext` outside a trusted user gesture, and a dynamic import
     * inserts a network round trip between the click and the first thing that
     * needs that gesture. The store's own backend construction is already one
     * await deep; adding a module fetch in front of it is the difference
     * between "usually works on Safari" and "works".
     */
    async function startAudiobook(): Promise<void> {
        const mediaId = externalIds?.internal;
        if (!mediaId || audiobookStarting) return;
        audiobookStarting = true;
        try {
            const started = await playAudiobook(mediaId);
            if (!started) {
                // The store's error has nowhere to render when the book never
                // opened: both player surfaces are gated on `book !== null`. So
                // the toast IS the error surface here, and the modal stays open
                // — closing it would leave the listener with nothing at all.
                toasts.error(audiobookStartFailureMessage());
                return;
            }
            // Close the modal once the book is running.
            //
            // Every other play path navigates away (to /watch), so nothing ever
            // needed to close this. An audiobook keeps you on the page, and the
            // modal then sits on top of the mini-player it just created —
            // measured in a real browser: the modal layer swallowed every click
            // aimed at the new bar, including the pause button. A player you
            // cannot reach is not a player.
            onclose?.();
        } finally {
            audiobookStarting = false;
        }
    }

    // Watched button: context menu for series (right-click + long-press)
    let watchedMenuPos = $state<{ x: number; y: number } | null>(null);
    // true when opened by long-press (touch) → renders as bottom sheet per existing UX
    let watchedMenuMobile = $state(false);

    let watchedMenuItems = $derived.by<ContextMenuEntry[]>(() => {
        const items: ContextMenuEntry[] = [];
        // "Mark all episodes" is only correct for series modals — its label and
        // toggle direction read isWatched as the SERIES state. On episode sub-
        // modals isWatched is the episode's state, which would mislabel and
        // toggle the wrong direction. Episode users get the picker-based
        // "Manage watch progress" instead.
        if (isSeries && onmarkallwatched) {
            items.push({
                label: isWatched
                    ? m.modal_mark_all_episodes_unwatched()
                    : m.modal_mark_all_episodes_watched(),
                onSelect: async () => {
                    watchedMenuPos = null;
                    // Unwatch-all wipes the entire series' watch history in one
                    // tap — require confirmation. Marking watched is
                    // non-destructive and stays one-tap.
                    const wasWatched = isWatched;
                    if (wasWatched) {
                        try {
                            await confirmDialog({
                                body: m.modal_confirm_unwatch_all_body({ title }),
                                confirmText: m.modal_mark_all_episodes_unwatched(),
                                confirmVariant: 'danger',
                            });
                        } catch {
                            // User cancelled — leave watch history intact.
                            return;
                        }
                        // Watch state can flip during the confirm dialog (another
                        // device / background sync). Abort if the direction we
                        // confirmed no longer applies, so we never perform the
                        // opposite (now-unconfirmed) action.
                        if (!isWatched) return;
                    }
                    onmarkallwatched?.();
                },
            });
        }
        if ((isSeries || hasSeriesContext) && onsetprogress) {
            items.push({
                label: m.modal_manage_watch_progress(),
                onSelect: () => {
                    watchedMenuPos = null;
                    onsetprogress();
                },
            });
        }
        return items;
    });

    /**
     * Action-mode override label — non-null when the watched button is in
     * "perform an action" mode rather than "toggle scope" mode. Two cases:
     *  1. Just-marked undo state ("S2E5 watched — undo?")
     *  2. Series with a known next episode ("Mark S2E5 as watched")
     * When this is null, the button is a scope-aware toggle and falls back
     * to watchedScopeLabel / watchedScopeTitle below.
     */
    let watchedActionLabel = $derived(
        justMarkedEpisode
            ? m.modal_se_watched_undo({
                  season: String(justMarkedEpisode.seasonNumber),
                  episode: String(justMarkedEpisode.episodeNumber),
              })
            : isSeries && nextEpisode && nextEpisodeId
              ? m.modal_mark_se_as_watched({
                    season: String(nextEpisode.seasonNumber),
                    episode: String(nextEpisode.episodeNumber),
                })
              : null,
    );

    /**
     * Scope-aware visible label for the watched button when no action-mode
     * override is in effect. Picks the right "Mark X as watched" / "X
     * watched" text based on media type so the user always knows exactly
     * what scope the button toggles.
     */
    let watchedScopeLabel = $derived.by(() => {
        // Episode modal with explicit S/E props — most specific
        if (isEpisode && seasonNumber != null && episodeNumber != null) {
            const params = {
                season: String(seasonNumber),
                episode: String(episodeNumber),
            };
            return isWatched ? m.modal_se_watched(params) : m.modal_mark_se_as_watched(params);
        }
        if (isEpisode) {
            return isWatched ? m.modal_episode_watched() : m.modal_mark_episode_watched();
        }
        if (isSeriesType(mediaType)) {
            return isWatched ? m.modal_series_watched() : m.modal_mark_series_watched();
        }
        return isWatched ? m.modal_movie_watched() : m.modal_mark_movie_watched();
    });

    /**
     * Scope-aware action description for hover/aria. Always action-oriented
     * ("Mark X as watched/unwatched") so screen readers announce the click
     * outcome regardless of current state.
     */
    let watchedScopeTitle = $derived.by(() => {
        if (isEpisode && seasonNumber != null && episodeNumber != null) {
            const params = {
                season: String(seasonNumber),
                episode: String(episodeNumber),
            };
            return isWatched
                ? m.modal_mark_se_as_unwatched(params)
                : m.modal_mark_se_as_watched(params);
        }
        if (isEpisode) {
            return isWatched ? m.modal_mark_episode_unwatched() : m.modal_mark_episode_watched();
        }
        if (isSeriesType(mediaType)) {
            return isWatched ? m.modal_mark_series_unwatched() : m.modal_mark_series_watched();
        }
        return isWatched ? m.modal_mark_movie_unwatched() : m.modal_mark_movie_watched();
    });

    function openWatchedMenu(x: number, y: number, mobile: boolean): void {
        watchedMenuMobile = mobile;
        watchedMenuPos = { x, y };
    }

    function handleWatchedContextMenu(e: MouseEvent): void {
        if (watchedMenuItems.length === 0) return;
        e.preventDefault();
        openWatchedMenu(e.clientX, e.clientY, false);
    }

    // UUID-first key for internal player navigation
    let mediaKey = $derived(
        buildMediaKey(
            externalIds,
            (mediaType ?? 'movie') as import('$lib/types/api-common').ApiMediaType,
        ) ?? '',
    );

    // Helper to get the watch URL
    function getWatchUrl(id: string, key?: string): string {
        const resolvedKey = key ?? id;
        let url = `/watch/${resolvedKey}`;
        if (playlistContext) {
            url += `?playlist=${playlistContext.playlistId}&position=${playlistContext.position}`;
        }
        return url;
    }

    function shouldOpenNewTab(): boolean {
        return false;
    }

    async function handleWatchClick(event: MouseEvent, url: string) {
        // Save return path BEFORE closing modal so the URL still has ?modal= param.
        // This allows the modal to reopen when navigating back from the player.
        event.preventDefault();
        saveReturnPath();
        // Signal that a player navigation is in progress so Search.svelte's
        // reopen $effect does not fire while the modal-close goto races the
        // player goto.
        setNavigatingToPlayer();
        // Await the modal close (which contains its own goto to strip ?modal=)
        // before issuing the player goto so the two navigations don't race.
        try {
            await onwatch?.({ itemId: playableId! });
        } catch {
            clearNavigatingToPlayer();
            return;
        }
        goto(resolve(url));
    }

    function handleRated(detail: {
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        rating: number;
        title: string;
    }) {
        onrated?.(detail);
    }

    function handleCleared(detail: {
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        title: string;
    }) {
        oncleared?.(detail);
    }

    function handleClose() {
        onclose?.();
    }

    // Type helper for API calls - must be 'movie' or 'tv'.
    //
    // `?? 'movie'` is unreachable for every consumer: `normalizedMediaType` is
    // only passed to <AIRatingButton>, <WatchlistButton> and <PlaylistButton>,
    // all three of which sit behind `showRatingButton` / `showWatchlistButton`,
    // and both of those require `isMovie(mediaType) || isSeriesType(mediaType)` —
    // exactly the set `toTmdbType` answers non-null for. It is a checked fallback
    // rather than an assertion so that relaxing either gate degrades HERE, where
    // the substitution is written down and reviewable, instead of silently
    // everywhere (which is what the old total `toTmdbType` did).
    function getNormalizedMediaType(): 'movie' | 'tv' {
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- this action is gated to movie/series media.
        return toTmdbType(mediaType) ?? 'movie';
    }

    // Debug panel state
    let showDebugPanel = $state(false);

    // Permission check - admin OR arrManager
    let isAdminOrArrManager = $derived.by(() => {
        const userGroups = (($page.data.user?.userGroups as string[] | undefined) || []).map((g) =>
            g.toLowerCase(),
        );
        const adminGroups = (($page.data.adminGroups as string[] | undefined) || []).map((g) =>
            g.toLowerCase(),
        );
        const arrManagerGroups = (($page.data.arrManagerGroups as string[] | undefined) || []).map(
            (g) => g.toLowerCase(),
        );

        return [...adminGroups, ...arrManagerGroups].some((group) => userGroups.includes(group));
    });

    // Service URLs from page data
    let serviceUrls = $derived(
        $page.data.serviceUrls || {
            jellyfin: '',
            sonarr: '',
            radarr: '',
            jellyseerr: '',
        },
    );

    // Feature flag for request modal and user permission
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // Check if we have valid external IDs for request
    let hasValidExternalIds = $derived(externalIds && Object.keys(externalIds).length > 0);
    // A submitted movie is already being handled. Keep the action in sync
    // with its progress instead of inviting a duplicate submission. Series
    // still open the season selector so additional seasons remain requestable.
    let trackedMovieRequest = $derived(
        isMovie(mediaType)
            ? $requestNotifications.notifications.find(
                  (request) =>
                      request.mediaType === 'movie' &&
                      request.status !== 'unavailable' &&
                      Object.entries(externalIds ?? {}).some(
                          ([provider, id]) =>
                              !!id &&
                              Object.entries(request.externalIds).some(
                                  ([requestProvider, requestId]) =>
                                      requestProvider === provider && requestId === id,
                              ),
                      ),
              )
            : undefined,
    );
    let trackedMovieKey = $derived(
        trackedMovieRequest ? buildMediaKey(trackedMovieRequest.externalIds, 'movie') : null,
    );
    // Derived - media value object for canPlayDirectly
    let mediaValue = $derived({
        mediaType,
        isAvailable,
        sonarrHasFile,
        availabilitySource: isAvailable ? 'lumastra' : undefined,
    });
    // Determine if we should show various buttons
    let showWatchButton = $derived(
        isAudiobook(mediaType) ||
            (playableId && canPlayDirectly(mediaValue)) ||
            (playableId && !isSeries) ||
            (playableId && isSeries && (nextEpisodeId || nextEpisodeLoading)),
    );
    let showRatingButton = $derived(
        (hasValidExternalId(externalIds) && (isMovie(mediaType) || isSeriesType(mediaType))) ||
            (isEpisodeType(mediaType) && !!externalIds?.internal),
    );
    let showWatchlistButton = $derived(
        hasValidExternalId(externalIds) && (isMovie(mediaType) || isSeriesType(mediaType)),
    );
    // Episode playlists need the episode's own catalog ID, never a parent ID
    // or a TMDB episode number masquerading as an entity identity.
    let showPlaylistButton = $derived(
        $page.data?.features?.playlists === true &&
            (showWatchlistButton ||
                (isEpisodeType(mediaType) &&
                    !!externalIds?.internal &&
                    UUID_RE.test(externalIds.internal))),
    );
    // Series ids for the playlist entry: the internal series UUID.
    let playlistSeriesIds = $derived(
        seriesInternalId && UUID_RE.test(seriesInternalId)
            ? { internal: seriesInternalId }
            : undefined,
    );
    // Only show watched button if content is actually available (has a playable id)
    // Exclude audiobooks (their progress lives in AudiobookShelf).
    //
    // `!isAudiobook(...)`, not `mediaType !== 'AUDIOBOOK'`: three case
    // conventions exist for media types, and this prop is only uppercase
    // because openMediaModal() happens to upper-case it on the way in. A caller
    // that passes the DB-canonical lowercase 'audiobook' would have slipped
    // past the bare string compare and shown "Mark Movie as watched" on a book.
    let showWatchedButton = $derived(
        playableId && !isAudiobook(mediaType) && (isAvailable || canPlayDirectly(mediaValue)),
    );
    let normalizedMediaType = $derived(getNormalizedMediaType());
    let isEpisode = $derived(isEpisodeType(mediaType));

    // Seen-aware rating: only `isWatched` is exposed to this component as a
    // watch-state signal (the modal does not thread playCount / completion /
    // in-progress here). A previously-set userRating also implies the user has
    // engaged with the title, so treat that as seen too.
    // TODO: thread inProgress / playCount / completionPercentage from the modal
    //       data into ModalActions for a more precise seen determination.
    let seen = $derived(isWatched || userRating != null);

    /**
     * Scope-aware label for the Watch / Play button.
     *
     * Always shows "Watch SxEx" for episode and series modals so the user
     * knows exactly which episode will play. Resolution priority:
     *  1. Loaded nextEpisode (most accurate — what the API returned)
     *  2. seasonNumber/episodeNumber props (covers loading state and URL
     *     deep-links like ?season=8&episode=15 before the API resolves)
     *  3. "Watch Movie" for movies
     *  4. Plain "Watch" as a last-resort fallback
     *
     * Uses `!= null` rather than truthy checks so S0 specials (e.g. S0E1)
     * also get the explicit label.
     */
    let watchButtonLabel = $derived.by(() => {
        if (nextEpisode && nextEpisode.seasonNumber != null && nextEpisode.episodeNumber != null) {
            return m.modal_watch_se({
                season: String(nextEpisode.seasonNumber),
                episode: String(nextEpisode.episodeNumber),
            });
        }
        // Whenever we have a concrete season+episode to play, label it as that
        // episode — regardless of mediaType. Some episode-opened modals resolve
        // to their series but carry mediaType='movie', which previously fell
        // through to the "Watch Movie" label despite showing an S/E context.
        // Movies never carry season/episode, so they're unaffected.
        if (seasonNumber != null && episodeNumber != null) {
            return m.modal_watch_se({
                season: String(seasonNumber),
                episode: String(episodeNumber),
            });
        }
        if (isEpisode || isSeriesType(mediaType)) {
            return m.modal_watch();
        }
        if (isMovie(mediaType)) {
            return m.modal_watch_movie();
        }
        return m.modal_watch();
    });

    /**
     * Collapsed "Rate" trigger visual state — mirrors the active-state
     * thresholds AIRatingButton uses for its quick-rating buttons (for-you
     * context: thumbs-down <=3, thumbs-up 6-8, love >=9) so the trigger's
     * icon/accent matches whichever quick button is highlighted inside the
     * popover. Ratings in the 4-5 gap only occur via the 10-star picker, so
     * they fall back to a neutral star + numeric label.
     */
    let rateState = $derived.by(() => {
        if (userRating == null) {
            return { emoji: '⭐', accentClass: '', label: m.modal_rate() };
        }
        if (userRating <= 3) {
            return { emoji: '👎', accentClass: 'rate-trigger-negative', label: `${userRating}/10` };
        }
        if (userRating >= 9) {
            return { emoji: '❤️', accentClass: 'rate-trigger-love', label: `${userRating}/10` };
        }
        if (userRating >= 6) {
            return { emoji: '👍', accentClass: 'rate-trigger-positive', label: `${userRating}/10` };
        }
        return { emoji: '⭐', accentClass: 'rate-trigger-neutral', label: `${userRating}/10` };
    });

    let rateAriaLabel = $derived(
        userRating != null
            ? m.rating_current_click_to_change({ rating: userRating })
            : m.modal_rate(),
    );

    // Scroll overflow tracking for the action-bar edge fade. The bar is a
    // non-wrapping scroller at every width now (see .actions-scroller in the
    // style block below), so this applies on desktop too — it used to be
    // visually active only under a narrow-viewport media query. (NB: a
    // literal style tag in this comment breaks svelte-check's script/style
    // block extraction.)
    let footerEl = $state<HTMLElement | undefined>(undefined);
    let showLeftFade = $state(false);
    let showRightFade = $state(false);

    function updateFadeVisibility(): void {
        const el = footerEl;
        if (!el) return;
        showLeftFade = el.scrollLeft > 0;
        showRightFade = el.scrollLeft + el.clientWidth < el.scrollWidth;
    }

    $effect(() => {
        // Re-evaluate whenever the set of rendered action buttons can
        // change — reading these flags registers them as effect
        // dependencies (mirrors Tabs.svelte's items.length tracking).
        showWatchButton;
        showRatingButton;
        showWatchlistButton;
        showWatchedButton;
        isAdminOrArrManager;
        isAvailable;
        canRequest;
        isEpisode;
        nextEpisodeLoading;
        watchedLoading;
        justMarkedEpisode;
        updateFadeVisibility();
    });

    // A pure viewport-size change (device rotation, zoom/text-size change)
    // touches neither the footer's own scroll event nor any of the flags
    // tracked above, so the fade masks can otherwise go stale after resize.
    // Re-measure via ResizeObserver on the footer element itself.
    $effect(() => {
        const el = footerEl;
        if (!el) return;
        const observer = new ResizeObserver(() => updateFadeVisibility());
        observer.observe(el);
        return () => observer.disconnect();
    });
</script>

<footer
    bind:this={footerEl}
    class="modal-footer relative mb-2 sm:mb-2 flex items-end gap-2 w-full max-w-full modal-footer-safe actions-scroller {parentRegionFooter}"
    class:show-left-fade={showLeftFade}
    class:show-right-fade={showRightFade}
    onscroll={updateFadeVisibility}>
    <!-- Audiobook: play IN Lumastra.
         This used to be a link out to the AudiobookShelf web UI, which was the
         only option while the player did not exist. It now starts the in-app
         player, which is what makes the byte proxy, the virtual timeline and
         the accidental-seek protection reachable at all. The out-link is kept
         beside it — an operator's own AudiobookShelf is still the place to go
         for anything this player deliberately does not do (downloads,
         bookmarks). -->
    <!-- Book/manga/comic: content lives in Kavita, so the one primary action is
         the deep link out — always a new tab (external link pattern, like the
         AudiobookShelf out-link below). -->
    {#if isBookMediaType(mediaType)}
        {@const kavitaUrl = kavitaSeriesUrl(kavitaSeriesId, kavitaLibraryId)}
        {#if kavitaUrl}
            <a
                href={kavitaUrl}
                data-testid="book-read"
                class="btn variant-filled-primary modal-watch-cta"
                target="_blank"
                rel="noreferrer"
                title="Kavita">
                📖 {m.card_read()}
            </a>
        {/if}
    {:else if isAudiobook(mediaType)}
        <button
            type="button"
            data-testid="audiobook-listen"
            class="btn variant-filled-primary modal-watch-cta"
            disabled={!externalIds?.internal || !isAvailable || audiobookStarting}
            onclick={startAudiobook}>
            {audiobookCta}
        </button>
        {#if audiobookItemUrl}
            <a
                href={audiobookItemUrl}
                class="btn variant-ghost-surface"
                target="_blank"
                rel="noreferrer">
                AudiobookShelf
            </a>
        {/if}
        {#if onaudiobookfinished && !audiobookFinished}
            <button
                type="button"
                data-testid="audiobook-mark-finished"
                class="btn variant-ghost-surface inline-flex items-center gap-2 min-h-10"
                disabled={!externalIds?.internal || audiobookFinishing}
                aria-busy={audiobookFinishing}
                aria-label={m.modal_audiobook_mark_finished()}
                title={m.modal_audiobook_mark_finished()}
                onclick={markAudiobookFinished}>
                <Icon src={Check} class="w-5 h-5" aria-hidden="true" />
                <span class="hidden sm:inline">{m.modal_audiobook_mark_finished()}</span>
            </button>
        {/if}
        {#if audiobookSharing}
            <!-- Icon-only: a per-book privacy control on EVERY audiobook, so it
                 must not sit at the primary CTA's weight. The icon shows the
                 current state (eye = others can see your progress), and the
                 tooltip says what that means and what a click does. -->
            <Tooltip text={audiobookSharingTooltip} position="top" inline fixed>
                <button
                    type="button"
                    data-testid="audiobook-sharing"
                    class="btn variant-ghost-surface inline-flex items-center gap-1.5 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    disabled={audiobookSharingLoading}
                    aria-disabled={!audiobookSharing.globallyShared}
                    aria-label={audiobookSharingTooltip}
                    aria-pressed={audiobookSharing.globallyShared
                        ? audiobookSharing.shared
                        : undefined}
                    onclick={toggleAudiobookSharing}>
                    <Icon
                        src={audiobookSharing.shared && audiobookSharing.globallyShared
                            ? Eye
                            : EyeSlash}
                        class="h-4 w-4"
                        aria-hidden="true" />
                </button>
            </Tooltip>
        {/if}

        <!-- Episode not yet available (future episode from calendar) - check early! -->
    {:else if isEpisode && isAvailable === false}
        <span class="text-surface-400 text-sm italic flex items-center h-9"
            >{m.modal_not_available_yet()}</span>

        <!-- Playable content (movies, episodes with files) -->
    {:else if playableId && canPlayDirectly(mediaValue)}
        <a
            href={getWatchUrl(playableId, mediaKey)}
            class="btn variant-filled-primary modal-watch-cta inline-flex items-center gap-1"
            target={shouldOpenNewTab() ? '_blank' : undefined}
            onclick={(e) => handleWatchClick(e, getWatchUrl(playableId, mediaKey))}
            aria-label={m.modal_watch_title({ title })}>
            {#if isNavigatingToPlayer}
                <span
                    class="loading-spinner loading-spinner-white"
                    role="status"
                    aria-label={m.loading()}></span>
            {:else}
                <span aria-hidden="true"
                    ><BrandedPlayIcon size="w-4 h-4" color="text-white" /></span>
            {/if}
            <span class="ml-1">{watchButtonLabel}</span>
        </a>
        <!-- Segment play buttons for combined episodes (internal player only — external can't seek) -->
        {#if segmentChapters && segmentChapters.length >= 2}
            {#each segmentChapters as chapter, chapterIdx (chapter.name + '__' + chapterIdx)}
                {@const startSeconds = Math.floor(chapter.startMs / 1000)}
                <a
                    href={getWatchUrl(playableId, mediaKey) + `?t=${startSeconds}`}
                    class="btn variant-soft-primary inline-flex items-center gap-1 text-sm"
                    target={shouldOpenNewTab() ? '_blank' : undefined}
                    onclick={(e) =>
                        handleWatchClick(
                            e,
                            getWatchUrl(playableId, mediaKey) + `?t=${startSeconds}`,
                        )}
                    aria-label={m.modal_play_chapter_aria({
                        name: chapter.name,
                    })}>
                    <span aria-hidden="true"
                        ><BrandedPlayIcon size="w-3 h-3" color="text-primary-400" /></span>
                    <span>{chapter.name}</span>
                </a>
            {/each}
        {/if}

        <!-- Non-series item in Jellyfin (only if available) -->
    {:else if playableId && !isSeries && isAvailable}
        <a
            href={getWatchUrl(playableId, mediaKey)}
            class="btn variant-filled-primary modal-watch-cta inline-flex items-center gap-1"
            target={shouldOpenNewTab() ? '_blank' : undefined}
            onclick={(e) => handleWatchClick(e, getWatchUrl(playableId, mediaKey))}
            aria-label={m.modal_watch_title({ title })}>
            {#if isNavigatingToPlayer}
                <span
                    class="loading-spinner loading-spinner-white"
                    role="status"
                    aria-label={m.loading()}></span>
            {:else}
                <span aria-hidden="true"
                    ><BrandedPlayIcon size="w-4 h-4" color="text-white" /></span>
            {/if}
            <span class="ml-1">{watchButtonLabel}</span>
        </a>

        <!-- Series - play next episode if available -->
    {:else if playableId && isSeries && isAvailable}
        {#if nextEpisodeLoading}
            <button
                class="btn variant-filled-primary modal-watch-cta inline-flex items-center gap-1 opacity-70"
                disabled
                aria-label={watchButtonLabel}>
                <span
                    class="loading-spinner loading-spinner-white w-4 h-4"
                    role="status"
                    aria-label={m.loading()}></span>
                <span class="ml-1">{watchButtonLabel}</span>
            </button>
        {:else if nextEpisodeId && nextEpisode?.playable === false}
            <!-- The modal targets an episode without a file (not aired or not
                 downloaded). Keep its label and grey it out; playing some other
                 episode instead would be surprising. -->
            <button
                class="btn variant-filled-primary modal-watch-cta inline-flex items-center gap-1 opacity-50 cursor-not-allowed"
                disabled
                title={m.modal_not_available_yet()}
                aria-label={`${watchButtonLabel} – ${m.modal_not_available_yet()}`}>
                <span aria-hidden="true"
                    ><BrandedPlayIcon size="w-4 h-4" color="text-white" /></span>
                <span class="ml-1">{watchButtonLabel}</span>
            </button>
        {:else if nextEpisodeId}
            <a
                href={withWatchEntry(getWatchUrl(nextEpisodeId), 'next_up')}
                class="btn variant-filled-primary modal-watch-cta inline-flex items-center gap-1"
                target={shouldOpenNewTab() ? '_blank' : undefined}
                onclick={(e) =>
                    handleWatchClick(e, withWatchEntry(getWatchUrl(nextEpisodeId), 'next_up'))}
                aria-label={watchButtonLabel}>
                {#if isNavigatingToPlayer}
                    <span
                        class="loading-spinner loading-spinner-white w-4 h-4"
                        role="status"
                        aria-label={m.loading()}></span>
                {:else}
                    <span aria-hidden="true"
                        ><BrandedPlayIcon size="w-4 h-4" color="text-white" /></span>
                {/if}
                <span class="ml-1">{watchButtonLabel}</span>
            </a>
        {:else}
            <a
                href={getWatchUrl(playableId, mediaKey)}
                class="btn variant-filled-primary modal-watch-cta inline-flex items-center gap-1"
                target={shouldOpenNewTab() ? '_blank' : undefined}
                onclick={(e) => handleWatchClick(e, getWatchUrl(playableId, mediaKey))}
                aria-label={watchButtonLabel}>
                {#if isNavigatingToPlayer}
                    <span
                        class="loading-spinner loading-spinner-white w-4 h-4"
                        role="status"
                        aria-label={m.loading()}></span>
                {:else}
                    <span aria-hidden="true"
                        ><BrandedPlayIcon size="w-4 h-4" color="text-white" /></span>
                {/if}
                <span class="ml-1">{watchButtonLabel}</span>
            </a>
        {/if}

        <!-- File exists but not in Jellyfin -->
    {:else if sonarrHasFile}
        <span class="text-surface-400 text-sm">{m.modal_file_not_available()}</span>

        <!-- Request button (only if user has permission) -->
    {:else if canRequest && hasValidExternalIds}
        {#if hasRequestPermission}
            {#if requestsEnabled}
                {#if trackedMovieRequest?.status === 'available' && trackedMovieKey}
                    <a
                        class="btn variant-filled-primary"
                        href={resolve(`/watch/${trackedMovieKey}`)}
                        onclick={() => saveReturnPath()}>
                        {m.req_watch_now()}
                    </a>
                {:else if trackedMovieRequest}
                    <span class="text-surface-400 text-sm" role="status">
                        {trackedMovieRequest.statusMessage ||
                            getStatusLabel(trackedMovieRequest.status)}
                    </span>
                {:else}
                    <button
                        class="btn btn variant-filled-primary"
                        onclick={() => {
                            const isTV = isSeriesType(mediaType);

                            if (isTV) {
                                // Replace current modal with season selector for TV shows
                                modals.replace(SeasonSelectorModal, {
                                    externalIds: externalIds,
                                    title: title,
                                    overview: overview,
                                    year: year != null ? String(year) : undefined,
                                    posterPath: externalIds
                                        ? imageFromIds(externalIds, 'poster', 'tv', {
                                              size: 'card',
                                          }) || undefined
                                        : undefined,
                                });
                            } else {
                                // Replace current modal with request modal for movies
                                openRequestModal({
                                    externalIds: externalIds,
                                    mediaType: 'movie',
                                    title: title,
                                    overview: overview,
                                    year: year != null ? String(year) : undefined,
                                    posterPath: externalIds
                                        ? imageFromIds(externalIds, 'poster', 'movie', {
                                              size: 'card',
                                          }) || undefined
                                        : undefined,
                                });
                            }
                        }}>
                        {m.request()}
                    </button>
                {/if}
            {:else}
                {@const requestId = (() => {
                    // This branch is inside `{:else if canRequest && hasValidExternalIds}`,
                    // and only movies and series are requestable — so the narrowing
                    // cannot fail. Guarded rather than interpolated directly: a null
                    // would have been stringified into the key as the literal "null".
                    const type = toTmdbType(mediaType);
                    const preferred = getPreferredExternalId(externalIds);
                    return preferred && type ? `${preferred.provider}:${preferred.id}:${type}` : '';
                })()}
                <a
                    href={apiUrl(
                        'internal',
                        `/request/redirect?id=${encodeURIComponent(requestId)}`,
                    )}
                    class="btn btn variant-filled-primary"
                    target="_blank">
                    {m.request()}
                </a>
            {/if}
        {:else}
            <!-- User doesn't have request permission - show info only -->
            <span class="text-surface-400 text-sm">{m.modal_not_available()}</span>
        {/if}
    {/if}

    {#if isEpisode}
        <!--
            Context indicator. All action buttons (Watch, Rate, Watched, etc.)
            on episode modals act on the episode itself, not the parent series.
            This single label communicates that scope globally so individual
            buttons don't need per-button captions.

            It sits AFTER the primary action deliberately. When it led the
            footer, its own width ("Episode S1E5" vs "Episode S10E100") set
            where the Watch button started, so episode modals put Watch at a
            different offset than movie and series modals -- and drifted
            between episodes. Trailing the button instead, its width feeds into
            nothing: Watch starts at the footer's left edge on every media
            type, and the spacer below still absorbs whatever the indicator
            leaves over. This is why it needs no min-width.
        -->
        <div class="self-center inline-flex items-center gap-1.5 text-xs text-surface-400">
            <Icon src={Film} class="w-3.5 h-3.5 opacity-70" aria-hidden="true" />
            <span>{m.modal_episode_indicator()}</span>
            {#if seasonNumber != null && episodeNumber != null}
                <span class="font-mono">S{seasonNumber}E{episodeNumber}</span>
            {/if}
        </div>
    {/if}

    <!-- Flexible spacer: everything above is the primary action slot (Watch /
         Listen / Request, or the "not available" placeholders), everything
         below is secondary. Absorbing the slack here pins the primary action
         to the footer's left edge, so its position stops depending on which
         secondary buttons happen to render for this item or this user — the
         complaint this layout exists to fix. Any future primary branch added
         above is anchored automatically.

         It grows only from sm upwards; below that the footer is a packed,
         left-aligned scroller where the primary action is already first and
         there is no slack to distribute. When the row overflows at any width
         the spacer collapses to zero and the row simply scrolls. -->
    <div class="hidden sm:block grow" aria-hidden="true"></div>

    <!-- "Go to Series" moved out of the action bar: the episode view's
         series-name subtitle (ModalHeader) is now the affordance. -->

    <!-- Rate button — collapses the thumbs-down/thumbs-up/love/star cluster
         behind a single trigger so it doesn't outweigh the primary Watch
         button. The trigger's icon/accent reflects the current rating (see
         rateState) so users see at a glance whether they've rated. For
         episodes: the bottom-left "Episode S?E?" indicator at the start of
         this footer makes the rate scope clear; the tooltip inside the
         popover spells out exactly which entity is being rated so users can
         confirm at a glance — especially useful when switching between
         series modals and episode sub-modals. -->
    {#if showRatingButton && externalIds}
        <ActionPopover
            ariaLabel={rateAriaLabel}
            panelRole="group"
            triggerClass="btn variant-ghost-surface flex items-center gap-2 {rateState.accentClass}"
            panelClass="p-3 bg-surface-800 border border-surface-600 rounded-lg shadow-xl">
            {#snippet trigger()}
                <span aria-hidden="true">{rateState.emoji}</span>
                <span class="hidden sm:inline">{rateState.label}</span>
            {/snippet}
            {#snippet content()}
                <Tooltip
                    text={isEpisode
                        ? m.modal_rating_tooltip_episode()
                        : isSeriesType(mediaType)
                          ? m.modal_rating_tooltip_series()
                          : m.modal_rating_tooltip_movie()}
                    position="top">
                    <AIRatingButton
                        {externalIds}
                        mediaType={normalizedMediaType}
                        {title}
                        currentRating={userRating}
                        context="for-you"
                        {seen}
                        onrated={handleRated}
                        oncleared={handleCleared} />
                </Tooltip>
            {/snippet}
        </ActionPopover>
    {/if}

    <!-- Watchlist Button -->
    {#if showWatchlistButton && externalIds}
        <WatchlistButton
            {externalIds}
            mediaType={normalizedMediaType}
            {title}
            {overview}
            rating={String(rating || 0)}
            {criticRating}
            {isAvailable}
            variant="button"
            size="md" />
    {/if}

    <!-- Playlist Button -->
    {#if showPlaylistButton && externalIds}
        <PlaylistButton
            {externalIds}
            mediaType={isEpisode ? 'episode' : normalizedMediaType}
            {title}
            {overview}
            {seasonNumber}
            {episodeNumber}
            {seriesName}
            seriesExternalIds={playlistSeriesIds}
            variant="ghost"
            size="md" />
    {/if}

    <!-- Share button (installed PWA only — see canShare). Icon-only: it sits
         beside Watchlist/Playlist and should not compete with the primary
         Watch action for width. -->
    {#if canShare}
        <button
            type="button"
            class="btn-icon variant-ghost-surface"
            onclick={handleShare}
            aria-label={m.modal_share_aria()}>
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                class="w-5 h-5"
                aria-hidden="true">
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
            </svg>
        </button>
    {/if}

    <!-- Admin overflow menu (admin/arrManager only): "Manage in Admin" +
         debug panel. Both are operator-only utilities that don't belong at
         top level alongside primary user actions — same permission gating
         as before, preserved per-item inside the popover. -->
    {#if isAdminOrArrManager}
        <ActionPopover
            ariaLabel={m.modal_more_actions()}
            triggerClass="btn-icon variant-ghost-surface"
            panelClass="min-w-48 bg-surface-800 border border-surface-600 rounded-lg shadow-xl py-1">
            {#snippet trigger()}
                <Icon src={EllipsisHorizontal} class="w-5 h-5" />
            {/snippet}
            {#snippet content({ close })}
                {#if externalIds?.internal}
                    <button
                        type="button"
                        role="menuitem"
                        class="w-full px-3 py-2 text-left hover:bg-surface-700 flex items-center gap-2 text-sm text-surface-100"
                        onclick={() => {
                            close();
                            modals.closeAll();
                            const adminUrl = `/admin/library/media/${externalIds?.internal}`;
                            const seasonQuery =
                                isEpisode && seasonNumber != null ? `?season=${seasonNumber}` : '';
                            goto(resolve(`${adminUrl}${seasonQuery}`));
                        }}>
                        <Icon src={Cog6Tooth} class="w-4 h-4 shrink-0" />
                        <span>{m.modal_manage_in_admin()}</span>
                    </button>
                {/if}
                <button
                    type="button"
                    role="menuitem"
                    class="w-full px-3 py-2 text-left hover:bg-surface-700 flex items-center gap-2 text-sm text-surface-100"
                    onclick={() => {
                        close();
                        showDebugPanel = true;
                    }}>
                    <Icon src={CodeBracket} class="w-4 h-4 shrink-0" />
                    <span>{m.modal_admin_debug_info_title()}</span>
                </button>
            {/snippet}
        </ActionPopover>
    {/if}

    <!-- Send to TV Button (only for available content) -->
    {#if externalIds?.internal && isAvailable}
        <SendToTVButton
            itemId={externalIds?.internal ?? ''}
            {title}
            mediaType={mediaType || 'movie'} />
    {/if}

    <!-- Mark as Watched Button -->
    {#if showWatchedButton}
        <div class="relative group">
            <button
                class="btn flex items-center gap-2 min-h-10 {justMarkedEpisode
                    ? 'variant-filled-success'
                    : watchedActionLabel
                      ? 'variant-ghost-surface'
                      : isWatched
                        ? 'variant-filled-success'
                        : 'variant-ghost-surface'}"
                {onclick}
                disabled={watchedLoading || (isSeries && nextEpisodeLoading)}
                title={watchedActionLabel ?? watchedScopeTitle}
                aria-label={watchedActionLabel ?? watchedScopeTitle}
                aria-pressed={watchedActionLabel ? undefined : isWatched}
                aria-busy={watchedLoading || (isSeries && nextEpisodeLoading)}
                oncontextmenu={watchedMenuItems.length > 0 ? handleWatchedContextMenu : undefined}
                use:longPress={{ duration: 500, haptic: true }}
                onlongpress={(e) => {
                    if (watchedMenuItems.length > 0) openWatchedMenu(e.detail.x, e.detail.y, true);
                }}>
                {#if watchedLoading || (isSeries && nextEpisodeLoading)}
                    <span class="loading-spinner" role="status" aria-label={m.loading()}></span>
                {:else}
                    <Icon src={Check} class="w-5 h-5" aria-hidden="true" />
                {/if}
                <span class="hidden sm:inline">{watchedActionLabel ?? watchedScopeLabel}</span>
            </button>
            <!--
                Desktop-only secondary affordance. Hover the watched button
                and a chip pops up above to jump straight into the progress
                manager. Hidden on touch (sm-and-down) — touch users get the
                long-press bottom sheet instead.
            -->
            {#if (isSeries || hasSeriesContext) && onsetprogress && !justMarkedEpisode}
                <button
                    type="button"
                    class="hidden sm:inline-flex absolute bottom-full right-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-md text-sm bg-surface-700 text-surface-50 shadow-lg border border-surface-600 opacity-0 pointer-events-none translate-y-1 group-hover:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:translate-y-0 transition"
                    onclick={onsetprogress}
                    aria-label={m.modal_manage_series_watch_progress()}>
                    <Icon src={Check} class="w-4 h-4 opacity-70" aria-hidden="true" />
                    {m.modal_manage_watch_progress()}
                </button>
            {/if}
        </div>
        {#if watchedMenuPos}
            <ContextMenu
                x={watchedMenuPos.x}
                y={watchedMenuPos.y}
                items={watchedMenuItems}
                mobileSheet={watchedMenuMobile}
                onClose={() => (watchedMenuPos = null)} />
        {/if}
    {/if}

    <!-- Close button -->
    <button
        class="btn variant-ghost-surface center w-9 h-9 !p-0 rounded-full"
        onclick={handleClose}
        aria-label={m.close()}
        title={m.close()}>
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12" />
        </svg>
    </button>
</footer>

<!-- Debug Panel Overlay -->
{#if showDebugPanel}
    <DebugPanel
        {externalIds}
        {sonarrSeriesId}
        mediaType={mediaType || 'MOVIE'}
        {title}
        {year}
        {genres}
        {isAvailable}
        {canRequest}
        {sonarrHasFile}
        {sonarrQuality}
        {sonarrNetwork}
        {sonarrAirDate}
        jellyfinUrl={serviceUrls.jellyfin}
        sonarrUrl={serviceUrls.sonarr}
        radarrUrl={serviceUrls.radarr}
        jellyseerrUrl={serviceUrls.jellyseerr}
        onclose={() => (showDebugPanel = false)} />
{/if}

<style>
    /* Rate trigger accent — mirrors AIRatingButton's quick-rating palette
       (thumbs-down/thumbs-up/love/star) so the collapsed button's color
       matches whichever quick-rating button is active inside the popover.
       These classes are passed via triggerClass into ActionPopover, which
       renders the trigger <button> in its own template — so the selectors
       must be :global() or they'd never match (Svelte only stamps its
       scoping hash onto elements authored in this component's own markup). */
    :global(.rate-trigger-negative) {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.4);
        color: #fca5a5;
    }

    :global(.rate-trigger-positive) {
        background: rgba(59, 130, 246, 0.15);
        border-color: rgba(59, 130, 246, 0.4);
        color: #93c5fd;
    }

    :global(.rate-trigger-love) {
        background: rgba(236, 72, 153, 0.15);
        border-color: rgba(236, 72, 153, 0.4);
        color: #f9a8d4;
    }

    :global(.rate-trigger-neutral) {
        background: rgba(234, 179, 8, 0.15);
        border-color: rgba(234, 179, 8, 0.4);
        color: #fde047;
    }

    /* Mobile safe area for footer */
    @media (max-width: 639px) {
        .modal-footer-safe {
            padding-bottom: env(safe-area-inset-bottom, 0px);
            margin-bottom: 0;
        }

        /* Ensure SVG icons render at their intended size. Deliberately still
           mobile-only: this is an !important override for a narrow-viewport
           icon-squashing problem, and promoting it to desktop would change
           icon rendering there for no benefit. */
        .actions-scroller :global(svg) {
            max-width: none !important;
            width: auto !important;
        }
    }

    /* Single-row layout at EVERY width: horizontal scroll instead of wrapping.
       This used to be mobile-only, with desktop left to wrap. Wrapping meant
       the primary action could move to a different LINE depending on how many
       secondary buttons an item rendered — a coarser version of the same
       instability the flex spacer removes horizontally. */
    .actions-scroller {
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        justify-content: flex-start;
        gap: 0.5rem;
    }

    .actions-scroller::-webkit-scrollbar {
        display: none;
    }

    /* Prevent buttons from shrinking — let them overflow and scroll */
    .actions-scroller > :global(*) {
        flex-shrink: 0;
    }

    /* Edge-fade affordance: hints that more actions are scrolled
       off-screen. Fades the scroller's own pixels via mask-image
       (rather than a coloured overlay) so it works over any modal
       backdrop, and only applies when there is actual overflow on that
       side (see updateFadeVisibility in script). Mirrors Tabs.svelte. */
    .actions-scroller.show-left-fade {
        -webkit-mask-image: linear-gradient(to right, transparent, black 16px);
        mask-image: linear-gradient(to right, transparent, black 16px);
    }

    .actions-scroller.show-right-fade {
        -webkit-mask-image: linear-gradient(to right, black calc(100% - 16px), transparent);
        mask-image: linear-gradient(to right, black calc(100% - 16px), transparent);
    }

    .actions-scroller.show-left-fade.show-right-fade {
        -webkit-mask-image: linear-gradient(
            to right,
            transparent,
            black 16px,
            black calc(100% - 16px),
            transparent
        );
        mask-image: linear-gradient(
            to right,
            transparent,
            black 16px,
            black calc(100% - 16px),
            transparent
        );
    }

    /* Primary-action slot. The spacer above pins these to the footer's left
       edge; the min-width stops a short label ("Watch") from collapsing the
       button relative to a long one ("Watch S10 E100"), which would otherwise
       move its centre and right edge between items.

       Because the button is anchored on its LEFT, a label that overruns the
       floor grows rightward into slack and the anchor still holds — the
       min-width is a refinement here, not load-bearing. That is the whole
       reason this sits at the left of the row rather than beside the close
       button: right-anchoring would make the floor load-bearing per locale.

       sm and up only: on mobile the scroller is packed and horizontal space
       is scarce, so the compact button stays. */
    @media (min-width: 640px) {
        .modal-watch-cta {
            min-width: 11rem;
            padding: 0.625rem 1.25rem;
            font-size: 1rem;
        }
    }
</style>
