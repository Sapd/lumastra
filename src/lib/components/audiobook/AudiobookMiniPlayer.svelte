<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  AudiobookMiniPlayer — the persistent bar that makes a 20-hour listen survive
  navigation.

  A NEW component, not an extraction. `MiniPlayer.svelte` is 2239 lines with 172
  store references; crossfade prediction, the queue panel, alchemy, mood colours
  and radio now-playing are woven through it and there is no shell inside to
  pull out. What IS shared is the docking geometry, which is copied deliberately
  so the two bars occupy the same place: bottom anchored to
  `--music-bottom-nav-h`, with the safe-area inset only added back when the nav
  bar is not already reserving it.

  Only one of the two bars is ever mounted, because starting a book calls the
  audio arbiter, which calls the music store's stop() — and that resets its
  state, so `currentTrack` goes null and MiniPlayer unmounts itself.
-->

<script lang="ts">
    import {
        Icon,
        Play,
        Pause,
        ArrowUturnLeft,
        ArrowUturnRight,
        XMark,
        SpeakerWave,
        SpeakerXMark,
    } from 'svelte-hero-icons';
    // NOTE: this bar deliberately has NO error banner. Every error path in the
    // store resets to INITIAL_STATE, so `book` is null whenever `error` is set —
    // and this whole component is gated on `book !== null`. A banner here would
    // be unreachable by construction. Start failures surface as a toast from the
    // caller (`audiobookStartFailureMessage`), which works with no player mounted.
    import { Z } from '$lib/utils/z-index';
    import {
        audiobookPlayerStore,
        SKIP_BACK_MS,
        SKIP_FORWARD_MS,
    } from '$lib/stores/audiobook-player.store';
    import { audiobookFullScreenOpen } from '$lib/stores/audiobook-ui';
    import { formatChapterTime } from '$lib/utils/music-chapters';
    import { page } from '$app/stores';
    import {
        applyVolumeCurve,
        inverseVolumeCurve,
        isVolumeCurve,
    } from '$lib/components/player/volume-control';

    const playerState = $derived($audiobookPlayerStore);
    const visible = $derived(playerState.book !== null);

    // ── Volume ─────────────────────────────────────────────────────────────
    // Same gate and same curve handling as the full-screen row and the music
    // mini bar: hidden entirely where the browser cannot set volume (iOS, where
    // `PlainAudioBackend` reports supportsVolumeControl false and the hardware
    // keys are the only control), and the SLIDER POSITION is curve-space, not
    // volume-space. Sharing the transform is what makes this bar and the
    // full-screen row put the handle in the same place for the same volume —
    // reading `volume` straight into the input would put them at odds on any
    // non-linear curve.
    const volumeCurve = $derived.by(() => {
        const configValue = $page.data?.player?.volumeCurve;
        return isVolumeCurve(configValue) ? configValue : 'linear';
    });
    const sliderPosition = $derived(
        inverseVolumeCurve(playerState.isMuted ? 0 : playerState.volume, volumeCurve),
    );

    /**
     * The mini bar's progress is CHAPTER-scoped, matching the full-screen
     * scrubber. A whole-book bar here would be ~4 minutes per pixel on a phone
     * and would look motionless for a quarter of an hour.
     */
    const chapterFraction = $derived(
        playerState.chapterDurationMs > 0
            ? Math.min(
                  1,
                  Math.max(0, playerState.chapterPositionMs / playerState.chapterDurationMs),
              )
            : 0,
    );

    /**
     * The width transition smooths the coarse position ticks the backend emits,
     * but it has no business animating a DISCONTINUITY. At a chapter boundary
     * the fraction snaps from ~1 back to ~0, and the transition then plays that
     * as a slow right-to-left crawl — the bar appears to rewind through the
     * chapter it just finished. Same for a backwards seek.
     *
     * So the transition is dropped for exactly the commit that jumps. This runs
     * in `$effect.pre`, which lands before the DOM update in the same flush, so
     * the class is already gone when the new width is written and the browser
     * has nothing to animate from. The next ordinary tick re-enables it, at
     * which point the width is not changing, so no animation is triggered by
     * the re-enable itself.
     */
    let animateWidth = $state(true);
    let lastChapterIndex: number | null = null;
    let lastFraction = 0;
    $effect.pre(() => {
        const chapterIndex = playerState.currentChapter?.index ?? null;
        const fraction = chapterFraction;
        animateWidth = chapterIndex === lastChapterIndex && fraction >= lastFraction - 0.001;
        lastChapterIndex = chapterIndex;
        lastFraction = fraction;
    });

    /**
     * Compact WHOLE-BOOK time readout for the mini bar — elapsed and
     * remaining, not the chapter clock the progress bar above already tracks
     * and not both timelines at once, which would either wrap or push the
     * transport buttons off screen on a narrow phone. Elapsed + remaining
     * (rather than elapsed + total) mirrors the pairing the full-screen
     * player shows under its own whole-book bar, and answers the question a
     * listener re-opening the app mid-book actually has: how much is left.
     *
     * `durationMs` can be 0 for a moment at load, before the session payload
     * has resolved. `formatChapterTime(0)` would print "0:00 / 0:00", which
     * reads as "this book is zero seconds long" rather than "still loading" —
     * so an unresolved duration shows a placeholder instead of a false zero.
     */
    const hasKnownDuration = $derived(playerState.durationMs > 0);
    const elapsedLabel = $derived(
        hasKnownDuration ? formatChapterTime(playerState.bookPositionMs) : '--:--',
    );
    const remainingLabel = $derived(
        hasKnownDuration
            ? `-${formatChapterTime(Math.max(0, playerState.durationMs - playerState.bookPositionMs))}`
            : '--:--',
    );

    function toggle(event: MouseEvent): void {
        event.stopPropagation();
        if (playerState.isPlaying) audiobookPlayerStore.pause();
        else void audiobookPlayerStore.resume();
    }

    function skip(event: MouseEvent, deltaMs: number): void {
        event.stopPropagation();
        void audiobookPlayerStore.skipBy(deltaMs);
    }

    function toggleMute(event: MouseEvent): void {
        event.stopPropagation();
        audiobookPlayerStore.toggleMute();
    }

    function setVolumeFromSlider(event: Event): void {
        event.stopPropagation();
        const position = Number((event.currentTarget as HTMLInputElement).value);
        audiobookPlayerStore.setVolume(applyVolumeCurve(position, volumeCurve));
    }

    // Scroll-wheel volume over the desktop volume region, matching the music
    // mini bar. The step is in slider-position units so one notch feels the
    // same regardless of which curve is configured.
    const WHEEL_VOLUME_STEP = 0.03;

    function volumeWheel(node: HTMLElement) {
        function onWheel(event: WheelEvent): void {
            event.preventDefault();
            if (event.deltaY === 0) return;
            const delta = event.deltaY < 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP;
            const target = Math.min(1, Math.max(0, sliderPosition + delta));
            audiobookPlayerStore.setVolume(applyVolumeCurve(target, volumeCurve));
        }
        node.addEventListener('wheel', onWheel, { passive: false });
        return {
            destroy() {
                node.removeEventListener('wheel', onWheel);
            },
        };
    }

    function close(event: MouseEvent): void {
        event.stopPropagation();
        audiobookFullScreenOpen.set(false);
        void audiobookPlayerStore.stop();
    }

    // ── Swipe-up to open (mobile) ──────────────────────────────────────────
    // Mirrors MiniPlayer.svelte's music gesture (same thresholds/feel), minus
    // the progressive full-screen slide-in — this bar has no store field to
    // drive that, and the full-screen sheet already has its own open
    // transition (`transition:fly`) shared with the tap-to-open path. The bar
    // itself gets a small tactile lift while dragging so the gesture isn't
    // silently swallowed the way it was before this existed.
    const SWIPE_UP_COMMIT_THRESHOLD = 64; // px to commit to opening
    const SWIPE_UP_START_THRESHOLD = 8; // px before we claim the gesture
    const SWIPE_UP_AXIS_LOCK = 8;
    const SWIPE_UP_FLICK_VELOCITY = 0.45; // px/ms
    const SWIPE_VELOCITY_WINDOW = 5;
    const SWIPE_LIFT_MAX_PX = 40;

    let swipeStartY = 0;
    let swipeStartX = 0;
    let swipeLastY = 0;
    let swipeLastTime = 0;
    let swipeDeltaY = $state(0);
    let swipeVelocity = 0;
    let swipeActive = $state(false);
    let swipeCaptured = false;
    let swipeVelocitySamples: number[] = [];

    function resetSwipe(): void {
        swipeDeltaY = 0;
        swipeVelocity = 0;
        swipeActive = false;
        swipeCaptured = false;
        swipeVelocitySamples = [];
    }

    function handleBarTouchStart(e: TouchEvent): void {
        if (window.innerWidth >= 768 || e.touches.length !== 1) return;
        swipeStartY = e.touches[0].clientY;
        swipeStartX = e.touches[0].clientX;
        swipeLastY = swipeStartY;
        swipeLastTime = performance.now();
        resetSwipe();
    }

    function handleBarTouchMove(e: TouchEvent): void {
        if (window.innerWidth >= 768 || e.touches.length !== 1) return;
        const touch = e.touches[0];
        const deltaY = swipeStartY - touch.clientY;
        const deltaX = touch.clientX - swipeStartX;
        const now = performance.now();
        const dt = Math.max(1, now - swipeLastTime);
        const instantV = (swipeLastY - touch.clientY) / dt;
        swipeVelocitySamples.push(instantV);
        if (swipeVelocitySamples.length > SWIPE_VELOCITY_WINDOW) {
            swipeVelocitySamples.shift();
        }
        swipeVelocity =
            swipeVelocitySamples.reduce((a, b) => a + b, 0) / swipeVelocitySamples.length;
        swipeLastY = touch.clientY;
        swipeLastTime = now;

        if (!swipeCaptured) {
            if (Math.abs(deltaY) < SWIPE_UP_AXIS_LOCK && Math.abs(deltaX) < SWIPE_UP_AXIS_LOCK) {
                return;
            }
            if (deltaY <= SWIPE_UP_START_THRESHOLD || Math.abs(deltaX) > deltaY) {
                resetSwipe();
                return;
            }
            swipeCaptured = true;
            swipeActive = true;
        }

        if (!swipeCaptured) return;
        // Own the gesture with a non-passive listener — Svelte's declarative
        // touchmove listener is passive, so iOS would otherwise scroll the page.
        if (e.cancelable) e.preventDefault();
        swipeDeltaY = Math.max(0, deltaY);
    }

    function handleBarTouchEnd(e: TouchEvent): void {
        if (window.innerWidth >= 768 || !swipeActive || !swipeCaptured) {
            resetSwipe();
            return;
        }
        if (e.cancelable) e.preventDefault();
        if (
            swipeDeltaY >= SWIPE_UP_COMMIT_THRESHOLD ||
            (swipeVelocity >= SWIPE_UP_FLICK_VELOCITY && swipeDeltaY > 24)
        ) {
            audiobookFullScreenOpen.set(true);
        }
        resetSwipe();
    }

    function swipeUpToOpen(node: HTMLElement) {
        node.addEventListener('touchstart', handleBarTouchStart, { passive: true });
        node.addEventListener('touchmove', handleBarTouchMove, { passive: false });
        node.addEventListener('touchend', handleBarTouchEnd, { passive: false });
        node.addEventListener('touchcancel', resetSwipe);
        return {
            destroy() {
                node.removeEventListener('touchstart', handleBarTouchStart);
                node.removeEventListener('touchmove', handleBarTouchMove);
                node.removeEventListener('touchend', handleBarTouchEnd);
                node.removeEventListener('touchcancel', resetSwipe);
            },
        };
    }
