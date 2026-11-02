<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { musicGenreIcon } from '$lib/utils/music-genre-icon';
    import { Z } from '$lib/utils/z-index';
    import CrossfadeSeekbarFx from './CrossfadeSeekbarFx.svelte';
    import PlayheadBeatPulse from './PlayheadBeatPulse.svelte';
    import TrackArtistLine from './TrackArtistLine.svelte';
    import TrackTitleLine from './TrackTitleLine.svelte';
    import {
        musicPlayerStore,
        formattedCurrentTime,
        formattedDuration,
        currentChapter,
        nextChapter,
        currentRadioNowPlaying,
    } from '$lib/stores/music-player.store';
    import { findChapterAtMs } from '$lib/utils/music-chapters';
    import MusicChapterSheet from './MusicChapterSheet.svelte';
    import {
        Icon,
        Play,
        Pause,
        Backward,
        Forward,
        SpeakerWave,
        SpeakerXMark,
        Heart,
        HandThumbDown,
        ChevronDown,
        ChevronRight,
        QueueList,
        Signal,
        Sparkles,
        ListBullet,
    } from 'svelte-hero-icons';
    import {
        openAlbumModal,
        openArtistModal,
        openSimilarTracksModal,
    } from '$lib/utils/modal-utils';
    import { modals } from '$lib/stores/modal.store';
    import LyricsPanel from './LyricsPanel.svelte';
    import QueueTrackItem from './QueueTrackItem.svelte';
    import QueueHistorySection from './QueueHistorySection.svelte';
    import QueueSelectionBanner from './QueueSelectionBanner.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { browser } from '$app/environment';
    import { toasts } from '$lib/stores/toast.store';
    import { beforeNavigate } from '$app/navigation';
    import { dragHandleZone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { fade } from 'svelte/transition';
    import { tick } from 'svelte';
    import { MusicTrackSchema, type MusicTrack, type QueueItem } from '$lib/schemas/music';
    import type { AutoplaySeed } from '$lib/schemas/autoplay-seed';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { moodToColor, energyToColor } from '$lib/utils/mood-palette';
    import SonicStatChips from './SonicStatChips.svelte';

    type FullScreenView = 'player' | 'lyrics' | 'queue';
    let activeView = $state<FullScreenView>('player');

    // Root element ref — used for focus-on-open (a11y: finding #2)
    let playerRoot = $state<HTMLDivElement | null>(null);

    // Cancel browser back navigation when the fullscreen player is open — close it instead
    beforeNavigate(({ type, cancel }) => {
        if (type === 'popstate' && $musicPlayerStore.isFullScreen) {
            cancel();
            musicPlayerStore.setFullScreen(false);
        }
    });

    // When the full-screen player OPENS (e.g. swiped up from the mini-player while an
    // artist/album modal is open), close any open modal. The player sits at
    // Z.MUSIC_FULLSCREEN (950), BELOW MODAL (1000) — so without this it would open
    // hidden behind the modal and look like "swipe does nothing". Only fires on the
    // closed→open transition, so modals opened later from inside the player are unaffected.
    let wasFullScreen = false;
    $effect(() => {
        const open = $musicPlayerStore.isFullScreen;
        if (open && !wasFullScreen) {
            modals.closeAll();
        }
        wasFullScreen = open;
    });

    // AirPlay support: browser API available + feature flag + at least one receiver reachable
    const browserSupportsAirPlay =
        typeof window !== 'undefined' && 'WebKitPlaybackTargetAvailabilityEvent' in window;

    let airplaySupported = $derived(
        browserSupportsAirPlay &&
            $page.data?.features?.deviceAuth === true &&
            $musicPlayerStore.isAirPlayAvailable,
    );
    let airplayLoading = $state(false);

    let isSeeking = $state(false);

    // Queue DnD state
    const flipDurationMs = 150;
    const DND_TYPE = 'fs-music-queue-item';
    let localQueue = $state<QueueItem[]>([]);
    let isDragging = $state(false);
    let isExternalDragOver = $state(false);

    const isAdmin = $derived.by(() => {
        const userGroups: string[] = ($page.data?.user?.userGroups as string[]) || [];
        const adminGroups: string[] = ($page.data?.adminGroups as string[]) || [];
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return userGroupsLower.some((group) =>
            adminGroups.map((g) => g.toLowerCase()).includes(group),
        );
    });
    const sonicEnabled = $derived($page.data?.features?.sonicEmbeddings === true);
    const alchemyEnabled = $derived($page.data?.features?.musicAlchemy === true);

    // Sync queue from store when not dragging
    $effect(() => {
        if (!isDragging) {
            localQueue = [...$musicPlayerStore.queue];
        }
    });

    // No reset effect needed — the {#if isFullScreen} block destroys and
    // recreates this component, so activeView starts as 'player' each time.

    // Move focus into the player root when the full-screen player opens so
    // keyboard/AT users can immediately interact with it (a11y: finding #2).
    $effect(() => {
        if ($musicPlayerStore.isFullScreen && playerRoot) {
            void tick().then(() => playerRoot?.focus());
        }
    });

    // Body + html scroll lock when full-screen player is visible.
    // Must lock <html> too: mobile (< 1024px) lets the document scroll so
    // iOS Safari's URL bar can shrink, which means <html> is the scrolling
    // element. Locking only <body> leaks touch gestures to document scroll
    // (finger drag on the sheet scrolls the page behind).
    $effect(() => {
        if (!browser) return;
        const isOpen = $musicPlayerStore.isFullScreen && $musicPlayerStore.currentTrack;
        if (isOpen) {
            document.body.style.overflow = 'hidden';
            document.documentElement.style.overflow = 'hidden';
        }
        return () => {
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
        };
    });

    // Touch swipe-down to close
    let touchStartY = $state(0);
    let touchStartX = $state(0);
    let touchDeltaY = $state(0);
    let isDraggingDown = $state(false);
    // Ref to the scrollable content in lyrics/queue views — swipe-close only
    // engages when the inner scroll is at top so regular scrolling still works.
    let scrollableEl = $state<HTMLElement | null>(null);
    const SWIPE_CLOSE_THRESHOLD = 80;
    const SWIPE_AXIS_LOCK = 10;

    // Horizontal swipe on album art for prev/next
    let artSwipeStartX = $state(0);
    let artSwipeDeltaX = $state(0);
    let artSwiping = $state(false);
    const ART_SWIPE_THRESHOLD = 60;

    function handleArtTouchStart(e: TouchEvent): void {
        artSwipeStartX = e.touches[0].clientX;
        artSwipeDeltaX = 0;
        artSwiping = false;
    }

    function handleArtTouchMove(e: TouchEvent): void {
        const delta = e.touches[0].clientX - artSwipeStartX;
        if (Math.abs(delta) > 10) {
            artSwiping = true;
            artSwipeDeltaX = delta;
            // Prevent vertical scroll while swiping horizontally
            e.preventDefault();
        }
    }

    function handleArtTouchEnd(): void {
        if (!artSwiping) return;
        if (artSwipeDeltaX < -ART_SWIPE_THRESHOLD) {
            musicPlayerStore.skip();
        } else if (artSwipeDeltaX > ART_SWIPE_THRESHOLD) {
            musicPlayerStore.previous();
        }
        artSwipeDeltaX = 0;
        artSwiping = false;
    }

    function handleTouchStart(e: TouchEvent): void {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
        touchDeltaY = 0;
        isDraggingDown = false;
    }

    function handleTouchMove(e: TouchEvent): void {
        // Inner album-art handler owns horizontal swipes — bail out.
        if (artSwiping) return;
        // In scrollable views, only engage when the inner scroll is at top
        // so normal content scrolling still works.
        if (activeView !== 'player' && (scrollableEl?.scrollTop ?? 0) > 0) return;
        const dy = e.touches[0].clientY - touchStartY;
        const dx = e.touches[0].clientX - touchStartX;
        if (!isDraggingDown) {
            if (Math.abs(dy) < SWIPE_AXIS_LOCK && Math.abs(dx) < SWIPE_AXIS_LOCK) return;
            // Require vertical-dominant downward motion.
            // Extra guard: if horizontal displacement already exceeds the art-swipe
            // threshold the gesture is likely a horizontal art-swipe that hasn't yet
            // set artSwiping=true (race on first touchmove) — reject it here so a
            // diagonal touch from the art doesn't accidentally trigger swipe-close
            // (finding #4).
            if (Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy)) return;
            if (Math.abs(dx) > Math.abs(dy) || dy <= 0) return;
            isDraggingDown = true;
        }
        if (dy > 0) {
            touchDeltaY = dy;
            if (e.cancelable) e.preventDefault();
        } else {
            touchDeltaY = 0;
        }
    }

    function handleTouchEnd(): void {
        if (isDraggingDown && touchDeltaY >= SWIPE_CLOSE_THRESHOLD) {
            musicPlayerStore.setFullScreen(false);
        }
        touchDeltaY = 0;
        isDraggingDown = false;
    }

    function seekFromPointer(e: PointerEvent): void {
        const bar = e.currentTarget as HTMLElement;
        const rect = bar.getBoundingClientRect();
        if (rect.width === 0) return;
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        musicPlayerStore.seekTo(ratio * $musicPlayerStore.durationMs);
    }

    function handleSeekStart(e: PointerEvent): void {
        isSeeking = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        seekFromPointer(e);
    }

    function handleSeekMove(e: PointerEvent): void {
        if (isSeeking) seekFromPointer(e);
        updateChapterHoverFromPointer(e);
    }

    function handleSeekEnd(): void {
        isSeeking = false;
        // Drag-and-release outside the seekbar: pointer capture suppresses
        // pointerleave, so clear the chapter tooltip explicitly.
        chapterHoverMs = null;
    }

    // ── Chapter state ─────────────────────────────────────────────────────
    let chapterSheetOpen = $state(false);
    let chapterHoverMs = $state<number | null>(null);
    let chapterHoverX = $state(0);
    let seekbarWidth = $state(0);
    let trackChapters = $derived($musicPlayerStore.currentTrack?.chapters ?? []);
    // Audible here or in another tab this one mirrors (see MiniPlayer).
    let audibleAnywhere = $derived(
        $musicPlayerStore.isPlaying || $musicPlayerStore.playingElsewhere,
    );
    let hoveredChapter = $derived.by(() => {
        if (chapterHoverMs === null || trackChapters.length === 0) return null;
        return findChapterAtMs(trackChapters, chapterHoverMs)?.chapter ?? null;
    });

    function updateChapterHoverFromPointer(e: PointerEvent): void {
        if (e.pointerType !== 'mouse') return;
        const bar = e.currentTarget as HTMLElement;
        const rect = bar.getBoundingClientRect();
        if (rect.width === 0) return;
        seekbarWidth = rect.width;
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        chapterHoverX = x;
        const duration = $musicPlayerStore.durationMs;
        if (duration > 0) chapterHoverMs = (x / rect.width) * duration;
    }

    function handleSeekbarPointerLeave(): void {
        chapterHoverMs = null;
    }

    function seekToChapterStart(startMs: number): void {
        musicPlayerStore.seekTo(startMs);
    }

    // U4: Full ARIA slider keyboard contract — mirrors MiniPlayer exactly.
    //   Arrow Up / Right → +5s (Shift: +30s)
    //   Arrow Down / Left → -5s (Shift: -30s)
    //   Home  → start
    //   End   → end
    function handleSeekKeydown(e: KeyboardEvent): void {
        const duration = $musicPlayerStore.durationMs;
        if (duration <= 0) return;
        const current = $musicPlayerStore.currentTimeMs;
        const step5s = 5_000;
        const step30s = 30_000;
        let target: number;
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowUp':
                target = current + (e.shiftKey ? step30s : step5s);
                break;
            case 'ArrowLeft':
            case 'ArrowDown':
                target = current - (e.shiftKey ? step30s : step5s);
                break;
            case 'Home':
                target = 0;
                break;
            case 'End':
                target = duration;
                break;
            default:
                return;
        }
        e.preventDefault();
        musicPlayerStore.seekTo(Math.max(0, Math.min(duration, target)));
    }

    function close(): void {
        musicPlayerStore.setFullScreen(false);
    }

    // Queue DnD handlers
    function handleQueueConsider(e: CustomEvent<{ items: QueueItem[] }>): void {
        isDragging = true;
        localQueue = e.detail.items.filter((i) => i.id !== SHADOW_PLACEHOLDER_ITEM_ID);
    }

    function handleQueueFinalize(e: CustomEvent<{ items: QueueItem[] }>): void {
        isDragging = false;
        // Drop the shadow placeholder AND a STALE copy of the now-playing
        // track (a crossfade start consumes queue[0] while the drag has
        // localQueue frozen — re-committing the snapshot would reinsert the
        // currently playing track and make it play twice). "Stale" means the
        // store's live queue no longer contains it; a deliberately re-queued
        // copy of the current track is still in the store queue and is kept.
        const nowPlayingId = $musicPlayerStore.currentTrack?.id;
        const storeStillQueuesIt = $musicPlayerStore.queue.some((i) => i.id === nowPlayingId);
        const cleaned = e.detail.items.filter(
            (i) =>
                i.id !== SHADOW_PLACEHOLDER_ITEM_ID &&
                (i.id !== nowPlayingId || storeStillQueuesIt),
        );
        localQueue = cleaned;
        musicPlayerStore.reorderQueue(cleaned);
    }

    function readDraggedTracks(e: DragEvent): MusicTrack[] {
        const raw = e.dataTransfer?.getData('application/lumastra-music-track');
        if (!raw) return [];
        try {
            const parsed: unknown = JSON.parse(raw);
            const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
            return items
                .map((item) => MusicTrackSchema.safeParse(item))
                .filter(
                    (result): result is { success: true; data: MusicTrack } =>
                        result.success && typeof result.data.id === 'string',
                )
                .map((result) => result.data);
        } catch {
            return [];
        }
    }

    function hasMusicTrackDrag(e: DragEvent): boolean {
        return Array.from(e.dataTransfer?.types ?? []).includes('application/lumastra-music-track');
    }

    function handleExternalDragOver(e: DragEvent): void {
        if (!hasMusicTrackDrag(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        isExternalDragOver = true;
    }

    function handleExternalDragLeave(e: DragEvent): void {
        const current = e.currentTarget as HTMLElement | null;
        const related = e.relatedTarget as Node | null;
        if (current && related && current.contains(related)) return;
        isExternalDragOver = false;
    }

    function handleExternalDrop(e: DragEvent): void {
        if (!hasMusicTrackDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        isExternalDragOver = false;
        for (const track of readDraggedTracks(e)) {
            musicPlayerStore.addToQueue(track);
        }
    }

    function getSeedEmoji(seed: AutoplaySeed): string {
        switch (seed.type) {
            case 'mood':
                return seed.emoji;
            case 'genre':
                return musicGenreIcon(seed.genre);
            case 'artist':
                return '📻';
            case 'album':
                return '📻';
        }
    }

    function getSeedLabel(seed: AutoplaySeed): string {
        switch (seed.type) {
            case 'mood':
                return seed.label;
            case 'genre':
                return `${seed.label} Radio`;
            case 'artist':
                return `${seed.artistName} Radio`;
            case 'album':
                return `${seed.albumName} Radio`;
        }
    }

    const isSwiping = $derived($musicPlayerStore.fullScreenSwipeProgress > 0);
    const isSwipeCompleting = $derived($musicPlayerStore.fullScreenSwipeCompleting);
    const readyToClose = $derived(isDraggingDown && touchDeltaY >= SWIPE_CLOSE_THRESHOLD);
    const isRadio = $derived($musicPlayerStore.currentTrack?.isRadio === true);

    // Progress and title/artist metadata already track the incoming track's
    // real clock/identity during a crossfade under the new crossfade model —
    // the store promotes the incoming track to currentTrack at fade start —
    // so no local blend or swap-threshold interpolation is needed here.
    const displayedProgress = $derived($musicPlayerStore.progress);
    const displayedTrack = $derived($musicPlayerStore.currentTrack);

    /** Outgoing-track art fallback for the album-art crossfade blend below:
     *  history[0] while a fade is active (falling back to currentTrack if
     *  history is empty), otherwise simply currentTrack. The overlay layer
     *  already shows currentTrack as the incoming art, so the base layer
     *  needs the outgoing track to avoid rendering the same image twice. */
    const crossfadeBaseTrack = $derived(
        $musicPlayerStore.isCrossfading
            ? ($musicPlayerStore.history[0] ?? $musicPlayerStore.currentTrack)
            : $musicPlayerStore.currentTrack,
    );

    // ── Acoustic / mood data for sonic strip ─────────────────────────────
    const audioFeatures = $derived(displayedTrack?.audioFeatures);
    const moodTags = $derived(audioFeatures?.moodTags ?? []);
    const energyCurve = $derived(audioFeatures?.energyCurve ?? []);

    /**
     * Normalize energyCurve values to [0, 1] for SVG rendering.
     * The curve values are already 0-1 per Essentia spec, but clamp just in case.
     */
    const normalizedEnergyCurve = $derived(energyCurve.map((v) => Math.max(0, Math.min(1, v))));

    /**
     * Build an SVG polyline points string for the energy ribbon.
     * The ribbon is rendered inside an SVG with viewBox "0 0 100 1".
     */
    const energyCurvePoints = $derived.by((): string => {
        const pts = normalizedEnergyCurve;
        if (pts.length < 2) return '';
        return pts.map((v, i) => `${(i / (pts.length - 1)) * 100},${1 - v}`).join(' ');
    });

    // ── Primary mood color for accent tinting ────────────────────────────
    /**
     * Derived color from the first mood tag (or energy if no tags).
     * Used as a subtle tint accent. Returns null if no acoustic data at all.
     */
    const primaryMoodColor = $derived.by((): string | null => {
        if (moodTags.length > 0) return moodToColor(moodTags[0]);
        if (audioFeatures?.energy !== undefined) return energyToColor(audioFeatures.energy);
        return null;
    });

    // Radio streams have no queue or lyrics view — force back to player.
    $effect(() => {
        if (isRadio && activeView !== 'player') {
            activeView = 'player';
        }
    });
    // Header title doubles as the swipe-down indicator — morphs through
    // "Keep swiping…" / "Release to close" so we don't need a second badge.
    const titleText = $derived.by(() => {
        if (isDraggingDown && readyToClose) return m.music_release_to_close();
        if (isDraggingDown) return m.music_keep_swiping();
        if (activeView === 'queue') return m.music_queue_view_label();
        if (activeView === 'lyrics') return m.music_lyrics_view_label();
        const seed = $musicPlayerStore.autoplaySeed;
        if (seed) {
            return seed.type === 'mood' ? `${seed.label} Radio` : 'Radio';
        }
        return m.music_now_playing_label();
    });
    // Mild rubber-band past the close threshold so the sheet keeps following
    // the finger but with resistance — signals "you're past the commit point".
    function swipeDownTranslate(dy: number): number {
        if (dy <= SWIPE_CLOSE_THRESHOLD) return dy;
        return SWIPE_CLOSE_THRESHOLD + (dy - SWIPE_CLOSE_THRESHOLD) * 0.6;
    }

    function trackPosterThumb(track: MusicTrack | null | undefined): string | undefined {
        return track?.images?.primary?.variants?.thumb;
    }

    function trackPosterCard(track: MusicTrack | null | undefined): string | undefined {
        return track?.images?.primary?.variants?.card ?? track?.images?.primary?.variants?.thumb;
    }
</script>

{#if ($musicPlayerStore.isFullScreen || isSwiping) && $musicPlayerStore.currentTrack}
    <div
        bind:this={playerRoot}
        class="fixed inset-x-0 top-0 flex flex-col bg-surface-900 player-viewport-height"
        style="z-index: {Z.MUSIC_FULLSCREEN}; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);"
        class:fullscreen-player={$musicPlayerStore.isFullScreen &&
            !isSwiping &&
            !$musicPlayerStore.fullScreenSuppressEntry}
        role="dialog"
        aria-modal="true"
        aria-label={m.music_fullscreen_player_aria()}
        tabindex="-1"
        ontouchstart={handleTouchStart}
        ontouchmove={handleTouchMove}
        ontouchend={handleTouchEnd}
        style:transform={isSwiping
            ? `translateY(${(1 - $musicPlayerStore.fullScreenSwipeProgress) * 100}%)`
            : isDraggingDown
              ? `translateY(${swipeDownTranslate(touchDeltaY)}px)`
              : undefined}
        style:transition={isSwipeCompleting
            ? 'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)'
            : isSwiping
              ? 'none'
              : isDraggingDown
                ? 'none'
                : 'transform 0.3s ease'}>
        <!-- Top bar: close + title (toggles moved to bottom action row for one-handed reach) -->
        <div class="flex items-center justify-between px-4 pb-2 pt-3">
            <button
                class="flex h-11 w-11 items-center justify-center transition-colors {readyToClose
                    ? 'text-primary-400'
                    : 'text-surface-300'}"
                onclick={close}
                aria-label={m.music_close_player_aria()}>
                <Icon src={ChevronDown} class="h-7 w-7" />
            </button>
            <!-- Title: crossfades between contextual label ("Now Playing" /
                 "Queue" / …) and the swipe-down hint ("Keep swiping…" /
                 "Release to close"). Avoids stacking a second badge on top. -->
            <div
                class="relative h-5 flex-1 overflow-hidden text-center text-sm font-medium transition-colors duration-150 {readyToClose
                    ? 'text-primary-300'
                    : isDraggingDown
                      ? 'text-surface-300'
                      : 'text-surface-400'}">
                {#key titleText}
                    <p
                        class="absolute inset-x-0 top-0"
                        class:title-pulse={readyToClose}
                        in:fade={{ duration: 140 }}
                        out:fade={{ duration: 100 }}>
                        {titleText}
                    </p>
                {/key}
            </div>
            <div class="h-11 w-11" aria-hidden="true"></div>
        </div>

        <!-- Content area: stacks vertically in portrait, splits horizontally
             in landscape (album art / view on left, controls on right). -->
        <div class="flex min-h-0 flex-1 flex-col landscape:flex-row">
            {#if activeView === 'player'}
                <!-- ═══ PLAYER VIEW ═══ -->
                <!-- Album art (swipe left/right for next/previous) -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="art-fit-box flex min-h-0 min-w-0 flex-1 items-center justify-center px-8 py-4 landscape:p-3"
                    ontouchstart={handleArtTouchStart}
                    ontouchmove={handleArtTouchMove}
                    ontouchend={handleArtTouchEnd}>
                    <div
                        class="art-fit aspect-square overflow-hidden rounded-2xl shadow-2xl"
                        class:album-art-playing={$musicPlayerStore.isPlaying}
                        style:transform={artSwiping
                            ? `translateX(${artSwipeDeltaX * 0.4}px)`
                            : undefined}
                        style:transition={artSwiping ? 'none' : 'transform 0.3s ease'}>
                        {#if $musicPlayerStore.isCrossfading && trackPosterCard($musicPlayerStore.currentTrack)}
                            <div class="relative h-full w-full">
                                {#if trackPosterCard(crossfadeBaseTrack)}
                                    <img
                                        src={trackPosterCard(crossfadeBaseTrack)}
                                        alt=""
                                        class="absolute inset-0 h-full w-full object-cover" />
                                {/if}
                                {#key $musicPlayerStore.currentTrack.id}
                                    <img
                                        src={trackPosterCard($musicPlayerStore.currentTrack)}
                                        alt=""
                                        class="absolute inset-0 h-full w-full object-cover"
                                        style:opacity={$musicPlayerStore.crossfadeProgress} />
                                {/key}
                            </div>
                        {:else if trackPosterCard(crossfadeBaseTrack)}
                            <img
                                src={trackPosterCard(crossfadeBaseTrack)}
                                alt=""
                                class="h-full w-full object-cover" />
                        {:else}
                            <div
                                class="flex h-full w-full items-center justify-center bg-surface-700">
                                <Icon src={SpeakerWave} class="h-24 w-24 text-surface-500" />
                            </div>
                        {/if}
                    </div>
                </div>
            {:else if activeView === 'lyrics'}
                <!-- ═══ LYRICS VIEW ═══ -->
                <div
                    bind:this={scrollableEl}
                    class="min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">
                    <!-- Small track info at top -->
                    <div class="mb-4 flex items-center gap-3">
                        {#if trackPosterThumb($musicPlayerStore.currentTrack)}
                            <img
                                src={trackPosterThumb($musicPlayerStore.currentTrack)}
                                alt=""
                                class="h-12 w-12 rounded-lg" />
                        {/if}
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-semibold text-white">
                                <TrackTitleLine
                                    title={$musicPlayerStore.currentTrack.title}
                                    artists={$musicPlayerStore.currentTrack.artists}
                                    remixerArtists={$musicPlayerStore.currentTrack.remixerArtists}
                                    onNavigate={close} />
                            </p>
                            <p class="truncate text-xs text-surface-400">
                                {$musicPlayerStore.currentTrack.artists
                                    .map((a) => a.title)
                                    .join(', ')}
                            </p>
                        </div>
                    </div>
                    <LyricsPanel />
                </div>
            {:else if activeView === 'queue'}
                <!-- ═══ QUEUE VIEW ═══ -->
                <div
                    bind:this={scrollableEl}
                    class="flex-1 overflow-y-auto overscroll-contain px-4 py-2">
                    <!-- Seed / context badge -->
                    {#if $musicPlayerStore.autoplaySeed}
                        <div
                            class="flex items-center justify-between border-b border-surface-700 px-2 py-3">
                            <div class="flex items-center gap-2">
                                <span class="text-lg"
                                    >{getSeedEmoji($musicPlayerStore.autoplaySeed)}</span>
                                <span class="font-semibold text-white"
                                    >{getSeedLabel($musicPlayerStore.autoplaySeed)}</span>
                            </div>
                            <button
                                class="text-xs text-surface-400 hover:text-red-400"
                                onclick={() => musicPlayerStore.clearAutoplaySeed()}>
                                Stop
                            </button>
                        </div>
                    {/if}

                    <QueueSelectionBanner />

                    <!-- Autoplay toggle -->
                    <div class="mb-3 mt-2 flex items-center justify-between">
                        <Tooltip
                            text={$musicPlayerStore.autoplayEnabled
                                ? 'Autoplay on — endless smart queue'
                                : 'Autoplay off — stops after current track'}
                            position="bottom">
                            <button
                                class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors {$musicPlayerStore.autoplayEnabled
                                    ? 'bg-primary-500/10 text-primary-400'
                                    : 'text-surface-500 hover:text-surface-300'}"
                                onclick={() => musicPlayerStore.toggleAutoplay()}>
                                <Icon src={Signal} class="h-3.5 w-3.5" />
                                {$musicPlayerStore.autoplayEnabled ? 'Autoplay' : 'Autoplay off'}
                            </button>
                        </Tooltip>
                    </div>

                    <QueueHistorySection />

                    <!-- Now Playing -->
                    {#if $musicPlayerStore.currentTrack}
                        <div class="mb-4">
                            <h3 class="mb-2 text-xs uppercase text-surface-400">Now Playing</h3>
                            <div class="flex items-center gap-3">
                                {#if trackPosterThumb($musicPlayerStore.currentTrack)}
                                    <button
                                        class="shrink-0 active:opacity-70"
                                        onclick={() => {
                                            activeView = 'player';
                                        }}
                                        aria-label={m.music_back_to_player_aria()}>
                                        <img
                                            src={trackPosterThumb($musicPlayerStore.currentTrack)}
                                            alt=""
                                            class="h-12 w-12 rounded" />
                                    </button>
                                {/if}
                                <div class="min-w-0 flex-1">
                                    <p class="truncate text-sm font-medium text-white">
                                        <TrackTitleLine
                                            title={$musicPlayerStore.currentTrack.title}
                                            artists={$musicPlayerStore.currentTrack.artists}
                                            remixerArtists={$musicPlayerStore.currentTrack
                                                .remixerArtists}
                                            onNavigate={close} />
                                    </p>
                                    <p class="truncate text-xs text-surface-400">
                                        <TrackArtistLine
                                            artist={$musicPlayerStore.currentTrack.artists
                                                .map((a) => a.title)
                                                .join(', ') ?? ''}
                                            artists={$musicPlayerStore.currentTrack.artists}
                                            artistId={$musicPlayerStore.currentTrack.artists[0]
                                                ?.id ?? undefined}
                                            onNavigate={close} />{#if $musicPlayerStore.currentTrack.album?.title}<span
                                                class="text-surface-500">
                                                &nbsp;·&nbsp;</span
                                            >{#if $musicPlayerStore.currentTrack.album?.id}<button
                                                    class="hover:text-primary-400 hover:underline"
                                                    onclick={() => {
                                                        openAlbumModal(
                                                            $musicPlayerStore.currentTrack?.album
                                                                ?.id ?? '',
                                                        );
                                                        close();
                                                    }}
                                                    >{$musicPlayerStore.currentTrack.album
                                                        ?.title}</button
                                                >{:else}{$musicPlayerStore.currentTrack.album
                                                    ?.title}{/if}{/if}
                                    </p>
                                </div>
                            </div>
                        </div>
                    {/if}

                    <!-- Up Next -->
                    {#if $musicPlayerStore.currentTrack}
                        <div class="mb-4">
                            <div class="mb-2 flex items-center justify-between">
                                <h3
                                    class="flex items-center gap-1.5 text-xs uppercase text-surface-400">
                                    Up Next
                                    {#if $musicPlayerStore.smartQueueFallback}
                                        <Tooltip
                                            text="No music embeddings available — using random fallback.{isAdmin
                                                ? ' Run Essentia analysis + embedding generation for smarter recommendations.'
                                                : ''}"
                                            position="bottom">
                                            <span class="inline-flex items-center">
                                                <svg
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    class="h-3.5 w-3.5 text-warning-400"
                                                    viewBox="0 0 20 20"
                                                    fill="currentColor">
                                                    <path
                                                        fill-rule="evenodd"
                                                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                                                        clip-rule="evenodd" />
                                                </svg>
                                            </span>
                                        </Tooltip>
                                    {/if}
                                </h3>
                                <div class="flex gap-1">
                                    <Tooltip text="Add AI-suggested track" position="bottom">
                                        <button
                                            class="rounded p-1 text-primary-400/70 transition-colors hover:bg-primary-500/10 hover:text-primary-400 disabled:pointer-events-none disabled:opacity-30"
                                            disabled={$musicPlayerStore.smartQueueLoading}
                                            onclick={() => musicPlayerStore.addSmartItem()}>
                                            <Icon src={Sparkles} class="h-4 w-4" />
                                        </button>
                                    </Tooltip>
                                    <Tooltip text="Get new suggestions" position="bottom">
                                        <button
                                            class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-800 hover:text-white"
                                            aria-label={m.music_get_suggestions_aria()}
                                            onclick={() => musicPlayerStore.refreshSmartQueue()}>
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-4 w-4"
                                                viewBox="0 0 20 20"
                                                fill="currentColor">
                                                <path
                                                    fill-rule="evenodd"
                                                    d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                                                    clip-rule="evenodd" />
                                            </svg>
                                        </button>
                                    </Tooltip>
                                    <Tooltip text="Clear queue" position="bottom">
                                        <button
                                            class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-800 hover:text-red-400"
                                            aria-label={m.music_clear_queue_aria()}
                                            onclick={() => musicPlayerStore.clearQueue()}>
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-4 w-4"
                                                viewBox="0 0 20 20"
                                                fill="currentColor">
                                                <path
                                                    fill-rule="evenodd"
                                                    d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                                                    clip-rule="evenodd" />
                                            </svg>
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>

                            {#if $musicPlayerStore.smartQueueLoading && localQueue.length === 0}
                                <div
                                    class="flex items-center gap-3 rounded-lg bg-surface-800/50 p-3">
                                    <div
                                        class="h-4 w-4 animate-spin rounded-full border-2 border-surface-600 border-t-primary-400">
                                    </div>
                                    <span class="text-xs text-surface-500"
                                        >Finding next track...</span>
                                </div>
                            {/if}

                            <div
                                use:dragHandleZone={{
                                    items: localQueue,
                                    flipDurationMs,
                                    type: DND_TYPE,
                                    dropTargetStyle: {
                                        outline:
                                            '2px dashed rgba(var(--color-primary-500-rgb) / 0.4)',
                                        borderRadius: '8px',
                                    },
                                }}
                                onconsider={handleQueueConsider}
                                onfinalize={handleQueueFinalize}
                                ondragover={handleExternalDragOver}
                                ondragleave={handleExternalDragLeave}
                                ondrop={handleExternalDrop}
                                role="list"
                                aria-label={m.music_queue_drag_zone_aria()}
                                class="min-h-[48px] rounded-lg {isExternalDragOver
                                    ? 'outline outline-2 outline-primary-400/60'
                                    : ''}">
                                {#if localQueue.length === 0 && !$musicPlayerStore.smartQueueLoading}
                                    <div
                                        class="flex items-center justify-center py-3 text-xs text-surface-600">
                                        Drag tracks here
                                    </div>
                                {/if}
                                {#each localQueue as item, idx (item.id)}
                                    <div
                                        animate:flip={{
                                            duration: flipDurationMs,
                                        }}
                                        aria-label={item.track.title}>
                                        <QueueTrackItem
                                            track={item.track}
                                            nextTrack={localQueue[idx + 1]?.track}
                                            source={item.source}
                                            showDragHandle={true}
                                            showDismiss={item.source === 'smart'}
                                            {sonicEnabled}
                                            {alchemyEnabled}
                                            onclick={() => musicPlayerStore.play(item.track)}
                                            ondismiss={() =>
                                                musicPlayerStore.dismissSmartItem(item.track.id)}
                                            onremove={() =>
                                                musicPlayerStore.removeFromQueue(item.id)} />
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- Right column (landscape) / bottom stack (portrait): track info +
             transport controls. In landscape the inner wrapper uses `m-auto`
             to vertically center when space allows, but falls back to
             top-anchored scrolling on very short viewports (e.g. iPhone SE
             landscape) where centering+overflow would otherwise clip the top. -->
            <div class="flex flex-col landscape:min-w-0 landscape:flex-1 landscape:overflow-y-auto">
                <div class="flex flex-col landscape:m-auto landscape:w-full">
                    {#if activeView === 'player'}
                        <!-- Track info (player view only) -->
                        <div class="px-6 pb-2 landscape:px-4">
                            {#key displayedTrack?.id}
                                <p
                                    class="truncate text-xl font-bold text-white"
                                    in:fade={{ duration: 200 }}>
                                    {displayedTrack?.title ?? $musicPlayerStore.currentTrack.title}
                                </p>
                            {/key}
                            {#if isRadio}
                                <!-- Radio: plain genre line + live now-playing metadata, no modal links -->
                                {#if $musicPlayerStore.currentTrack.artists
                                    .map((a) => a.title)
                                    .join(', ')}
                                    <p class="truncate text-sm text-surface-400">
                                        {$musicPlayerStore.currentTrack.artists
                                            .map((a) => a.title)
                                            .join(', ')}
                                    </p>
                                {/if}
                                {#if $currentRadioNowPlaying}
                                    {@const np = $currentRadioNowPlaying}
                                    {@const djShowSubtitle = [
                                        np.dj.name ? `🎤 ${np.dj.name}` : null,
                                        np.show.name,
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    {#if np.track.title}
                                        <p class="mt-1 truncate text-sm text-primary-400">
                                            ♪ {np.track.title}
                                            {#if np.track.artist}
                                                <span class="text-surface-500"> · </span>
                                                {#if np.track.artistId}
                                                    <button
                                                        type="button"
                                                        class="hover:text-primary-300 hover:underline"
                                                        onclick={() => {
                                                            openArtistModal(
                                                                np.track.artistId ?? '',
                                                            );
                                                            close();
                                                        }}>
                                                        {np.track.artist}
                                                    </button>
                                                {:else}
                                                    {np.track.artist}
                                                {/if}
                                            {/if}
                                        </p>
                                    {/if}
                                    {#if djShowSubtitle}
                                        <p class="truncate text-xs text-surface-400">
                                            {djShowSubtitle}
                                        </p>
                                    {/if}
                                {/if}
                            {:else}
                                <!-- Normal track: artist/album with modal links -->
                                {#key displayedTrack?.id}
                                    <div
                                        class="flex items-center gap-1 truncate text-sm text-surface-400"
                                        in:fade={{ duration: 200 }}>
                                        {#if displayedTrack?.artists[0]?.id}
                                            <button
                                                class="hover:text-primary-400 hover:underline"
                                                onclick={() => {
                                                    openArtistModal(
                                                        displayedTrack?.artists[0]?.id ?? '',
                                                    );
                                                    close();
                                                }}>
                                                {displayedTrack?.artists
                                                    .map((a) => a.title)
                                                    .join(', ')}
                                            </button>
                                        {:else}
                                            <span
                                                >{displayedTrack?.artists
                                                    .map((a) => a.title)
                                                    .join(', ')}</span>
                                        {/if}
                                        {#if displayedTrack?.album?.title}
                                            <span class="text-surface-600">·</span>
                                            {#if displayedTrack?.album?.id}
                                                <button
                                                    class="hover:text-primary-400 hover:underline"
                                                    onclick={() => {
                                                        openAlbumModal(
                                                            displayedTrack?.album?.id ?? '',
                                                        );
                                                        close();
                                                    }}>
                                                    {displayedTrack?.album?.title}
                                                </button>
                                            {:else}
                                                <span>{displayedTrack?.album?.title}</span>
                                            {/if}
                                        {/if}
                                    </div>
                                {/key}

                                <!-- ═══ Current chapter indicator ═══ -->
                                <!-- Button stays mounted whenever the track has chapters —
                             so mobile users can still open the picker before the
                             first chapter starts playing. -->
                                {#if trackChapters.length > 0}
                                    <button
                                        type="button"
                                        class="mt-2 flex w-full items-center gap-2 rounded-lg border border-surface-700/50 bg-surface-800/50 px-3 py-2 text-left transition-colors hover:border-primary-500/40 hover:bg-surface-800"
                                        onclick={() => (chapterSheetOpen = true)}
                                        aria-label={m.music_browse_chapters_aria()}>
                                        <Icon
                                            src={ListBullet}
                                            class="h-4 w-4 shrink-0 text-primary-400" />
                                        <div class="min-w-0 flex-1">
                                            {#if $currentChapter}
                                                <div
                                                    class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-primary-300">
                                                    <span
                                                        >Chapter {$currentChapter.index + 1} of
                                                        {$currentChapter.total}</span>
                                                </div>
                                                <p class="truncate text-sm font-medium text-white">
                                                    {$currentChapter.chapter.title}
                                                </p>
                                                {#if $currentChapter.chapter.artist}
                                                    <p class="truncate text-xs text-surface-400">
                                                        {$currentChapter.chapter.artist}
                                                    </p>
                                                {/if}
                                                {#if $nextChapter}
                                                    <p
                                                        class="mt-0.5 hidden truncate text-[11px] text-surface-500 md:block">
                                                        Up next: {$nextChapter.title}{#if $nextChapter.artist}
                                                            <span class="text-surface-600">
                                                                — {$nextChapter.artist}</span>
                                                        {/if}
                                                    </p>
                                                {/if}
                                            {:else}
                                                <div
                                                    class="text-[10px] font-semibold uppercase tracking-wide text-primary-300">
                                                    Chapters
                                                </div>
                                                <p class="text-sm text-surface-300">
                                                    {trackChapters.length}
                                                    {trackChapters.length === 1
                                                        ? 'section'
                                                        : 'sections'}
                                                </p>
                                            {/if}
                                        </div>
                                        <Icon
                                            src={ChevronRight}
                                            class="h-4 w-4 shrink-0 text-surface-500" />
                                    </button>
                                {/if}
                            {/if}

                            <!-- ═══ SONIC STRIP (player view only, non-radio) ═══ -->
                            <!-- BPM/key/energy/danceability chips via SonicStatChips; mood
                             tags rendered inline below (SonicStatChips does not handle them). -->
                            {#if !isRadio && (audioFeatures || moodTags.length > 0)}
                                <div
                                    class="mt-2 rounded-lg bg-surface-800/50 px-3 py-2"
                                    aria-label="Acoustic properties">
                                    <!-- Acoustic stat chips (BPM, key, energy, danceability) -->
                                    <SonicStatChips {audioFeatures} showLabels={false} />
                                    <!-- Mood chips — rendered after the stat chips -->
                                    {#if moodTags.length > 0}
                                        <div class="mt-1 flex flex-wrap gap-1">
                                            {#each moodTags.slice(0, 4) as tag (tag)}
                                                <span
                                                    class="rounded-full px-2 py-0.5 text-[10px] font-medium leading-none text-surface-900"
                                                    style="background-color: {moodToColor(tag)};">
                                                    {tag}
                                                </span>
                                            {/each}
                                        </div>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/if}

                    <!-- ═══ CONTROLS (always visible) ═══ -->
                    <!-- Action row: feedback/airplay on left, lyrics/queue on right (one-handed reach) -->
                    <div class="flex items-center justify-between px-4 pb-2">
                        <div class="flex items-center gap-1">
                            {#if !isRadio}
                                <!-- Like/dislike are hidden on radio: the "track" id is the
                         station UUID, not the song actually playing, so the
                         feedback would be recorded against the wrong entity. -->
                                <button
                                    class="flex h-11 w-11 items-center justify-center rounded-full transition-colors {$musicPlayerStore.currentTrackFeedback ===
                                    'liked'
                                        ? 'text-primary-400'
                                        : 'text-surface-500 hover:text-white'}"
                                    onclick={() => musicPlayerStore.likeCurrentTrack()}
                                    aria-label={m.music_like_track_aria()}>
                                    <Icon
                                        src={Heart}
                                        class="h-6 w-6"
                                        solid={$musicPlayerStore.currentTrackFeedback ===
                                            'liked'} />
                                </button>
                                <button
                                    class="flex h-11 w-11 items-center justify-center rounded-full transition-colors {$musicPlayerStore.currentTrackFeedback ===
                                    'disliked'
                                        ? 'text-red-400'
                                        : 'text-surface-500 hover:text-white'}"
                                    onclick={() => musicPlayerStore.dislikeCurrentTrack()}
                                    aria-label={m.music_dislike_track_aria()}>
                                    <Icon
                                        src={HandThumbDown}
                                        class="h-6 w-6"
                                        solid={$musicPlayerStore.currentTrackFeedback ===
                                            'disliked'} />
                                </button>
                                <button
                                    class="flex h-11 w-11 items-center justify-center rounded-full text-surface-500 transition-colors hover:text-primary-400"
                                    onclick={() => {
                                        if ($musicPlayerStore.currentTrack?.id) {
                                            openSimilarTracksModal(
                                                $musicPlayerStore.currentTrack.id,
                                                $page.data?.features?.sonicEmbeddings === true,
                                            );
                                            close();
                                        }
                                    }}
                                    aria-label={m.music_find_similar_tracks_aria()}>
                                    <Icon src={Sparkles} class="h-6 w-6" />
                                </button>
                            {/if}
                            {#if airplaySupported}
                                <button
                                    class="flex h-11 w-11 items-center justify-center rounded-full text-surface-500 transition-colors hover:text-white disabled:opacity-40"
                                    disabled={airplayLoading}
                                    onclick={async () => {
                                        airplayLoading = true;
                                        try {
                                            const ok = await musicPlayerStore.activateAirPlay();
                                            if (!ok) {
                                                toasts.error(m.toast_airplay_unavailable());
                                            }
                                        } finally {
                                            airplayLoading = false;
                                        }
                                    }}
                                    aria-label={m.player_airplay()}>
                                    {#if airplayLoading}
                                        <div
                                            class="h-5 w-5 animate-spin rounded-full border-2 border-surface-600 border-t-white">
                                        </div>
                                    {:else}
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            class="h-5 w-5">
                                            <path
                                                d="M6 22h12l-6-6-6 6zM21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                                        </svg>
                                    {/if}
                                </button>
                            {/if}
                        </div>
                        {#if !isRadio}
                            <div class="flex items-center gap-1">
                                <!-- Intentionally never disabled: if lyrics become unavailable
                         while this view is open, the user still needs to toggle
                         back to the player. The panel shows "No lyrics available"
                         when there's nothing to render. -->
                                <button
                                    class="flex h-11 w-11 items-center justify-center rounded-full transition-colors {activeView ===
                                    'lyrics'
                                        ? 'text-primary-400'
                                        : 'text-surface-500 hover:text-white'}"
                                    onclick={() => {
                                        activeView = activeView === 'lyrics' ? 'player' : 'lyrics';
                                    }}
                                    aria-label={$musicPlayerStore.lyricsStatus === 'unavailable'
                                        ? 'Lyrics (none available)'
                                        : 'Toggle lyrics'}
                                    aria-pressed={activeView === 'lyrics'}>
                                    <span
                                        class="font-serif text-[1.15rem] font-semibold italic leading-none tracking-tight"
                                        aria-hidden="true">Aa</span>
                                </button>
                                <button
                                    class="flex h-11 w-11 items-center justify-center rounded-full transition-colors {activeView ===
                                    'queue'
                                        ? 'text-primary-400'
                                        : 'text-surface-500 hover:text-white'}"
                                    onclick={() => {
                                        activeView = activeView === 'queue' ? 'player' : 'queue';
                                    }}
                                    aria-label={m.music_toggle_queue_aria()}
                                    aria-pressed={activeView === 'queue'}>
                                    <Icon src={QueueList} class="h-6 w-6" />
                                </button>
                            </div>
                        {/if}
                    </div>

                    <!-- Seekbar / Live indicator -->
                    <div class="px-6 pb-2">
                        {#if isRadio}
                            <!-- Live radio: replace seekbar with a LIVE pill -->
                            <div class="flex h-11 items-center justify-center">
                                <span
                                    class="inline-flex items-center gap-1.5 rounded-full bg-red-600/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-400">
                                    <span class="h-2 w-2 animate-pulse rounded-full bg-red-400">
                                    </span>
                                    Live
                                </span>
                            </div>
                        {:else}
                            <div
                                class="group relative h-11 touch-none"
                                onpointerdown={handleSeekStart}
                                onpointermove={handleSeekMove}
                                onpointerup={handleSeekEnd}
                                onpointercancel={handleSeekEnd}
                                onpointerleave={handleSeekbarPointerLeave}
                                onkeydown={handleSeekKeydown}
                                role="slider"
                                tabindex="0"
                                aria-label={m.music_seek_aria()}
                                aria-valuenow={Math.round($musicPlayerStore.currentTimeMs / 1000)}
                                aria-valuemin={0}
                                aria-valuemax={Math.round($musicPlayerStore.durationMs / 1000)}
                                aria-valuetext="{$formattedCurrentTime} of {$formattedDuration}">
                                <div
                                    class="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 overflow-visible rounded-full bg-surface-700 group-active:h-1.5">
                                    <div
                                        class="absolute inset-y-0 left-0 rounded-full bg-primary-500"
                                        style="width: {displayedProgress * 100}%">
                                    </div>
                                    <CrossfadeSeekbarFx rounded />
                                    <!-- Chapter tick marks (skip 0 — the start is implicit) -->
                                    {#if $musicPlayerStore.durationMs > 0}
                                        {#each trackChapters as chapter, i (i)}
                                            {#if i > 0 && chapter.startMs < $musicPlayerStore.durationMs}
                                                <div
                                                    class="pointer-events-none absolute top-0 bottom-0 w-[2px] -translate-x-1/2 rounded-[1px] bg-white/60"
                                                    style="left: {(chapter.startMs /
                                                        $musicPlayerStore.durationMs) *
                                                        100}%">
                                                </div>
                                            {/if}
                                        {/each}
                                    {/if}
                                    <PlayheadBeatPulse
                                        progress={displayedProgress}
                                        large
                                        seeking={isSeeking} />
                                </div>

                                <!-- Chapter hover preview (desktop — pointerType 'mouse' only) -->
                                {#if hoveredChapter && seekbarWidth > 0}
                                    <div
                                        class="pointer-events-none absolute bottom-full left-0 mb-2 max-w-[280px] rounded-md border border-surface-500/40 bg-surface-900/95 px-2.5 py-1.5 text-xs leading-tight text-white shadow-lg backdrop-blur"
                                        style="transform: translateX({Math.max(
                                            70,
                                            Math.min(seekbarWidth - 70, chapterHoverX),
                                        )}px) translateX(-50%);">
                                        <p class="truncate font-medium">
                                            {hoveredChapter.title}
                                        </p>
                                        {#if hoveredChapter.artist}
                                            <p class="truncate text-[11px] text-surface-400">
                                                {hoveredChapter.artist}
                                            </p>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                            <div class="flex justify-between text-xs text-surface-400">
                                <span>{$formattedCurrentTime}</span>
                                <span>{$formattedDuration}</span>
                            </div>
                        {/if}

                        <!-- ═══ ENERGY CURVE RIBBON ═══ -->
                        <!-- A thin SVG ribbon visualizing the energyCurve over the full track.
                             A vertical cursor line follows playback position.
                             Renders only when at least 2 curve points exist and track has duration. -->
                        {#if !isRadio && energyCurvePoints && $musicPlayerStore.durationMs > 0}
                            <div
                                class="relative mt-1 h-6 w-full overflow-hidden rounded-sm"
                                aria-hidden="true"
                                title="Energy curve">
                                <svg
                                    class="h-full w-full"
                                    viewBox="0 0 100 1"
                                    preserveAspectRatio="none"
                                    xmlns="http://www.w3.org/2000/svg">
                                    <!-- Filled area under the curve -->
                                    <defs>
                                        <linearGradient
                                            id="fsp-energy-grad"
                                            x1="0"
                                            x2="1"
                                            y1="0"
                                            y2="0">
                                            <stop
                                                offset="0%"
                                                stop-color="#60a5fa"
                                                stop-opacity="0.5" />
                                            <stop
                                                offset="50%"
                                                stop-color="#fbbf24"
                                                stop-opacity="0.5" />
                                            <stop
                                                offset="100%"
                                                stop-color="#ef4444"
                                                stop-opacity="0.5" />
                                        </linearGradient>
                                    </defs>
                                    <!-- Fill polygon from polyline + bottom edge -->
                                    {#if normalizedEnergyCurve.length >= 2}
                                        <polygon
                                            points="0,1 {energyCurvePoints} 100,1"
                                            fill="url(#fsp-energy-grad)" />
                                        <polyline
                                            points={energyCurvePoints}
                                            fill="none"
                                            stroke="url(#fsp-energy-grad)"
                                            stroke-width="0.04"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            opacity="0.9" />
                                    {/if}
                                </svg>
                                <!-- Playback cursor line -->
                                <div
                                    class="absolute top-0 bottom-0 w-0.5 rounded-sm bg-white/70"
                                    style="left: {displayedProgress *
                                        100}%; transform: translateX(-50%);">
                                </div>
                            </div>
                        {/if}
                    </div>

                    <!-- Main controls -->
                    <div class="flex items-center justify-center gap-6 px-6 pb-4">
                        {#if !isRadio}
                            <button
                                class="flex h-11 w-11 items-center justify-center text-surface-300 transition-colors hover:text-white disabled:opacity-30"
                                onclick={() => musicPlayerStore.previous()}
                                aria-label={m.music_previous_track_aria()}>
                                <Icon src={Backward} class="h-8 w-8" />
                            </button>
                        {/if}

                        <button
                            class="flex h-16 w-16 items-center justify-center rounded-full bg-white text-surface-900 shadow-lg transition-transform active:scale-95"
                            onclick={() =>
                                audibleAnywhere
                                    ? musicPlayerStore.pause()
                                    : musicPlayerStore.resume()}
                            aria-label={audibleAnywhere ? m.player_pause() : m.player_play()}>
                            <Icon src={audibleAnywhere ? Pause : Play} class="h-9 w-9" />
                        </button>

                        {#if !isRadio}
                            <button
                                class="flex h-11 w-11 items-center justify-center text-surface-300 transition-colors hover:text-white"
                                onclick={() => musicPlayerStore.skip()}
                                aria-label={m.music_skip_track_aria()}>
                                <Icon src={Forward} class="h-8 w-8" />
                            </button>
                        {/if}
                    </div>

                    <!-- Volume row: hidden on iOS/devices where browser can't control volume.
             Also hidden in landscape to conserve vertical space — volume remains
             reachable via hardware buttons / OS sliders. -->
                    {#if $musicPlayerStore.supportsVolumeControl}
                        <div class="flex items-center gap-3 px-6 pb-4 landscape:hidden">
                            <button
                                class="flex h-11 w-11 items-center justify-center text-surface-400"
                                onclick={() => musicPlayerStore.toggleMute()}
                                aria-label={$musicPlayerStore.isMuted ? 'Unmute' : 'Mute'}>
                                <Icon
                                    src={$musicPlayerStore.isMuted ? SpeakerXMark : SpeakerWave}
                                    class="h-5 w-5" />
                            </button>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={$musicPlayerStore.volume}
                                oninput={(e) =>
                                    musicPlayerStore.setVolume(
                                        Number((e.target as HTMLInputElement).value),
                                    )}
                                class="h-1 flex-1 accent-primary-500"
                                aria-label={m.music_volume_aria()} />
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    </div>

    <!-- The three values the sheet used to read off `musicPlayerStore` itself.
         Passed explicitly since the audiobook player reuses the sheet with a
         different clock (book time, not the backend's file time). -->
    <MusicChapterSheet
        open={chapterSheetOpen}
        onclose={() => (chapterSheetOpen = false)}
        chapters={$musicPlayerStore.currentTrack?.chapters ?? []}
        positionMs={$musicPlayerStore.currentTimeMs}
        durationMs={$musicPlayerStore.durationMs}
        onseek={(ms) => musicPlayerStore.seekTo(ms)} />
{/if}

<style>
    /* Use dvh for dynamic viewport height on mobile (accounts for browser UI
       — the URL bar overlaying fixed-position content when visible). */
    .player-viewport-height {
        height: 100vh;
        height: 100dvh;
    }

    /* The art takes whatever height the track info and controls leave over,
       so extra rows (tags, energy curve) shrink the art instead of pushing the
       transport buttons off the bottom of a short phone viewport. */
    .art-fit-box {
        container-type: size;
    }

    .art-fit {
        width: min(100cqw, 100cqh, 20rem);
    }

    @media (orientation: landscape) {
        .art-fit {
            width: min(100cqw, 100cqh);
        }
    }

    .fullscreen-player {
        animation: slide-up-player 0.35s cubic-bezier(0.32, 0.72, 0, 1);
    }

    @keyframes slide-up-player {
        from {
            transform: translateY(100%);
        }
        to {
            transform: translateY(0);
        }
    }

    .album-art-playing {
        box-shadow:
            0 0 40px rgba(0, 0, 0, 0.6),
            0 20px 60px rgba(0, 0, 0, 0.4);
        transform: scale(1.02);
        transition: transform 0.3s ease;
    }

    /* Ready-to-close attention: gentle scale + glow pulse on the title
       while the sheet is past the commit threshold. */
    .title-pulse {
        animation: title-pulse 0.9s ease-in-out infinite;
        transform-origin: center;
    }

    @keyframes title-pulse {
        0%,
        100% {
            transform: scale(1);
            text-shadow: 0 0 0 rgba(var(--color-primary-500-rgb) / 0);
        }
        50% {
            transform: scale(1.06);
            text-shadow: 0 0 8px rgba(var(--color-primary-500-rgb) / 0.35);
        }
    }

    /* Suppress decorative animations for users who prefer reduced motion
       (finding #5). The slide-up entry and title-pulse are purely cosmetic —
       remove them entirely rather than just shortening them so there is zero
       motion for those who need it. The incoming album-art opacity is now
       driven by crossfadeProgress (a JS value), so no CSS override needed. */
    @media (prefers-reduced-motion: reduce) {
        .fullscreen-player {
            animation: none;
        }

        .album-art-playing {
            transition: none;
            transform: none;
        }

        .title-pulse {
            animation: none;
        }
    }
</style>
