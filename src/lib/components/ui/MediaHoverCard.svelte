<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	MediaHoverCard.svelte

	Netflix-style hover popup for media cards. Shows expanded information
	including backdrop image, description, ratings, and quick actions.

	Wraps child content (typically UniversalMediaCard) and shows popup on hover.
	Uses floating-ui for smart positioning and portal rendering to escape
	overflow containers.

	@example
	<MediaHoverCard {item} {hasRequestPermission} onplay onrequest onmore>
		<UniversalMediaCard {item} />
	</MediaHoverCard>
-->
<script lang="ts">
    import { onMount, onDestroy, mount, unmount } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { browser } from '$app/environment';
    import { goto } from '$app/navigation';
    import { saveReturnPath } from '$lib/stores/playerNavigation';
    import { isSeries, isEpisode, isAudiobook } from '$lib/shared/media-types';
    import { toMovieOrSeries } from '$lib/shared/media-type-domain';
    import { prefetchSimilar } from '$lib/utils/similar-prefetch';
    import { computePosition, autoUpdate, offset, shift, flip } from '@floating-ui/dom';
    import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { getLocalPreviewId } from '$lib/utils/media-id-helpers';
    import { youtube_parser } from '../../../utility';
    import * as m from '$lib/paraglide/messages';
    import { formatSeriesCounts } from '$lib/utils/series-episode-counts';
    import { getCwDismissDisplayName } from '$lib/utils/cw-dismiss-helper';
    import MediaPreviewPlayer from './MediaPreviewPlayer.svelte';
    import { mediaHoverCoordinator } from './media-hover-coordinator.svelte';
    import {
        ensureYouTubeApi,
        waitForYouTubeApi,
        createYouTubePlayer,
        destroyYouTubePlayer,
        calculateSmartPreviewPosition,
        type YouTubePlayer,
    } from '$lib/utils/video-player-utils';
    import { previewAudio } from '$lib/stores/preview-audio.svelte';
    import {
        decideHoverPreview,
        decideFallbackContent,
        type HoverFallbackContent,
    } from './media-hover-decisions';
    import {
        resolveMediaPlayTarget,
        buildWatchUrlWithPosition,
    } from '$lib/utils/media-play-target';
    // Static import on purpose: WebKit only honours play() inside a trusted user
    // gesture, and a dynamic import inserts a round trip that loses it. Same
    // constraint ModalActions.svelte documents.
    import { playAudiobook, audiobookStartFailureMessage } from '$lib/services/audiobook-playback';
    import { toasts } from '$lib/stores/toast.store';
    import { appPath } from '$lib/shared/api-urls';
    import { trailerOverlay } from '$lib/stores/trailer-overlay.svelte';
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from './context-menu-types';
    import {
        PlayCircle,
        CheckCircle,
        InformationCircle,
        DocumentPlus,
        Bookmark,
        Star,
        ClipboardDocument,
        ArrowUturnLeft,
        ArrowPath,
        DocumentMagnifyingGlass,
        HandThumbDown,
        HandThumbUp,
        Heart,
        Sparkles,
        WrenchScrewdriver,
        EyeSlash,
        XMark,
    } from 'svelte-hero-icons';
    import RatingPickerModal from '$lib/components/modal/RatingPickerModal.svelte';
    import MediaFileInfoModal from '$lib/components/modal/MediaFileInfoModal.svelte';
    import WhyHereModal from '$lib/components/modal/WhyHereModal.svelte';
    import {
        copyMediaLink,
        markMediaUnwatched,
        setEpisodeWatchState,
        refreshMediaMetadata,
        toggleWatchlistMedia,
        canWatchlistMedia,
        canRateMedia,
        quickRateMedia,
        buildMediaShareId,
        isPageAdmin,
    } from '$lib/utils/media-context-actions';
    import { watchlistItems } from '$lib/stores/watchlist';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import { isMovie } from '$lib/shared/media-types';
    import { requireValue } from '$lib/utils/runtime-validation';
    import { hasModals } from '$lib/stores/modal.store';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The media item data */
        item: UniversalMediaItem;
        /** Whether hover popup is enabled */
        enabled?: boolean;
        /** Whether trailers should auto-play in popup */
        trailersEnabled?: boolean;
        /** Whether video previews should auto-play in popup */
        videoPreviewEnabled?: boolean;
        /** Hover delay before showing popup (ms) */
        delay?: number;
        /** Delay (ms) before loading the trailer/preview video; popup
         *  itself opens instantly with the backdrop image and the video
         *  is swapped in after this timeout. 0 = load immediately. */
        videoLoadDelay?: number;
        /** Whether the user has permission to make requests */
        hasRequestPermission?: boolean;
        /** Show the "show less like this" (taste-damper) action — only on
         *  surfaces whose ranking consumes the damper. Off by default. */
        showDamperAction?: boolean;
        /** Content to wrap (the media card) */
        children: import('svelte').Snippet;
        /** Callback when play button is clicked */
        onplay?: (item: UniversalMediaItem) => void;
        /** Callback when request button is clicked */
        onrequest?: (item: UniversalMediaItem) => void;
        /** Callback when more/similar button is clicked */
        onmore?: (item: UniversalMediaItem) => void;
        /** Callback when details/info button is clicked */
        onclick?: (item: UniversalMediaItem) => void;
        /** Hide the item from Continue Watching. Only passed on the CW row;
         *  when set, the popup shows a hide button and a menu entry. The
         *  card's own X is covered by this popup, so this is its stand-in. */
        onhide?: (item: UniversalMediaItem) => void;
    }

    let {
        item,
        enabled = true,
        trailersEnabled = false,
        videoPreviewEnabled = false,
        delay = 0,
        videoLoadDelay = 0,
        hasRequestPermission = true,
        showDamperAction = false,
        children,
        onplay,
        onrequest,
        onmore,
        onclick,
        onhide,
    }: Props = $props();

    // Neither the request modal nor an external Jellyseerr URL is configured —
    // the request action must stay hidden regardless of item.canRequest.
    let requestsConfigured = $derived(
        $page.data?.features?.requests === true || !!env.PUBLIC_REQUESTURL,
    );

    // =========================================================================
    // Internal State
    // =========================================================================

    let isVisible = $state(false);
    let isHovering = $state(false);
    let isPopupHovering = $state(false);
    let showProgressiveInfo = $state(false); // Progressive disclosure state
    let triggerElement: HTMLDivElement | undefined = $state();
    // Reference to the shared body-portal owned by mediaHoverCoordinator.
    // Captured once on mount; never recreated per-instance. See
    // ./media-hover-coordinator.svelte.ts for why this is shared.
    let portalElement: HTMLDivElement | null = null;
    let popupElement = $state<HTMLDivElement | null>(null);
    let cleanupAutoUpdate: (() => void) | undefined;
    let showTimeout: ReturnType<typeof setTimeout> | undefined;
    let popupBuildFrame: number | undefined;
    let popupBuildRevision = 0;
    let hideTimeout: ReturnType<typeof setTimeout> | undefined;
    let progressiveTimeout: ReturnType<typeof setTimeout> | undefined;
    let videoLoadTimeout: ReturnType<typeof setTimeout> | undefined;
    let muteStateInterval: ReturnType<typeof setInterval> | undefined;
    // Pending video swap captured during renderPopupContent. Non-null
    // while we're showing the still backdrop image waiting for the
    // intent timer to fire; null once the swap has happened (or there
    // was never a video to load).
    let pendingVideoSetup: {
        kind: 'preview' | 'youtube';
        containerId: string;
        item: UniversalMediaItem;
        videoId?: string;
        isTrailer?: boolean;
    } | null = null;
    let videoLoaded = false;
    let backdropLoaded = $state(false);
    let backdropError = $state(false);

    // Unique ID for this popup instance
    const popupId = Math.random().toString(36).slice(2);

    // This popup's exclusive-audio owner id (see preview-audio store). The same id
    // is handed to the mounted MediaPreviewPlayer so its own mute button and this
    // popup's mute button drive one shared owner.
    const audioId = `hover-${popupId}`;

    // Local trailer probe: tried first, ahead of the YouTube/snippet
    // priority. A 'none' answer from the server (no local trailer for this
    // item) is remembered here so re-hovering the same card doesn't
    // re-probe every time. Scoped to this MediaHoverCard instance — it
    // persists across repeated show/hide cycles of the same card, which is
    // the whole point (this component isn't recreated per hover).
    const trailerProbeFailedIds = new SvelteSet<string>();

    // YouTube player state
    let ytPlayer: YouTubePlayer | null = null;
    let currentVideoId: string | null = null;
    let youtubeError = $state(false); // Track YouTube loading errors
    let activeItem: UniversalMediaItem | null = null; // Track current item for fallback
    // Generation token: bumped on every popup teardown (hidePopup) and every
    // fresh popup content build (createPopupContent). Async trailer-probe
    // callbacks (onNoTrailer/onError from the MediaPreviewPlayer mounted in
    // initVideoPreview) capture the generation at mount time and compare
    // against the live value before touching the DOM/state — a callback that
    // resolves after a fast hover-out/hover-in (or this instance getting
    // recycled onto a different item) is stale and must bail instead of
    // unmounting the CURRENT live preview or overwriting the CURRENT backdrop.
    let popupGeneration = 0;

    // Video preview state
    let previewPlayerComponent: ReturnType<typeof mount> | null = null;
    const previewPositions = new SvelteMap<string, number>(); // itemId -> seconds

    // Muted unless this popup owns audio. Only one preview/hero across the page
    // may own audio at a time, so unmuting here silences every other player.
    let isMuted = $derived(!previewAudio.owns(audioId));

    // When ownership changes — including when ANOTHER player claims audio and this
    // popup must fall silent — apply it to the YouTube trailer (the mounted
    // <video> preview handles itself via the shared id) and refresh the imperative
    // mute-button icon.
    $effect(() => {
        const muted = isMuted;
        if (ytPlayer) {
            try {
                if (muted) {
                    ytPlayer.mute();
                } else {
                    ytPlayer.unMute();
                    ytPlayer.setVolume(50);
                }
            } catch {
                /* player may not be ready */
            }
        }
        updateMuteButton();
    });

    // Store playback positions per video (shared across all hover cards)
    const videoPositions = new SvelteMap<string, number>();

    // =========================================================================
    // Note: Computed values are calculated directly in renderPopupContent()
    // to ensure correct values in imperative (non-reactive) context
    // =========================================================================

    // =========================================================================
    // Touch Detection & Portal Management
    // =========================================================================

    let isTouchDevice = $state(false);

    onMount(() => {
        if (!browser) return;

        // Check for touch device
        const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        isTouchDevice = isTouch;

        // Don't create portal on touch devices or if disabled
        if (!enabled || isTouch) {
            return;
        }

        // Load YouTube IFrame API if not already loaded
        if (trailersEnabled) {
            ensureYouTubeApi(() => {});
        }

        // Use the singleton portal owned by mediaHoverCoordinator instead
        // of creating a private portal per instance. The home page mounts
        // hundreds of MediaHoverCards; one shared <body> child instead of
        // 800+ keeps the document tree small and avoids the CSSOM cost
        // we used to pay.
        portalElement = mediaHoverCoordinator.getPortal();

        // Escape closes the active popup via the coordinator. The
        // listener attaches to <document> exactly once (on first call)
        // regardless of how many cards mount — fan-out from N×keystrokes
        // to 1×keystroke.
        mediaHoverCoordinator.ensureEscapeListener();
    });

    // Watch coordinator.activeId so this card hides itself when another
    // card claims the popup, or when Escape clears the active id. Replaces
    // the previous document-level 'media-hover-show' broadcast that woke up
    // every MediaHoverCard listener for every popup transition.
    //
    // Also handles hover-steal: when the active popup detects the cursor
    // is geometrically over a neighboring card (which the popup overhang
    // visually covers), it claims the new id; that card's effect fires
    // here and opens its own popup so scrubbing across a row feels
    // continuous.
    $effect(() => {
        const active = mediaHoverCoordinator.activeId;
        if (active === popupId && !isVisible) {
            showPopup();
        } else if (active !== popupId && isVisible) {
            hidePopup();
        }
    });

    // Attach play button listeners using event delegation (mouseover/mouseout bubble)
    $effect(() => {
        if (!browser || !enabled || isTouchDevice || !triggerElement) return;

        // Capture element reference for cleanup (TypeScript narrowing)
        const element = triggerElement;
        let currentPlayButton: Element | null = null;

        function handleMouseOver(e: MouseEvent) {
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest('[data-preview-suppress]')) {
                currentPlayButton = null;
                isHovering = false;
                clearTimeout(showTimeout);
                hidePopup();
                return;
            }
            const playButton = target?.closest('[data-play-button]');

            // Entering a play button for the first time
            if (playButton && playButton !== currentPlayButton) {
                currentPlayButton = playButton;
                handlePlayButtonEnter();
            }
        }

        function handleMouseOut(e: MouseEvent) {
            const target = e.target instanceof Element ? e.target : null;
            const relatedTarget = e.relatedTarget instanceof Element ? e.relatedTarget : null;
            const playButton = target?.closest('[data-play-button]');

            // Only trigger leave if we're actually leaving the play button entirely
            if (
                playButton &&
                playButton === currentPlayButton &&
                (!relatedTarget?.closest('[data-play-button]') ||
                    !!relatedTarget?.closest('[data-preview-suppress]'))
            ) {
                currentPlayButton = null;
                handlePlayButtonLeave();
            }
        }

        element.addEventListener('mouseover', handleMouseOver);
        element.addEventListener('mouseout', handleMouseOut);

        // Cleanup function
        return () => {
            element.removeEventListener('mouseover', handleMouseOver);
            element.removeEventListener('mouseout', handleMouseOut);
            currentPlayButton = null;
        };
    });

    onDestroy(() => {
        // Ensure preview players are fully torn down. hidePopup() removes
        // this card's popupElement from the shared portal and releases the
        // coordinator if we were the active popup. The shared portal
        // itself and the document keydown listener belong to the
        // coordinator and intentionally outlive individual cards.
        hidePopup();
        cleanupAutoUpdate?.();
        clearTimeout(showTimeout);
        clearTimeout(hideTimeout);
        clearTimeout(progressiveTimeout);
        clearTimeout(videoLoadTimeout);
        clearInterval(muteStateInterval);
    });

    // =========================================================================
    // Position Updates
    // =========================================================================

    function updatePosition() {
        if (!triggerElement || !popupElement) return;

        cleanupAutoUpdate?.();
        cleanupAutoUpdate = autoUpdate(triggerElement, popupElement, () => {
            const trigger = requireValue(
                triggerElement,
                'triggerElement must exist inside autoUpdate callback',
            );
            const popup = requireValue(
                popupElement,
                'popupElement must exist inside autoUpdate callback',
            );
            // Get trigger and popup dimensions for centering
            const triggerRect = trigger.getBoundingClientRect();
            const popupWidth = 320; // Fixed popup width
            const popupHeight = popup.offsetHeight;

            // Calculate centered X position
            const centeredX = triggerRect.left + triggerRect.width / 2 - popupWidth / 2;

            // Center the backdrop (preview video), not the whole popup, over the
            // card: the popup opens from the card's play button, so the cursor
            // must land on the video. Centering the full popup lets rows added
            // below (e.g. the Continue Watching dismiss) push the video upward.
            const backdrop = popup.querySelector<HTMLElement>('.popup-backdrop');
            const anchorOffset = backdrop
                ? backdrop.offsetTop + backdrop.offsetHeight / 2
                : popupHeight / 2;
            const centeredY = triggerRect.top + triggerRect.height / 2 - anchorOffset;

            // Clamp to viewport bounds
            const clampedX = Math.max(16, Math.min(centeredX, window.innerWidth - popupWidth - 16));
            const clampedY = Math.max(
                16,
                Math.min(centeredY, window.innerHeight - popupHeight - 16),
            );

            Object.assign(popup.style, {
                left: `${clampedX}px`,
                top: `${clampedY}px`,
            });
        });
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    // Cross-instance "another popup is shown" coordination and Escape
    // handling live in mediaHoverCoordinator. The $effect above watches
    // coordinator.activeId and runs hidePopup() when this card loses
    // focus, so we don't need per-instance handleOtherPopupShow /
    // handleKeyDown functions any more.

    function handlePlayButtonEnter() {
        if (!enabled || isTouchDevice) return;

        isHovering = true;
        clearTimeout(showTimeout);
        clearTimeout(hideTimeout);

        if (delay <= 0) {
            showPopup();
            return;
        }

        showTimeout = setTimeout(() => {
            if (isHovering) {
                showPopup();
            }
        }, delay);
    }

    function handlePlayButtonLeave() {
        if (!enabled || isTouchDevice) return;

        isHovering = false;
        clearTimeout(showTimeout);
        clearTimeout(progressiveTimeout);
        if (popupBuildFrame !== undefined) hidePopup();
        schedulePopupHide();
    }

    function handlePopupMouseEnter() {
        isPopupHovering = true;
        clearTimeout(hideTimeout);
    }

    function handlePopupMouseLeave() {
        isPopupHovering = false;
        clearTimeout(progressiveTimeout);
        schedulePopupHide();
    }

    function schedulePopupHide(): void {
        clearTimeout(hideTimeout);
        // Pointer and keyboard containment are independent. A focusout must
        // re-arm this check even if an earlier pointer-leave timer kept focus.
        hideTimeout = setTimeout(() => {
            if (
                !isHovering &&
                !isPopupHovering &&
                !actionTooltipHovered &&
                !actionTooltipButtonHovered &&
                !popupElement?.contains(document.activeElement)
            ) {
                hidePopup();
            }
        }, 150);
    }

    function cancelPopupBuild(): void {
        popupBuildRevision++;
        if (popupBuildFrame !== undefined) cancelAnimationFrame(popupBuildFrame);
        popupBuildFrame = undefined;
    }

    function showPopup() {
        // Never spawn a new preview while a modal is open — the modal's
        // backdrop should be the only thing on top. Covers both the direct
        // hover-intent path and the coordinator's hover-steal effect below.
        if (!portalElement || $hasModals || isVisible) return;
        // A modal trailer is playing — don't steal the preview budget/audio.
        if (trailerOverlay.isOpen) return;

        isVisible = true;
        showProgressiveInfo = false;
        // An opened popup is click intent — warm the detail modal's Similar row.
        prefetchSimilar(item);
        backdropLoaded = false;
        backdropError = false;

        // Notify the coordinator so the previously-active popup's $effect
        // fires and hides itself. Replaces the old document-level
        // CustomEvent dispatch that was synchronously read by every
        // mounted card's listener.
        mediaHoverCoordinator.claim(popupId);

        // Keep zero-delay opening, but fence callbacks across suppression and
        // hide/show cycles even if a cancelled frame has already been queued.
        cancelPopupBuild();
        const buildRevision = popupBuildRevision;
        popupBuildFrame = requestAnimationFrame(() => {
            if (buildRevision !== popupBuildRevision || !isVisible) return;
            popupBuildFrame = undefined;
            createPopupContent();
            requestAnimationFrame(() => {
                if (buildRevision === popupBuildRevision && isVisible) updatePosition();
            });
        });

        // Progressive disclosure: promote the pending watch-state badge
        // after extended hover (1000ms). We deliberately DO NOT re-render
        // the whole popup here — that would destroy and recreate the
        // video element, restarting playback mid-watch.
        progressiveTimeout = setTimeout(() => {
            if (!isVisible || !(isHovering || isPopupHovering)) return;
            showProgressiveInfo = true;
            const badge = popupElement?.querySelector('.watch-state-badge.progressive-pending');
            if (badge instanceof HTMLElement) {
                badge.classList.remove('progressive-pending');
                badge.classList.add('progressive-disclosure');
            }
        }, 1000);

        // Poll mute button state to keep it in sync with video element
        muteStateInterval = setInterval(() => {
            if (isVisible && popupElement) {
                updateMuteButton();
            }
        }, 500); // Check every 500ms
    }

    function hidePopup() {
        cancelPopupBuild();
        hideActionTooltip();
        isPopupHovering = false;
        // New generation: any in-flight async trailer-probe callback captured
        // from before this teardown must recognize itself as stale.
        popupGeneration++;
        cleanupAutoUpdate?.();
        cleanupAutoUpdate = undefined;
        clearTimeout(progressiveTimeout);
        clearTimeout(videoLoadTimeout);
        videoLoadTimeout = undefined;
        pendingVideoSetup = null;
        videoLoaded = false;
        lastMouseMoveX = -1;
        lastMouseMoveY = -1;
        clearInterval(muteStateInterval);
        isVisible = false;
        showProgressiveInfo = false;
        youtubeError = false; // Reset YouTube error state
        activeItem = null; // Clear active item reference
        // Save playback position and cleanup YouTube player
        if (ytPlayer && currentVideoId) {
            const currentTime = destroyYouTubePlayer(ytPlayer);
            if (currentTime !== null && currentTime > 0) {
                videoPositions.set(currentVideoId, currentTime);
            }
            ytPlayer = null;
        }
        currentVideoId = null;
        // Cleanup video preview component
        if (previewPlayerComponent) {
            try {
                unmount(previewPlayerComponent);
            } catch {
                /* expected: component may already be unmounted on hover-out */
            }
            previewPlayerComponent = null;
        }
        // Release exclusive audio if this popup held it, so hovering away frees
        // audio for the next player instead of leaving a phantom owner.
        previewAudio.release(audioId);
        // Remove only this card's own popup element from the shared portal;
        // we must NOT clear the portal's innerHTML because other cards may
        // be mid-transition and have already appended their own popup.
        if (popupElement) {
            popupElement.remove();
            popupElement = null;
        }
        // Tell the coordinator we're no longer the active popup. release()
        // is idempotent — if another card has already claimed activity,
        // this is a no-op.
        mediaHoverCoordinator.release(popupId);
    }

    function createPopupContent() {
        if (!portalElement) return;
        // If hidePopup ran between showPopup queueing the rAF and this
        // callback firing, isVisible is false again — bail rather than
        // create an orphan popup the user can't see and the shared
        // portal would never garbage-collect (unlike the old
        // per-instance portal which onDestroy used to wipe wholesale).
        if (!isVisible) return;
        // Defensive: if popupElement is somehow already set (e.g. a
        // double-rAF race we didn't anticipate), drop the stale element
        // before creating a new one so we never accumulate copies in
        // the shared portal.
        if (popupElement) {
            popupElement.remove();
            popupElement = null;
        }

        // New generation: this is fresh popup content (possibly for a
        // different item, if this instance is being recycled) — any
        // trailer-probe callback captured against the previous content is
        // now stale.
        popupGeneration++;

        // We need to create the popup element and attach event handlers
        const popup = document.createElement('div');
        popup.className = 'media-hover-popup';
        popup.setAttribute('role', 'tooltip');
        // Start off-screen until floating-ui positions it
        popup.style.left = '-9999px';
        popup.style.top = '-9999px';

        popupElement = popup;
        portalElement.appendChild(popup);

        // Render content first
        renderPopupContent();

        // Attach mouse handlers to the popup content (not the wrapper)
        // Since popup wrapper has pointer-events: none, we attach to content
        const content = popup.querySelector('.popup-content');
        if (content instanceof HTMLElement) {
            attachPopupContentHandlers(content);
        }
    }

    function attachPopupContentHandlers(content: HTMLElement) {
        content.addEventListener('mouseenter', handlePopupMouseEnter);
        content.addEventListener('mouseleave', handlePopupMouseLeave);
        content.addEventListener('mousemove', handlePopupMouseMove);
        content.addEventListener('wheel', handlePopupWheel, { passive: true });
        content.addEventListener('contextmenu', handlePopupContextMenu);
        content.addEventListener('focusin', () => clearTimeout(hideTimeout));
        content.addEventListener('focusout', schedulePopupHide);
    }

    // Hover-steal: the popup is wider than its originating poster, so it
    // overhangs neighbors in the row. While the cursor is on the popup,
    // detect when it has crossed off this card onto a sibling poster and
    // hand the active popup to that card.
    let lastMouseMoveX = -1;
    let lastMouseMoveY = -1;
    function handlePopupMouseMove(e: MouseEvent) {
        // Controls and metadata can extend over another row of cards. Moving
        // into them belongs to this popup, even when a different poster sits
        // underneath. Only the preview image participates in hover handoff.
        const target = e.target;
        if (
            !(target instanceof Element) ||
            !target.closest('.popup-backdrop') ||
            target.closest('button, a')
        ) {
            return;
        }
        // Browsers fire mousemove repeatedly even when the pointer is
        // stationary (e.g. while a video frame paints under the cursor).
        // Skip the elementsFromPoint walk when nothing has actually moved.
        if (e.clientX === lastMouseMoveX && e.clientY === lastMouseMoveY) {
            return;
        }
        lastMouseMoveX = e.clientX;
        lastMouseMoveY = e.clientY;
        if (!triggerElement) return;
        const rect = triggerElement.getBoundingClientRect();
        // Cursor still within this card's poster area — keep current popup
        // so the user can slide into popup controls without losing it.
        if (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
        ) {
            return;
        }
        // Cursor moved off this poster. Look past the popup (which captures
        // pointer events) for any other card under the cursor and swap.
        const stack = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of stack) {
            if (!(el instanceof HTMLElement)) continue;
            const otherId = el.dataset.cardPopupId;
            if (otherId && otherId !== popupId) {
                mediaHoverCoordinator.claim(otherId);
                return;
            }
        }
    }

    function handlePopupWheel(event: Event) {
        const wheelEvent = event as WheelEvent;
        const scrollContainer = document.querySelector('.main-content');
        if (scrollContainer) {
            scrollContainer.scrollBy({
                top: wheelEvent.deltaY,
                left: wheelEvent.deltaX,
                behavior: 'auto',
            });
        } else {
            window.scrollBy({
                top: wheelEvent.deltaY,
                left: wheelEvent.deltaX,
                behavior: 'auto',
            });
        }
    }

    // ---------------------------------------------------------------------
    // DOM construction helpers (replace innerHTML/escapeHtml string building).
    // User-controlled strings are assigned via textContent / property setters
    // so they are never parsed as HTML — eliminates the stored-XSS surface
    // (same approach as the F64 Tooltip fix).
    // ---------------------------------------------------------------------
    const SVG_NS = 'http://www.w3.org/2000/svg';

    /** Create an HTML element with optional class, text, and attributes. */
    function makeEl(
        tag: string,
        opts: {
            className?: string;
            text?: string;
            attrs?: Record<string, string>;
        } = {},
    ): HTMLElement {
        const node = document.createElement(tag);
        if (opts.className) node.className = opts.className;
        if (opts.text !== undefined) node.textContent = opts.text;
        if (opts.attrs) {
            for (const [k, v] of Object.entries(opts.attrs)) {
                node.setAttribute(k, v);
            }
        }
        return node;
    }

    /**
     * Build an inline SVG icon from a trusted, hard-coded list of path `d`
     * strings. The path data is a developer-authored constant (never user
     * input), and each segment is set via setAttribute on a namespaced
     * <path>, so no HTML/SVG string is ever parsed.
     */
    function makeSvgIcon(
        className: string,
        paths: string[],
        opts: {
            viewBox?: string;
            fill?: string;
            stroke?: string;
            strokeWidth?: string;
            rounded?: boolean;
        } = {},
    ): SVGSVGElement {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', className);
        svg.setAttribute('viewBox', opts.viewBox ?? '0 0 24 24');
        svg.setAttribute('fill', opts.fill ?? 'currentColor');
        if (opts.stroke) svg.setAttribute('stroke', opts.stroke);
        if (opts.strokeWidth) svg.setAttribute('stroke-width', opts.strokeWidth);
        for (const d of paths) {
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            if (opts.rounded) {
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-linejoin', 'round');
            }
            svg.appendChild(path);
        }
        return svg;
    }

    // Trusted, hard-coded icon path data.
    const ICON_PLAY = ['M8 5v14l11-7z'];
    const ICON_PLUS = ['M12 4v16m8-8H4'];
    const ICON_SPARKLES = [
        'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z',
    ];
    // Match the small Continue Watching card's removal icon.
    const ICON_REMOVE = ['M6 18 18 6M6 6l12 12'];
    const ICON_INFO = [
        'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z',
    ];
    // Heroicons v2 "bookmark" — the same glyph the context menu's watchlist
    // entry uses (imported there as the `Bookmark` component). The path is a
    // closed shape, so the one constant serves both states: stroked when the
    // item is not saved, filled when it is.
    const ICON_BOOKMARK = [
        'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z',
    ];
    const ICON_MUTED = [
        'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    ];
    const ICON_UNMUTED = [
        'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    ];

    /**
     * The still image this popup shows behind / instead of a video preview.
     *
     * ONE place decides the image ROLE, because the popup resolves this still in
     * four places (initial render, video→still swap-back, no-fallback-video path,
     * and the hover-cap expiry path) and they had drifted into four copies of the
     * same expression — so an audiobook fix applied to one left the other three
     * showing popcorn.
     *
     * Role per type:
     *  - audiobook → 'poster'. A book has exactly ONE image; every other role
     *    short-circuits to null in ImageProxyService and the media image route
     *    302s that to the popcorn placeholder. A 302 resolves to a 200, so no
     *    onerror ever fires to recover — the placeholder simply stays.
     *  - episode → 'thumb'. Episodes have no backdrop of their own; 'backdrop'
     *    inherits series/season art or 404s.
     *  - everything else → 'backdrop'.
     */
    function stillImageFor(item: {
        mediaType?: string;
        externalIds?: Parameters<typeof imageFromIds>[0];
    }): string | null {
        const ids = item.externalIds;
        if (!ids) return null;
        if (isAudiobook(item.mediaType)) {
            return imageFromIds(ids, 'poster', 'movie', { size: 'thumb' });
        }
        if (isEpisode(item.mediaType)) {
            return imageFromIds(ids, 'thumb', 'tv', { size: 'thumb' });
        }
        return imageFromIds(ids, 'backdrop', isSeries(item.mediaType) ? 'tv' : 'movie', {
            size: 'thumb',
        });
    }

    /** Build a backdrop <img> element (src/alt set as properties). */
    function makeBackdropImg(
        src: string,
        opts: { className: string; alt?: string; loading?: string },
    ): HTMLImageElement {
        const img = document.createElement('img');
        img.src = src;
        img.alt = opts.alt ?? '';
        img.className = opts.className;
        if (opts.loading) img.setAttribute('loading', opts.loading);
        return img;
    }

    /** Re-entrancy guard: a double click must not open two sessions. */
    let audiobookStarting = false;

    /**
     * Start the audiobook player that `+layout.svelte` mounts on every page.
     *
     * A failure has to surface as a toast: both audiobook player surfaces are
     * gated on `book !== null`, so when the book never opened the store's own
     * `error` state has nowhere to render. Same reasoning (and same helper) as
     * ModalActions.startAudiobook().
     */
    async function startAudiobookPlayback(mediaId: string): Promise<void> {
        if (audiobookStarting) return;
        audiobookStarting = true;
        try {
            const started = await playAudiobook(mediaId);
            if (!started) toasts.error(audiobookStartFailureMessage());
        } finally {
            audiobookStarting = false;
        }
    }

    // =========================================================================
    // Watchlist action button
    //
    // The popup is imperative DOM, so this button cannot be the shared
    // <WatchlistButton> component and nothing re-renders it for us — it paints
    // and repaints itself. It is also the ONE action that must not close the
    // popup: saving is a side note to browsing the card, not a departure from
    // it. That's why it is wired directly instead of joining the [data-action]
    // delegation, which calls hidePopup() for every entry.
    // =========================================================================

    /** Membership of `target` in the client-side watchlist index. */
    function isItemInWatchlist(target: UniversalMediaItem): boolean {
        if (!canWatchlistMedia(target)) return false;
        const key = mediaCompositeKey(
            target.externalIds,
            isSeries(target.mediaType) ? 'tv' : 'movie',
        );
        return $watchlistItems.some((w) => mediaCompositeKey(w.externalIds, w.mediaType) === key);
    }

    /** Paint the button + its tooltip for a membership state. */
    function paintWatchlistButton(
        btn: HTMLButtonElement,
        tooltip: HTMLElement,
        saved: boolean,
    ): void {
        const label = saved ? m.watchlist_remove() : m.watchlist_add();
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
        tooltip.textContent = label;
        refreshActionTooltip(btn);

        const icon = makeSvgIcon(
            'action-icon',
            ICON_BOOKMARK,
            saved
                ? { fill: 'currentColor' }
                : { fill: 'none', stroke: 'currentColor', strokeWidth: '2', rounded: true },
        );
        const existing = btn.querySelector('svg');
        if (existing) existing.replaceWith(icon);
        else btn.prepend(icon);
    }

    async function handleWatchlistToggle(
        event: Event,
        btn: HTMLButtonElement,
        tooltip: HTMLElement,
    ): Promise<void> {
        event.stopPropagation();
        if (btn.disabled) return;

        const target = item;
        const wasSaved = isItemInWatchlist(target);
        // The popup can be hidden or recycled onto a different item while the
        // request is in flight; only repaint if this is still that popup.
        const generationAtClick = popupGeneration;

        btn.disabled = true;
        try {
            const result = await toggleWatchlistMedia(target, { isInWatchlist: wasSaved });
            // 'unchanged' means the call failed — toggleWatchlistMedia has
            // already toasted, so leave the button showing the old state.
            if (result !== 'unchanged' && generationAtClick === popupGeneration) {
                paintWatchlistButton(btn, tooltip, result === 'added');
            }
        } finally {
            btn.disabled = false;
        }
    }

    let actionTooltipHideTimeout: ReturnType<typeof setTimeout> | undefined;
    let actionTooltip: HTMLElement | null = null;
    let actionTooltipTrigger: Element | null = null;
    let actionTooltipHovered = false;
    let actionTooltipButtonHovered = false;
    let cleanupActionTooltip: (() => void) | undefined;

    function hideActionTooltip(): void {
        clearTimeout(actionTooltipHideTimeout);
        cleanupActionTooltip?.();
        cleanupActionTooltip = undefined;
        actionTooltipTrigger?.removeAttribute('aria-describedby');
        actionTooltipTrigger = null;
        actionTooltip?.remove();
        actionTooltip = null;
        actionTooltipHovered = false;
        actionTooltipButtonHovered = false;
    }

    function scheduleActionTooltipHide(): void {
        clearTimeout(actionTooltipHideTimeout);
        actionTooltipHideTimeout = setTimeout(() => {
            if (
                !actionTooltipHovered &&
                !actionTooltipButtonHovered &&
                document.activeElement !== actionTooltipTrigger
            ) {
                hideActionTooltip();
            }
        }, 150);
    }

    function refreshActionTooltip(button: Element): void {
        if (button === actionTooltipTrigger && actionTooltip) {
            actionTooltip.textContent = button.getAttribute('aria-label');
        }
    }

    function attachActionTooltips(actions: HTMLElement): void {
        for (const button of actions.querySelectorAll<HTMLElement>('.has-tooltip')) {
            const show = (): void => {
                clearTimeout(actionTooltipHideTimeout);
                if (actionTooltipTrigger === button && actionTooltip) return;
                hideActionTooltip();
                const bubble = makeEl('div', {
                    className: 'popup-action-tooltip',
                    text: button.getAttribute('aria-label') ?? '',
                    attrs: { role: 'tooltip', id: `${popupId}-action-tooltip` },
                });
                bubble.style.visibility = 'hidden';
                document.body.appendChild(bubble);
                actionTooltip = bubble;
                actionTooltipTrigger = button;
                bubble.addEventListener('mouseenter', () => {
                    actionTooltipHovered = true;
                    clearTimeout(actionTooltipHideTimeout);
                    clearTimeout(hideTimeout);
                });
                bubble.addEventListener('mouseleave', () => {
                    actionTooltipHovered = false;
                    schedulePopupHide();
                    scheduleActionTooltipHide();
                });
                button.setAttribute('aria-describedby', bubble.id);
                cleanupActionTooltip = autoUpdate(button, bubble, () => {
                    void computePosition(button, bubble, {
                        strategy: 'fixed',
                        placement: 'top',
                        middleware: [offset(8), flip(), shift({ padding: 8 })],
                    }).then(({ x, y }) => {
                        Object.assign(bubble.style, {
                            left: `${x}px`,
                            top: `${y}px`,
                            visibility: 'visible',
                        });
                    });
                });
            };
            button.addEventListener('mouseenter', () => {
                show();
                actionTooltipButtonHovered = true;
                clearTimeout(hideTimeout);
            });
            button.addEventListener('focus', show);
            button.addEventListener('mouseleave', () => {
                actionTooltipButtonHovered = false;
                scheduleActionTooltipHide();
            });
            button.addEventListener('blur', () => {
                scheduleActionTooltipHide();
                schedulePopupHide();
            });
        }
    }

    function renderPopupContent() {
        if (!popupElement) return;

        // Access item properties directly instead of through derived values
        // to ensure correct values in imperative context
        const currentItem = item;
        activeItem = currentItem; // Store for error fallback handlers

        // Where "play" goes for this item: the video route `/watch/{id}`, the
        // globally-mounted audiobook player, or the parent's onplay callback.
        // Resolved ONCE here and shared by the play button and the backdrop
        // click, which used to carry two copies of the same navigation.
        const playTarget = resolveMediaPlayTarget(currentItem);

        /** Play button / backdrop click. Hides the popup in every branch. */
        const startPlayback = (): void => {
            if (playTarget.kind === 'audiobook') {
                // Deliberately NO position: the server answers with
                // AudiobookShelf's own saved progress. See
                // resolveMediaPlayTarget().
                void startAudiobookPlayback(playTarget.mediaId);
                hidePopup();
                return;
            }
            if (playTarget.kind === 'watch') {
                // Hand the preview's absolute source time to the full player.
                // MediaPreviewPlayer reports absolute time (it adds FFmpeg's
                // seek offset internally) and only fires after real playback
                // has started, so a presence in previewPositions means the user
                // actually watched some of the preview — pass ?t= to continue
                // from there. Otherwise let the watch page resume from server
                // state.
                const watchUrl = buildWatchUrlWithPosition(
                    playTarget.playbackId,
                    previewPositions.get(currentItem.id),
                );
                saveReturnPath();
                hidePopup();
                // appPath(): base-aware (GUARD H). The URL carries a `?t=`
                // query, which `resolve()`'s route types do not accept, and it
                // is built as a plain string so the pure builder stays testable.
                void goto(appPath(watchUrl));
                return;
            }
            // Nothing this component can start (requests, external items).
            onplay?.(item);
            hidePopup();
        };

        // Build rating chips as DOM elements (icon + value).
        function makeRatingItem(icon: string, value: string): HTMLElement {
            const wrap = makeEl('span', { className: 'rating-item' });
            wrap.appendChild(makeEl('span', { className: 'rating-icon', text: icon }));
            wrap.appendChild(document.createTextNode(value));
            return wrap;
        }

        function formatRatings(): HTMLElement[] {
            const ratings: HTMLElement[] = [];

            // TMDB/IMDb rating (star)
            if (currentItem.rating !== undefined && currentItem.rating !== null) {
                const num =
                    typeof currentItem.rating === 'number'
                        ? currentItem.rating
                        : parseFloat(String(currentItem.rating));
                if (!isNaN(num) && num > 0) {
                    ratings.push(makeRatingItem('⭐', num.toFixed(1)));
                }
            }

            // RT Critic rating (tomato)
            if (currentItem.criticRating !== undefined && currentItem.criticRating > 0) {
                ratings.push(makeRatingItem('RT', `${currentItem.criticRating}%`));
            }

            // RT Audience rating (popcorn)
            if (currentItem.audienceRating !== undefined && currentItem.audienceRating > 0) {
                ratings.push(makeRatingItem('AUD', `${currentItem.audienceRating}%`));
            }

            return ratings;
        }

        // Format overview
        let overview = '';
        if (currentItem.overview) {
            overview =
                currentItem.overview.length > 150
                    ? currentItem.overview.substring(0, 147) + '...'
                    : currentItem.overview;
        }

        // Format runtime
        let runtime = '';
        if (Number.isFinite(currentItem.durationMs) && currentItem.durationMs! > 0) {
            const totalMinutes = Math.round(currentItem.durationMs! / 60_000);
            const hours = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;
            if (hours > 0 && mins > 0) runtime = `${hours}h ${mins}m`;
            else if (hours > 0) runtime = `${hours}h`;
            else runtime = `${mins}m`;
        }

        // Enhanced metadata line: year • runtime • 1-2 genres (inline)
        // For episodes: SxE • runtime • show title
        const metaParts: string[] = [];
        const countSummary = formatSeriesCounts(currentItem, currentItem.mediaType);
        if (countSummary) metaParts.push(countSummary);

        const episode = isEpisode(currentItem.mediaType);
        const seriesName = currentItem.seriesName?.trim();
        const episodeCode =
            Number.isInteger(currentItem.seasonNumber) &&
            Number.isInteger(currentItem.episodeNumber)
                ? `S${currentItem.seasonNumber}E${currentItem.episodeNumber}`
                : '';
        // CW feeds use the series as title and "S12:E10 - Pandemic" as subtitle.
        // Other surfaces put the actual episode in title. Strip only a matching
        // structured code, so an episode name that resembles a code is preserved.
        const subtitle = currentItem.subtitle?.trim();
        const subtitleCode = subtitle?.match(/^S(\d+):?E(\d+)(?:\s*[-–—·•]\s*|$)/i);
        const subtitleTitle =
            subtitleCode &&
            Number(subtitleCode[1]) === currentItem.seasonNumber &&
            Number(subtitleCode[2]) === currentItem.episodeNumber
                ? subtitle?.slice(subtitleCode[0].length).trim()
                : subtitle;
        const popupTitle = episode && seriesName ? seriesName : currentItem.title;
        const episodeTitle = episode
            ? seriesName && currentItem.title.trim() !== seriesName
                ? currentItem.title.trim()
                : subtitleTitle
            : undefined;
        if (episode) {
            if (runtime) metaParts.push(runtime);
        } else {
            // Movies/Series format: 2023 • 2h 15m • Action, Thriller
            if (currentItem.year) metaParts.push(String(currentItem.year));
            if (runtime) metaParts.push(runtime);

            // Add 1-2 genres inline in metadata (rest shown as tags below)
            if (currentItem.genres && currentItem.genres.length > 0) {
                const inlineGenres = currentItem.genres.slice(0, 2).join(', ');
                metaParts.push(inlineGenres);
            }

            if (isSeries(currentItem.mediaType) && !currentItem.genres?.length) {
                metaParts.push(m.card_series());
            }
        }

        const metaLine = metaParts.join(' \u2022 ');

        // Genre tags (show remaining genres not in metadata line, max 3 total)
        const remainingGenres = isEpisode(currentItem.mediaType)
            ? []
            : Array.isArray(currentItem.genres)
              ? currentItem.genres.slice(2, 3)
              : [];
        const genreTagEls: HTMLElement[] = remainingGenres.map((g) =>
            makeEl('span', { className: 'genre-tag', text: g }),
        );

        const progress = Number.isFinite(currentItem.progress)
            ? Math.max(0, Math.min(currentItem.progress!, 100))
            : 0;
        const resumeText =
            Number.isFinite(currentItem.durationMs) && currentItem.durationMs! > 0
                ? m.hero_minutes_left({
                      n: Math.ceil((currentItem.durationMs! * (100 - progress)) / 6_000_000),
                  })
                : `${Math.round(progress)}%`;

        // Format progress indicator (DOM)
        let progressEl: HTMLElement | null = null;
        if (progress > 0 && !currentItem.isPlayed) {
            progressEl = makeEl('div', { className: 'popup-progress' });
            const bar = makeEl('div', { className: 'progress-bar' });
            const fill = makeEl('div', { className: 'progress-fill' });
            fill.style.width = `${progress}%`;
            bar.appendChild(fill);
            progressEl.appendChild(bar);
            progressEl.appendChild(
                makeEl('span', {
                    className: 'progress-text',
                    text: resumeText,
                }),
            );
        } else if (currentItem.isPlayed) {
            progressEl = makeEl('div', {
                className: 'popup-watched',
                text: `✓ ${m.modal_watched()}`,
            });
        }

        // Format recommendation reason (DOM)
        let reasonEl: HTMLElement | null = null;
        if (currentItem.reason) {
            reasonEl = makeEl('p', {
                className: 'popup-reason',
                text: `💫 ${currentItem.reason}`,
            });
        }

        // Progressive disclosure: Watch state badge (shown after extended hover).
        // Always emit the markup so we can promote it via class swap at the
        // 1000ms tick instead of re-rendering the popup — re-rendering would
        // destroy the inline video element and restart playback.
        let watchStateBadgeEl: HTMLElement | null = null;
        const badgeStateClass = showProgressiveInfo
            ? 'progressive-disclosure'
            : 'progressive-pending';
        if (progress > 0 && !currentItem.isPlayed) {
            watchStateBadgeEl = makeEl('div', {
                className: `watch-state-badge ${badgeStateClass}`,
                text: `${m.device_continue()} · ${resumeText}`,
            });
        } else if (currentItem.isPlayed) {
            watchStateBadgeEl = makeEl('div', {
                className: `watch-state-badge watched ${badgeStateClass}`,
                text: 'Watched',
            });
        } else if ((currentItem as { inWatchlist?: boolean }).inWatchlist) {
            watchStateBadgeEl = makeEl('div', {
                className: `watch-state-badge watchlist ${badgeStateClass}`,
                text: 'In Watchlist',
            });
        }

        // Get backdrop URL from the current item.
        // Use 'thumb' size (250px) for optimal loading (popup is 320px wide).
        // Episodes only ever have their OWN artwork under image type 'thumb' —
        // 'backdrop' has no per-episode source and inherits series/season art
        // instead (or 404s to the popcorn placeholder if that's empty too).
        const currentBackdropUrl = stillImageFor(currentItem);

        // Determine preview type based on decision logic
        // Priority: Video Preview > YouTube Trailer > Static Backdrop
        // Gate on isAvailable: unavailable items (request-only, metadata stubs)
        // have no local file and would 404 on /preview-session.
        const playableId = getLocalPreviewId(currentItem);
        const hasPlayableSource = !!playableId && currentItem.isAvailable !== false;
        const nativeStreamUrl = (currentItem as { nativeStreamUrl?: string }).nativeStreamUrl;
        const hasNativeStream = !!nativeStreamUrl;
        const hasYouTubeTrailer = trailersEnabled && !!currentItem.trailerUrl;

        // Which inline video (if any) this popup may play. Lives in
        // ./media-hover-decisions.ts so the branch table — including the
        // "audiobooks get no video at all" gate — is unit-testable without
        // mounting this component.
        const {
            tryLocalTrailer: shouldTryLocalTrailer,
            showVideoPreview: shouldShowVideoPreview,
            useYouTubeTrailer,
        } = decideHoverPreview({
            mediaType: currentItem.mediaType,
            trailersEnabled,
            videoPreviewEnabled,
            hasPlayableSource,
            hasNativeStream,
            hasYouTubeTrailer,
            isContinueWatchingItem: currentItem.progress !== undefined && currentItem.progress > 0,
            isNextUpItem:
                isEpisode(currentItem.mediaType) &&
                (currentItem.progress === undefined || currentItem.progress === 0),
            trailerProbeFailed: trailerProbeFailedIds.has(currentItem.id),
        });

        const videoId =
            useYouTubeTrailer && currentItem.trailerUrl
                ? youtube_parser(currentItem.trailerUrl)
                : false;

        // Build backdrop node — video preview container, YouTube trailer, or image
        let backdropNode: HTMLElement | null = null;
        const playerId = `yt-player-${popupId}`;
        const videoPreviewId = `video-preview-${popupId}`;

        // Track whether we're showing any video (for mute button)
        const hasVideo = shouldTryLocalTrailer || shouldShowVideoPreview || videoId;

        // Defer the video load when configured: render the still image
        // first, then swap to the video container after videoLoadDelay
        // ms. This keeps the popup snappy and avoids firing trailer /
        // preview-stream requests for cards the user is just scrubbing
        // past via hover-steal.
        const deferVideo = videoLoadDelay > 0 && !videoLoaded;
        const makeImageNode = (): HTMLImageElement | null =>
            currentBackdropUrl
                ? makeBackdropImg(currentBackdropUrl, {
                      className: 'backdrop-img',
                      loading: 'lazy',
                  })
                : null;

        if (shouldTryLocalTrailer || shouldShowVideoPreview) {
            if (deferVideo) {
                backdropNode = makeImageNode();
                pendingVideoSetup = {
                    kind: 'preview',
                    containerId: videoPreviewId,
                    item: currentItem,
                    isTrailer: shouldTryLocalTrailer,
                };
            } else {
                backdropNode = makeEl('div', {
                    className: 'popup-preview-container',
                    attrs: { id: videoPreviewId },
                });
                pendingVideoSetup = null;
            }
        } else if (videoId) {
            if (deferVideo) {
                backdropNode = makeImageNode();
                pendingVideoSetup = {
                    kind: 'youtube',
                    containerId: playerId,
                    item: currentItem,
                    videoId,
                };
            } else {
                backdropNode = makeEl('div', {
                    className: 'popup-video-container',
                });
                backdropNode.appendChild(makeEl('div', { attrs: { id: playerId } }));
                pendingVideoSetup = null;
            }
        } else if (currentBackdropUrl) {
            backdropNode = makeImageNode();
            pendingVideoSetup = null;
        } else {
            pendingVideoSetup = null;
        }

        const ratingEls = formatRatings();

        // ----- Build the popup tree programmatically (no innerHTML) -----
        const content = makeEl('div', {
            className: 'popup-content',
            attrs: {
                role: 'dialog',
                'aria-label': `Media details for ${currentItem.title}`,
            },
        });

        // Backdrop region
        const backdropRegion = makeEl('div', { className: 'popup-backdrop' });
        if (backdropNode) backdropRegion.appendChild(backdropNode);
        backdropRegion.appendChild(makeEl('div', { className: 'backdrop-overlay' }));
        if (ratingEls.length > 0) {
            const ratingsBadge = makeEl('div', { className: 'ratings-badge' });
            for (const r of ratingEls) ratingsBadge.appendChild(r);
            backdropRegion.appendChild(ratingsBadge);
        }
        if (watchStateBadgeEl) backdropRegion.appendChild(watchStateBadgeEl);
        content.appendChild(backdropRegion);

        // Info region
        const info = makeEl('div', { className: 'popup-info' });
        info.appendChild(
            makeEl('h4', {
                className: 'popup-title',
                text: popupTitle,
            }),
        );
        if (episode && (episodeCode || (episodeTitle && episodeTitle !== popupTitle))) {
            info.appendChild(
                makeEl('p', {
                    className: 'popup-episode',
                    text: [episodeCode, episodeTitle !== popupTitle ? episodeTitle : undefined]
                        .filter(Boolean)
                        .join(' · '),
                }),
            );
        }
        if (metaLine) {
            info.appendChild(makeEl('p', { className: 'popup-meta', text: metaLine }));
        }
        if (progressEl) info.appendChild(progressEl);
        if (reasonEl) info.appendChild(reasonEl);
        if (genreTagEls.length > 0) {
            const genresWrap = makeEl('div', { className: 'popup-genres' });
            for (const g of genreTagEls) genresWrap.appendChild(g);
            info.appendChild(genresWrap);
        }
        if (overview) {
            info.appendChild(makeEl('p', { className: 'popup-overview', text: overview }));
        }

        // Actions region
        const actions = makeEl('div', { className: 'popup-actions' });
        if (playTarget.kind !== 'delegate') {
            const label =
                currentItem.progress && currentItem.progress > 0
                    ? m.device_continue()
                    : m.card_play();
            const playBtn = makeEl('button', {
                className: 'action-btn primary',
                attrs: {
                    'data-action': 'play',
                    tabindex: '0',
                    'aria-label': label,
                },
            });
            playBtn.appendChild(makeSvgIcon('action-icon', ICON_PLAY));
            playBtn.appendChild(makeEl('span', { text: label }));
            actions.appendChild(playBtn);
        } else if (currentItem.canRequest && hasRequestPermission && requestsConfigured) {
            const requestBtn = makeEl('button', {
                className: 'action-btn secondary',
                attrs: {
                    'data-action': 'request',
                    tabindex: '0',
                    'aria-label': m.request(),
                },
            });
            requestBtn.appendChild(
                makeSvgIcon('action-icon', ICON_PLUS, {
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: '2',
                }),
            );
            requestBtn.appendChild(makeEl('span', { text: m.request() }));
            actions.appendChild(requestBtn);
        }

        if (hasVideo) {
            const muteBtn = makeEl('button', {
                className: 'action-btn ghost has-tooltip mute-btn',
                attrs: {
                    'data-mute-toggle': '',
                    tabindex: '0',
                    'aria-label': isMuted ? m.player_unmute() : m.card_mute(),
                    'aria-pressed': String(!isMuted),
                },
            });
            muteBtn.appendChild(makeSvgIcon('action-icon', ICON_MUTED));
            muteBtn.appendChild(
                makeEl('span', {
                    className: 'tooltip-text',
                    text: isMuted ? m.player_unmute() : m.card_mute(),
                }),
            );
            actions.appendChild(muteBtn);
        }

        // Movies and series only — episodes, audiobooks and music have no
        // watchlist row, same rule the context menu applies.
        if (canWatchlistMedia(currentItem)) {
            const watchlistBtn = makeEl('button', {
                className: 'action-btn ghost has-tooltip',
                // NOT `data-action` — that attribute opts a button into the
                // delegated handler below, which hides the popup.
                attrs: { 'data-watchlist-toggle': '', tabindex: '0' },
            }) as HTMLButtonElement;
            const watchlistTooltip = makeEl('span', { className: 'tooltip-text' });
            paintWatchlistButton(watchlistBtn, watchlistTooltip, isItemInWatchlist(currentItem));
            watchlistBtn.appendChild(watchlistTooltip);
            watchlistBtn.addEventListener('click', (e) => {
                void handleWatchlistToggle(e, watchlistBtn, watchlistTooltip);
            });
            actions.appendChild(watchlistBtn);
        }

        const moreBtn = makeEl('button', {
            className: 'action-btn ghost has-tooltip',
            attrs: {
                'data-action': 'more',
                tabindex: '0',
                'aria-label': m.card_similar_titles(),
            },
        });
        moreBtn.appendChild(
            makeSvgIcon('action-icon', ICON_SPARKLES, {
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '2',
                rounded: true,
            }),
        );
        moreBtn.appendChild(
            makeEl('span', {
                className: 'tooltip-text',
                text: m.card_similar_titles(),
            }),
        );
        actions.appendChild(moreBtn);

        const detailsBtn = makeEl('button', {
            className: 'action-btn ghost has-tooltip',
            attrs: {
                'data-action': 'click',
                tabindex: '0',
                'aria-label': m.card_details(),
            },
        });
        detailsBtn.appendChild(
            makeSvgIcon('action-icon', ICON_INFO, {
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '2',
                rounded: true,
            }),
        );
        detailsBtn.appendChild(
            makeEl('span', {
                className: 'tooltip-text',
                text: m.card_details(),
            }),
        );
        actions.appendChild(detailsBtn);

        info.appendChild(actions);

        if (onhide) {
            const hideLabel = m.card_hide_title_from_continue_watching({
                title: getCwDismissDisplayName(currentItem),
            });
            const hideBtn = makeEl('button', {
                className: 'action-btn popup-dismiss',
                attrs: {
                    'data-action': 'hide',
                    tabindex: '0',
                    'aria-label': hideLabel,
                },
            });
            hideBtn.appendChild(
                makeSvgIcon('action-icon', ICON_REMOVE, {
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: '2',
                    rounded: true,
                }),
            );
            hideBtn.appendChild(makeEl('span', { text: hideLabel }));
            info.appendChild(hideBtn);
        }

        attachActionTooltips(actions);
        content.appendChild(info);

        popupElement.textContent = '';
        popupElement.appendChild(content);

        // Attach click handlers to buttons
        popupElement.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = (btn as HTMLElement).dataset.action;
                if (action === 'play') {
                    startPlayback();
                    return;
                } else if (action === 'request') {
                    onrequest?.(item);
                } else if (action === 'more') {
                    onmore?.(item);
                } else if (action === 'click') {
                    onclick?.(item);
                } else if (action === 'hide') {
                    onhide?.(item);
                }
                hidePopup();
            });
        });

        // Handle backdrop load error
        const backdropImg = popupElement.querySelector('.backdrop-img') as HTMLImageElement;
        if (backdropImg) {
            backdropImg.onerror = () => {
                backdropImg.style.display = 'none';
            };
        }

        // Initialize video preview if needed (skipped while pendingVideoSetup
        // is non-null — the swap will happen when videoLoadTimeout fires).
        if ((shouldTryLocalTrailer || shouldShowVideoPreview) && !pendingVideoSetup) {
            initVideoPreview(videoPreviewId, currentItem, shouldTryLocalTrailer);
        }

        // Initialize YouTube player if we have a video
        if (videoId && !pendingVideoSetup && window.YT && window.YT.Player) {
            initYouTubePlayer(playerId, videoId);
        } else if (videoId && !pendingVideoSetup) {
            // Wait for YT API to load
            waitForYouTubeApi(() => initYouTubePlayer(playerId, videoId));
        }

        // Schedule the deferred video swap exactly once per show. If
        // renderPopupContent runs again before the timer fires (the
        // 1000ms progressive-disclosure re-render), we must NOT reset
        // the timer or any videoLoadDelay > ~1000ms would never elapse.
        // hidePopup() clears the timeout, so leaving it pending across
        // re-renders is safe.
        if (pendingVideoSetup && videoLoadTimeout === undefined) {
            videoLoadTimeout = setTimeout(loadDeferredVideo, videoLoadDelay);
        }

        // Handle mute button (uses separate attribute to avoid generic action handler)
        const muteBtn = popupElement.querySelector('[data-mute-toggle]');
        if (muteBtn) {
            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleMute();
            });
        }

        // Handle backdrop click → trigger play/continue
        const backdrop = popupElement.querySelector('.popup-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;

                // Don't trigger if clicking on buttons, badges, or mute button
                if (
                    target.closest('button') ||
                    target.closest('.ratings-badge') ||
                    target.closest('.watch-state-badge')
                ) {
                    return;
                }

                // Otherwise, trigger play action (same as play button)
                e.stopPropagation();
                startPlayback();
            });
        }
    }

    // Fires after videoLoadDelay if the popup is still visible. Replaces
    // the placeholder image with the appropriate video container and
    // boots the player. If the popup gets stolen / closed before this
    // runs, hidePopup() clears videoLoadTimeout so we never enqueue a
    // request for a card the user only scrubbed past.
    function loadDeferredVideo() {
        videoLoadTimeout = undefined;
        if (!isVisible || !popupElement || !pendingVideoSetup) return;
        const setup = pendingVideoSetup;
        const backdrop = popupElement.querySelector('.popup-backdrop');
        if (!backdrop) return;

        const existingImg = backdrop.querySelector('.backdrop-img');
        videoLoaded = true;
        pendingVideoSetup = null;

        if (setup.kind === 'preview') {
            const container = document.createElement('div');
            container.id = setup.containerId;
            container.className = 'popup-preview-container';
            if (existingImg) existingImg.replaceWith(container);
            else backdrop.insertBefore(container, backdrop.firstChild);
            initVideoPreview(setup.containerId, setup.item, setup.isTrailer === true);
        } else {
            const ytId = setup.videoId;
            if (!ytId) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'popup-video-container';
            const inner = document.createElement('div');
            inner.id = setup.containerId;
            wrapper.appendChild(inner);
            if (existingImg) existingImg.replaceWith(wrapper);
            else backdrop.insertBefore(wrapper, backdrop.firstChild);
            if (window.YT && window.YT.Player) {
                initYouTubePlayer(setup.containerId, ytId);
            } else {
                waitForYouTubeApi(() => initYouTubePlayer(setup.containerId, ytId));
            }
        }
    }

    function initVideoPreview(
        containerId: string,
        mediaItem: UniversalMediaItem,
        isTrailerAttempt = false,
    ) {
        const containerElement = document.getElementById(containerId);
        if (!containerElement) {
            console.error('[MediaHoverCard] Video preview container not found:', containerId);
            return;
        }

        // Captured now so the async onError/onNoTrailer callbacks below can
        // detect if the popup was hidden and re-shown (or recycled onto a
        // different item) before they resolved — see popupGeneration above.
        const generationAtMount = popupGeneration;

        // Lumastra-first: item.id IS the internal UUID; externalIds.internal may not be set
        const internalId = getLocalPreviewId(mediaItem);
        const nativeStreamUrl = (mediaItem as { nativeStreamUrl?: string }).nativeStreamUrl;

        if (!nativeStreamUrl && !internalId) {
            console.error('[MediaHoverCard] No playable source for video preview:', mediaItem.id);
            return;
        }

        // TV Series are now handled by the preview-session API, which resolves
        // the series to the appropriate episode (next unwatched or S01E01)

        // Standalone live TV channels use nativeStreamUrl (no provider API needed)
        const isNativeStream = !!nativeStreamUrl;

        // Detect if this is a live TV channel (has 'Live' badge)
        const isLiveTv = isNativeStream || mediaItem.badges?.some((badge) => badge.text === 'Live');

        // Calculate preview position (0 for live TV since it's live streaming,
        // and always 0 for a trailer request — resuming a trailer mid-way
        // makes no sense, and the server forces seek 0 for trailer responses
        // regardless).
        const startPositionSeconds = isTrailerAttempt
            ? 0
            : isLiveTv
              ? 0
              : calculatePreviewStartPosition(mediaItem);

        // Also passed into MediaPreviewPlayer so the loading/error states show
        // the still image instead of a black box.
        const backdropUrl = stillImageFor(mediaItem);

        // Swap the inline video out for the still backdrop image. Shared by
        // the error path (onError) and the benign hover-cap-expiry path
        // (onExpire); only the former logs — a cap-expiry is an expected UI
        // transition, not a failure, and must produce zero error-level logs.
        const swapToBackdrop = (): void => {
            if (!containerElement.parentElement) return;
            if (!backdropUrl) return;
            // Never cover a video that is still actually playing: the expire/
            // error signal can be spurious (session record lost server-side
            // while the stream itself keeps working — the "backdrop reappears
            // over the video" bug, 2026-07-17). Only swap when playback truly
            // is not running.
            const activeVideo = containerElement.querySelector('video');
            if (
                activeVideo instanceof HTMLVideoElement &&
                !activeVideo.paused &&
                !activeVideo.ended &&
                activeVideo.readyState >= 2
            ) {
                console.info(
                    '[MediaHoverCard] swapToBackdrop skipped — preview video is still playing',
                );
                return;
            }
            // The preview stopped (error/expiry) — release exclusive audio if this
            // popup held it so a silent backdrop doesn't strand ownership.
            previewAudio.release(audioId);
            containerElement.textContent = '';
            containerElement.appendChild(
                makeBackdropImg(backdropUrl, {
                    className: 'backdrop-img',
                    loading: 'lazy',
                }),
            );
        };

        // Mount the MediaPreviewPlayer component
        try {
            previewPlayerComponent = mount(MediaPreviewPlayer, {
                target: containerElement,
                props: {
                    itemId: mediaItem.id,
                    internalId,
                    nativeStreamUrl,
                    backdropUrl: backdropUrl ?? undefined,
                    startPositionSeconds,
                    durationSeconds: mediaItem.durationMs ? mediaItem.durationMs / 1000 : undefined,
                    isLiveTv, // Flag for live TV channels (enables strict rate limiting)
                    muted: isMuted,
                    // The action row's mute button is the only one; the
                    // player's own overlay would show a second one on the video.
                    showMuteButton: false,
                    // Share this popup's audio-owner id with the player.
                    audioOwnerId: audioId,
                    // Trailers never loop — they play to their natural end and
                    // fall back to the backdrop (onEnded below).
                    loop: false,
                    // Always request the local trailer explicitly on the
                    // trailer attempt — trailerRequired:true stops the server
                    // from silently substituting a snippet-from-0 for what was
                    // meant to be a real trailer probe.
                    trailerPreferred: isTrailerAttempt,
                    trailerRequired: isTrailerAttempt,
                    onTimeUpdate: (currentTime: number) => {
                        // Track position for resume handoff
                        previewPositions.set(mediaItem.id, currentTime);
                    },
                    onError: (error: string) => {
                        if (isTrailerAttempt) {
                            // Stale: this trailer attempt no longer belongs to the
                            // live popup content (hidden/re-shown or recycled onto
                            // a different item since mount) — bail silently.
                            if (generationAtMount !== popupGeneration) return;
                            console.error('[MediaHoverCard] Video preview error:', error);
                            trailerProbeFailedIds.add(mediaItem.id);
                            handleTrailerFallback(mediaItem, generationAtMount);
                        } else {
                            console.error('[MediaHoverCard] Video preview error:', error);
                            swapToBackdrop();
                        }
                    },
                    onExpire: () => {
                        // Benign: preview reached its hover time limit. Revert to
                        // the backdrop WITHOUT logging (unlike onError).
                        swapToBackdrop();
                    },
                    onNoTrailer: isTrailerAttempt
                        ? () => {
                              // Stale: bail before doing any work (see onError above).
                              if (generationAtMount !== popupGeneration) return;
                              // Server confirmed no local trailer exists for this
                              // item — remember it so re-hovering the same card
                              // doesn't re-probe, then fall through to the
                              // YouTube-or-snippet priority.
                              trailerProbeFailedIds.add(mediaItem.id);
                              handleTrailerFallback(mediaItem, generationAtMount);
                          }
                        : undefined,
                    onEnded: isTrailerAttempt
                        ? () => {
                              // Trailer finished playing to the end — fall back
                              // to the static backdrop (reuses the same
                              // audio-release + backdrop-swap routine as the
                              // error/expire paths above).
                              swapToBackdrop();
                          }
                        : undefined,
                    onCleanup: () => {
                        // Cleanup called by component on unmount
                    },
                },
            });
        } catch (error) {
            console.error('[MediaHoverCard] Failed to mount video preview:', error);
            if (isTrailerAttempt) {
                trailerProbeFailedIds.add(mediaItem.id);
                handleTrailerFallback(mediaItem, generationAtMount);
            }
        }
    }

    function calculatePreviewStartPosition(mediaItem: UniversalMediaItem): number {
        return calculateSmartPreviewPosition({
            progress: mediaItem.progress,
            runtimeMinutes:
                mediaItem.durationMs == null ? undefined : mediaItem.durationMs / 60_000,
            itemKey: mediaItem.externalIds?.internal ?? mediaItem.id,
            // No explicit fallback: the shared default already clears the
            // studio-logo window when runtimeMinutes is missing. Hardcoding 30
            // here reintroduced the logo problem for metadata-incomplete items.
        });
    }

    function initYouTubePlayer(playerId: string, videoId: string) {
        const playerElement = document.getElementById(playerId);
        if (!playerElement) return;

        currentVideoId = videoId;

        // Check for saved position, default to 2 seconds
        const savedPosition = videoPositions.get(videoId);
        const startTime = savedPosition ? Math.floor(savedPosition) : 2;

        ytPlayer = createYouTubePlayer({
            containerId: playerId,
            videoId,
            startTime,
            muted: isMuted,
            onReady: () => {
                // Reassert current ownership onto the freshly-created player.
                // createYouTubePlayer's own onReady unmutes when it was created
                // with muted:false; if ownership has since moved elsewhere we must
                // force it back to muted (else two players would sound).
                try {
                    if (previewAudio.owns(audioId)) {
                        ytPlayer?.unMute();
                        ytPlayer?.setVolume(50);
                    } else {
                        ytPlayer?.mute();
                    }
                } catch {
                    /* player may not be ready yet */
                }
                updateMuteButton();
            },
            onMuteChange: (muted) => {
                // The YouTube player changed its own mute state (e.g. the browser
                // blocked an unmute). Reconcile ownership so the store stays the
                // single source of truth.
                if (muted) {
                    previewAudio.release(audioId);
                } else {
                    previewAudio.claim(audioId);
                }
            },
            onError: (errorCode) => {
                console.warn(`[MediaHoverCard] YouTube error ${errorCode} for video ${videoId}`);
                youtubeError = true;
                handleYouTubeFallback();
            },
        });
    }

    // Gathers this component's inputs for the "YouTube trailer → local snippet
    // → static image" fallback priority, which lives (next to the initial
    // decision it near-duplicates, and sharing its audiobook gate) in
    // ./media-hover-decisions.ts. Used once the local-trailer probe is out of
    // the picture — either it failed, or shouldTryLocalTrailer was never true
    // for this item (e.g. Continue Watching/Next Up).
    function pickFallbackContent(
        mediaItem: UniversalMediaItem,
        options: { excludeYouTube?: boolean } = {},
    ): HoverFallbackContent {
        const hasYouTubeTrailer = trailersEnabled && !!mediaItem.trailerUrl;
        // A trailerUrl can be present but fail to parse to a YouTube video id
        // (malformed/unsupported URL) — only count it as usable when it does.
        const youtubeId =
            !options.excludeYouTube && hasYouTubeTrailer && mediaItem.trailerUrl
                ? youtube_parser(mediaItem.trailerUrl)
                : false;

        return decideFallbackContent({
            mediaType: mediaItem.mediaType,
            hasUsableYouTubeId: !!youtubeId,
            hasYouTubeTrailer,
            videoPreviewEnabled,
            hasPlayableSource: !!getLocalPreviewId(mediaItem) && mediaItem.isAvailable !== false,
            hasNativeStream: !!(mediaItem as { nativeStreamUrl?: string }).nativeStreamUrl,
            // Continue Watching / Next Up items prefer their local
            // resume-preview over a trailer (a trailer restarts from 0,
            // defeating "continue") — explicit rather than implicit via "these
            // items never reach this function" (they can, via
            // handleYouTubeFallback).
            isContinueWatchingItem: mediaItem.progress !== undefined && mediaItem.progress > 0,
            isNextUpItem:
                isEpisode(mediaItem.mediaType) &&
                (mediaItem.progress === undefined || mediaItem.progress === 0),
        });
    }

    // The local trailer probe came back with 'none' (or errored/failed to
    // mount) — re-run the YouTube-or-snippet priority that would have run
    // had shouldTryLocalTrailer been false, surgically swapping only the
    // backdrop container's content. Mirrors handleYouTubeFallback below
    // (same pattern, opposite direction in the priority chain); a full
    // renderPopupContent() re-render would destroy the popup content
    // element that attachPopupContentHandlers wired up in
    // createPopupContent(), losing hover-steal/mouse tracking — not just
    // the video.
    function handleTrailerFallback(mediaItem: UniversalMediaItem, generationAtMount: number) {
        // Stale: the popup was hidden/re-shown or recycled onto a different
        // item since the trailer attempt that led here was mounted — bail
        // before touching the (possibly now-different) live popup content.
        if (generationAtMount !== popupGeneration) return;
        if (!popupElement || !activeItem) return;

        const videoPreviewId = `video-preview-${popupId}`;
        const playerId = `yt-player-${popupId}`;
        const backdropContainer = popupElement.querySelector('.popup-backdrop');
        if (!backdropContainer) return;

        // Tear down the failed trailer attempt.
        if (previewPlayerComponent) {
            try {
                unmount(previewPlayerComponent);
            } catch {
                /* expected: component may already be unmounted */
            }
            previewPlayerComponent = null;
        }

        const fallback = pickFallbackContent(mediaItem);

        if (fallback === 'youtube') {
            const youtubeFallbackId = youtube_parser(mediaItem.trailerUrl!);
            backdropContainer.textContent = '';
            const wrapper = makeEl('div', { className: 'popup-video-container' });
            wrapper.appendChild(makeEl('div', { attrs: { id: playerId } }));
            backdropContainer.appendChild(wrapper);
            if (youtubeFallbackId) {
                if (window.YT && window.YT.Player) {
                    initYouTubePlayer(playerId, youtubeFallbackId);
                } else {
                    waitForYouTubeApi(() => initYouTubePlayer(playerId, youtubeFallbackId));
                }
            }
            return;
        }

        if (fallback === 'snippet') {
            backdropContainer.textContent = '';
            backdropContainer.appendChild(
                makeEl('div', {
                    className: 'popup-preview-container',
                    attrs: { id: videoPreviewId },
                }),
            );
            initVideoPreview(videoPreviewId, mediaItem, false);
            return;
        }

        // No fallback video available — release exclusive audio if this
        // popup held it and show the static backdrop image.
        previewAudio.release(audioId);
        const backdropUrl = stillImageFor(mediaItem);
        backdropContainer.textContent = '';
        backdropContainer.appendChild(
            makeBackdropImg(backdropUrl ?? '', {
                className: 'popup-backdrop-image',
                alt: `${mediaItem.title} backdrop`,
                loading: 'eager',
            }),
        );
    }

    function handleYouTubeFallback() {
        if (!popupElement || !activeItem) return;

        const videoPreviewId = `video-preview-${popupId}`;
        const backdropContainer = popupElement.querySelector('.popup-backdrop');
        if (!backdropContainer) return;

        // Destroy YouTube player
        if (ytPlayer) {
            destroyYouTubePlayer(ytPlayer);
            ytPlayer = null;
        }

        // Check if we can fall back to video preview — the YouTube trailer
        // itself already failed, so exclude it from the priority (retrying
        // the same failed video would be pointless).
        const canShowVideoPreview =
            pickFallbackContent(activeItem, { excludeYouTube: true }) === 'snippet';

        if (canShowVideoPreview) {
            // Replace YouTube container with video preview
            backdropContainer.textContent = '';
            backdropContainer.appendChild(
                makeEl('div', {
                    className: 'popup-preview-container',
                    attrs: { id: videoPreviewId },
                }),
            );
            initVideoPreview(videoPreviewId, activeItem);
        } else {
            // Fall back to backdrop image (no playing media left) — release
            // exclusive audio if this popup held it so ownership isn't stranded.
            previewAudio.release(audioId);
            const backdropUrl = stillImageFor(activeItem);
            backdropContainer.textContent = '';
            backdropContainer.appendChild(
                makeBackdropImg(backdropUrl ?? '', {
                    className: 'popup-backdrop-image',
                    alt: `${activeItem.title} backdrop`,
                    loading: 'eager',
                }),
            );
        }
    }

    function toggleMute() {
        // Unmuting claims exclusive audio (silencing every other preview/hero);
        // muting releases it. The $effect above applies the result to the YouTube
        // trailer and refreshes the icon; the mounted <video> preview reacts via
        // the shared audio-owner id.
        if (previewAudio.owns(audioId)) {
            previewAudio.release(audioId);
        } else {
            previewAudio.claim(audioId);
        }
    }

    function updateMuteButton() {
        if (!popupElement) return;
        const muteBtn = popupElement.querySelector('.mute-btn');
        if (!muteBtn) return;

        // The exclusive-audio store is the single source of truth; render the icon
        // straight from it (no reverse-sync from the video element).
        const actualMutedState = isMuted;
        const label = actualMutedState ? m.player_unmute() : m.card_mute();
        muteBtn.setAttribute('aria-label', label);
        muteBtn.setAttribute('aria-pressed', String(!actualMutedState));
        const hint = muteBtn.querySelector('.tooltip-text');
        if (hint) hint.textContent = label;
        refreshActionTooltip(muteBtn);

        // Update icon based on actual mute state. The path data is a trusted
        // hard-coded constant; rebuild the <path> via namespaced DOM nodes
        // instead of assigning innerHTML.
        const iconPaths = actualMutedState ? ICON_MUTED : ICON_UNMUTED;

        const svg = muteBtn.querySelector('svg');
        if (svg) {
            svg.textContent = '';
            for (const d of iconPaths) {
                const path = document.createElementNS(SVG_NS, 'path');
                path.setAttribute('d', d);
                svg.appendChild(path);
            }
        }
    }

    // =========================================================================
    // Right-click context menu (mirrors HeroSection's focused subset).
    // =========================================================================

    let contextMenuPos = $state<{ x: number; y: number } | null>(null);
    let contextMenuItem = $state<UniversalMediaItem | null>(null);
    let ratingModalOpen = $state(false);
    let fileInfoModalOpen = $state(false);
    let whyHereOpen = $state(false);
    let modalTargetItem = $state<UniversalMediaItem | null>(null);

    let isHoverAdmin = $derived(isPageAdmin($page.data));

    let hoverMenuItems: ContextMenuEntry[] = $derived.by(() => {
        const target = contextMenuItem;
        if (!target) return [];
        const isCwEpisode = !!onhide && isEpisode(target.mediaType);
        const out: ContextMenuEntry[] = [];
        // An audiobook must NOT travel through onplay: every surface's handler
        // routes to the video player. This popup starts the audiobook player
        // itself, so the entry is offered even where no onplay was provided.
        const menuPlayTarget = resolveMediaPlayTarget(target);
        const menuPlayable =
            menuPlayTarget.kind === 'audiobook' ||
            (menuPlayTarget.kind === 'watch' && onplay !== undefined);
        if (target.isAvailable && menuPlayable) {
            out.push({
                label: m.card_play(),
                icon: PlayCircle,
                onSelect: () => {
                    if (menuPlayTarget.kind === 'audiobook') {
                        void startAudiobookPlayback(menuPlayTarget.mediaId);
                        return;
                    }
                    onplay?.(target);
                },
            });
        } else if (
            target.canRequest &&
            $page.data?.user?.hasRequestPermission !== false &&
            requestsConfigured &&
            onrequest
        ) {
            out.push({
                label: m.request(),
                icon: DocumentPlus,
                onSelect: () => onrequest?.(target),
            });
        }
        if (onclick) {
            out.push({
                label: m.card_open_details(),
                icon: InformationCircle,
                onSelect: () => onclick?.(target),
            });
        }
        if (onmore) {
            out.push({
                label: m.card_similar_titles(),
                icon: Sparkles,
                onSelect: () => onmore?.(target),
            });
        }
        if (typeof target.reason === 'string' && target.reason.trim().length > 0) {
            out.push({
                label: m.card_why_here(),
                icon: Sparkles,
                onSelect: () => {
                    modalTargetItem = target;
                    whyHereOpen = true;
                },
            });
        }
        const isVideo =
            isMovie(target.mediaType) || isSeries(target.mediaType) || isEpisode(target.mediaType);
        if (canWatchlistMedia(target)) {
            const targetKey = mediaCompositeKey(
                target.externalIds,
                isSeries(target.mediaType) ? 'tv' : 'movie',
            );
            const inWatchlist = $watchlistItems.some(
                (w) => mediaCompositeKey(w.externalIds, w.mediaType) === targetKey,
            );
            out.push({
                label: inWatchlist ? m.watchlist_remove() : m.watchlist_add(),
                icon: Bookmark,
                onSelect: () => {
                    void toggleWatchlistMedia(target, {
                        isInWatchlist: inWatchlist,
                    });
                },
            });
        }
        if (canRateMedia(target)) {
            out.push({
                kind: 'actions',
                actions: [
                    {
                        icon: HandThumbDown,
                        label: m.card_dislike(),
                        accent: 'negative',
                        onSelect: () => {
                            void quickRateMedia(target, 'dislike');
                        },
                    },
                    {
                        icon: HandThumbUp,
                        label: m.card_liked(),
                        accent: 'positive',
                        onSelect: () => {
                            void quickRateMedia(target, 'liked');
                        },
                    },
                    {
                        icon: Heart,
                        label: m.card_loved(),
                        accent: 'love',
                        onSelect: () => {
                            void quickRateMedia(target, 'loved');
                        },
                    },
                ],
            });
            out.push({
                label: m.card_rate_this(),
                icon: Star,
                onSelect: () => {
                    modalTargetItem = target;
                    ratingModalOpen = true;
                },
            });
        }
        // "Show less like this" — soft, decaying neighborhood steering (not a
        // rating). Movies/series only.
        if (showDamperAction && (isMovie(target.mediaType) || isSeries(target.mediaType))) {
            out.push({
                label: m.card_less_like_this(),
                icon: EyeSlash,
                onSelect: () => {
                    void handleHoverLessLikeThis(target);
                },
            });
        }
        if (!isCwEpisode && target.isPlayed && target.externalIds?.internal && isVideo) {
            out.push({
                label: m.card_mark_unwatched(),
                icon: ArrowUturnLeft,
                onSelect: () => {
                    void markMediaUnwatched(target);
                },
            });
        }
        if (buildMediaShareId(target) !== null) {
            out.push({
                label: m.card_copy_link(),
                icon: ClipboardDocument,
                onSelect: () => {
                    void copyMediaLink(target);
                },
            });
        }
        if (onhide) {
            out.push({
                label: m.card_hide_title_from_continue_watching({
                    title: getCwDismissDisplayName(target),
                }),
                icon: XMark,
                destructive: true,
                onSelect: () => onhide?.(target),
            });
            if (isCwEpisode && target.externalIds?.internal) {
                out.push(
                    {
                        label: m.card_mark_episode_complete(),
                        icon: CheckCircle,
                        onSelect: () => {
                            void setEpisodeWatchState(target, true);
                        },
                    },
                    {
                        label: m.card_mark_episode_not_watched(),
                        icon: ArrowUturnLeft,
                        onSelect: () => {
                            void setEpisodeWatchState(target, false);
                        },
                    },
                );
            }
        }
        if (isHoverAdmin && target.externalIds?.internal && isVideo) {
            out.push({
                label: m.card_file_info(),
                icon: DocumentMagnifyingGlass,
                hideOnMobile: true,
                onSelect: () => {
                    modalTargetItem = target;
                    fileInfoModalOpen = true;
                },
            });
            out.push({
                label: m.card_refresh_metadata(),
                icon: ArrowPath,
                hideOnMobile: true,
                onSelect: () => {
                    void refreshMediaMetadata(target);
                },
            });
            const adminTargetId =
                isEpisode(target.mediaType) && target.seriesId
                    ? target.seriesId
                    : target.externalIds.internal;
            out.push({
                label: m.card_open_in_admin(),
                icon: WrenchScrewdriver,
                hideOnMobile: true,
                onSelect: () => {
                    if (typeof window === 'undefined') return;
                    window.open(
                        `/admin/library/media/${encodeURIComponent(adminTargetId)}`,
                        '_blank',
                        'noopener,noreferrer',
                    );
                },
            });
        }
        return out;
    });

    async function handleHoverLessLikeThis(target: UniversalMediaItem): Promise<void> {
        if (!target.externalIds) return;
        const [{ lessLikeThis }, { toasts }] = await Promise.all([
            import('$lib/api/for-you'),
            import('$lib/stores/toast.store'),
        ]);
        const mediaType = toMovieOrSeries(target.mediaType);
        // `lessLikeThis` writes a taste damper against a RECOMMENDER entity,
        // and the recommender only models movies and series. The old
        // `toPublicMovieOrSeries` answered 'movie' here, so "Less like this"
        // on an audiobook or a track recorded a damper against a MOVIE
        // carrying that item's external ids: it damped an unrelated title and
        // left the actual item unaffected. Bail instead of guessing.
        if (mediaType === null) return;
        const { error } = await lessLikeThis({
            externalIds: target.externalIds,
            mediaType,
            title: target.title,
        });
        if (!error) {
            toasts.info(m.card_less_like_this_done());
        }
    }

    function handlePopupContextMenu(e: MouseEvent): void {
        const tgt = e.target as HTMLElement | null;
        if (tgt?.closest('button, a, input, select, textarea')) return;
        e.preventDefault();
        e.stopPropagation();
        contextMenuItem = item;
        contextMenuPos = { x: e.clientX, y: e.clientY };
    }

    function closeHoverContextMenu(): void {
        contextMenuPos = null;
        contextMenuItem = null;
    }
