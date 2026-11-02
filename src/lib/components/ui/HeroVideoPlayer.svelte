<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	HeroVideoPlayer.svelte

	Reusable video player for hero sections and hover cards.
	Supports YouTube trailers, local video previews, and backdrop fallback.

	Features:
	- YouTube trailer autoplay (muted, looped)
	- Local video preview via MediaPreviewPlayer
	- Mute toggle with localStorage persistence
	- Automatic fallback chain: YouTube → Video preview → Backdrop
	- Playback position tracking for resume

	@example
	<HeroVideoPlayer
		{item}
		{trailersEnabled}
		{videoPreviewEnabled}
		backdropUrl="/api/image/..."
		aspectRatio="16/9"
	/>
-->
<script module lang="ts">
    /**
     * Module-level (shared across ALL instances) cache of item ids whose
     * video (YouTube trailer and/or local file preview) failed fatally
     * during this page's lifetime.
     *
     * The homepage hero carousel (HeroSection.svelte) mounts a BRAND-NEW
     * HeroVideoPlayer instance every time a slide re-enters the active or
     * preloaded slot — it does not keep one instance alive and mutate its
     * `item` prop. That means per-instance `$state` (e.g.
     * `showBackdropFallback`) cannot remember a past failure across a
     * rotation wraparound: without this cache, revisiting a slide whose
     * video failed earlier in the session would blindly re-attempt the same
     * doomed HLS/YouTube session and could reproduce the endless-retry bug
     * every time the carousel loops back around to it.
     */
    const failedVideoItemIds = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- page-lifetime failure cache, read once at init to seed $state, never reactively

    /**
     * Item ids whose local-trailer probe answered a definitive `mode: 'none'`
     * this page lifetime. Same reason as failedVideoItemIds: every carousel
     * pass mounts a new instance, so the per-instance verdict was lost and each
     * loop re-ran the probe — two preview-session POSTs per AI-suggested movie
     * per pass on prod (2026-09-25). Only 'none' is recorded; a probe ERROR may
     * be transient and is retried on the next mount.
     */
    const noLocalTrailerItemIds = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- page-lifetime verdict cache, read once per item to seed $state, never reactively
</script>

