<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import { SvelteSet } from 'svelte/reactivity';

    // Image error events do not expose HTTP status. Treat failed decorative
    // logos (including 404s) as absent for this tab, across player remounts.
    // Bound the negative cache for long-lived tabs.
    const failedLogoUrls = new SvelteSet<string>();
    const MAX_FAILED_LOGOS = 128;
</script>

<script lang="ts">
    /**
     * VideoOverlays - UI overlays that sit on top of the video
     *
     * Contains:
     * - Mobile double-tap skip animations
     * - Skip Intro/Credits button (with auto-skip countdown for credits)
     * - Next Item button/prompt (for episodes or playlist items)
     * - Quality change toast
     * - Player logo
     *
     * This component handles the visual overlays, while the parent
     * VideoPlayer handles the logic and state management.
     */
    import { onDestroy, untrack } from 'svelte';
    import type { SkipAnimationState } from './video-input';
    import * as m from '$lib/paraglide/messages';
    import { getCatalogPosterUrl, getCatalogThumbUrl } from '$lib/utils/image-utils';
    import { isEpisode as isEpisodeType } from '$lib/shared/media-types';
    import AudioOnlyBackdrop from './AudioOnlyBackdrop.svelte';
    import { getBackdropArtworkId } from './backdrop-artwork';
    import { formatEpisodeRangeCode } from './playback-display';
    import { playerStore } from './playerStore.svelte';
    import { shouldAdvanceInPlace } from './audio-only-advance';
    import {
        recordAutoplayedEpisode,
        resetStillWatchingStreak,
        shouldPromptStillWatching,
    } from './still-watching';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';

    // Effective next item type - unified structure for both episodes and playlist items
    type EffectiveNextItem = {
        type: 'playlist' | 'episode';
        itemId: string;
        internalId?: string;
        title: string;
        seriesName?: string;
        seasonNumber?: number;
        episodeNumber?: number;
        hasPrimaryImage: boolean;
        overview?: string;
        playlistId?: number;
        position?: number;
        isNewSeason?: boolean;
    } | null;

    interface Props {
        // Props - Logo
        logoUrl?: string | null;
        logoLoaded?: boolean;
        showLogo?: boolean;
        // Props - Skip animation (mobile double-tap)
        skipAnimation?: SkipAnimationState | null;
        // Props - Active segment (intro/outro/recap)
        activeSegment?: {
            type: 'intro' | 'outro' | 'recap' | 'preview' | 'commercial';
            endMs: number;
        } | null;
        // Props - Next item (unified: episode or playlist item)
        nextItem?: EffectiveNextItem;
        showNextItemPrompt?: boolean;
        // Props - Toast
        toast?: {
            message: string;
            type: 'up' | 'down' | 'info';
        } | null;
        // Props - Volume indicator
        volumeIndicator?: {
            volume: number; // 0-1
            isMuted: boolean;
        } | null;
        volumeIndicatorKey?: number; // Used to restart animation
        // Props - Speed indicator
        speedIndicator?: {
            speed: number; // playback rate (0.25 - 2)
        } | null;
        speedIndicatorKey?: number;
        // Props - Frame step indicator
        frameStepIndicator?: {
            direction: 'forward' | 'backward';
        } | null;
        frameStepIndicatorKey?: number;
        // Props - Seek percent indicator (for 0-9 keys)
        seekPercentIndicator?: {
            percent: number; // 0-100
        } | null;
        seekPercentIndicatorKey?: number;
        // Props - Auto-skip settings
        autoSkipIntroEnabled?: boolean; // Auto-skip intro immediately (small delay)
        autoSkipCreditsEnabled?: boolean; // Auto-skip credits with countdown
        autoPlayNextEnabled?: boolean; // Auto-play next item with countdown
        autoSkipCreditsDelay?: number; // seconds
        autoDismissNextItemEnabled?: boolean; // Auto-hide the next-item prompt after the delay (when not auto-playing)
        stillWatchingEnabled?: boolean; // Ask "are you still watching?" after unattended auto-play
        // Props - Watch party guest mode (disables skip buttons and auto-skip)
        isWatchPartyGuest?: boolean;
        // Props - External cancel trigger (increment to cancel any active auto-skip)
        cancelTrigger?: number;
        // Callbacks
        onskipsegment?: () => void;
        onnextitem?: (detail: {
            type: 'playlist' | 'episode';
            itemId: string;
            playlistId?: number;
            position?: number;
        }) => void;
        onlogoload?: (url: string) => void;
        onlogoerror?: (url: string) => void;
        onautoskipactivechange?: (detail: { active: boolean }) => void;
    }

    let {
        logoUrl = null,
        logoLoaded = $bindable(false),
        showLogo = false,
        skipAnimation = null,
        activeSegment = null,
        nextItem = null,
        showNextItemPrompt = false,
        toast = null,
        volumeIndicator = null,
        volumeIndicatorKey = 0,
        speedIndicator = null,
        speedIndicatorKey = 0,
        frameStepIndicator = null,
        frameStepIndicatorKey = 0,
        seekPercentIndicator = null,
        seekPercentIndicatorKey = 0,
        autoSkipIntroEnabled = false,
        autoSkipCreditsEnabled = true,
        autoPlayNextEnabled = true,
        autoSkipCreditsDelay = 10,
        autoDismissNextItemEnabled = false,
        stillWatchingEnabled = false,
        isWatchPartyGuest = false,
        cancelTrigger = 0,
        onskipsegment,
        onnextitem,
        onlogoload,
        onlogoerror,
        onautoskipactivechange,
    }: Props = $props();

    // Auto-skip timer for credits (Outro) - also handles auto-play next
    let autoSkipCountdown = $state(0);
    let autoSkipTimer = $state<ReturnType<typeof setInterval> | null>(null);
    let autoSkipCancelled = $state(false);

    // Auto-skip for intro - uses a separate timer with shorter delay
    let introSkipTimer = $state<ReturnType<typeof setTimeout> | null>(null);
    let introSkipCancelled = $state(false);
    const INTRO_SKIP_DELAY_MS = 3500; // Keep in sync with CSS --intro-skip-duration

    // Auto-dismiss timer for the next-item prompt (when the user enabled
    // auto-dismiss AND auto-play-next is OFF, so the prompt would otherwise
    // linger through the credits). Hides the prompt after autoSkipCreditsDelay.
    let autoDismissTimer = $state<ReturnType<typeof setTimeout> | null>(null);
    function clearAutoDismissTimer() {
        if (autoDismissTimer) {
            clearTimeout(autoDismissTimer);
            autoDismissTimer = null;
        }
    }

    // Track previous segment type to reset cancelled state on segment change
    let prevSegmentType: string | null = null;
    let prevShowNextItemPrompt = false;
    // User explicitly dismissed the next item card (persists until new prompt)
    let nextItemDismissed = $state(false);
    // Snapshot taken when the prompt appears: this advance waits for a human.
    // A snapshot, not a live derivation — once we have decided to ask, a stray
    // mouse nudge clearing the streak must not turn the question back into a
    // countdown under the viewer's nose.
    let stillWatchingHold = $state(false);

    // Track previous cancel trigger to detect external cancel requests.
    // untrack() is intentional — we want the initial value snapshot, not
    // a reactive read (the prev-value pattern updates this inside $effect).
    let prevCancelTrigger = untrack(() => cancelTrigger);

    // Expose whether any auto-skip is currently cancellable (for keyboard hint)
    // Uses timer existence to avoid cyclical dependency with cancelled flags
    let hasActiveAutoSkip = $derived(
        !!introSkipTimer || (!!autoSkipTimer && autoSkipCountdown > 0),
    );

    // Start/stop auto-skip timer for intro (shorter delay, no countdown UI)
    // Use a separate triggered flag to prevent reactive cycle
    let introSkipTriggered = $state(false);

    // Helper to dispatch next item event (used by auto-skip and manual click)
    function dispatchNextItem() {
        if (!nextItem) return;
        onnextitem?.({
            type: nextItem.type,
            itemId: nextItem.itemId,
            playlistId: nextItem.playlistId,
            position: nextItem.position,
        });
    }

    function triggerAutoSkip() {
        // Prevent the reactive block from restarting the countdown
        autoSkipCancelled = true;

        // If there's a next item available, go to it
        if (nextItem) {
            dispatchNextItem();
        } else if (activeSegment?.type === 'outro') {
            // Otherwise just skip credits
            onskipsegment?.();
        }
    }

    function cancelAutoSkip(event?: Event) {
        event?.stopPropagation();
        autoSkipCancelled = true;
        nextItemDismissed = true;
        clearAutoSkipTimer();
    }

    function dismissNextItem(event?: Event) {
        event?.stopPropagation();
        nextItemDismissed = true;
        autoSkipCancelled = true;
        clearAutoSkipTimer();
    }

    function cancelIntroAutoSkip(event?: Event) {
        event?.stopPropagation();
        introSkipCancelled = true;
        introSkipTriggered = false;
        clearIntroSkipTimer();
    }

    function clearAutoSkipTimer() {
        if (autoSkipTimer) {
            clearInterval(autoSkipTimer);
            autoSkipTimer = null;
        }
        autoSkipCountdown = 0;
    }

    function clearIntroSkipTimer() {
        if (introSkipTimer) {
            clearTimeout(introSkipTimer);
            introSkipTimer = null;
        }
    }

    onDestroy(() => {
        clearAutoSkipTimer();
        clearIntroSkipTimer();
        clearAutoDismissTimer();
    });

    // Get skip button label based on segment type
    function getSkipLabel(type: string): string {
        switch (type) {
            case 'intro':
                return m.player_skip_intro();
            case 'outro':
                return m.player_skip_credits();
            case 'recap':
                return m.player_skip_recap();
            case 'preview':
                return m.player_skip_preview();
            default:
                return m.player_skip();
        }
    }

    // Dispatch when auto-skip active state changes. untrack() — initial
    // snapshot only; $effect blocks elsewhere read+update it reactively.
    let prevHasActiveAutoSkip = untrack(() => hasActiveAutoSkip);

    // Event handlers
    function handleSkipSegment(event: Event) {
        event.stopPropagation();
        onskipsegment?.();
    }

    function handleNextItem(event?: Event) {
        event?.stopPropagation();
        // A deliberate "yes, keep going" — the streak starts over from here.
        resetStillWatchingStreak();
        stillWatchingHold = false;
        dispatchNextItem();
    }

    // Get label for next item button based on context
    function getNextItemLabel(): string {
        if (!nextItem) return '';

        if (nextItem.type === 'playlist') {
            return m.player_next_entry();
        }

        if (nextItem.isNewSeason) {
            return m.player_start_next_season({
                season: nextItem.seasonNumber ?? 1,
            });
        }

        return m.player_next_episode();
    }

    let visibleLogoUrl = $derived(logoUrl && !failedLogoUrls.has(logoUrl) ? logoUrl : null);

    function handleLogoLoad(event: Event & { currentTarget: EventTarget & Element }): void {
        const url = event.currentTarget.getAttribute('src');
        if (!url || url !== logoUrl) return;
        logoLoaded = true;
        onlogoload?.(url);
    }

    function handleLogoError(event: Event & { currentTarget: EventTarget & Element }): void {
        const url = event.currentTarget.getAttribute('src');
        if (!url) return;
        failedLogoUrls.add(url);
        if (failedLogoUrls.size > MAX_FAILED_LOGOS) {
            const oldest = failedLogoUrls.values().next().value;
            if (oldest) failedLogoUrls.delete(oldest);
        }
        if (url === logoUrl) logoLoaded = false;
        onlogoerror?.(url);
    }
    // Computed
    // Audio-only backdrop: shown as the bottom-most layer while the player is
    // running the audio-only quality rung (no video track to render). Uses
    // the same artwork id as MediaSessionController's lock-screen artwork so
    // both surfaces agree on which catalog id backs the fetched image.
    let showAudioOnlyBackdrop = $derived(
        playerStore.qualityMode === 'audio-only' && !!playerStore.playbackInfo,
    );
    let audioOnlyArtworkId = $derived.by(() => {
        const info = playerStore.playbackInfo;
        return info ? getBackdropArtworkId(info) : '';
    });
    let audioOnlySubtitle = $derived.by(() => {
        if (!isEpisodeType(playerStore.mediaType) || !playerStore.seriesName) return undefined;
        const seasonEp = formatEpisodeRangeCode(
            playerStore.seasonNumber,
            playerStore.episodeStartNumber ?? playerStore.episodeNumber,
            playerStore.episodeEndNumber,
        );
        return `${playerStore.seriesName} · ${seasonEp}`;
    });
    // Watch party guests should not see skip buttons - only the host controls playback
    let showSkipButton = $derived(
        activeSegment && !(showNextItemPrompt && nextItem) && !isWatchPartyGuest,
    );
    let showNextItemButton = $derived(
        showNextItemPrompt && nextItem && !isWatchPartyGuest && !nextItemDismissed,
    );
    // Watch for external cancel trigger (e.g., ESC key from parent)
    $effect(() => {
        if (cancelTrigger !== prevCancelTrigger) {
            prevCancelTrigger = cancelTrigger;
            if (cancelTrigger > 0) {
                // Cancel any active auto-skip timers
                // Call both unconditionally - they're safe to call even if nothing is active
                // The cancelled flags will be reset when entering new segments
                cancelIntroAutoSkip();
                cancelAutoSkip();
            }
        }
    });
    // Reset cancelled state when segment type changes or next item prompt appears
    $effect(() => {
        const currentType = activeSegment?.type ?? null;

        // Reset when segment type changes
        if (currentType !== prevSegmentType) {
            if (currentType === 'intro') {
                introSkipCancelled = false;
            } else if (currentType === 'outro') {
                autoSkipCancelled = false;
            } else if (currentType === null && !showNextItemPrompt) {
                // No segment and no prompt - reset both
                autoSkipCancelled = false;
                introSkipCancelled = false;
            }
            prevSegmentType = currentType;
        }

        // Reset when entering a new next-item prompt context
        if (showNextItemPrompt && !prevShowNextItemPrompt) {
            autoSkipCancelled = false;
            nextItemDismissed = false;
            stillWatchingHold =
                stillWatchingEnabled &&
                nextItem?.type === 'episode' &&
                // Audio-only advances in place so that background listening is
                // never interrupted; a streak banked while watching must not
                // reach across and stop it.
                playerStore.qualityMode !== 'audio-only' &&
                shouldPromptStillWatching(playerStore.seriesName ?? null);
        } else if (!showNextItemPrompt && prevShowNextItemPrompt) {
            // The hold gates shouldAutoSkip, which also arms the credits skip.
            // Leaving it set after the prompt closes (a seek back out of the
            // window) would silently disable auto-skip credits — a separate
            // setting this feature has no business touching.
            stillWatchingHold = false;
        }
        prevShowNextItemPrompt = showNextItemPrompt;
    });
    // Determine if we should auto-skip intro (no countdown, just a brief delay)
    // Watch party guests should never auto-skip - only the host controls playback
    let shouldAutoSkipIntro = $derived(
        autoSkipIntroEnabled &&
            !introSkipCancelled &&
            !isWatchPartyGuest &&
            activeSegment?.type === 'intro' &&
            showSkipButton,
    );
    $effect(() => {
        if (shouldAutoSkipIntro && !introSkipTimer && !introSkipTriggered) {
            // Start timer - will skip after brief delay
            introSkipTriggered = true; // Set before starting to prevent re-entry
            introSkipTimer = setTimeout(() => {
                clearIntroSkipTimer();
                onskipsegment?.();
            }, INTRO_SKIP_DELAY_MS);
        } else if (!shouldAutoSkipIntro) {
            // Reset triggered flag when segment ends
            if (introSkipTimer) clearIntroSkipTimer();
            introSkipTriggered = false;
        }
    });
    // Determine if we should show auto-skip countdown:
    // - During Outro segment: use autoSkipCreditsEnabled
    // - During next item prompt (end of video): use autoPlayNextEnabled
    // - Watch party guests should never auto-skip - only the host controls playback
    let shouldAutoSkip = $derived(
        !autoSkipCancelled &&
            !isWatchPartyGuest &&
            !stillWatchingHold &&
            ((autoSkipCreditsEnabled && activeSegment?.type === 'outro' && showSkipButton) ||
                (autoPlayNextEnabled && showNextItemPrompt && nextItem)),
    );
    // Start/stop auto-skip timer for credits/next item
    $effect(() => {
        if (shouldAutoSkip && !autoSkipTimer) {
            // Audio-only advances episodes in place for uninterrupted
            // background listening. A hidden tab throttles setInterval
            // unreliably, and there's no one to see the countdown card
            // anyway — skip it entirely and advance immediately instead of
            // waiting it out. Visible tabs keep the normal countdown.
            // Calls the same shouldAdvanceInPlace() the controller uses
            // (rather than re-deriving the condition here) so the two can't
            // drift — e.g. the watch-party exclusion only needs to be added
            // in one place.
            if (
                typeof document !== 'undefined' &&
                document.hidden &&
                nextItem?.type === 'episode' &&
                shouldAdvanceInPlace(
                    playerStore.qualityMode,
                    nextItem.type,
                    watchTogether.isInWatchParty,
                )
            ) {
                nextItemDismissed = true;
                triggerAutoSkip();
                return;
            }
            // Start countdown
            autoSkipCountdown = autoSkipCreditsDelay;
            autoSkipTimer = setInterval(() => {
                autoSkipCountdown--;
                if (autoSkipCountdown <= 0) {
                    clearAutoSkipTimer();
                    // Nobody asked for this one. Matches triggerAutoSkip's own
                    // branch: with a next item it advances, otherwise it only
                    // skips credits, which starts nothing.
                    if (nextItem?.type === 'episode') {
                        recordAutoplayedEpisode(playerStore.seriesName ?? null, nextItem.itemId);
                    }
                    triggerAutoSkip();
                }
            }, 1000);
        } else if (!shouldAutoSkip && autoSkipTimer) {
            // Clear timer when segment/prompt ends
            clearAutoSkipTimer();
        }
    });
    $effect(() => {
        if (hasActiveAutoSkip !== prevHasActiveAutoSkip) {
            prevHasActiveAutoSkip = hasActiveAutoSkip;
            onautoskipactivechange?.({ active: hasActiveAutoSkip });
        }
    });
    // Auto-dismiss the next-item prompt after the delay. Only relevant when
    // auto-play-next is OFF — when it's ON the countdown already advances, so
    // there's nothing to dismiss. Setting nextItemDismissed flips
    // showNextItemButton false, which makes shouldAutoDismiss false and clears
    // the (already-fired) timer on the next run.
    $effect(() => {
        const shouldAutoDismiss =
            autoDismissNextItemEnabled &&
            !autoPlayNextEnabled &&
            showNextItemButton &&
            !isWatchPartyGuest;
        if (shouldAutoDismiss && !autoDismissTimer) {
            const delayMs = Math.max(1, autoSkipCreditsDelay) * 1000;
            autoDismissTimer = setTimeout(() => {
                autoDismissTimer = null;
                nextItemDismissed = true;
            }, delayMs);
        } else if (!shouldAutoDismiss && autoDismissTimer) {
            clearAutoDismissTimer();
        }
    });