</script>

<div
    class="media-hover-wrapper shrink-0"
    bind:this={triggerElement}
    data-card-popup-id={enabled && !isTouchDevice ? popupId : undefined}>
    {@render children()}
</div>

{#if contextMenuPos && contextMenuItem}
    <ContextMenu
        x={contextMenuPos.x}
        y={contextMenuPos.y}
        title={contextMenuItem.title}
        items={hoverMenuItems}
        onClose={closeHoverContextMenu} />
{/if}

{#if ratingModalOpen && modalTargetItem}
    <RatingPickerModal
        open={ratingModalOpen}
        title={modalTargetItem.title}
        externalIds={modalTargetItem.externalIds}
        mediaType={isSeries(modalTargetItem.mediaType) ? 'tv' : 'movie'}
        onClose={() => (ratingModalOpen = false)} />
{/if}

{#if fileInfoModalOpen && modalTargetItem?.externalIds?.internal}
    <MediaFileInfoModal
        open={fileInfoModalOpen}
        mediaId={modalTargetItem.externalIds.internal}
        includeChildren={isSeries(modalTargetItem.mediaType)}
        title={modalTargetItem.title}
        onClose={() => (fileInfoModalOpen = false)} />
{/if}

{#if whyHereOpen && modalTargetItem}
    <WhyHereModal
        open={whyHereOpen}
        title={modalTargetItem.title}
        reason={modalTargetItem.reason}
        onClose={() => (whyHereOpen = false)} />
{/if}

<!-- Portal-popup styles moved to src/lib/styles/global-components.css so the
     CSS lives in CSSOM exactly once instead of being injected per
     instance via <svelte:head>. -->

<style>
    /* Wrapper needs to create a box for floating-ui positioning */
    /* shrink-0 prevents flex shrinking in carousels */
    .media-hover-wrapper {
        outline: none;
        border-radius: 8px;
    }

    .media-hover-wrapper:focus-visible {
        outline: 2px solid rgb(59, 130, 246);
        outline-offset: 2px;
    }
</style>