<script lang="ts">
    import { onMount, onDestroy, mount, unmount } from 'svelte';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { youtube_parser } from '../../../utility';
    import MediaPreviewPlayer from './MediaPreviewPlayer.svelte';
    import {
        ensureYouTubeApi,
        waitForYouTubeApi,
        createYouTubePlayer,
        destroyYouTubePlayer,
        calculateSmartPreviewPosition,
        type YouTubePlayer,
    } from '$lib/utils/video-player-utils';
    import { previewAudio } from '$lib/stores/preview-audio.svelte';
    import { isEpisode, isMovie } from '$lib/shared/media-types';
    import { canPlayInlineVideo } from './media-hover-decisions';
    import { getLocalPreviewId } from '$lib/utils/media-id-helpers';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The media item data */
        item: UniversalMediaItem;
        /** Whether YouTube trailers are enabled */
        trailersEnabled?: boolean;
        /** Whether local video previews are enabled */
        videoPreviewEnabled?: boolean;
        /** Backdrop image URL for fallback */
        backdropUrl?: string | null;
        /** Aspect ratio for the container */
        aspectRatio?: string;
        /** Whether to show the mute button in corner */
        showMuteButton?: boolean;
        /** Whether to autoplay (default true) */
        autoplay?: boolean;
        /** Start offset in seconds (skip intros/logos) */
        startOffset?: number;
        /** Video container scale - 100 = native, 200 = 2x zoom (default) */
        videoScale?: number;
        /**
         * Optional separate scale for the YouTube trailer (defaults to
         * `videoScale`). A little extra zoom crops the YouTube logo/chrome at
         * the corners without over-cropping local file previews.
         */
        youtubeScale?: number;
        /**
         * Loop the local video preview snippet (hero use). When true the
         * MediaPreviewPlayer replays its clip on end / duration-cap instead of
         * stopping. Only affects the local preview path, not YouTube trailers.
         */
        loop?: boolean;
        /**
         * Optional bound (seconds) on the looped snippet before it restarts.
         * Forwarded to MediaPreviewPlayer; only meaningful when `loop` is true.
         */
        durationCapSeconds?: number;
        /**
         * Force the most compatible codec (h264/AAC) on the server for a hero
         * preview shown to everyone. Forwarded to MediaPreviewPlayer →
         * POST /preview-session.
         */
        heroSafeCodec?: boolean;
        /** Callback when playback position updates */
        onTimeUpdate?: (position: number) => void;
        /** Callback when video errors and falls back */
        onFallback?: () => void;
        /** Callback when mute state changes */
        onMuteChange?: (muted: boolean) => void;
    }

    let {
        item,
        trailersEnabled = false,
        videoPreviewEnabled = false,
        backdropUrl = null,
        aspectRatio = '16/9',
        showMuteButton = true,
        autoplay = true,
        startOffset = 0,
        videoScale = 200,
        youtubeScale,
        loop = false,
        durationCapSeconds,
        heroSafeCodec,
        onTimeUpdate,
        onFallback,
        onMuteChange,
    }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    let containerElement: HTMLDivElement | undefined = $state();
    let videoContainerElement: HTMLDivElement | undefined = $state();

    // YouTube player state
    let ytPlayer: YouTubePlayer | null = null;
    let currentVideoId: string | null = null;
    let youtubeError = $state(false);

    // Video preview state
    let previewPlayerComponent: ReturnType<typeof mount> | null = null;

    // Playback position tracking
    let playbackPosition = $state(0);

    // Unique ID for this player instance. Doubles as this player's
    // exclusive-audio owner id (see preview-audio store).
    const playerId = `hero-player-${Math.random().toString(36).slice(2)}`;

    // Muted unless this player owns audio. Only one preview/hero across the whole
    // page may own audio at a time, so unmuting here silences every other player
    // (and vice-versa). The template mute icon and getMuted() read this.
    let isMuted = $derived(!previewAudio.owns(playerId));

    // Push the mute state onto whichever backend is active (YouTube iframe or the
    // mounted <video>) whenever ownership changes — including when ANOTHER player
    // claims audio and this one must fall silent — and notify the parent so its
    // own mute button icon (FeaturedPickSection) stays in sync.
    $effect(() => {
        const muted = isMuted;
        try {
            if (ytPlayer) {
                if (muted) {
                    ytPlayer.mute();
                } else {
                    ytPlayer.unMute();
                    ytPlayer.setVolume(50);
                }
            } else if (containerElement) {
                const videoElement = containerElement.querySelector('video');
                if (videoElement) {
                    videoElement.muted = muted;
                    if (!muted) videoElement.volume = 0.5;
                }
            }
        } catch {
            /* expected: player may not be ready when ownership changes */
        }
        onMuteChange?.(muted);
    });

    // Fallback state. Seeded from the module-level failure cache so a slide
    // whose video already failed once this session goes straight to the
    // backdrop on every subsequent mount (see `failedVideoItemIds` above)
    // instead of re-attempting a video path already known to be doomed.
    let showBackdropFallback = $state(false);
    // False until the active video actually starts playing. While false, the
    // backdrop cover overlay sits on top of the video — showing the backdrop
    // during buffering and hiding the brief YouTube chrome/title flash — then
    // fades out once playback begins.
    let videoReady = $state(false);

    // =========================================================================
    // Derived
    // =========================================================================

    // Lumastra-first: item.id IS the internal UUID; externalIds.internal may not be set
    let internalId = $derived(getLocalPreviewId(item));
    // Only attempt a local preview when the item is actually in the library.
    // Items surfaced with isAvailable=false are metadata-only (e.g. Jellyseerr
    // request targets shown in Featured Pick) and have no file to transcode —
    // skipping them avoids spurious 404s from /preview-session.
    let hasPlayableSource = $derived(!!internalId && item.isAvailable !== false);
    let hasYouTubeTrailer = $derived(trailersEnabled && !!item.trailerUrl);

    // The `videoPreviewEnabled` prop reflects the caller's own toggle (e.g. the
    // Featured Pick "enable video" switch); it does not know whether the server's
    // local-preview transcode pipeline is actually enabled
    // (FEATURE_MEDIA_HOVER_VIDEO_PREVIEW, off by default). Without this check we'd
    // call POST /preview-session anyway and the server would reject it with 400
    // "Video preview feature is disabled" — a console error on a fresh install.
    // Gate on the flag that mirrors the /preview-session endpoint's OWN
    // authorization (raw FEATURE_MEDIA_HOVER_VIDEO_PREVIEW), NOT the composite
    // `mediaHoverVideoPreview` (which also requires the hover-popup UI flag).
    // The hero calls preview-session directly, so it must match what the server
    // actually allows — else video-preview-on + hover-popup-off would suppress a
    // request the server would serve.
    let previewPipelineEnabled = $derived(
        $page.data?.features?.videoPreviewSessionEnabled === true,
    );
    let effectiveVideoPreviewEnabled = $derived(videoPreviewEnabled && previewPipelineEnabled);

    // Determine if this is a continue watching or next up item
    let isContinueWatchingItem = $derived(item.progress !== undefined && item.progress > 0);
    let isNextUpItem = $derived(
        isEpisode(item.mediaType) && (item.progress === undefined || item.progress === 0),
    );

    // Local trailer probe: tried once per item; 'none' answer falls through to
    // the existing YouTube-or-snippet priority.
    let localTrailerUnavailable = $state(false);

    // Hoisted so both the eligibility check below and initVideoPreview's own
    // live-TV branch (start position, trailerRequired override) agree on the
    // same signal — a live channel has no "trailer" concept.
    let isLiveTv = $derived(item.badges?.some((badge) => badge.text === 'Live') ?? false);

    // A book has no video track. This gate is shared with MediaHoverCard
    // (canPlayInlineVideo) rather than re-derived, because the hero's own
    // priority rules differ (movies prefer the trailer) so it cannot reuse the
    // whole table. Every arm below is gated: suppressing only the preview would
    // hand the slide to the YouTube arm instead.
    let inlineVideoPossible = $derived(canPlayInlineVideo(item.mediaType));

    let shouldTryLocalTrailer = $derived(
        inlineVideoPossible &&
            trailersEnabled &&
            hasPlayableSource &&
            !isLiveTv &&
            !isContinueWatchingItem &&
            !isNextUpItem &&
            !localTrailerUnavailable,
    );

    // For MOVIES we prefer the trailer over a local file preview (a polished
    // trailer beats a mid-film snippet). Episodes keep local-first (Next Up /
    // Continue Watching previews are the whole point). Movies without a trailer
    // still fall back to the local preview below.
    let preferTrailerForMovie = $derived(isMovie(item.mediaType) && hasYouTubeTrailer);

    // Video preview logic:
    // Show local preview if: feature enabled AND has playable source AND we are
    // not preferring a movie trailer AND (Continue Watching/Next Up OR no trailer)
    let shouldShowVideoPreview = $derived(
        inlineVideoPossible &&
            effectiveVideoPreviewEnabled &&
            hasPlayableSource &&
            !preferTrailerForMovie &&
            (isContinueWatchingItem || isNextUpItem || !hasYouTubeTrailer),
    );

    let youtubeVideoId = $derived(
        inlineVideoPossible &&
            !shouldTryLocalTrailer &&
            !shouldShowVideoPreview &&
            hasYouTubeTrailer &&
            item.trailerUrl
            ? youtube_parser(item.trailerUrl)
            : null,
    );

    let hasVideo = $derived(shouldTryLocalTrailer || shouldShowVideoPreview || !!youtubeVideoId);

    // YouTube trailers can use extra zoom (to crop the corner logo/chrome)
    // without over-cropping local file previews.
    let effectiveScale = $derived(youtubeVideoId ? (youtubeScale ?? videoScale) : videoScale);

    // Track if video has been initialized to detect re-enable
    let videoInitialized = $state(false);

    // =========================================================================
    // Lifecycle
    // =========================================================================

    onMount(() => {
        if (!browser || !autoplay) return;

        // Load YouTube IFrame API if needed (the $effect below handles actual player init)
        if (youtubeVideoId) {
            ensureYouTubeApi(() => {});
        }
    });

    onDestroy(() => {
        cleanup();
    });

    // Declared BEFORE the init effect below on purpose: effects run in
    // declaration order, and the init effect reads both flags this one seeds
    // from the page-lifetime caches. Declared after it, a remounted slide
    // probed (and fetched) before its remembered verdict landed.
    //
    // Reset the local-trailer probe when item identity changes on a live
    // instance (e.g. FeaturedPickSection's rotating `section.items[0]`
    // derive re-rolls without remounting this component) — a previous item's
    // 'no trailer' verdict must not carry over and suppress a genuinely
    // different item's trailer attempt.
    let lastLocalTrailerItemId = $state<string | null>(null);
    $effect(() => {
        const itemId = item.id;
        showBackdropFallback = browser && failedVideoItemIds.has(itemId);
        if (itemId !== lastLocalTrailerItemId) {
            lastLocalTrailerItemId = itemId;
            localTrailerUnavailable = noLocalTrailerItemIds.has(itemId);
        }
    });

    // Initialize/re-initialize video when props change or on initial mount
    $effect(() => {
        if (!browser || !autoplay) return;

        // If video should now be shown but wasn't initialized, initialize it
        if (hasVideo && !videoInitialized && videoContainerElement) {
            // initializeVideo() sets $state.videoInitialized, which this effect's own
            // guard reads at line 325. Writing it triggers a re-run. The second pass is
            // inert: !videoInitialized is now false (so this branch skips) and !hasVideo
            // is false (so cleanup skips too). This re-run is unchanged from the previous
            // deferred-call behavior — the 100ms delay never prevented it, only postponed it.
            initializeVideo();
        }

        // If video is disabled, cleanup
        if (!hasVideo && videoInitialized) {
            cleanup();
            videoInitialized = false;
        }
    });

    function initializeVideo() {
        // Guard against double-initialization from racing timeouts
        if (videoInitialized) return;

        // Re-cover with the backdrop until this video reports it is playing.
        videoReady = false;

        if (shouldTryLocalTrailer && internalId) {
            initVideoPreview({ trailer: true });
            videoInitialized = true;
        } else if (shouldShowVideoPreview && internalId) {
            initVideoPreview();
            videoInitialized = true;
        } else if (youtubeVideoId) {
            initYouTubePlayer(youtubeVideoId);
            videoInitialized = true;
        }
    }

    // =========================================================================
    // Video Preview (Local)
    // =========================================================================

    function initVideoPreview(opts?: { trailer?: boolean }) {
        if (!videoContainerElement || !internalId) return;

        const isTrailerAttempt = opts?.trailer === true;

        // Captured once per mount attempt so late-arriving trailer callbacks
        // (onEnded/onExpire/onError/onNoTrailer) can detect that `item` has
        // since rotated on this live instance (FeaturedPick swapping
        // `section.items[0]` mid-probe) and no-op instead of mis-acting on
        // whatever item is now current.
        const probeItemId = item.id;

        // Calculate resume position using shared utility. A trailer request
        // always starts from 0 — resuming a trailer mid-way makes no sense,
        // and the server forces seek 0 for trailer responses regardless.
        // Unwatched items get a deterministic mid-content offset rather than a
        // flat one, so a hero preview never opens on the studio logo reel. This
        // MUST match the hover-card path (MediaHoverCard) — the two diverged,
        // and the hero's plain resume calculation returned `startOffset` (0) for
        // every unwatched movie, which the downstream floor then pinned to 30s.
        const startPositionSeconds = isTrailerAttempt
            ? 0
            : isLiveTv
              ? 0
              : calculateSmartPreviewPosition({
                    progress: item.progress,
                    runtimeMinutes:
                        item.durationMs == null ? undefined : item.durationMs / 60_000,
                    itemKey: item.externalIds?.internal ?? item.id,
                    ...(startOffset > 0 ? { fallbackSeconds: startOffset } : {}),
                });

        try {
            previewPlayerComponent = mount(MediaPreviewPlayer, {
                target: videoContainerElement,
                props: {
                    // Server-driven hero items (e.g. Featured Pick) may have no
                    // top-level id — fall back to the internal UUID so the API
                    // path never renders a literal "undefined".
                    itemId: item.id ?? internalId,
                    internalId,
                    startPositionSeconds,
                    // Lets the player cap the studio-logo skip floor so it
                    // never seeks past the end of short content.
                    durationSeconds: item.durationMs ? item.durationMs / 1000 : undefined,
                    isLiveTv,
                    muted: isMuted,
                    // Share this hero's audio-owner id so the preview's own mute
                    // button and this hero's mute button drive the SAME owner.
                    audioOwnerId: playerId,
                    // Trailers never loop (they play to their natural end and
                    // fade to the backdrop); non-trailer previews keep the
                    // caller's own loop setting.
                    loop: isTrailerAttempt ? false : loop,
                    durationCapSeconds,
                    heroSafeCodec,
                    // Always request the local trailer explicitly on the
                    // trailer attempt — trailerRequired:true stops the server
                    // from silently substituting a snippet-from-0 for what
                    // was meant to be a real trailer probe.
                    trailerPreferred: isTrailerAttempt,
                    trailerRequired: isTrailerAttempt,
                    onTimeUpdate: (currentTime: number) => {
                        playbackPosition = currentTime;
                        onTimeUpdate?.(currentTime);
                    },
                    onError: isTrailerAttempt
                        ? () => {
                              // Trailer probe failed: fall through to the
                              // YouTube-or-snippet chain instead of going
                              // straight to the backdrop.
                              fallThroughFromTrailer(probeItemId);
                          }
                        : () => {
                              // MediaPreviewPlayer already logs the error with
                              // the right severity (info for expected 404
                              // fallback, error for genuine failures). Just
                              // trigger backdrop fallback here.
                              handleVideoError();
                          },
                    onNoTrailer: isTrailerAttempt
                        ? () => {
                              noLocalTrailerItemIds.add(probeItemId);
                              fallThroughFromTrailer(probeItemId);
                          }
                        : undefined,
                    onEnded: isTrailerAttempt
                        ? () => {
                              // Stale-probe guard: `item` may have rotated on
                              // this live instance since this trailer attempt
                              // was mounted (FeaturedPick swapping items mid-
                              // probe) — a late 'ended' for the OLD item must
                              // not kill the NEW item's already-live playback.
                              if (probeItemId !== item.id) return;
                              // Trailer finished: fade back to the backdrop.
                              previewAudio.release(playerId);
                              showBackdropFallback = true;
                              onFallback?.();
                          }
                        : undefined,
                    // Belt-and-braces: with hoverCapActive now excluded for
                    // trailers, onEnded is the expected path, but wire onExpire
                    // too in case the cap ever fires for a trailer (defense in
                    // depth) — same release→backdrop→fallback sequence, same
                    // stale-probe guard.
                    onExpire: isTrailerAttempt
                        ? () => {
                              if (probeItemId !== item.id) return;
                              previewAudio.release(playerId);
                              showBackdropFallback = true;
                              onFallback?.();
                          }
                        : undefined,
                    onCleanup: () => {},
                    onPlaying: () => {
                        videoReady = true;
                    },
                },
            });
        } catch (error) {
            console.error('[HeroVideoPlayer] Failed to mount video preview:', error);
            if (isTrailerAttempt) {
                fallThroughFromTrailer(probeItemId);
            } else {
                handleVideoError();
            }
        }
    }

    // =========================================================================
    // YouTube Player
    // =========================================================================

    function initYouTubePlayer(videoId: string) {
        if (!videoContainerElement) return;

        // Create player container
        const playerDiv = document.createElement('div');
        playerDiv.id = playerId;
        // eslint-disable-next-line svelte/no-dom-manipulating -- Dynamic YouTube player container
        videoContainerElement.appendChild(playerDiv);

        currentVideoId = videoId;

        const doInit = () => {
            ytPlayer = createYouTubePlayer({
                containerId: playerId,
                videoId,
                startTime: startOffset || 2,
                muted: isMuted,
                onReady: () => {
                    // Reassert current ownership onto the freshly-created player.
                    // createYouTubePlayer's own onReady unmutes when it was created
                    // with muted:false; if ownership has since moved elsewhere we
                    // must force it back to muted (else two players would sound).
                    try {
                        if (previewAudio.owns(playerId)) {
                            ytPlayer?.unMute();
                            ytPlayer?.setVolume(50);
                        } else {
                            ytPlayer?.mute();
                        }
                    } catch {
                        /* player may not be ready yet */
                    }
                },
                onPlaying: () => {
                    // Hold the cover briefly AFTER YouTube reports PLAYING: at the
                    // play-start moment YT still paints its big play-button / chrome
                    // frame, and fading the cover immediately exposes it. ~700ms
                    // lets real footage take over first. (Local previews fade
                    // immediately — they have no chrome.)
                    const startedId = currentVideoId;
                    setTimeout(() => {
                        if (currentVideoId === startedId) videoReady = true;
                    }, 700);
                },
                onMuteChange: (muted) => {
                    // The YouTube player changed its own mute state (e.g. the
                    // browser blocked an unmute). Reconcile ownership so the store
                    // stays the single source of truth.
                    if (muted) {
                        previewAudio.release(playerId);
                    } else {
                        previewAudio.claim(playerId);
                    }
                },
                onError: (errorCode) => {
                    console.warn(
                        `[HeroVideoPlayer] YouTube error ${errorCode} for video ${videoId}`,
                    );
                    youtubeError = true;
                    handleVideoError();
                },
            });
        };

        if (window.YT && window.YT.Player) {
            doInit();
        } else {
            waitForYouTubeApi(doInit);
        }
    }

    // =========================================================================
    // Error Handling & Fallback
    // =========================================================================

    // The trailer probe answered 'none' (or errored): tear down and re-enter
    // initializeVideo so the existing YouTube-or-snippet priority takes over.
    // `probeItemId` is the item this specific trailer attempt was mounted
    // for — if `item` has since rotated on this live instance (FeaturedPick
    // swapping items mid-probe), this callback is stale and must no-op
    // rather than tearing down or reinitializing the NEW item's playback.
    function fallThroughFromTrailer(probeItemId: string) {
        if (probeItemId !== item.id) return;
        if (previewPlayerComponent) {
            try {
                unmount(previewPlayerComponent);
            } catch {
                /* may already be unmounted */
            }
            previewPlayerComponent = null;
        }
        if (videoContainerElement) {
            // eslint-disable-next-line svelte/no-dom-manipulating -- Clear for fallthrough re-init
            videoContainerElement.innerHTML = '';
        }
        localTrailerUnavailable = true;
        videoInitialized = false;
        initializeVideo();
    }

    function handleVideoError() {
        // Cleanup current video
        if (ytPlayer) {
            destroyYouTubePlayer(ytPlayer);
            ytPlayer = null;
        }
        if (previewPlayerComponent) {
            try {
                unmount(previewPlayerComponent);
            } catch {
                /* expected: component may already be unmounted during error recovery */
            }
            previewPlayerComponent = null;
        }

        // Try video preview as fallback if YouTube failed
        if (
            youtubeError &&
            effectiveVideoPreviewEnabled &&
            hasPlayableSource &&
            videoContainerElement
        ) {
            // eslint-disable-next-line svelte/no-dom-manipulating -- Clear for fallback re-init
            videoContainerElement.innerHTML = '';
            initVideoPreview();
            return;
        }

        // Fall back to backdrop. Remember this item so a later rotation
        // wraparound doesn't retry the same doomed video path (see
        // `failedVideoItemIds` above). Release exclusive audio if we held it —
        // there's no playing media left, so keeping ownership would strand the
        // mute icon as "unmuted" and leave every other player muted.
        previewAudio.release(playerId);
        failedVideoItemIds.add(item.id);
        showBackdropFallback = true;
        onFallback?.();
    }

    // =========================================================================
    // Mute Control
    // =========================================================================

    export function toggleMute() {
        // Unmuting claims exclusive audio (silencing every other preview/hero);
        // muting releases it. The $effect above applies the result to the active
        // backend and notifies the parent — the template icon reacts to isMuted.
        if (previewAudio.owns(playerId)) {
            previewAudio.release(playerId);
        } else {
            previewAudio.claim(playerId);
        }
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    function cleanup() {
        // Release exclusive audio if we held it, so unmounting (e.g. hero slide
        // rotation) doesn't leave a phantom owner keeping everyone else muted.
        previewAudio.release(playerId);

        if (ytPlayer) {
            const currentTime = destroyYouTubePlayer(ytPlayer);
            if (currentTime !== null && currentTime > 0) {
                playbackPosition = currentTime;
            }
            ytPlayer = null;
        }
        currentVideoId = null;

        if (previewPlayerComponent) {
            try {
                unmount(previewPlayerComponent);
            } catch {
                /* expected: component may already be unmounted during cleanup */
            }
            previewPlayerComponent = null;
        }

        // Clear container for potential re-initialization
        if (videoContainerElement) {
            // eslint-disable-next-line svelte/no-dom-manipulating -- Clear for re-init
            videoContainerElement.innerHTML = '';
        }
    }

    // =========================================================================
    // Exports for parent components
    // =========================================================================

    export function getPlaybackPosition(): number {
        return playbackPosition;
    }

    export function getMuted(): boolean {
        return isMuted;
    }
</script>

<div class="hero-video-player" style="aspect-ratio: {aspectRatio};" bind:this={containerElement}>
    {#if hasVideo && !showBackdropFallback}
        <!-- Video Container -->
        <div
            class="video-container"
            style="width: {effectiveScale}%; height: {effectiveScale}%;"
            bind:this={videoContainerElement}>
        </div>

        <!-- Backdrop cover: sits on top of the video while it buffers, then
             cross-fades out once playback starts. Also hides the brief YouTube
             chrome/title flash during load. Always rendered (even without a
             backdropUrl) so the video's own black background + spinner is
             NEVER visible during buffering or an in-flight (bounded) HLS
             retry — the div's CSS gradient background is the minimum floor,
             the image (when available) layers on top of it. -->
        <div class="backdrop-cover" class:revealed={videoReady}>
            {#if backdropUrl}
                <img src={backdropUrl} alt="" aria-hidden="true" loading="eager" />
            {/if}
        </div>

        <!-- Mute Button -->
        {#if showMuteButton}
            <button
                class="hero-mute-btn"
                onclick={(e) => {
                    e.stopPropagation();
                    toggleMute();
                }}
                title={isMuted ? 'Unmute' : 'Mute'}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                    {#if isMuted}
                        <path
                            d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    {:else}
                        <path
                            d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    {/if}
                </svg>
            </button>
        {/if}
    {:else if backdropUrl}
        <!-- Backdrop Fallback -->
        <img src={backdropUrl} alt={item.title} class="backdrop-image" loading="eager" />
    {:else}
        <!-- Empty State -->
        <div class="empty-backdrop"></div>
    {/if}
</div>

<style>
    .hero-video-player {
        position: relative;
        width: 100%;
        overflow: hidden;
        background: linear-gradient(135deg, rgb(40, 40, 50) 0%, rgb(25, 25, 35) 100%);
    }

    .video-container {
        position: absolute;
        top: 50%;
        left: 50%;
        /* width and height set via inline style for dynamic videoScale */
        transform: translate(-50%, -50%);
        pointer-events: none;
    }

    .video-container :global(video) {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    /* A YouTube <iframe> can't object-fit:cover — its 16:9 content letterboxes
       when the iframe isn't 16:9 (the hero slide is taller than 16:9). Size it as
       a 16:9 box that is AT LEAST as large as the container in both axes, centered
       and overflow-cropped, so it always covers with no black bars. */
    .video-container :global(iframe) {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: auto;
        height: auto;
        min-width: 100%;
        min-height: 100%;
        aspect-ratio: 16 / 9;
        border: none;
    }

    .backdrop-image {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    /* Covers the (buffering) video; cross-fades out once playback starts.
       Always present (regardless of backdropUrl) so the video's own black
       background + spinner can never show through during buffering or a
       bounded HLS retry - the gradient background is the floor, the <img>
       (when a backdropUrl exists) layers on top of it. */
    .backdrop-cover {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 10;
        opacity: 1;
        pointer-events: none;
        transition: opacity 0.6s ease;
        /* Opaque dark base so the cover hides the YouTube chrome/play-button
           flash even in the moment before the cover image itself has decoded
           (discovery items aren't always cached), and is a graceful final
           state on its own when there is no backdropUrl at all. */
        background: linear-gradient(135deg, rgb(40, 40, 50) 0%, rgb(25, 25, 35) 100%);
    }

    .backdrop-cover img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .backdrop-cover.revealed {
        opacity: 0;
    }

    @media (prefers-reduced-motion: reduce) {
        .backdrop-cover {
            transition: none;
        }
    }

    .empty-backdrop {
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgb(40, 40, 50) 0%, rgb(25, 25, 35) 100%);
    }

    .hero-mute-btn {
        position: absolute;
        bottom: 12px;
        right: 12px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 20;
        transition: all 0.15s ease;
        backdrop-filter: blur(4px);
    }

    .hero-mute-btn:hover {
        background: rgba(0, 0, 0, 0.8);
        border-color: rgba(255, 255, 255, 0.5);
        transform: scale(1.1);
    }

    .hero-mute-btn svg {
        width: 20px;
        height: 20px;
    }
</style>