</script>

{#if visible}
    <div
        class="audiobook-mini fixed left-0 right-0 border-t border-surface-500/20 bg-surface-800/95 backdrop-blur-lg"
        style="z-index: {Z.MUSIC_BAR}; bottom: var(--music-bottom-nav-h, 0px);
               padding-bottom: max(0px, calc(env(safe-area-inset-bottom) - var(--music-bottom-nav-h, 0px)));">
        <!-- Chapter progress, non-interactive here: the interactive scrubber
             lives in the full-screen player, where a mis-tap is deliberate
             rather than a consequence of reaching for the play button. -->
        <div class="h-1 w-full bg-surface-600/40" aria-hidden="true">
            <div
                class="h-full bg-primary-500 {animateWidth
                    ? 'transition-[width] duration-300'
                    : ''}"
                style="width: {chapterFraction * 100}%">
            </div>
        </div>

        {#if playerState.pendingUndo}
            <!-- Layer 2 of the accidental-seek protection. A transient
                 affordance, NOT a confirm dialog: confirms get muscle-memoried
                 away and then protect nothing. -->
            <div
                class="flex items-center gap-2 bg-surface-700/80 px-4 py-2 text-sm text-surface-100">
                <span class="min-w-0 flex-1 truncate">
                    Jumped to {formatChapterTime(playerState.pendingUndo.toMs)}
                </span>
                <button
                    type="button"
                    class="shrink-0 rounded px-2 py-1 font-semibold text-primary-300 hover:bg-surface-600"
                    onclick={() => void audiobookPlayerStore.undoSeek()}>
                    Undo
                </button>
                <button
                    type="button"
                    class="shrink-0 rounded p-1 text-surface-400 hover:bg-surface-600"
                    aria-label="Dismiss"
                    onclick={() => audiobookPlayerStore.dismissUndo()}>
                    <Icon src={XMark} class="h-4 w-4" />
                </button>
            </div>
        {/if}

        <div
            role="button"
            tabindex="0"
            aria-label="Open the audiobook player"
            class="flex w-full items-center gap-4 px-4 py-3 text-left"
            style:transform={swipeDeltaY > 0
                ? `translateY(-${Math.min(SWIPE_LIFT_MAX_PX, swipeDeltaY * 0.3)}px)`
                : undefined}
            style:transition={swipeActive ? 'none' : 'transform 0.2s ease'}
            use:swipeUpToOpen
            onclick={() => audiobookFullScreenOpen.set(true)}
            onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    audiobookFullScreenOpen.set(true);
                }
            }}>
            {#if playerState.book?.images.primary?.href}
                <img
                    src={playerState.book.images.primary?.href}
                    alt=""
                    class="h-14 w-14 shrink-0 rounded object-cover"
                    loading="lazy" />
            {:else}
                <div class="h-14 w-14 shrink-0 rounded bg-surface-700"></div>
            {/if}

            <div class="min-w-0 flex-1">
                <p class="truncate text-base font-medium text-white">
                    {playerState.book?.title ?? ''}
                </p>
                <p class="truncate text-sm text-surface-400">
                    {playerState.currentChapter?.title ?? playerState.book?.author ?? ''}
                </p>
            </div>

            <div
                class="flex shrink-0 flex-col items-end whitespace-nowrap text-xs leading-tight tabular-nums text-surface-400"
                aria-hidden="true">
                <span>{elapsedLabel}</span>
                <span>{remainingLabel}</span>
            </div>

            <div class="flex shrink-0 items-center gap-1">
                <button
                    type="button"
                    class="flex h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-700 hover:text-white"
                    aria-label="Back 30 seconds"
                    onclick={(e) => skip(e, -SKIP_BACK_MS)}>
                    <Icon src={ArrowUturnLeft} class="h-6 w-6" />
                </button>
                <button
                    type="button"
                    data-testid="audiobook-mini-toggle"
                    class="flex h-12 w-12 items-center justify-center rounded-full bg-primary-500 text-white hover:bg-primary-400"
                    aria-label={playerState.isPlaying ? 'Pause' : 'Play'}
                    onclick={toggle}>
                    <Icon src={playerState.isPlaying ? Pause : Play} class="h-6 w-6" solid />
                </button>
                <button
                    type="button"
                    class="flex h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-700 hover:text-white"
                    aria-label="Forward 30 seconds"
                    onclick={(e) => skip(e, SKIP_FORWARD_MS)}>
                    <Icon src={ArrowUturnRight} class="h-6 w-6" />
                </button>
                <!-- Volume. The bar already spends its whole width budget on a
                     narrow phone (cover + two clocks + four transport buttons
                     overflow 375px on their own), so the mute button only
                     appears from `sm` and the slider from `md`; below that the
                     full-screen sheet — one tap or one swipe up — owns volume,
                     as do the hardware keys. -->
                {#if playerState.supportsVolumeControl}
                    <!-- onclick already stops propagation (inside toggleMute), but
                         that only guards the pointer path: Enter/Space on a
                         focused button dispatches keydown FIRST, which bubbles to
                         the row before the button's own default click activation
                         runs -- the row's handler wins the race, preventDefault()s
                         and opens the full-screen sheet instead of muting. Same
                         guard as the range input below. -->
                    <button
                        type="button"
                        data-testid="audiobook-mini-mute"
                        class="hidden h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-700 hover:text-white sm:flex md:hidden"
                        aria-label={playerState.isMuted ? 'Unmute' : 'Mute'}
                        onclick={toggleMute}
                        onkeydown={(e) => e.stopPropagation()}>
                        <Icon
                            src={playerState.isMuted ? SpeakerXMark : SpeakerWave}
                            class="h-6 w-6" />
                    </button>
                    <div class="hidden items-center gap-1 md:flex" use:volumeWheel>
                        <button
                            type="button"
                            class="flex h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-700 hover:text-white"
                            aria-label={playerState.isMuted ? 'Unmute' : 'Mute'}
                            onclick={toggleMute}
                            onkeydown={(e) => e.stopPropagation()}>
                            <Icon
                                src={playerState.isMuted ? SpeakerXMark : SpeakerWave}
                                class="h-5 w-5" />
                        </button>
                        <!-- Space/Enter on the slider would otherwise bubble to
                             the row's own key handler and open the full-screen
                             player mid-adjustment. -->
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            data-testid="audiobook-mini-volume"
                            value={sliderPosition}
                            oninput={setVolumeFromSlider}
                            onclick={(e) => e.stopPropagation()}
                            onkeydown={(e) => e.stopPropagation()}
                            class="h-1 w-20 accent-primary-500"
                            aria-label="Volume" />
                    </div>
                {/if}
                <button
                    type="button"
                    data-testid="audiobook-mini-close"
                    class="flex h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-700 hover:text-white"
                    aria-label="Close audiobook player"
                    onclick={close}>
                    <Icon src={XMark} class="h-6 w-6" />
                </button>
            </div>
        </div>
    </div>
{/if}