</script>

<!-- Audio-only backdrop: bottom-most layer, no video track to show -->
{#if showAudioOnlyBackdrop}
    <AudioOnlyBackdrop
        artworkId={audioOnlyArtworkId}
        title={playerStore.title}
        subtitle={audioOnlySubtitle} />
{/if}

<!-- Mobile double-tap skip animation -->
{#if skipAnimation}
    <div
        class="skip-overlay"
        class:left={skipAnimation.side === 'left'}
        class:right={skipAnimation.side === 'right'}>
        <div class="skip-ripple"></div>
        <div class="skip-content">
            <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32" class="skip-icon">
                {#if skipAnimation.side === 'left'}
                    <path
                        d="M12.5 3C17.15 3 21.08 6.03 22.47 10.22L20.1 11C19.05 7.81 16.04 5.5 12.5 5.5C10.54 5.5 8.77 6.22 7.38 7.38L10 10H3V3l2.6 2.6C7.45 4 9.85 3 12.5 3z" />
                {:else}
                    <path
                        d="M11.5 3C6.85 3 2.92 6.03 1.53 10.22L3.9 11C4.95 7.81 7.96 5.5 11.5 5.5C13.46 5.5 15.23 6.22 16.62 7.38L14 10H21V3l-2.6 2.6C16.55 4 14.15 3 11.5 3z" />
                {/if}
            </svg>
            <span class="skip-amount">{skipAnimation.amount} {m.player_seconds()}</span>
        </div>
    </div>
{/if}

<!-- Logo (bottom left) -->
{#if visibleLogoUrl}
    <div class="player-logo-container" class:visible={logoLoaded && showLogo}>
        <img
            src={visibleLogoUrl}
            alt=""
            class="player-logo"
            onload={handleLogoLoad}
            onerror={handleLogoError} />
    </div>
{/if}

<!-- Skip Intro/Credits Button -->
{#if showSkipButton && activeSegment}
    <div class="skip-button-container">
        <button
            class="skip-button"
            class:has-countdown={activeSegment.type === 'outro' && autoSkipCountdown > 0}
            class:has-auto-skip={activeSegment.type === 'intro' && shouldAutoSkipIntro}
            onclick={handleSkipSegment}
            aria-label={getSkipLabel(activeSegment.type)}>
            {getSkipLabel(activeSegment.type)}
            <span class="keyboard-hint" aria-hidden="true">↵</span>
            {#if activeSegment.type === 'outro' && autoSkipCountdown > 0}
                <span class="countdown-badge">{autoSkipCountdown}</span>
            {/if}
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
            </svg>
            {#if activeSegment.type === 'intro' && shouldAutoSkipIntro}
                <!-- Auto-skip indicator for intro -->
                <div
                    class="intro-auto-skip-indicator"
                    style="--intro-skip-duration: {INTRO_SKIP_DELAY_MS}ms">
                </div>
            {/if}
        </button>
        <!-- Cancel buttons are outside the main button to avoid nesting -->
        {#if activeSegment.type === 'outro' && autoSkipCountdown > 0}
            <button
                class="cancel-auto-skip"
                onclick={cancelAutoSkip}
                aria-label={m.player_cancel_auto_skip()}
                title={m.player_key_esc()}>
                ✕
            </button>
        {/if}
        {#if activeSegment.type === 'intro' && shouldAutoSkipIntro}
            <button
                class="cancel-auto-skip"
                onclick={cancelIntroAutoSkip}
                aria-label={m.player_cancel_auto_skip()}
                title={m.player_key_esc()}>
                ✕
            </button>
        {/if}
    </div>
{/if}

<!-- Next Item Button (Episode or Playlist Item) -->
{#if showNextItemButton && nextItem}
    {@const isEpisodeShape =
        nextItem.seasonNumber !== undefined && nextItem.episodeNumber !== undefined}
    {@const nextItemImageUrl = isEpisodeShape
        ? getCatalogThumbUrl(nextItem.internalId || nextItem.itemId, {
              size: 'thumb',
          })
        : getCatalogPosterUrl(nextItem.internalId || nextItem.itemId, {
              size: 'thumb',
          })}
    <div class="next-episode-container" class:has-countdown={autoSkipCountdown > 0}>
        <div
            class="next-episode-button"
            role="button"
            tabindex="0"
            onclick={handleNextItem}
            onkeydown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') handleNextItem();
            }}>
            {#if nextItem.hasPrimaryImage}
                <img
                    src={nextItemImageUrl}
                    alt={m.player_next_item_thumbnail_alt()}
                    class="next-episode-thumbnail"
                    onerror={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }} />
            {/if}
            <div class="next-episode-content">
                <span class="next-label">
                    {#if stillWatchingHold}
                        <span class="still-watching-label">{m.player_still_watching()}</span>
                    {:else}
                        {getNextItemLabel()}
                    {/if}
                    <span class="keyboard-hint-inline" aria-hidden="true">↵</span>
                    {#if autoSkipCountdown > 0}
                        <span class="countdown-inline"
                            >{m.player_in_seconds({
                                seconds: autoSkipCountdown,
                            })}</span>
                    {/if}
                </span>
                <span class="next-title">
                    {#if nextItem.seasonNumber !== undefined && nextItem.episodeNumber !== undefined}
                        S{String(nextItem.seasonNumber).padStart(2, '0')}E{String(
                            nextItem.episodeNumber,
                        ).padStart(2, '0')} - {nextItem.title}
                    {:else}
                        {nextItem.title}
                    {/if}
                </span>
                {#if nextItem.overview}
                    <span class="next-overview">{nextItem.overview}</span>
                {/if}
                {#if stillWatchingHold}
                    <button class="still-watching-continue" onclick={handleNextItem}>
                        {m.player_still_watching_continue()}
                        <span class="keyboard-hint-cancel" aria-hidden="true">↵</span>
                    </button>
                {:else if autoSkipCountdown > 0}
                    <button
                        class="cancel-inline"
                        onclick={cancelAutoSkip}
                        aria-label={m.player_cancel_auto_play()}>
                        {m.cancel()}
                        <span class="keyboard-hint-cancel" aria-hidden="true">Esc</span>
                    </button>
                {/if}
            </div>
            {#if autoSkipCountdown > 0}
                <!-- Circular progress indicator -->
                <div class="countdown-circle">
                    <svg viewBox="0 0 36 36" class="circular-progress">
                        <path
                            class="circle-bg"
                            d="M18 2.0845
								a 15.9155 15.9155 0 0 1 0 31.831
								a 15.9155 15.9155 0 0 1 0 -31.831" />
                        <path
                            class="circle-progress"
                            stroke-dasharray="{(autoSkipCountdown / autoSkipCreditsDelay) *
                                100}, 100"
                            d="M18 2.0845
								a 15.9155 15.9155 0 0 1 0 31.831
								a 15.9155 15.9155 0 0 1 0 -31.831" />
                    </svg>
                    <span class="countdown-number">{autoSkipCountdown}</span>
                </div>
            {:else}
                <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                </svg>
            {/if}
        </div>
        <button
            class="next-episode-dismiss"
            onclick={dismissNextItem}
            aria-label={m.a11y_dismiss()}
            title="Esc">
            ✕
        </button>
    </div>
{/if}

<!-- Quality change toast -->
{#if toast}
    <div
        class="quality-toast"
        class:toast-up={toast.type === 'up'}
        class:toast-down={toast.type === 'down'}>
        <span class="toast-icon">
            {#if toast.type === 'up'}
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path d="M7 14l5-5 5 5z" />
                </svg>
            {:else if toast.type === 'down'}
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path d="M7 10l5 5 5-5z" />
                </svg>
            {:else}
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path
                        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                </svg>
            {/if}
        </span>
        <span class="toast-message">{toast.message}</span>
    </div>
{/if}

<!-- Volume indicator OSD -->
{#key volumeIndicatorKey}
    {#if volumeIndicator}
        <div class="volume-indicator">
            <div class="volume-icon">
                {#if volumeIndicator.isMuted || volumeIndicator.volume === 0}
                    <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                        <path
                            d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                {:else if volumeIndicator.volume < 0.5}
                    <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                        <path
                            d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                    </svg>
                {:else}
                    <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                        <path
                            d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                {/if}
            </div>
            <div class="volume-bar-container">
                <div class="volume-bar-bg"></div>
                <div
                    class="volume-bar-fill"
                    style="width: {volumeIndicator.isMuted ? 0 : volumeIndicator.volume * 100}%">
                </div>
            </div>
            <span class="volume-percent"
                >{volumeIndicator.isMuted ? 0 : Math.round(volumeIndicator.volume * 100)}%</span>
        </div>
    {/if}
{/key}

<!-- Speed indicator OSD -->
{#key speedIndicatorKey}
    {#if speedIndicator}
        <div class="action-indicator">
            <div class="action-icon">
                <!-- Speed/gauge icon -->
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                    <path
                        d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zM10.59 15.41a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z" />
                </svg>
            </div>
            <span class="action-text">{speedIndicator.speed}x</span>
        </div>
    {/if}
{/key}

<!-- Frame step indicator OSD -->
{#key frameStepIndicatorKey}
    {#if frameStepIndicator}
        <div class="action-indicator">
            <div class="action-icon">
                <!-- Film frame icon -->
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                    <path
                        d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
                </svg>
            </div>
            <span class="action-text">
                {#if frameStepIndicator.direction === 'forward'}
                    {m.player_frame_forward()}
                {:else}
                    {m.player_frame_backward()}
                {/if}
            </span>
        </div>
    {/if}
{/key}

<!-- Seek percent indicator OSD -->
{#key seekPercentIndicatorKey}
    {#if seekPercentIndicator}
        <div class="action-indicator">
            <div class="action-icon">
                <!-- Seek/position icon -->
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
            </div>
            <span class="action-text">{seekPercentIndicator.percent}%</span>
        </div>
    {/if}
{/key}

<style>
    /* Mobile double-tap skip overlay */
    .skip-overlay {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 40%;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        z-index: 5;
    }

    .skip-overlay.left {
        left: 0;
        background: linear-gradient(to right, rgba(255, 255, 255, 0.15), transparent);
        border-radius: 0 100% 100% 0 / 0 50% 50% 0;
    }

    .skip-overlay.right {
        right: 0;
        background: linear-gradient(to left, rgba(255, 255, 255, 0.15), transparent);
        border-radius: 100% 0 0 100% / 50% 0 0 50%;
    }

    .skip-ripple {
        position: absolute;
        width: 100px;
        height: 100px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.3);
        animation: skip-ripple-anim 0.4s ease-out forwards;
    }

    @keyframes skip-ripple-anim {
        0% {
            transform: scale(0.5);
            opacity: 1;
        }
        100% {
            transform: scale(2);
            opacity: 0;
        }
    }

    .skip-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        color: white;
        animation: skip-fade-in 0.15s ease-out;
    }

    @keyframes skip-fade-in {
        0% {
            opacity: 0;
            transform: scale(0.8);
        }
        100% {
            opacity: 1;
            transform: scale(1);
        }
    }

    .skip-icon {
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
    }

    .skip-amount {
        font-size: 14px;
        font-weight: 600;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
    }

    /* Logo container - sized box with logo anchored to bottom-left.
       z-index 2 (not 5): this div is a direct, unwrapped child of
       .player-container (VideoOverlays has no root element), so it
       compares via plain sibling z-index against PlayerControls'
       .controls-container (tier 3, see VideoPlayer.svelte's
       .video-element comment). At 5 it painted over the entire control
       bar, including ProgressBar's trickplay hover-preview popup that
       pops up above the seek bar into this same bottom-left region. */
    .player-logo-container {
        position: absolute;
        bottom: 100px;
        left: 24px;
        width: 200px;
        height: 80px;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
        z-index: 2;
    }

    .player-logo-container.visible {
        opacity: 0.9;
    }

    /* Logo image - absolutely positioned at bottom-left of container */
    .player-logo {
        position: absolute;
        bottom: 0;
        left: 0;
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.6));
    }

    /* Mobile portrait */
    @media (max-width: 640px) and (orientation: portrait) {
        .player-logo-container {
            bottom: 75px;
            left: 12px;
            width: 140px;
            height: 80px;
        }
    }

    /* PWA standalone mode - account for safe area */
    @media (max-width: 640px) and (orientation: portrait) and (display-mode: standalone) {
        .player-logo-container {
            bottom: calc(75px + env(safe-area-inset-bottom, 0px));
        }
    }

    /* Mobile/tablet landscape */
    @media (orientation: landscape) and (max-height: 500px) {
        .player-logo-container {
            bottom: 90px;
            left: max(16px, env(safe-area-inset-left));
            width: 180px;
            height: 90px;
        }
    }

    /* Quality change toast */
    .quality-toast {
        position: absolute;
        bottom: 100px;
        right: 20px;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        background: rgba(0, 0, 0, 0.85);
        border-radius: 6px;
        color: white;
        font-size: 13px;
        font-weight: 500;
        z-index: 50;
        animation: toast-slide 2.5s ease-in-out;
        pointer-events: none;
    }

    .quality-toast.toast-up {
        border: 1px solid rgba(46, 204, 113, 0.5);
    }

    .quality-toast.toast-down {
        border: 1px solid rgba(241, 196, 15, 0.5);
    }

    .toast-icon {
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .toast-up .toast-icon {
        color: #2ecc71;
    }

    .toast-down .toast-icon {
        color: #f1c40f;
    }

    .toast-message {
        white-space: nowrap;
    }

    @keyframes toast-slide {
        0% {
            opacity: 0;
            transform: translateX(20px);
        }
        10% {
            opacity: 1;
            transform: translateX(0);
        }
        80% {
            opacity: 1;
        }
        100% {
            opacity: 0;
            transform: translateX(20px);
        }
    }

    /* Volume indicator OSD */
    .volume-indicator {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 24px;
        background: rgba(0, 0, 0, 0.85);
        border-radius: 12px;
        color: white;
        z-index: 60;
        animation: volume-fade 1.5s ease-in-out forwards;
        pointer-events: none;
    }

    @keyframes volume-fade {
        0% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.9);
        }
        10% {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }
        70% {
            opacity: 1;
        }
        100% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.95);
        }
    }

    .volume-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.9;
    }

    .volume-bar-container {
        position: relative;
        width: 120px;
        height: 6px;
        border-radius: 3px;
        overflow: hidden;
    }

    .volume-bar-bg {
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 3px;
    }

    .volume-bar-fill {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        background: white;
        border-radius: 3px;
        transition: width 0.1s ease-out;
    }

    .volume-percent {
        font-size: 16px;
        font-weight: 600;
        min-width: 48px;
        text-align: right;
    }

    /* Mobile adjustments for volume indicator */
    @media (max-width: 640px) {
        .volume-indicator {
            padding: 12px 18px;
            gap: 10px;
        }

        .volume-icon svg {
            width: 24px;
            height: 24px;
        }

        .volume-bar-container {
            width: 80px;
            height: 5px;
        }

        .volume-percent {
            font-size: 14px;
            min-width: 40px;
        }
    }

    /* Action indicator OSD (speed, frame step, seek percent) */
    .action-indicator {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 24px;
        background: rgba(0, 0, 0, 0.85);
        border-radius: 12px;
        color: white;
        z-index: 60;
        animation: action-fade 1.2s ease-in-out forwards;
        pointer-events: none;
    }

    @keyframes action-fade {
        0% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.9);
        }
        10% {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }
        70% {
            opacity: 1;
        }
        100% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.95);
        }
    }

    .action-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.9;
    }

    .action-text {
        font-size: 20px;
        font-weight: 600;
        white-space: nowrap;
    }

    /* Mobile adjustments for action indicator */
    @media (max-width: 640px) {
        .action-indicator {
            padding: 12px 18px;
            gap: 10px;
        }

        .action-icon svg {
            width: 24px;
            height: 24px;
        }

        .action-text {
            font-size: 16px;
        }
    }

    /* Keyboard hint badge */
    .keyboard-hint {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(0, 0, 0, 0.2);
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
        text-transform: uppercase;
        opacity: 0.7;
        margin-left: 4px;
    }

    /* Keyboard hint for inline text (next episode label) */
    .keyboard-hint-inline {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 3px;
        font-size: 10px;
        font-weight: 600;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
        text-transform: uppercase;
        margin-left: 6px;
        vertical-align: middle;
    }

    /* Keyboard hint for cancel button */
    .keyboard-hint-cancel {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px 4px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 3px;
        font-size: 9px;
        font-weight: 600;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
        margin-left: 4px;
        vertical-align: middle;
    }

    /* Hide keyboard hints on touch devices / mobile */
    @media (hover: none) and (pointer: coarse) {
        .keyboard-hint,
        .keyboard-hint-inline,
        .keyboard-hint-cancel {
            display: none;
        }
    }

    /* Skip Intro/Credits Button Container */
    .skip-button-container {
        position: absolute;
        bottom: 120px;
        right: 20px;
        z-index: 30;
        animation: skip-button-in 0.3s ease-out;
    }

    /* Skip Intro/Credits Button */
    .skip-button {
        position: relative;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1.25rem;
        background: rgba(255, 255, 255, 0.95);
        border: none;
        border-radius: 4px;
        color: #000;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition:
            transform 0.2s,
            background 0.2s;
        overflow: hidden;
    }

    .skip-button:hover {
        background: #fff;
        transform: scale(1.02);
    }

    .skip-button:active {
        transform: scale(0.98);
    }

    @keyframes skip-button-in {
        from {
            opacity: 0;
            transform: translateX(30px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }

    /* Next Episode Button */
    .next-episode-button {
        position: absolute;
        bottom: 120px;
        right: 20px;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0;
        background: rgba(20, 20, 20, 0.95);
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        color: white;
        cursor: pointer;
        z-index: 30;
        transition:
            transform 0.2s,
            border-color 0.2s,
            background 0.2s;
        animation: skip-button-in 0.3s ease-out;
        overflow: hidden;
    }

    .next-episode-button:hover {
        background: rgba(30, 30, 30, 0.98);
        border-color: rgba(255, 255, 255, 0.4);
        transform: scale(1.02);
    }

    .next-episode-button:active {
        transform: scale(0.98);
    }

    .next-episode-thumbnail {
        width: 160px;
        height: auto;
        display: block;
        flex-shrink: 0;
    }

    .next-episode-content {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        text-align: left;
        padding: 0.75rem 0;
    }

    .next-episode-content:first-child {
        padding-left: 0.75rem;
    }

    .next-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.7;
    }

    .next-title {
        font-size: 14px;
        font-weight: 500;
        margin-top: 4px;
        max-width: 200px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .next-overview {
        font-size: 11px;
        opacity: 0.65;
        margin-top: 4px;
        max-width: 200px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.4;
    }

    .next-episode-button svg {
        margin-right: 0.75rem;
        flex-shrink: 0;
        opacity: 0.8;
    }

    /* Next Episode Container (for cancel button placement) */
    .next-episode-container {
        position: absolute;
        bottom: 120px;
        right: 20px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.5rem;
        z-index: 30;
        animation: skip-button-in 0.3s ease-out;
    }

    .next-episode-container .next-episode-button {
        position: relative;
        bottom: auto;
        right: auto;
        animation: none;
    }

    .next-episode-dismiss {
        position: absolute;
        top: -10px;
        right: -10px;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: rgba(255, 255, 255, 0.8);
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
        transition:
            background 0.15s,
            color 0.15s;
    }

    .next-episode-dismiss:hover {
        background: rgba(255, 255, 255, 0.2);
        color: #fff;
    }

    /* Countdown badge for skip credits button */
    .countdown-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 50%;
        font-size: 12px;
        font-weight: 700;
    }

    .skip-button.has-countdown,
    .skip-button.has-auto-skip {
        padding-right: 2.5rem;
    }

    /* Auto-skip progress bar for intro */
    .intro-auto-skip-indicator {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: rgba(0, 0, 0, 0.2);
        overflow: hidden;
    }

    .intro-auto-skip-indicator::after {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        animation: intro-skip-progress var(--intro-skip-duration, 3500ms) linear forwards;
    }

    @keyframes intro-skip-progress {
        from {
            width: 0%;
        }
        to {
            width: 100%;
        }
    }

    /* Cancel auto-skip button - positioned at top-right of container */
    .skip-button-container > .cancel-auto-skip {
        position: absolute;
        right: -8px;
        top: -8px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: rgba(0, 0, 0, 0.7);
        border: 2px solid rgba(255, 255, 255, 0.9);
        border-radius: 50%;
        color: #fff;
        font-size: 11px;
        font-weight: bold;
        cursor: pointer;
        opacity: 0.9;
        transition:
            opacity 0.2s,
            transform 0.2s;
        z-index: 1;
    }

    .skip-button-container > .cancel-auto-skip:hover {
        opacity: 1;
        transform: scale(1.1);
    }

    /* Inline cancel button for next episode auto-play */
    .cancel-inline {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 6px;
        padding: 0.25rem 0.5rem;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.75);
        font-size: 11px;
        cursor: pointer;
        transition:
            background 0.2s,
            color 0.2s,
            border-color 0.2s;
    }

    .cancel-inline:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.4);
        color: white;
    }

    .still-watching-label {
        font-weight: 600;
    }

    .still-watching-continue {
        margin-top: 0.5rem;
        align-self: flex-start;
        padding: 0.35rem 0.75rem;
        border: 1px solid rgba(255, 255, 255, 0.35);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
        color: inherit;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
    }

    .still-watching-continue:hover,
    .still-watching-continue:focus-visible {
        background: rgba(255, 255, 255, 0.24);
    }

    /* Countdown inline text */
    .countdown-inline {
        font-weight: 400;
        opacity: 0.9;
        margin-left: 0.3rem;
    }

    /* Circular progress countdown */
    .countdown-circle {
        position: relative;
        width: 40px;
        height: 40px;
        margin-right: 0.75rem;
        flex-shrink: 0;
    }

    .circular-progress {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
    }

    .circle-bg {
        fill: none;
        stroke: rgba(255, 255, 255, 0.2);
        stroke-width: 3;
    }

    .circle-progress {
        fill: none;
        stroke: white;
        stroke-width: 3;
        stroke-linecap: round;
        transition: stroke-dasharray 0.3s ease;
    }

    .countdown-number {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 14px;
        font-weight: 600;
        color: white;
    }

    /* Mobile adjustments */
    @media (max-width: 640px) {
        .skip-button-container {
            bottom: 100px;
            right: 10px;
        }

        .skip-button {
            padding: 0.6rem 1rem;
            font-size: 12px;
        }

        .skip-button-container > .cancel-auto-skip {
            right: -6px;
            top: -6px;
            width: 20px;
            height: 20px;
            font-size: 10px;
        }

        .next-episode-button {
            bottom: 100px;
            right: 10px;
            gap: 0.5rem;
        }

        .next-episode-thumbnail {
            width: 100px;
        }

        .next-episode-content {
            padding: 0.5rem 0;
        }

        .next-episode-content:first-child {
            padding-left: 0.5rem;
        }

        .next-label {
            font-size: 9px;
        }

        .next-title {
            font-size: 11px;
            max-width: 140px;
        }

        .next-overview {
            font-size: 10px;
            max-width: 140px;
        }

        .next-episode-button svg {
            width: 18px;
            height: 18px;
            margin-right: 0.5rem;
        }

        .next-episode-container {
            bottom: 100px;
            right: 10px;
        }

        .countdown-circle {
            width: 32px;
            height: 32px;
            margin-right: 0.5rem;
        }

        .countdown-number {
            font-size: 12px;
        }

        .cancel-inline {
            font-size: 10px;
            padding: 0.2rem 0.4rem;
            margin-top: 4px;
        }
    }
</style>
