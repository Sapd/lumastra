<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { musicGenreIcon } from '$lib/utils/music-genre-icon';
    import { onDestroy } from 'svelte';
    import { prefersReducedMotion } from 'svelte/motion';
    import { slide } from 'svelte/transition';
    import { cubicOut } from 'svelte/easing';
    import * as m from '$lib/paraglide/messages';
    import {
        musicPlayerStore,
        isMinPlayerVisible,
        currentRadioNowPlaying,
        crossfadeEffective,
    } from '$lib/stores/music-player.store';
    import { findChapterAtMs } from '$lib/utils/music-chapters';
    import { setDocumentTitleOverride, stopDocumentTitleOverride } from '$lib/utils/document-title';
    import { formatNowPlayingTitle } from '$lib/utils/now-playing-title';
    import { topModalKind } from '$lib/stores/modal.store';
    import { page } from '$app/stores';
    import { toasts } from '$lib/stores/toast.store';
    import type { AutoplaySeed } from '$lib/schemas/autoplay-seed';
    import type { MusicTrack } from '$lib/schemas/music';
    import { Z } from '$lib/utils/z-index';
    import CrossfadeSeekbarFx from './CrossfadeSeekbarFx.svelte';
    import PlayheadBeatPulse from './PlayheadBeatPulse.svelte';
    import TrackArtistLine from './TrackArtistLine.svelte';
    import TrackTitleLine from './TrackTitleLine.svelte';
    import MusicEntityHoverCard from './MusicEntityHoverCard.svelte';
    import {
        BPM_NATIVE_RATE_MAX_GAP,
        BPM_WSOLA_MAX_GAP,
        bpmGap,
        determineCrossfadeStyle,
    } from '$lib/utils/beat-math';
    import { computeCrossfadePlan, predictCrossfadeStartMs } from '$lib/utils/crossfade-plan';
    import { moodToColor, energyToColor } from '$lib/utils/mood-palette';
    import {
        Icon,
        Play,
        Pause,
        Backward,
        Forward,
        SpeakerWave,
        SpeakerXMark,
        ComputerDesktop,
        ChevronUp,
        ChevronDown,
        XMark,
        Heart,
        HandThumbDown,
        Sparkles,
        ArrowRight,
        DocumentText,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import QueuePanel from './QueuePanel.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { buildMusicTrackMenu } from '$lib/components/music/music-track-menu';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import { clickOutside } from '$lib/utils/click-outside';
    import {
        openAlbumForTrack,
        openAlbumModal,
        openSimilarTracksModal,
    } from '$lib/utils/modal-utils';
    import { createHoldToAct } from '$lib/utils/hold-to-act';

    // Track whether we are on a desktop-width viewport (≥768px) to suppress
    // the album-art button from the a11y tree where it is a no-op.
    let isDesktop = $state(false);
    $effect(() => {
        const mq = window.matchMedia('(min-width: 768px)');
        isDesktop = mq.matches;
        const onChange = (ev: MediaQueryListEvent): void => {
            isDesktop = ev.matches;
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
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

    const isAdmin = $derived.by(() => {
        const userGroups: string[] = ($page.data?.user?.userGroups as string[]) || [];
        const adminGroups: string[] = ($page.data?.adminGroups as string[]) || [];
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return userGroupsLower.some((group) =>
            adminGroups.map((g) => g.toLowerCase()).includes(group),
        );
    });

    function goToMusicPath(path: string): void {
        void import('$app/navigation').then(({ goto }) => goto(resolve(path)));
    }

    // ── Track context menus ──────────────────────────────────────────────
    // Anchored either to the album art (current track) or to the up-next /
    // crossfade strip (the incoming track), so both tiles offer the same
    // actions on right-click.
    let posterMenuPos = $state<{ x: number; y: number } | null>(null);
    let upNextMenuPos = $state<{ x: number; y: number } | null>(null);

    function buildTrackMenu(track: MusicTrack | null): ContextMenuEntry[] {
        return buildMusicTrackMenu(track, {
            sonicEnabled: $page.data?.features?.sonicEmbeddings === true,
            alchemyEnabled: $page.data?.features?.musicAlchemy === true,
            isAdmin,
            navigate: goToMusicPath,
        });
    }

    let posterMenuItems: ContextMenuEntry[] = $derived(
        buildTrackMenu($musicPlayerStore.currentTrack),
    );
    function handlePosterContextMenu(e: MouseEvent): void {
        if (posterMenuItems.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        posterMenuPos = { x: e.clientX, y: e.clientY };
    }

    function handleUpNextContextMenu(e: MouseEvent): void {
        if (upNextMenuItems.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        upNextMenuPos = { x: e.clientX, y: e.clientY };
    }

    // Stop playback and hide on /watch pages — video player takes over
    let isWatchPage = $derived($page.url.pathname.startsWith('/watch'));
    let visible = $derived($isMinPlayerVisible && !isWatchPage);

    // Lift above music-type modals (album/artist/similar-tracks) on desktop only.
    // CSS media query enforces the desktop scope; class toggles the intent.
    let overMusicModal = $derived($topModalKind === 'music');

    // Auto-stop music when entering a watch page
    $effect(() => {
        if (isWatchPage && $musicPlayerStore.isPlaying) {
            musicPlayerStore.stop();
        }
    });

    // Mirror the now-playing line into the browser tab title, so a backgrounded
    // tab still says what it is playing. Scoped to `visible` so /watch is left
    // entirely to the video player's own title handling — it snapshots
    // document.title on init and restores it on teardown, and would otherwise
    // capture ours during the overlap before the auto-stop above lands.
    $effect(() => {
        setDocumentTitleOverride(
            visible
                ? formatNowPlayingTitle({
                      track: $musicPlayerStore.currentTrack,
                      isPlaying: $musicPlayerStore.isPlaying,
                      radioNowPlaying: $currentRadioNowPlaying,
                  })
                : null,
        );
    });

    onDestroy(() => {
        stopDocumentTitleOverride();
        skipHold.destroy();
        // Store teardown moved here (was a self-guarded $effect that also ran
        // init()/hydrateFromPersistence() on first mount — Task 8 moved that
        // bootstrap to +layout.svelte's onMount, since it runs unconditionally
        // and determines `isMinPlayerVisible`, which now gates whether THIS
        // component ever loads at all). Unmount timing is unchanged: this
        // component stays mounted for the app's lifetime once first loaded.
        musicPlayerStore.destroy();
    });

    // ── Crossfade zone calculations ──────────────────────────────────────
    const PREVIEW_LEAD_MS = 45_000;

    /** Whether there's a next track available for crossfading */
    let hasNextTrack = $derived($musicPlayerStore.queue.length > 0);
    // Music audible somewhere: here, or in another tab this one mirrors. The
    // play/pause control reflects what the listener hears — its Pause then
    // pauses the other tab (the store routes it), its Play moves playback here.
    let audibleAnywhere = $derived(
        $musicPlayerStore.isPlaying || $musicPlayerStore.playingElsewhere,
    );

    /** The next track to play (first item in the unified queue) — pre-fade
     *  prediction only. Once a fade starts the store has already promoted
     *  the incoming track to currentTrack, so queue[0] may be empty or
     *  unrelated; per-usage code below swaps to currentTrack in that case. */
    let upNextTrack = $derived($musicPlayerStore.queue[0]?.track ?? null);

    /** Track shown in the "Up Next" highlighted strip card. Pre-fade this is
     *  the queue head (upNextTrack). Once a fade is underway, show
     *  currentTrack (the incoming track, already promoted at fade start)
     *  instead — queue[0] may be empty or unrelated to the active fade. */
    let upNextStripTrack = $derived(
        $musicPlayerStore.isCrossfading ? $musicPlayerStore.currentTrack : upNextTrack,
    );

    let upNextMenuItems: ContextMenuEntry[] = $derived(buildTrackMenu(upNextStripTrack));

    /** Base-layer track for the mini-player art/metadata crossfade: the
     *  outgoing track (history[0], falling back to currentTrack if history
     *  is empty) while a fade is active, otherwise simply currentTrack. The
     *  overlay layers already show currentTrack as the incoming track, so
     *  the base layer needs the outgoing one to avoid duplicating it. */
    let crossfadeBaseTrack = $derived(
        $musicPlayerStore.isCrossfading
            ? ($musicPlayerStore.history[0] ?? $musicPlayerStore.currentTrack)
            : $musicPlayerStore.currentTrack,
    );

    /** Ms position where the crossfade will trigger.
     *  Prefers the store's actually-armed pending point (already snapped to the
     *  next downbeat and clamped past the last vocal) so the UI countdown lands
     *  on the SAME instant the audio fade fires. Falls back to a predictive
     *  estimate (shared with the store via predictCrossfadeStartMs — see
     *  crossfade-plan.ts) before the store has armed a trigger. */
    let crossfadeStartMs = $derived.by(() => {
        const state = $musicPlayerStore;
        if (!$crossfadeEffective) return null;

        // Authoritative: once checkCrossfadeTrigger has armed a pending point
        // for the current queue head, mirror it verbatim — it accounts for the
        // downbeat snap and last-vocal-end clamp our estimate below cannot see.
        // Without this the UI countdown expires before the real fade starts and
        // the "Up Next" indicator flickers off then back on.
        if (
            state.pendingCrossfadeAtMs !== null &&
            state.pendingCrossfadeForTrackId === state.queue[0]?.id
        ) {
            return state.pendingCrossfadeAtMs;
        }

        const chMood =
            state.autoplaySeed?.type === 'mood'
                ? state.autoplaySeed.mood?.toLowerCase()
                : undefined;
        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: state.currentTrack?.audioFeatures,
            incomingAudioFeatures: state.queue[0]?.track?.audioFeatures,
            durationMs: state.durationMs,
            incomingDurationSec: (state.queue[0]?.track?.durationMs ?? 0) / 1000,
            crossfadeBeatsOverride: state.crossfadeBeatsOverride,
            mood: chMood,
            currentMs: state.currentTimeMs,
        });
        return plan?.startMs ?? null;
    });

    /** Crossfade zone start as 0-1 ratio for positioning on seekbar (only when next track exists) */
    let crossfadeZoneProgress = $derived(
        crossfadeStartMs !== null && $musicPlayerStore.durationMs > 0 && hasNextTrack
            ? crossfadeStartMs / $musicPlayerStore.durationMs
            : null,
    );

    /** Show the "Up Next" preview strip when approaching the crossfade zone.
     *  We deliberately do NOT hide the strip once `timeUntil` passes 0: the real
     *  fade fires a beat or two after our predicted point (downbeat snap / vocal
     *  clamp), and hiding it in that gap made the indicator flicker off then back
     *  on. It stays up until the fade actually starts (isCrossfading, handled
     *  above) or the preview conditions drop out — no next track, or crossfade
     *  disabled / queue head swapped so crossfadeStartMs recomputes (→ null or a
     *  fresh future time). Because the store guarantees the fade fires before the
     *  track ends, the post-estimate tail is bounded by the remaining track. */
    /** Up Next strip in/out: a height slide (plus fade) instead of mounting in
     *  one frame — the seekbar rides on top of the mini-player, so a strip
     *  that appears/disappears instantly made the bar teleport by its
     *  height, most visibly when a crossfade ends. */
    function upNextStripTransition(node: Element): ReturnType<typeof slide> {
        const base = slide(node, {
            duration: prefersReducedMotion.current ? 0 : 380,
            easing: cubicOut,
        });
        return {
            ...base,
            // slide()'s css ends without a ';' ("min-height: 0"): appended
            // straight on, both declarations were invalid and dropped.
            css: (t, u) => `${base.css?.(t, u) ?? ''}; opacity: ${t};`,
        };
    }

    let showUpNextPreview = $derived.by(() => {
        const state = $musicPlayerStore;
        if (state.isCrossfading) return true;
        if (!upNextTrack) return false;
        if (crossfadeStartMs === null) return false;
        const timeUntil = crossfadeStartMs - state.currentTimeMs;
        return timeUntil < PREVIEW_LEAD_MS;
    });

    /** Seconds until crossfade triggers (null if unknown, 0 if active) */
    let crossfadeCountdownSec = $derived.by(() => {
        if ($musicPlayerStore.isCrossfading) return 0;
        if (crossfadeStartMs === null) return null;
        const remaining = crossfadeStartMs - $musicPlayerStore.currentTimeMs;
        if (remaining <= 0) return 0;
        return Math.ceil(remaining / 1000);
    });

    /**
     * Opacity values for title/artist cross-fade (U3).
     * Outgoing text (currentTrack when idle, the fading-out track — history[0]
     * — during a crossfade) fades from 1→0 over the second half of the
     * crossfade (t 0.5→1). Incoming text (currentTrack — already promoted at
     * fade start under the new crossfade model) fades from 0→1 over the same
     * window. Before t=0.5 the incoming layer is invisible; after t=1 the
     * outgoing layer is gone.
     */
    let metadataOutgoingOpacity = $derived.by(() => {
        const state = $musicPlayerStore;
        if (!state.isCrossfading) return 1;
        const t = state.crossfadeProgress;
        return Math.max(0, 1 - (t - 0.5) * 2);
    });
    let metadataIncomingOpacity = $derived.by(() => {
        const state = $musicPlayerStore;
        if (!state.isCrossfading) return 0;
        const t = state.crossfadeProgress;
        return Math.max(0, (t - 0.5) * 2);
    });

    /** Interpolated BPM during crossfade (blends from outgoing to incoming based on progress) */
    let liveCrossfadeBpm = $derived.by(() => {
        const state = $musicPlayerStore;
        if (!state.isCrossfading) return null;
        const outBpm = state.history[0]?.audioFeatures?.bpm;
        const inBpm = state.currentTrack?.audioFeatures?.bpm;
        if (!outBpm || !inBpm) return state.effectiveBpm;
        const blended = outBpm + (inBpm - outBpm) * state.crossfadeProgress;
        return Math.round(blended);
    });

    /** Crossfade technique + BPM info derived from current & next track.
     *  Pre-fade this previews the upcoming transition (out=currentTrack,
     *  in=queue head). During an active fade the store has already promoted
     *  the incoming track, so out/in map to (history[0], currentTrack) instead. */
    let crossfadeInfo = $derived.by(() => {
        const state = $musicPlayerStore;
        if (!$crossfadeEffective) return null;
        const outTrack = state.isCrossfading ? state.history[0] : state.currentTrack;
        const inTrack = state.isCrossfading ? state.currentTrack : state.queue[0]?.track;
        const outBpm = outTrack?.audioFeatures?.bpm;
        const inBpm = inTrack?.audioFeatures?.bpm;

        // Smart fade detection
        const channelMood =
            state.autoplaySeed?.type === 'mood'
                ? state.autoplaySeed.mood?.toLowerCase()
                : undefined;
        const style = determineCrossfadeStyle(
            outTrack?.audioFeatures,
            inTrack?.audioFeatures,
            channelMood,
        );

        // Beats, length and mode from the same plan the trigger runs (scaled
        // for track length, bass-swap clamp, vocal fit) — the raw style beat
        // count read ~2× too long on radio edits. Mid-fade the outgoing
        // position is not the store's clock, so no remaining-time clamp.
        const outDurationMs = state.isCrossfading
            ? (outTrack?.durationMs ?? 0)
            : state.durationMs || (outTrack?.durationMs ?? 0);
        const plan = computeCrossfadePlan({
            outgoingAudioFeatures: outTrack?.audioFeatures,
            incomingAudioFeatures: inTrack?.audioFeatures,
            durationMs: outDurationMs,
            incomingDurationSec: (inTrack?.durationMs ?? 0) / 1000,
            crossfadeBeatsOverride: state.crossfadeBeatsOverride,
            mood: channelMood,
            currentMs: state.isCrossfading ? 0 : state.currentTimeMs,
        });
        const beats = plan.beats;
        const fadeMode = plan.mode;
        const durationSec = (plan.fadeDurationMs / 1000).toFixed(1);

        // Mirrors the store's syncTechnique: unsynced styles (organic pairs,
        // the BPM-gap echo) never rate-match — triggerCrossfade omits the
        // incoming BPM for them, manual beat override or not.
        let technique: 'rate-match' | 'time-stretch' | 'no-sync' = 'no-sync';
        const gap = outBpm && inBpm ? bpmGap(outBpm, inBpm) : null;
        if (gap !== null && style.plainTransition !== true) {
            if (gap <= BPM_NATIVE_RATE_MAX_GAP) technique = 'rate-match';
            else if (gap <= BPM_WSOLA_MAX_GAP) technique = 'time-stretch';
        }

        return {
            outBpm: outBpm ? Math.round(outBpm) : null,
            inBpm: inBpm ? Math.round(inBpm) : null,
            beats,
            durationSec,
            technique,
            fadeMode,
        };
    });

    // ── Hold-to-mix on the skip button ─────────────────────────────────────
    // Tap = instant skip (unchanged). Holding for SKIP_HOLD_MS arms a manual
    // beat-quantized crossfade via mixNow(); a progress ring fills during the
    // hold and the icon pulses while the armed mix waits for its downbeat.
    const SKIP_HOLD_MS = 600;
    let skipHoldActive = $state(false);
    const skipHold = createHoldToAct({
        thresholdMs: SKIP_HOLD_MS,
        onTap: () => void musicPlayerStore.skip(),
        onHoldStart: () => (skipHoldActive = true),
        onHoldCommit: () => musicPlayerStore.mixNow(),
        onHoldEnd: () => (skipHoldActive = false),
    });

    /** Manual mix armed and waiting for its downbeat. */
    let mixArmed = $derived(
        $musicPlayerStore.pendingCrossfadeIsManual &&
            $musicPlayerStore.pendingCrossfadeAtMs !== null,
    );

    // ── Mood tint accent ─────────────────────────────────────────────────
    /**
     * Subtle ambient glow color derived from the current track's first mood tag
     * or its energy level. Used as a box-shadow tint on the mini-player bar.
     * Returns null when no acoustic data is available (no tint applied).
     */
    const moodTintColor = $derived.by((): string | null => {
        const track = $musicPlayerStore.currentTrack;
        if (!track) return null;
        const af = track.audioFeatures;
        if (!af) return null;
        const tags = af.moodTags;
        if (tags && tags.length > 0) return moodToColor(tags[0]);
        if (af.energy !== undefined) return energyToColor(af.energy);
        return null;
    });

    // ── Lifecycle ────────────────────────────────────────────────────────

    // Expose player height as a CSS variable so modal overlays can stop at the player top.
    // bar ≈ 5rem (h-14 + py-3), seekbar 1.25rem above; up-next strip adds ~3.5rem when visible.
    $effect(() => {
        const shown = visible && !!$musicPlayerStore.currentTrack;
        if (shown) {
            const remHeight = showUpNextPreview ? 10 : 6.5;
            document.documentElement.style.setProperty('--miniplayer-height', `${remHeight}rem`);
        } else {
            document.documentElement.style.removeProperty('--miniplayer-height');
        }
    });

    // What a modal must keep clear: the bar's real top edge (measured bar +
    // 1px border + the seekbar hit area sitting above it) plus the player's
    // actual bottom offset, which differs when it drops to bottom:0 over a
    // music modal (see the inline style below). The up-next strip is left out
    // on purpose: it appears for a few seconds before a crossfade and slides
    // up OVER the modal rather than making the modal resize mid-scroll.
    // --miniplayer-height above still includes it for the tooltips anchored
    // above the strip.
    const SEEKBAR_HIT_PX = 20;
    let mainBarHeight = $state(0);
    $effect(() => {
        const shown = visible && !!$musicPlayerStore.currentTrack && mainBarHeight > 0;
        if (!shown) return;
        const seekbarPx = $musicPlayerStore.currentTrack?.isRadio ? 0 : SEEKBAR_HIT_PX;
        const bottomOffset = overMusicModal
            ? 'env(safe-area-inset-bottom)'
            : 'max(var(--music-bottom-nav-h, 0px), env(safe-area-inset-bottom))';
        document.documentElement.style.setProperty(
            '--miniplayer-modal-inset',
            `calc(${mainBarHeight + 1 + seekbarPx}px + ${bottomOffset})`,
        );
        return () => document.documentElement.style.removeProperty('--miniplayer-modal-inset');
    });

    // musicPlayerStore.init()/.hydrateFromPersistence() used to run from a
    // guarded $effect here. Moved to +layout.svelte's onMount (Task 8): this
    // component is now itself lazy-loaded, gated on `isMinPlayerVisible` —
    // which hydrateFromPersistence() is what SETS after a reload with a
    // persisted queue. Running it here would be too late (this component
    // would never load in the first place). Teardown lives in the onDestroy
    // above.

    // ── Handlers ─────────────────────────────────────────────────────────

    let isSeeking = $state(false);

    function seekFromPointer(e: PointerEvent): void {
        const bar = (e.currentTarget ?? e.target) as HTMLElement;
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
        updateHoverFromPointer(e);
    }

    function handleSeekEnd(_e: PointerEvent): void {
        isSeeking = false;
        // Pointer capture suppresses pointerleave — clear hover explicitly
        // so the chapter tooltip doesn't stick after a drag-and-release
        // that finishes outside the seekbar.
        chapterHoverMs = null;
    }

    // ── Seekbar keyboard handler ──────────────────────────────────────────
    // Implements ARIA slider keyboard contract:
    //   Arrow Up/Right  → +5s
    //   Arrow Down/Left → -5s
    //   Shift + Arrow   → ±30s
    //   Home            → start
    //   End             → end
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

    // ── Chapter hover preview (desktop) ──────────────────────────────────
    // Fine-pointer-only tooltip; on touch the cursor doesn't hover so the
    // preview never shows (the FullScreenPlayer chapter sheet covers mobile).
    let chapterHoverMs = $state<number | null>(null);
    let chapterHoverX = $state(0);
    let seekbarWidth = $state(0);
    let chapters = $derived($musicPlayerStore.currentTrack?.chapters ?? []);
    let hoveredChapter = $derived.by(() => {
        if (chapterHoverMs === null || chapters.length === 0) return null;
        return findChapterAtMs(chapters, chapterHoverMs)?.chapter ?? null;
    });

    function updateHoverFromPointer(e: PointerEvent): void {
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

    function handleSeekPointerLeave(): void {
        chapterHoverMs = null;
    }

    function getSeedEmoji(seed: AutoplaySeed): string {
        if (seed.type === 'mood') return seed.emoji;
        if (seed.type === 'genre') return musicGenreIcon(seed.genre);
        if (seed.type === 'artist') return '📻';
        return '🎵';
    }

    function getSeedLabel(seed: AutoplaySeed): string {
        switch (seed.type) {
            case 'mood':
                return `${seed.label} Radio`;
            case 'genre':
                return `${seed.label} Radio`;
            case 'artist':
                return `${seed.artistName} Radio`;
            case 'album':
                return `📻 ${seed.albumName} Radio`;
        }
    }

    function formatTime(ms: number): string {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${String(min)}:${String(sec).padStart(2, '0')}`;
    }

    function formatRemainingTime(currentMs: number, durationMsValue: number): string {
        return `-${formatTime(Math.max(0, durationMsValue - currentMs))}`;
    }

    const TIME_REMAINING_STORAGE_KEY = 'lumastra:time-remaining';
    let showTimeRemaining = $state(false);
    $effect(() => {
        try {
            showTimeRemaining = localStorage.getItem(TIME_REMAINING_STORAGE_KEY) === 'true';
        } catch {
            /* expected: localStorage may be unavailable (private browsing) */
        }
    });

    function toggleTimeRemaining(): void {
        showTimeRemaining = !showTimeRemaining;
        try {
            localStorage.setItem(TIME_REMAINING_STORAGE_KEY, String(showTimeRemaining));
        } catch {
            /* expected: localStorage may be unavailable (private browsing) */
        }
    }

    function trackPosterThumb(track: MusicTrack | null | undefined): string | undefined {
        return track?.images?.primary?.variants?.thumb;
    }

    // ── Swipe-up to open full-screen player (mobile) ──────────────────────
    // Progressive animation: as the finger moves up, the full-screen player
    // slides in from below following the gesture (like Apple Music / YT Music).
    const SWIPE_UP_COMMIT_THRESHOLD = 64; // px to commit to opening
    const SWIPE_UP_START_THRESHOLD = 8; // px before we claim the gesture
    const SWIPE_UP_AXIS_LOCK = 8;
    const SWIPE_UP_FLICK_VELOCITY = 0.45; // px/ms
    // Rolling-average velocity: keep the last N samples so a decelerating
    // flick that stalls on the final touchmove doesn't miss the threshold.
    const SWIPE_VELOCITY_WINDOW = 5;
    let swipeStartY = $state(0);
    let swipeStartX = $state(0);
    let swipeLastY = $state(0);
    let swipeLastTime = $state(0);
    let swipeDeltaY = $state(0);
    let swipeVelocity = $state(0);
    let swipeActive = $state(false);
    let swipeCaptured = $state(false);
    // Circular buffer for rolling velocity samples
    let swipeVelocitySamples: number[] = [];

    function swipeTravelPx(): number {
        return Math.min(window.innerHeight * 0.45, 360);
    }

    function resetSwipeProgress(): void {
        musicPlayerStore.setFullScreenSwipeProgress(0);
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
        swipeDeltaY = 0;
        swipeVelocity = 0;
        swipeActive = false;
        swipeCaptured = false;
        swipeVelocitySamples = [];
    }

    function handleBarTouchMove(e: TouchEvent): void {
        if (window.innerWidth >= 768 || e.touches.length !== 1) return;
        // A touch that began on the hold-gesture skip button must never be
        // captured as a swipe: capturing below calls preventDefault() on this
        // touchmove, which fires a pointercancel for the coincident touch
        // pointer and silently aborts an in-progress hold-to-mix press before
        // it reaches the 600ms threshold. Bail while the hold is active; the
        // recorded touchstart origin is left intact so a genuine swipe can
        // still be picked up if the hold later cancels via drag-away.
        if (skipHoldActive) return;

        const touch = e.touches[0];
        const deltaY = swipeStartY - touch.clientY;
        const deltaX = touch.clientX - swipeStartX;
        const now = performance.now();
        const dt = Math.max(1, now - swipeLastTime);
        // Rolling-average velocity over the last SWIPE_VELOCITY_WINDOW samples
        // so a decelerating flick that stalls on the final touchmove event still
        // carries the peak velocity from earlier in the gesture.
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
                resetSwipeProgress();
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
        const progress = Math.min(1, swipeDeltaY / swipeTravelPx());
        musicPlayerStore.setFullScreenSwipeProgress(progress);
    }

    function handleBarTouchEnd(e: TouchEvent): void {
        if (window.innerWidth >= 768 || !swipeActive || !swipeCaptured) {
            resetSwipeProgress();
            return;
        }
        if (e.cancelable) e.preventDefault();
        if (
            swipeDeltaY >= SWIPE_UP_COMMIT_THRESHOLD ||
            (swipeVelocity >= SWIPE_UP_FLICK_VELOCITY && swipeDeltaY > 24)
        ) {
            // Smoothly finish the swipe and enter fullscreen without
            // re-triggering the slide-up-player keyframe (would bounce).
            musicPlayerStore.commitSwipeFullScreen();
        } else {
            musicPlayerStore.setFullScreenSwipeProgress(0);
        }
        swipeActive = false;
        swipeCaptured = false;
    }

    function miniplayerSwipe(node: HTMLElement) {
        node.addEventListener('touchstart', handleBarTouchStart, {
            passive: true,
        });
        node.addEventListener('touchmove', handleBarTouchMove, {
            passive: false,
        });
        node.addEventListener('touchend', handleBarTouchEnd, {
            passive: false,
        });
        node.addEventListener('touchcancel', resetSwipeProgress);
        return {
            destroy() {
                node.removeEventListener('touchstart', handleBarTouchStart);
                node.removeEventListener('touchmove', handleBarTouchMove);
                node.removeEventListener('touchend', handleBarTouchEnd);
                node.removeEventListener('touchcancel', resetSwipeProgress);
            },
        };
    }

    // ── Global keyboard shortcuts (Space/arrows/M) ───────────────────────
    const KEYBOARD_SEEK_STEP_MS = 5_000;
    const KEYBOARD_SEEK_STEP_SHIFT_MULTIPLIER = 6;
    const KEYBOARD_VOLUME_STEP = 0.05;

    function isFocusEligibleForShortcuts(): boolean {
        const active = document.activeElement;
        return active === document.body || active === document.documentElement || active === null;
    }

    function handleGlobalKeydown(event: KeyboardEvent): void {
        if (!$musicPlayerStore.currentTrack) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.shiftKey && event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return;
        if (event.defaultPrevented) return;
        if (isWatchPage) return;
        if (!isFocusEligibleForShortcuts()) return;

        switch (event.code) {
            case 'Space': {
                if (event.repeat) return;
                event.preventDefault();
                if (audibleAnywhere) musicPlayerStore.pause();
                else musicPlayerStore.resume();
                break;
            }
            case 'ArrowLeft':
            case 'ArrowRight': {
                const step = event.shiftKey
                    ? KEYBOARD_SEEK_STEP_MS * KEYBOARD_SEEK_STEP_SHIFT_MULTIPLIER
                    : KEYBOARD_SEEK_STEP_MS;
                const delta = event.code === 'ArrowLeft' ? -step : step;
                const target = Math.min(
                    Math.max($musicPlayerStore.currentTimeMs + delta, 0),
                    $musicPlayerStore.durationMs,
                );
                event.preventDefault();
                musicPlayerStore.seekTo(target);
                break;
            }
            case 'ArrowUp':
            case 'ArrowDown': {
                if (!$musicPlayerStore.supportsVolumeControl) return;
                const delta =
                    event.code === 'ArrowUp' ? KEYBOARD_VOLUME_STEP : -KEYBOARD_VOLUME_STEP;
                const target = Math.min(Math.max($musicPlayerStore.volume + delta, 0), 1);
                event.preventDefault();
                musicPlayerStore.setVolume(target);
                break;
            }
            case 'KeyM': {
                if (event.repeat) return;
                event.preventDefault();
                musicPlayerStore.toggleMute();
                break;
            }
            default:
                return;
        }
    }

    // ── Scroll-wheel volume control (desktop volume region) ─────────────
    const WHEEL_VOLUME_STEP = 0.03;

    function volumeWheel(node: HTMLElement) {
        function onWheel(event: WheelEvent): void {
            event.preventDefault();
            if (event.deltaY === 0) return;
            const delta = event.deltaY < 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP;
            const target = Math.min(Math.max($musicPlayerStore.volume + delta, 0), 1);
            musicPlayerStore.setVolume(target);
        }
        node.addEventListener('wheel', onWheel, { passive: false });
        return {
            destroy() {
                node.removeEventListener('wheel', onWheel);
            },
        };
    }

    // ── Up Next hover popover (desktop) ───────────────────────────────────
    // Peeks at the next up-to-3 queued tracks (or an "Autoplay" hint when the
    // queue is empty but autoplay will keep it going) above the expand/collapse
    // chevron. Pointer-events-none — it's a peek, not an interactive menu.
    const UPNEXT_POPOVER_DELAY_MS = 150;
    let showUpNextPopover = $state(false);
    let upNextPopoverTimer: ReturnType<typeof setTimeout> | null = null;
    let upNextPopoverEligible = $derived(
        $musicPlayerStore.queue.length > 0 || $musicPlayerStore.autoplayEnabled,
    );
    let upNextPopoverItems = $derived($musicPlayerStore.queue.slice(0, 3));
    let upNextPopoverExtraCount = $derived(Math.max(0, $musicPlayerStore.queue.length - 3));

    function clearUpNextPopoverTimer(): void {
        if (upNextPopoverTimer !== null) {
            clearTimeout(upNextPopoverTimer);
            upNextPopoverTimer = null;
        }
    }

    function scheduleUpNextPopover(): void {
        if ($musicPlayerStore.isExpanded || !upNextPopoverEligible) return;
        clearUpNextPopoverTimer();
        upNextPopoverTimer = setTimeout(() => {
            showUpNextPopover = true;
        }, UPNEXT_POPOVER_DELAY_MS);
    }

    function hideUpNextPopover(): void {
        clearUpNextPopoverTimer();
        showUpNextPopover = false;
    }

    // Close immediately if the queue panel opens while the popover is showing.
    $effect(() => {
        if ($musicPlayerStore.isExpanded) hideUpNextPopover();
    });

    // ── Lyrics quick access ────────────────────────────────────────────────
    function openLyricsPanel(): void {
        if (!$musicPlayerStore.isExpanded) {
            musicPlayerStore.toggleExpanded();
        }
        musicPlayerStore.setActivePanel('lyrics');
    }

    // ── Output device picker (desktop-only, backend-dependent) ────────────
    // canSelectOutputDevice() reflects backend/browser capability. The backend
    // is created lazily on first play, so key the check off currentTrack —
    // by the time a track is set the backend exists and the answer is stable.
    const canSelectOutput = $derived.by(() => {
        if (!$musicPlayerStore.currentTrack) return false;
        return musicPlayerStore.canSelectOutputDevice();
    });

    let showOutputMenu = $state(false);
    let outputDevices = $state<MediaDeviceInfo[]>([]);
    let outputSelectFailed = $state(false);
    let outputButtonEl: HTMLButtonElement | undefined = $state();

    async function refreshOutputDevices(): Promise<void> {
        try {
            const all = await navigator.mediaDevices.enumerateDevices();
            outputDevices = all.filter(
                (d) => d.kind === 'audiooutput' && d.deviceId !== '' && d.deviceId !== 'default',
            );
        } catch {
            outputDevices = [];
        }
    }

    function closeOutputMenu(): void {
        showOutputMenu = false;
        outputSelectFailed = false;
        outputButtonEl?.focus();
    }

    async function toggleOutputMenu(): Promise<void> {
        if (showOutputMenu) {
            closeOutputMenu();
            return;
        }
        outputSelectFailed = false;
        showOutputMenu = true;
        await refreshOutputDevices();
    }

    async function selectOutputDevice(deviceId: string): Promise<void> {
        outputSelectFailed = false;
        const ok = await musicPlayerStore.setOutputDevice(deviceId);
        if (ok) {
            closeOutputMenu();
        } else {
            outputSelectFailed = true;
        }
    }

    function handleOutputMenuKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closeOutputMenu();
        }
    }

    // Keep the device list fresh while the menu is open.
    $effect(() => {
        if (!showOutputMenu) return;
        const handler = (): void => {
            void refreshOutputDevices();
        };
        navigator.mediaDevices.addEventListener('devicechange', handler);
        return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
    });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if visible && $musicPlayerStore.currentTrack}
    <div
        class="mini-player fixed left-0 right-0 z-40 border-t border-surface-500/20 bg-surface-800/95 backdrop-blur-lg"
        class:mini-player-crossfading={$musicPlayerStore.isCrossfading}
        class:over-music-modal={overMusicModal}
        style={`${
            moodTintColor !== null && !$musicPlayerStore.isCrossfading
                ? `border-top-color: ${moodTintColor}33; box-shadow: 0 -2px 12px ${moodTintColor}1a, 0 -1px 4px ${moodTintColor}0d;`
                : ''
        } bottom: ${overMusicModal ? '0px' : 'var(--music-bottom-nav-h, 0px)'}; padding-bottom: ${
            overMusicModal
                ? 'env(safe-area-inset-bottom)'
                : 'max(0px, calc(env(safe-area-inset-bottom) - var(--music-bottom-nav-h, 0px)))'
        }; z-index: ${overMusicModal ? Z.MUSIC_OVER_MODAL : Z.MUSIC_BAR};`}>
        <!-- ═══ Seekbar (zone-aware, touch-scrubbing) — hidden for live radio ═══ -->
        {#if !$musicPlayerStore.currentTrack?.isRadio}
            <div
                class="seekbar absolute left-0 right-0 cursor-pointer group touch-none"
                style="bottom: 100%; height: {SEEKBAR_HIT_PX}px;"
                onpointerdown={handleSeekStart}
                onpointermove={handleSeekMove}
                onpointerup={handleSeekEnd}
                onpointercancel={handleSeekEnd}
                onpointerleave={handleSeekPointerLeave}
                onkeydown={handleSeekKeydown}
                role="slider"
                tabindex="0"
                aria-label={m.music_seek_aria()}
                aria-valuenow={Math.round($musicPlayerStore.currentTimeMs / 1000)}
                aria-valuemin={0}
                aria-valuemax={Math.round($musicPlayerStore.durationMs / 1000)}
                aria-valuetext="{formatTime($musicPlayerStore.currentTimeMs)} of {formatTime(
                    $musicPlayerStore.durationMs,
                )}">
                <!-- Visual bar anchored to bottom of hit area. During a fade it
                     swells by up to 2px along sin(pi*t) — zero at both ends —
                     so it grows out of and settles back into the normal bar
                     instead of snapping between two heights. -->
                <div
                    class="absolute bottom-0 left-0 right-0 h-[calc(0.25rem+var(--xf-swell))] transition-[height] duration-300 group-hover:h-[calc(0.375rem+var(--xf-swell))]"
                    style="--xf-swell: {$musicPlayerStore.isCrossfading
                        ? Math.sin(
                              Math.max(0, Math.min(1, $musicPlayerStore.crossfadeProgress)) *
                                  Math.PI,
                          ) * 2
                        : 0}px">
                    <!-- Background -->
                    <div class="absolute inset-0 bg-surface-700"></div>

                    <!-- Crossfade zone diagonal stripes (hidden mid-fade: the
                         promoted incoming track's own outro zone would flash
                         up at the far end while the hand-off plays) -->
                    {#if crossfadeZoneProgress !== null && !$musicPlayerStore.isCrossfading}
                        <div
                            class="crossfade-zone-stripes absolute top-0 right-0 bottom-0"
                            style="left: {crossfadeZoneProgress * 100}%">
                        </div>
                    {/if}

                    <!-- Progress fill -->
                    <div
                        class="absolute top-0 left-0 bottom-0 bg-primary-500"
                        style="width: {$musicPlayerStore.progress * 100}%">
                    </div>

                    <CrossfadeSeekbarFx />

                    <!-- Outro start marker -->
                    {#if crossfadeZoneProgress !== null && !$musicPlayerStore.isCrossfading}
                        <div
                            class="absolute top-0 bottom-0 w-0.5 transition-all {showUpNextPreview
                                ? 'bg-amber-400/80'
                                : 'bg-amber-500/40'}"
                            class:marker-pulse={showUpNextPreview &&
                                !$musicPlayerStore.isCrossfading}
                            style="left: {crossfadeZoneProgress * 100}%">
                            <!-- Diamond marker -->
                            <div
                                class="absolute -top-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rotate-45 rounded-[1px] {showUpNextPreview
                                    ? 'bg-amber-400'
                                    : 'bg-amber-500/50'}">
                            </div>
                        </div>
                    {/if}

                    <!-- Chapter tick marks (skip index 0 — the start is implicit) -->
                    {#if $musicPlayerStore.durationMs > 0}
                        {#each chapters as chapter, i (i)}
                            {#if i > 0 && chapter.startMs < $musicPlayerStore.durationMs}
                                <div
                                    class="chapter-tick absolute top-0 bottom-0 w-[2px] -translate-x-1/2 rounded-[1px] bg-white/55 group-hover:bg-white/80 pointer-events-none"
                                    style="left: {(chapter.startMs / $musicPlayerStore.durationMs) *
                                        100}%">
                                </div>
                            {/if}
                        {/each}
                    {/if}

                    <PlayheadBeatPulse progress={$musicPlayerStore.progress} seeking={isSeeking} />
                </div>

                <!-- Chapter hover preview (desktop; hides on touch since
                 chapterHoverMs is only set for mouse pointers). -->
                {#if hoveredChapter && seekbarWidth > 0}
                    <div
                        class="pointer-events-none absolute bottom-full mb-1 max-w-[260px] -translate-x-1/2 rounded-md border border-surface-500/40 bg-surface-900/95 px-2 py-1 text-[11px] leading-tight text-white shadow-lg backdrop-blur"
                        style="left: {Math.max(60, Math.min(seekbarWidth - 60, chapterHoverX))}px">
                        <p class="truncate font-medium">
                            {hoveredChapter.title}
                        </p>
                        {#if hoveredChapter.artist}
                            <p class="truncate text-surface-400">
                                {hoveredChapter.artist}
                            </p>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- ═══ Up Next Preview Strip (slides up when approaching crossfade) ═══ -->
        {#if showUpNextPreview}
            <div
                transition:upNextStripTransition
                class="upnext-strip relative flex items-center gap-3 border-b border-surface-700/50 px-4 py-2">
                <!-- Countdown / blending status + crossfade technique -->
                {#if crossfadeInfo}
                    {#if $musicPlayerStore.isCrossfading && $musicPlayerStore.crossfadeTotalBeats > 0}
                        <!-- Beat progress visualization during active crossfade -->
                        <div class="flex items-center gap-2 shrink-0">
                            <span class="crossfade-pulse-text text-amber-400 text-xs">↔</span>
                            <!-- Progress bar with bar-boundary markers -->
                            <div
                                class="relative h-3.5 w-28 bg-surface-700 rounded-full overflow-hidden">
                                <div
                                    class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75 ease-linear {crossfadeInfo.technique !==
                                    'no-sync'
                                        ? 'bg-emerald-500/80'
                                        : 'bg-amber-500/80'}"
                                    style="width: {$musicPlayerStore.crossfadeProgress * 100}%">
                                </div>
                                <!-- Bar boundaries (every 4 beats) -->
                                {#each Array(Math.max(Math.floor($musicPlayerStore.crossfadeTotalBeats / 4) - 1, 0)) as _, i (i)}
                                    <div
                                        class="absolute top-0 bottom-0 w-px bg-surface-500/40"
                                        style="left: {((i + 1) * 4 * 100) /
                                            $musicPlayerStore.crossfadeTotalBeats}%">
                                    </div>
                                {/each}
                            </div>
                            <!-- Beat counter + live BPM -->
                            <div class="text-[10px] tabular-nums leading-tight">
                                <div class="text-surface-400">
                                    {$musicPlayerStore.crossfadeCurrentBeat}/{$musicPlayerStore.crossfadeTotalBeats}
                                </div>
                                {#if crossfadeInfo.technique !== 'no-sync' && (liveCrossfadeBpm ?? $musicPlayerStore.effectiveBpm)}
                                    <div class="flex items-center gap-0.5 text-emerald-500/80">
                                        <span
                                            class="live-bpm-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"
                                        ></span>
                                        {liveCrossfadeBpm ?? $musicPlayerStore.effectiveBpm}
                                        {#if crossfadeInfo.inBpm && (liveCrossfadeBpm ?? $musicPlayerStore.effectiveBpm) !== crossfadeInfo.inBpm}
                                            <span class="text-surface-500"
                                                >→{crossfadeInfo.inBpm}</span>
                                        {/if}
                                    </div>
                                {:else if crossfadeInfo.outBpm && crossfadeInfo.inBpm}
                                    <div class="text-surface-500">
                                        {crossfadeInfo.outBpm}→{crossfadeInfo.inBpm}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {:else if $musicPlayerStore.isCrossfading}
                        <div
                            class="shrink-0 crossfade-pulse-text text-amber-400 text-xs flex items-center gap-1">
                            ↔ Blending
                            {#if isAdmin && crossfadeInfo.technique === 'no-sync'}
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    class="h-3 w-3 text-warning-400"
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    role="img"
                                    aria-label={m.music_no_bpm_blending()}>
                                    <path
                                        fill-rule="evenodd"
                                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                                        clip-rule="evenodd" />
                                </svg>
                            {/if}
                        </div>
                    {:else}
                        <div class="shrink-0 whitespace-nowrap text-sm tabular-nums">
                            {#if crossfadeCountdownSec !== null && crossfadeCountdownSec > 0}
                                <div class="text-surface-300">
                                    ↔ in <span class="text-amber-400"
                                        >{crossfadeCountdownSec}s</span>
                                </div>
                            {:else if crossfadeCountdownSec === 0}
                                <!-- Predicted trigger reached but the audio fade
                                     hasn't flipped isCrossfading yet (it starts on
                                     the next downbeat). Hold a pulsing ↔ so the
                                     symbol persists smoothly instead of blanking. -->
                                <div class="crossfade-pulse-text text-amber-400">↔</div>
                            {/if}
                            <Tooltip
                                text={crossfadeInfo.technique === 'rate-match'
                                    ? 'Native playback rate adjustment'
                                    : crossfadeInfo.technique === 'time-stretch'
                                      ? 'SoundTouch WSOLA pitch-preserving stretch'
                                      : 'No BPM data available'}
                                position="top"
                                fixed>
                                <div class="flex items-center gap-1 text-xs text-surface-400">
                                    {#if crossfadeInfo.fadeMode !== 'blend'}
                                        <span class="text-pink-400">{crossfadeInfo.fadeMode}</span> ·
                                    {/if}
                                    {crossfadeInfo.beats}-beat · {crossfadeInfo.durationSec}s
                                    {#if crossfadeInfo.technique === 'rate-match'}
                                        · synced
                                    {:else if crossfadeInfo.technique === 'time-stretch'}
                                        · stretched
                                    {:else if isAdmin}
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            class="h-3 w-3 text-warning-400"
                                            viewBox="0 0 20 20"
                                            fill="currentColor"
                                            role="img"
                                            aria-label={m.music_no_bpm_essentia()}>
                                            <path
                                                fill-rule="evenodd"
                                                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                                                clip-rule="evenodd" />
                                        </svg>
                                    {/if}
                                </div>
                            </Tooltip>
                        </div>
                    {/if}
                {/if}

                <!-- Auto-selected next track (highlighted). Pre-fade this is
                     the queue head (prediction); during an active fade it
                     shows currentTrack — already the incoming track under
                     the new crossfade model — via upNextStripTrack. -->
                {#if upNextStripTrack}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-700/40 px-2 py-1 ring-1 ring-primary-500/20"
                        oncontextmenu={handleUpNextContextMenu}>
                        {#if trackPosterThumb(upNextStripTrack)}
                            <img
                                src={trackPosterThumb(upNextStripTrack)}
                                alt={upNextStripTrack.title}
                                class="h-10 w-10 shrink-0 rounded shadow-sm" />
                        {:else}
                            <div
                                class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-600">
                                <Icon src={SpeakerWave} class="h-4 w-4 text-surface-400" />
                            </div>
                        {/if}
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium text-white">
                                {upNextStripTrack.title}
                            </p>
                            <p class="truncate text-xs text-surface-400">
                                <TrackArtistLine
                                    artist={upNextStripTrack.artists
                                        .map((a) => a.title)
                                        .join(', ') ?? ''}
                                    artists={upNextStripTrack.artists}
                                    artistId={upNextStripTrack.artists[0]?.id ?? undefined} />
                                {#if upNextStripTrack.album?.title}
                                    <span class="text-surface-500"> · </span>
                                    {#if upNextStripTrack.album?.id}
                                        <button
                                            type="button"
                                            class="hidden hover:text-primary-400 hover:underline md:inline"
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                openAlbumModal(upNextStripTrack.album?.id ?? '');
                                            }}>{upNextStripTrack.album?.title}</button>
                                        <span class="md:hidden"
                                            >{upNextStripTrack.album?.title}</span>
                                    {:else}
                                        {upNextStripTrack.album?.title}
                                    {/if}
                                {/if}
                            </p>
                        </div>
                        {#if crossfadeInfo && crossfadeInfo.outBpm && crossfadeInfo.inBpm}
                            <span
                                class="shrink-0 tabular-nums text-[10px] {crossfadeInfo.technique !==
                                'no-sync'
                                    ? 'text-emerald-500/80'
                                    : 'text-surface-500'}">
                                {crossfadeInfo.outBpm}→{crossfadeInfo.inBpm}
                            </span>
                        {:else if crossfadeInfo && crossfadeInfo.inBpm}
                            <span class="shrink-0 tabular-nums text-[10px] text-surface-500">
                                {crossfadeInfo.inBpm} BPM
                            </span>
                        {/if}
                    </div>
                {/if}

                <!-- Debug overlay: only show when info matches the current queue head or during active crossfade -->
                {#if $musicPlayerStore.crossfadeDebug && $musicPlayerStore.crossfadeDebugInfo && ($musicPlayerStore.isCrossfading || $musicPlayerStore.crossfadeDebugInfo.inTrackId === $musicPlayerStore.queue[0]?.id)}
                    {@const dbg = $musicPlayerStore.crossfadeDebugInfo}
                    <!-- Fixed + left-anchored so it escapes the mini-player's own
                         stacking context (bounded by Z.MUSIC_BAR/MUSIC_OVER_MODAL)
                         and never sits under the right-anchored QueuePanel. -->
                    <div
                        class="debug-overlay pointer-events-none fixed left-2 flex max-w-[420px] flex-wrap items-start gap-x-3 gap-y-0.5 rounded-md border border-cyan-500/20 bg-surface-900/95 px-4 py-1.5 font-mono text-[10px] leading-tight shadow-lg backdrop-blur"
                        style="bottom: var(--miniplayer-height, 6.5rem); z-index: {Z.TOOLTIP};">
                        <!-- Same in-place off switch as the audio-features variant
                             below — this crossfade-active variant is the one on
                             screen during long fades, so it needs its own. -->
                        <button
                            type="button"
                            class="pointer-events-auto order-last -mr-2 ml-auto self-start rounded p-0.5 text-surface-500 transition-colors hover:text-surface-200"
                            aria-label={m.music_debug_overlay_dismiss()}
                            title={m.music_debug_overlay_dismiss()}
                            onclick={() => musicPlayerStore.toggleCrossfadeDebug()}>
                            <Icon src={XMark} class="h-3 w-3" />
                        </button>
                        <!-- Fade mode + reason -->
                        <span class="text-pink-400"
                            >mode: <span class="text-white">{dbg.fadeMode}</span></span>
                        {#if dbg.fadeReason}
                            <span class="text-pink-400/60">({dbg.fadeReason})</span>
                        {/if}
                        <!-- Alignment method -->
                        <span class="text-cyan-400"
                            >align: <span class="text-white">{dbg.alignmentMethod}</span></span>
                        <!-- Beat data availability -->
                        <span class="text-surface-500">
                            out♩: <span
                                class={dbg.outHasDownbeats ? 'text-emerald-400' : 'text-red-400'}
                                >{dbg.outHasDownbeats ? '✓' : '✗'}</span>
                            in♩:
                            <span class={dbg.inHasDownbeats ? 'text-emerald-400' : 'text-red-400'}
                                >{dbg.inHasDownbeats ? '✓' : '✗'}</span>
                            grid:
                            <span class={dbg.inHasBeatGrid ? 'text-emerald-400' : 'text-red-400'}
                                >{dbg.inHasBeatGrid ? '✓' : '✗'}</span>
                        </span>
                        <!-- Bar phase -->
                        {#if dbg.outBarPhase !== null}
                            <span class="text-amber-400"
                                >phase: <span class="text-white">{dbg.outBarPhase}</span></span>
                        {/if}
                        <!-- Sync info -->
                        <span class="text-purple-400"
                            >sync: <span class="text-white">{dbg.syncTechnique}</span></span>
                        <!-- BPM gap -->
                        {#if dbg.bpmGapPercent !== null}
                            <span class="text-surface-400"
                                >gap: <span
                                    class={dbg.bpmGapPercent <= 8
                                        ? 'text-emerald-400'
                                        : dbg.bpmGapPercent <= 25
                                          ? 'text-amber-400'
                                          : 'text-red-400'}>{dbg.bpmGapPercent}%</span
                                ></span>
                        {/if}
                        <!-- Keys -->
                        {#if dbg.outKey || dbg.inKey}
                            <span class="text-surface-400"
                                >key: <span class="text-white">{dbg.outKey ?? '?'}</span>→<span
                                    class="text-white">{dbg.inKey ?? '?'}</span
                                ></span>
                        {/if}
                        <!-- BPMs (precise) -->
                        {#if dbg.outBpm || dbg.inBpm}
                            <span class="text-surface-400"
                                >bpm: <span class="text-white">{dbg.outBpm ?? '?'}</span>→<span
                                    class="text-white">{dbg.inBpm ?? '?'}</span
                                ></span>
                        {/if}
                        <!-- Start position -->
                        <span class="text-surface-500">in@{dbg.inStartSec}s</span>
                        <!-- Outro trigger source -->
                        {#if dbg.outroSource}<span class="text-orange-400"
                                >trigger: <span class="text-white">{dbg.outroSource}</span></span
                            >{/if}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- Debug: current track audio features (visible when debug mode on, not near crossfade) -->
        {#if $musicPlayerStore.crossfadeDebug && !showUpNextPreview && $musicPlayerStore.currentTrack?.audioFeatures}
            {@const af = $musicPlayerStore.currentTrack.audioFeatures}
            <!-- Fixed + left-anchored for the same reason as the active-crossfade
                 debug overlay above — see comment there. Mutually exclusive with
                 that variant via the showUpNextPreview gates on both. -->
            <div
                class="pointer-events-none fixed left-2 flex max-w-[420px] flex-wrap items-start gap-x-3 gap-y-0.5 rounded-md border border-cyan-500/20 bg-surface-900/95 px-4 py-1.5 font-mono text-[10px] leading-tight shadow-lg backdrop-blur"
                style="bottom: var(--miniplayer-height, 6.5rem); z-index: {Z.TOOLTIP};">
                <!-- In-place off switch: the overlay is a persisted setting
                     (Crossfade settings → Debug overlay), so without this a
                     user who toggled it once sees a "stuck" readout on every
                     track with no visible way back. pointer-events-auto
                     re-enables clicks just for this button. -->
                <button
                    type="button"
                    class="pointer-events-auto order-last -mr-2 ml-auto self-start rounded p-0.5 text-surface-500 transition-colors hover:text-surface-200"
                    aria-label={m.music_debug_overlay_dismiss()}
                    title={m.music_debug_overlay_dismiss()}
                    onclick={() => musicPlayerStore.toggleCrossfadeDebug()}>
                    <Icon src={XMark} class="h-3 w-3" />
                </button>
                {#if af.bpm}<span class="text-cyan-400"
                        >bpm: <span class="text-white">{Math.round(af.bpm * 10) / 10}</span></span
                    >{/if}
                {#if af.key}<span class="text-purple-400"
                        >key: <span class="text-white">{af.key}</span></span
                    >{/if}
                {#if af.energy !== undefined}<span class="text-amber-400"
                        >energy: <span class="text-white">{(af.energy * 100).toFixed(0)}%</span
                        ></span
                    >{/if}
                {#if af.danceability !== undefined}<span class="text-emerald-400"
                        >dance: <span class="text-white"
                            >{(Math.min(af.danceability / 3, 1) * 100).toFixed(0)}%</span
                        ></span
                    >{/if}
                {#if af.loudnessLufs !== undefined}<span class="text-surface-400"
                        >loud: <span class="text-white">{af.loudnessLufs.toFixed(1)} LUFS</span
                        ></span
                    >{/if}
                <span class="text-surface-500">
                    ♩: <span
                        class={af.downbeats && af.downbeats.length > 0
                            ? 'text-emerald-400'
                            : 'text-red-400'}>{af.downbeats?.length ?? 0} downbeats</span>
                    grid:
                    <span
                        class={af.beatGrid && af.beatGrid.length > 0
                            ? 'text-emerald-400'
                            : 'text-red-400'}>{af.beatGrid?.length ?? 0} beats</span>
                </span>
                {#if af.introEndMs}<span class="text-surface-500"
                        >intro→{(af.introEndMs / 1000).toFixed(1)}s</span
                    >{/if}
                {#if af.outroStartMs}<span class="text-surface-500"
                        >outro@{(af.outroStartMs / 1000).toFixed(1)}s</span
                    >{/if}
                {#if af.moodTags && af.moodTags.length > 0}<span class="text-surface-500"
                        >mood: {af.moodTags.join(', ')}</span
                    >{/if}
                {#if af.vocalInstrumental}<span class="text-orange-400"
                        >vocal: <span class="text-white">{af.vocalInstrumental}</span
                        >{#if af.vocalConfidence !== undefined}
                            <span class="text-surface-500">
                                ({(af.vocalConfidence * 100).toFixed(0)}%)</span
                            >{/if}</span
                    >{/if}
            </div>
        {/if}

        <!-- ═══ Main Player Bar ═══ -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="miniplayer-swipe-zone flex items-center gap-3 px-4 py-3"
            bind:clientHeight={mainBarHeight}
            use:miniplayerSwipe>
            <!-- Album art with cross-dissolve.
                 On mobile: tapping opens the full-screen player.
                 On desktop: the onclick is a no-op, so we hide it from the a11y tree
                 (aria-hidden + tabindex=-1) to avoid a focusable button that does nothing.
                 The context-menu (right-click) still works because it needs no keyboard path. -->
            <button
                class="relative h-14 w-14 shrink-0 overflow-hidden rounded transition-opacity active:opacity-70 md:cursor-default"
                onclick={() => {
                    if (window.innerWidth < 768) musicPlayerStore.setFullScreen(true);
                }}
                oncontextmenu={handlePosterContextMenu}
                aria-label={isDesktop ? undefined : m.music_open_full_player_aria()}
                aria-hidden={isDesktop ? 'true' : undefined}
                tabindex={isDesktop ? -1 : 0}
                type="button">
                <!-- Base layer: currentTrack art when idle; the fading-out
                     track (history[0]) during a crossfade, since the overlay
                     below already shows currentTrack as the incoming art. -->
                {#if trackPosterThumb(crossfadeBaseTrack)}
                    <img
                        src={trackPosterThumb(crossfadeBaseTrack)}
                        alt={crossfadeBaseTrack?.title ?? ''}
                        class="h-full w-full object-cover" />
                {:else}
                    <div class="flex h-full w-full items-center justify-center bg-surface-700">
                        <Icon src={SpeakerWave} class="h-6 w-6 text-surface-400" />
                    </div>
                {/if}
                <!-- Overlay: incoming track (currentTrack — already promoted
                     at fade start) fades in during crossfade.
                     Opacity is driven by crossfadeProgress (0→1) rather than a fixed
                     2.5 s CSS keyframe so it tracks the actual audio blend in real time.
                     {#key} restarts the element when the incoming track changes so a
                     new crossfade always starts from opacity 0. -->
                {#if $musicPlayerStore.isCrossfading && trackPosterThumb($musicPlayerStore.currentTrack)}
                    {#key $musicPlayerStore.currentTrack.id}
                        <img
                            src={trackPosterThumb($musicPlayerStore.currentTrack)}
                            alt=""
                            class="absolute inset-0 h-full w-full object-cover"
                            style="opacity: {$musicPlayerStore.crossfadeProgress}" />
                    {/key}
                {/if}
            </button>

            <!-- Track info: on mobile, entire area opens fullscreen; on desktop, links open modals.
                 The wrapper stays a <div> to avoid button-in-button HTML violations (artist/album
                 child links are <button> elements). A visually-hidden <button> overlay is
                 injected inside this div on mobile so keyboard/AT users can open the full-screen
                 player. On desktop the inner artist/album/title buttons are the focusable targets.
                 The onclick here is a pointer-only convenience alias for the mobile touch target;
                 keyboard access is provided by the overlay <button> below. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="relative min-w-0 flex-1 md:cursor-default"
                onclick={(e) => {
                    if (window.innerWidth < 768) {
                        e.preventDefault();
                        e.stopPropagation();
                        musicPlayerStore.setFullScreen(true);
                    }
                }}>
                {#if $musicPlayerStore.playingElsewhere && !$musicPlayerStore.isPlaying}
                    <!-- Another tab took playback (music-tab-sync.ts). Says why
                         this one went quiet; pressing play here brings it back
                         from where the other tab was. -->
                    <div
                        class="flex items-center gap-1.5 text-xs text-surface-400"
                        data-testid="music-playing-elsewhere">
                        <Icon src={SpeakerWave} class="h-3.5 w-3.5" />
                        <span class="truncate">{m.music_playing_in_other_tab()}</span>
                        <!-- The transport buttons steer the tab that plays;
                             this one moves playback HERE, in one click. -->
                        <button
                            type="button"
                            class="ml-1 shrink-0 rounded-full border border-surface-500/60 px-2 py-0.5 font-medium text-primary-300 transition-colors hover:border-primary-400 hover:text-white"
                            data-testid="music-play-here"
                            onclick={(e) => {
                                e.stopPropagation();
                                musicPlayerStore.resume();
                            }}>
                            {m.music_play_here()}
                        </button>
                    </div>
                {:else if $musicPlayerStore.autoplaySeed}
                    <div class="flex items-center gap-1.5 text-xs text-primary-400">
                        <span>{getSeedEmoji($musicPlayerStore.autoplaySeed)}</span>
                        <span class="font-medium"
                            >{getSeedLabel($musicPlayerStore.autoplaySeed)}</span>
                        <!-- Padded to ≥44×44px for touch accessibility -->
                        <button
                            type="button"
                            class="ml-1 p-3 text-surface-500 hover:text-white"
                            onclick={(e) => {
                                e.stopPropagation();
                                musicPlayerStore.clearAutoplaySeed();
                            }}
                            aria-label={m.music_stop_radio_aria()}>
                            <Icon src={XMark} class="h-3.5 w-3.5" />
                        </button>
                    </div>
                {:else if $musicPlayerStore.playbackContext?.type === 'station'}
                    <!-- Surfaces the taste-station queue origin. Not a seed —
                         doesn't affect smart queue, just shows provenance.
                         Auto-clears when queue runs out (see store's
                         queue-empty effect). -->
                    <div class="flex items-center gap-1.5 text-xs text-primary-400">
                        <span>&#9654;</span>
                        <span class="font-medium truncate max-w-[240px]">
                            {m.music_playing_from({
                                name: $musicPlayerStore.playbackContext.name,
                            })}
                        </span>
                    </div>
                {/if}
                <!-- Title / artist: cross-fades between the outgoing track
                     (currentTrack when idle, history[0] during a crossfade)
                     and the incoming track (currentTrack — already promoted
                     at fade start under the new crossfade model) via two
                     opacity layers driven by metadataOutgoingOpacity /
                     metadataIncomingOpacity (see derived values in script).
                     When not crossfading the incoming layer is hidden (opacity 0)
                     and the outgoing layer is fully opaque (opacity 1). -->
                <div class="relative min-h-[2.6rem] overflow-hidden">
                    <!-- Outgoing metadata layer -->
                    <div class="w-full" style="opacity: {metadataOutgoingOpacity}">
                        <p class="truncate text-[15px] font-medium text-white">
                            {#if crossfadeBaseTrack?.album?.id}
                                <span class="hidden md:inline"
                                    ><TrackTitleLine
                                        title={crossfadeBaseTrack?.title ?? ''}
                                        artists={crossfadeBaseTrack?.artists}
                                        remixerArtists={crossfadeBaseTrack?.remixerArtists}
                                        plainClass="cursor-pointer"
                                        onPlainClick={(e) => {
                                            e.stopPropagation();
                                            // Title click = "show THIS track": open the
                                            // album scrolled to the playing track, not
                                            // just the album top.
                                            void openAlbumForTrack(crossfadeBaseTrack?.id ?? '', {
                                                albumId: crossfadeBaseTrack?.album?.id,
                                            });
                                        }} /></span>
                                <span class="md:hidden">{crossfadeBaseTrack?.title ?? ''}</span>
                            {:else}
                                <TrackTitleLine
                                    title={crossfadeBaseTrack?.title ?? ''}
                                    artists={crossfadeBaseTrack?.artists}
                                    remixerArtists={crossfadeBaseTrack?.remixerArtists} />
                            {/if}
                        </p>
                        <p class="truncate text-sm text-surface-400">
                            <TrackArtistLine
                                artist={crossfadeBaseTrack?.artists
                                    .map((a) => a.title)
                                    .join(', ') ?? ''}
                                artists={crossfadeBaseTrack?.artists}
                                artistId={crossfadeBaseTrack?.artists[0]?.id ?? undefined} />
                            {#if crossfadeBaseTrack?.album?.title}
                                <span class="text-surface-500"> · </span>
                                {#if crossfadeBaseTrack?.album?.id}
                                    <span class="hidden md:inline">
                                        <MusicEntityHoverCard
                                            kind="album"
                                            id={crossfadeBaseTrack.album?.id}
                                            class="hover:text-primary-400 hover:underline"
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                openAlbumModal(crossfadeBaseTrack?.album?.id ?? '');
                                            }}>
                                            {crossfadeBaseTrack.album?.title}
                                        </MusicEntityHoverCard>
                                    </span>
                                    <span class="md:hidden">{crossfadeBaseTrack.album?.title}</span>
                                {:else}
                                    {crossfadeBaseTrack.album?.title}
                                {/if}
                            {/if}
                        </p>
                    </div>
                    <!-- Incoming metadata layer: currentTrack, overlaid
                         absolutely, fades in at t≈0.5 -->
                    {#if $musicPlayerStore.isCrossfading}
                        <div
                            class="absolute inset-0 w-full"
                            style="opacity: {metadataIncomingOpacity}">
                            <p class="truncate text-[15px] font-medium text-white">
                                {$musicPlayerStore.currentTrack?.title ?? ''}
                            </p>
                            <p class="truncate text-sm text-surface-400">
                                <TrackArtistLine
                                    artist={$musicPlayerStore.currentTrack?.artists
                                        .map((a) => a.title)
                                        .join(', ') ?? ''}
                                    artists={$musicPlayerStore.currentTrack?.artists}
                                    artistId={$musicPlayerStore.currentTrack?.artists[0]?.id ??
                                        undefined} />
                                {#if $musicPlayerStore.currentTrack?.album?.title}
                                    <span class="text-surface-500"> · </span>{$musicPlayerStore
                                        .currentTrack.album?.title}
                                {/if}
                            </p>
                        </div>
                    {/if}
                </div>
                {#if $musicPlayerStore.currentTrack?.isRadio && $currentRadioNowPlaying}
                    {@const np = $currentRadioNowPlaying}
                    {@const djShowSubtitle = [np.dj.name ? `🎤 ${np.dj.name}` : null, np.show.name]
                        .filter(Boolean)
                        .join(' · ')}
                    {#if np.track.title}
                        <p class="truncate text-xs text-primary-400">
                            ♪ {np.track.title}
                            {#if np.track.artist}
                                <span class="text-surface-500"> · </span>
                                <!-- Radio metadata comes off the ICY stream, so there is no
                                     structured artists[] here — only a resolved artistId.
                                     TrackArtistLine degrades to exactly that single link. -->
                                <TrackArtistLine
                                    artist={np.track.artist}
                                    artistId={np.track.artistId ?? undefined} />
                            {/if}
                        </p>
                    {/if}
                    {#if djShowSubtitle}
                        <p class="truncate text-xs text-surface-400">
                            {djShowSubtitle}
                        </p>
                    {/if}
                {/if}
                <!-- Mobile-only keyboard/AT shortcut to open the full-screen player.
                     Positioned to cover the track-info area; invisible on desktop (md:hidden).
                     This avoids button-in-button HTML violations: on desktop the artist/album
                     links inside this div are the interactive targets; on mobile they are hidden. -->
                <button
                    type="button"
                    class="absolute inset-0 md:hidden"
                    aria-label={m.music_open_full_player_aria()}
                    onclick={(e) => {
                        e.stopPropagation();
                        musicPlayerStore.setFullScreen(true);
                    }}>
                </button>
            </div>

            <!-- Like / Dislike / Similar (hidden on mobile — available in full-screen player).
                 Hidden entirely on radio: feedback would be recorded against the
                 station UUID, not the song actually playing. -->
            {#if !$musicPlayerStore.currentTrack?.isRadio}
                <div class="hidden items-center gap-0.5 md:flex">
                    <Tooltip text="Like" position="top" fixed>
                        <button
                            type="button"
                            class="rounded p-1 transition-colors {$musicPlayerStore.currentTrackFeedback ===
                            'liked'
                                ? 'text-primary-400'
                                : 'text-surface-500 hover:text-white'}"
                            onclick={() => musicPlayerStore.likeCurrentTrack()}
                            aria-label={m.music_like_track_aria()}>
                            <Icon
                                src={Heart}
                                class="h-5 w-5"
                                solid={$musicPlayerStore.currentTrackFeedback === 'liked'} />
                        </button>
                    </Tooltip>
                    <Tooltip text="Dislike" position="top" fixed>
                        <button
                            type="button"
                            class="rounded p-1 transition-colors {$musicPlayerStore.currentTrackFeedback ===
                            'disliked'
                                ? 'text-red-400'
                                : 'text-surface-500 hover:text-white'}"
                            onclick={() => musicPlayerStore.dislikeCurrentTrack()}
                            aria-label={m.music_dislike_track_aria()}>
                            <Icon
                                src={HandThumbDown}
                                class="h-5 w-5"
                                solid={$musicPlayerStore.currentTrackFeedback === 'disliked'} />
                        </button>
                    </Tooltip>
                    <Tooltip text="Similar tracks" position="top" fixed>
                        <button
                            type="button"
                            class="rounded p-1 text-surface-500 transition-colors hover:text-primary-400"
                            onclick={() => {
                                if ($musicPlayerStore.currentTrack?.id) {
                                    openSimilarTracksModal(
                                        $musicPlayerStore.currentTrack.id,
                                        $page.data?.features?.sonicEmbeddings === true,
                                    );
                                }
                            }}
                            aria-label={m.music_find_similar_tracks_aria()}>
                            <Icon src={Sparkles} class="h-4 w-4" />
                        </button>
                    </Tooltip>
                    {#if $musicPlayerStore.lyricsStatus === 'available'}
                        <Tooltip text="Lyrics" position="top" fixed>
                            <button
                                type="button"
                                class="rounded p-1 text-surface-500 transition-colors hover:text-white"
                                onclick={openLyricsPanel}
                                aria-label={m.music_open_lyrics_aria()}>
                                <Icon src={DocumentText} class="h-4 w-4" />
                            </button>
                        </Tooltip>
                    {/if}
                </div>
            {/if}

            <!-- AirPlay button (desktop-only, available even on radio) -->
            {#if airplaySupported}
                <div class="hidden items-center md:flex">
                    <Tooltip text="AirPlay" position="top" fixed>
                        <button
                            type="button"
                            class="rounded p-1 text-surface-500 transition-colors hover:text-white disabled:opacity-40"
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
                                <svg viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5">
                                    <path
                                        d="M6 22h12l-6-6-6 6zM21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                                </svg>
                            {/if}
                        </button>
                    </Tooltip>
                </div>
            {/if}

            <!-- Output device picker (desktop-only, backend-dependent — see canSelectOutput) -->
            {#if canSelectOutput}
                <div class="relative hidden items-center md:flex">
                    <Tooltip text="Output device" position="top" fixed>
                        <button
                            type="button"
                            bind:this={outputButtonEl}
                            class="rounded p-1 text-surface-500 transition-colors hover:text-white"
                            onclick={() => void toggleOutputMenu()}
                            aria-haspopup="menu"
                            aria-expanded={showOutputMenu}
                            aria-label={m.music_output_device_aria()}>
                            <!-- Devices icon (screen), not SpeakerWave — the
                                 mute toggle beside it already uses the speaker. -->
                            <Icon src={ComputerDesktop} class="h-5 w-5" />
                        </button>
                    </Tooltip>

                    {#if showOutputMenu}
                        <div
                            class="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-surface-600/40 bg-surface-900/95 p-1 shadow-lg backdrop-blur"
                            style="z-index: {Z.CTX_MENU};"
                            role="menu"
                            tabindex="-1"
                            use:clickOutside={closeOutputMenu}
                            onkeydown={handleOutputMenuKeydown}>
                            <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={$musicPlayerStore.audioOutputDeviceId === null}
                                class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-surface-200 hover:bg-surface-700/60"
                                onclick={() => void selectOutputDevice('default')}>
                                <span class="truncate">System default</span>
                                {#if $musicPlayerStore.audioOutputDeviceId === null}
                                    <span class="shrink-0 text-primary-400">✓</span>
                                {/if}
                            </button>
                            {#each outputDevices as device, i (device.deviceId)}
                                <button
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={$musicPlayerStore.audioOutputDeviceId ===
                                        device.deviceId}
                                    class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-surface-200 hover:bg-surface-700/60"
                                    onclick={() => void selectOutputDevice(device.deviceId)}>
                                    <span class="truncate"
                                        >{device.label || `Output device ${i + 1}`}</span>
                                    {#if $musicPlayerStore.audioOutputDeviceId === device.deviceId}
                                        <span class="shrink-0 text-primary-400">✓</span>
                                    {/if}
                                </button>
                            {/each}
                            {#if outputSelectFailed}
                                <p class="px-2 py-1 text-[11px] text-red-400">Failed</p>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- Time display (compact on mobile) — hidden for live radio. -->
            {#if !$musicPlayerStore.currentTrack?.isRadio}
                <button
                    type="button"
                    class="hidden tabular-nums text-sm text-surface-400 transition-colors hover:text-surface-200 sm:block"
                    onclick={toggleTimeRemaining}
                    aria-label={m.music_toggle_time_display_aria()}>
                    {formatTime($musicPlayerStore.currentTimeMs)} / {showTimeRemaining
                        ? formatRemainingTime(
                              $musicPlayerStore.currentTimeMs,
                              $musicPlayerStore.durationMs,
                          )
                        : formatTime($musicPlayerStore.durationMs)}
                </button>
            {/if}

            <!-- Live BPM normalization badge (visible while playbackRate drifts back to 1.0) -->
            {#if $musicPlayerStore.normalizingTargetBpm !== null && $musicPlayerStore.effectiveBpm}
                <div
                    class="bpm-normalize-badge hidden items-center gap-1 rounded-full bg-surface-700/60 px-2 py-0.5 sm:flex">
                    <span class="live-bpm-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"
                    ></span>
                    <span class="tabular-nums text-[10px] text-emerald-400/80">
                        {$musicPlayerStore.effectiveBpm}
                    </span>
                    <span class="text-[10px] text-surface-500">
                        → {$musicPlayerStore.normalizingTargetBpm}
                    </span>
                </div>
            {/if}

            <!-- Playback controls — Prev/Next hidden for live radio
                 (no queue concept). -->
            <div class="flex items-center gap-1">
                {#if !$musicPlayerStore.currentTrack?.isRadio}
                    <Tooltip text="Previous" position="top" fixed>
                        <button
                            type="button"
                            class="hidden p-2 text-surface-300 transition-colors hover:text-white md:block"
                            onclick={() => musicPlayerStore.previous()}
                            aria-label={m.music_previous_track_aria()}>
                            <Icon src={Backward} class="h-6 w-6" />
                        </button>
                    </Tooltip>
                {/if}

                <Tooltip text={audibleAnywhere ? 'Pause' : 'Play'} position="top" fixed>
                    <button
                        type="button"
                        class="p-2 text-white transition-colors hover:text-primary-400"
                        onclick={() =>
                            audibleAnywhere ? musicPlayerStore.pause() : musicPlayerStore.resume()}
                        aria-label={audibleAnywhere ? 'Pause' : 'Play'}>
                        {#if $musicPlayerStore.isLoadingTrack && !$musicPlayerStore.isPlaying}
                            <!-- Show a spinner while the track is buffering/loading -->
                            <div
                                class="h-7 w-7 animate-spin rounded-full border-2 border-surface-500 border-t-white">
                            </div>
                        {:else}
                            <Icon src={audibleAnywhere ? Pause : Play} class="h-7 w-7" />
                        {/if}
                    </button>
                </Tooltip>

                {#if !$musicPlayerStore.currentTrack?.isRadio}
                    {#if $crossfadeEffective}
                        <Tooltip text={m.music_skip_hold_tooltip()} position="top" fixed>
                            <div class="relative">
                                <button
                                    type="button"
                                    class="relative touch-none select-none p-2 text-surface-300 transition-colors hover:text-white"
                                    onpointerdown={skipHold.handlePointerDown}
                                    onpointerup={skipHold.handlePointerUp}
                                    onpointerleave={skipHold.handlePointerCancel}
                                    onpointercancel={skipHold.handlePointerCancel}
                                    onclick={skipHold.handleClick}
                                    oncontextmenu={skipHold.handleContextMenu}
                                    aria-label={m.music_skip_track_hold_aria()}>
                                    <Icon
                                        src={Forward}
                                        class="h-6 w-6 {mixArmed
                                            ? 'animate-pulse text-primary-400'
                                            : ''}" />
                                    {#if skipHoldActive}
                                        <svg
                                            class="pointer-events-none absolute inset-0 h-full w-full -rotate-90 text-primary-400"
                                            viewBox="0 0 40 40"
                                            aria-hidden="true"
                                            style="--mix-hold-ms: {SKIP_HOLD_MS}ms">
                                            <circle
                                                cx="20"
                                                cy="20"
                                                r="18"
                                                fill="none"
                                                stroke="currentColor"
                                                stroke-width="2.5"
                                                stroke-linecap="round"
                                                pathLength="100"
                                                class="mix-hold-ring" />
                                        </svg>
                                    {/if}
                                </button>
                                {#if mixArmed}
                                    <div
                                        role="status"
                                        class="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-surface-800/90 px-2 py-0.5 text-[10px] font-medium text-primary-300">
                                        {m.music_mixing_on_beat()}
                                    </div>
                                {/if}
                            </div>
                        </Tooltip>
                    {:else}
                        <!-- No crossfade support on this platform (e.g. iOS): plain
                             tap-to-skip only — no hold-to-mix affordance, since a
                             held mix would promise a blend the backend can't do and
                             just cut instead. -->
                        <Tooltip text="Skip" position="top" fixed>
                            <button
                                type="button"
                                class="p-2 text-surface-300 transition-colors hover:text-white"
                                onclick={() => void musicPlayerStore.skip()}
                                aria-label={m.music_skip_track_aria()}>
                                <Icon src={Forward} class="h-6 w-6" />
                            </button>
                        </Tooltip>
                    {/if}
                {/if}
            </div>

            <!-- Volume: hidden on iOS (hardware-only), mute toggle on mobile, full slider on desktop -->
            {#if $musicPlayerStore.supportsVolumeControl}
                <Tooltip text={$musicPlayerStore.isMuted ? 'Unmute' : 'Mute'} position="top" fixed>
                    <!-- Mobile mute: padded to ≥44px touch target -->
                    <button
                        type="button"
                        class="p-3 text-surface-300 hover:text-white md:hidden"
                        onclick={() => musicPlayerStore.toggleMute()}
                        aria-label={$musicPlayerStore.isMuted ? 'Unmute' : 'Mute'}>
                        <Icon
                            src={$musicPlayerStore.isMuted ? SpeakerXMark : SpeakerWave}
                            class="h-5 w-5" />
                    </button>
                </Tooltip>
                <div class="hidden items-center gap-1 md:flex" use:volumeWheel>
                    <Tooltip
                        text={$musicPlayerStore.isMuted ? 'Unmute' : 'Mute'}
                        position="top"
                        fixed>
                        <button
                            type="button"
                            class="p-1 text-surface-300 hover:text-white"
                            onclick={() => musicPlayerStore.toggleMute()}
                            aria-label={$musicPlayerStore.isMuted ? 'Unmute' : 'Mute'}>
                            <Icon
                                src={$musicPlayerStore.isMuted ? SpeakerXMark : SpeakerWave}
                                class="h-5 w-5" />
                        </button>
                    </Tooltip>
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
                        class="h-1 w-20 accent-primary-500"
                        aria-label={m.music_volume_aria()} />
                </div>
            {:else}
                <span class="hidden text-xs text-surface-400 md:inline">Device volume</span>
            {/if}

            <!-- Expand / collapse queue panel (desktop only — mobile uses full-screen player).
                 Wrapped so hovering/focusing the button also peeks the Up Next
                 popover (desktop-only; gated by upNextPopoverEligible). -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="relative hidden md:block"
                onmouseenter={scheduleUpNextPopover}
                onmouseleave={hideUpNextPopover}
                onfocusin={scheduleUpNextPopover}
                onfocusout={hideUpNextPopover}>
                <Tooltip
                    text={$musicPlayerStore.isExpanded ? 'Close queue' : 'Open queue'}
                    position="top"
                    fixed>
                    <button
                        type="button"
                        class="p-2 text-surface-300 transition-colors hover:text-white"
                        onclick={() => musicPlayerStore.toggleExpanded()}
                        aria-label={$musicPlayerStore.isExpanded ? 'Close queue' : 'Open queue'}>
                        <Icon
                            src={$musicPlayerStore.isExpanded ? ChevronDown : ChevronUp}
                            class="h-6 w-6" />
                    </button>
                </Tooltip>

                {#if showUpNextPopover && upNextPopoverEligible}
                    <div
                        class="pointer-events-none absolute bottom-full right-0 mb-2 w-64 rounded-md border border-surface-500/40 bg-surface-900/95 p-2 shadow-lg backdrop-blur"
                        style="z-index: {Z.TOOLTIP};"
                        aria-hidden="true">
                        {#if upNextPopoverItems.length > 0}
                            <ul class="space-y-1.5">
                                {#each upNextPopoverItems as item (item.id)}
                                    <li class="flex items-center gap-2">
                                        {#if trackPosterThumb(item.track)}
                                            <img
                                                src={trackPosterThumb(item.track)}
                                                alt=""
                                                class="h-8 w-8 shrink-0 rounded object-cover" />
                                        {:else}
                                            <div
                                                class="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-surface-700">
                                                <Icon
                                                    src={SpeakerWave}
                                                    class="h-3.5 w-3.5 text-surface-400" />
                                            </div>
                                        {/if}
                                        <div class="min-w-0">
                                            <p class="truncate text-xs font-medium text-white">
                                                {item.track.title}
                                            </p>
                                            <p class="truncate text-[11px] text-surface-400">
                                                {item.track.artists.map((a) => a.title).join(', ')}
                                            </p>
                                        </div>
                                    </li>
                                {/each}
                            </ul>
                            {#if upNextPopoverExtraCount > 0}
                                <p class="mt-1.5 text-[11px] text-surface-500">
                                    +{upNextPopoverExtraCount} more
                                </p>
                            {/if}
                        {:else}
                            <p class="text-xs text-surface-300">{m.music_autoplay_label()}</p>
                        {/if}
                    </div>
                {/if}
            </div>

            <!-- Close (stop playback) -->
            <Tooltip text="Close" position="top" fixed>
                <button
                    type="button"
                    class="shrink-0 p-1.5 text-surface-400 transition-colors hover:text-red-400 md:p-2"
                    onclick={() => musicPlayerStore.stop(true)}
                    aria-label={m.music_close_player_aria()}>
                    <Icon src={XMark} class="h-5 w-5" />
                </button>
            </Tooltip>
        </div>
    </div>

    <!-- Queue / lyrics panel slides up from mini-player -->
    {#if $musicPlayerStore.isExpanded}
        <QueuePanel
            upNextVisible={showUpNextPreview}
            debugOverlay={$musicPlayerStore.crossfadeDebug &&
                !showUpNextPreview &&
                !!$musicPlayerStore.currentTrack?.audioFeatures}
            {overMusicModal} />
    {/if}
{/if}

{#if upNextMenuPos}
    <ContextMenu
        x={upNextMenuPos.x}
        y={upNextMenuPos.y}
        items={upNextMenuItems}
        title={upNextStripTrack?.title}
        subtitle={upNextStripTrack?.artists.map((a) => a.title).join(', ')}
        onClose={() => (upNextMenuPos = null)} />
{/if}

{#if posterMenuPos}
    <ContextMenu
        x={posterMenuPos.x}
        y={posterMenuPos.y}
        title={$musicPlayerStore.currentTrack?.title}
        subtitle={$musicPlayerStore.currentTrack?.artists.map((a) => a.title).join(', ')}
        items={posterMenuItems}
        onClose={() => (posterMenuPos = null)} />
{/if}

<style>
    /* Hold-to-mix progress ring on the skip button. pathLength="100" on the
       circle makes the dash math unit-free; the animation duration is driven
       by --mix-hold-ms so it can never drift from SKIP_HOLD_MS. */
    .mix-hold-ring {
        stroke-dasharray: 100;
        stroke-dashoffset: 100;
        animation: mix-hold-fill var(--mix-hold-ms, 600ms) linear forwards;
    }
    @keyframes mix-hold-fill {
        to {
            stroke-dashoffset: 0;
        }
    }

    /* Lift mini-player above the modal layer when a music-kind modal is open,
       at all widths. ModalContainer positioners use z-index: 1001 + stack_index
       (backdrop 1000+idx); 1050 = Z.MUSIC_OVER_MODAL, safely above that stack.
       This is safe on mobile too: ModalContainer reserves --miniplayer-modal-inset
       at the bottom of its positioner, so the modal/drawer never overlaps the
       mini-player bar (only the transient up-next strip slides over it) — lifting it just keeps it visible and un-blurred above
       the backdrop instead of dimmed behind it. */
    .mini-player.over-music-modal {
        z-index: 1050;
    }

    @media (max-width: 767px) {
        .miniplayer-swipe-zone {
            touch-action: none;
            overscroll-behavior: contain;
        }
    }

    /* Diagonal stripe pattern in crossfade zone */
    .crossfade-zone-stripes {
        background: repeating-linear-gradient(
            -45deg,
            transparent,
            transparent 3px,
            rgba(217, 119, 6, 0.1) 3px,
            rgba(217, 119, 6, 0.1) 5px
        );
    }

    /* Outro marker pulsing glow */
    .marker-pulse {
        animation: marker-glow 2s ease-in-out infinite;
    }

    @keyframes marker-glow {
        0%,
        100% {
            opacity: 0.6;
        }
        50% {
            opacity: 1;
            box-shadow: 0 0 6px rgba(245, 158, 11, 0.5);
        }
    }

    /* "Blending" text pulse */
    .crossfade-pulse-text {
        animation: text-pulse 1.5s ease-in-out infinite;
    }

    @keyframes text-pulse {
        0%,
        100% {
            opacity: 0.7;
        }
        50% {
            opacity: 1;
        }
    }

    /* Ambient glow on mini-player during active crossfade. The transition
       sits on the base class so the glow also fades OUT when the fade ends. */
    .mini-player {
        transition: box-shadow 0.5s ease;
    }

    .mini-player-crossfading {
        box-shadow:
            0 -4px 20px rgba(245, 158, 11, 0.15),
            0 -1px 8px rgba(245, 158, 11, 0.1);
    }

    /* Live BPM indicator dot — steady pulse */
    .live-bpm-dot {
        animation: bpm-dot-pulse 1s ease-in-out infinite;
        box-shadow: 0 0 4px rgba(52, 211, 153, 0.5);
    }

    @keyframes bpm-dot-pulse {
        0%,
        100% {
            opacity: 0.6;
        }
        50% {
            opacity: 1;
            box-shadow: 0 0 6px rgba(52, 211, 153, 0.8);
        }
    }

    /* BPM normalization badge — slides in */
    .bpm-normalize-badge {
        animation: badge-fade-in 0.3s ease-out;
    }

    @keyframes badge-fade-in {
        from {
            opacity: 0;
            transform: scale(0.9);
        }
        to {
            opacity: 1;
            transform: scale(1);
        }
    }

    .debug-overlay {
        /* z-index is set inline (Z.TOOLTIP) so it escapes the mini-player's
           own stacking context — see the template comment above. */
        animation: debug-slide-down 0.2s ease-out;
    }

    @keyframes debug-slide-down {
        from {
            opacity: 0;
            transform: translateY(-4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    /* ── prefers-reduced-motion ─────────────────────────────────────────────
       Disable all continuous and entrance animations for users who have
       requested reduced motion via OS/browser accessibility settings.
       Album art and metadata cross-fades are driven by inline opacity bound
       to crossfadeProgress, so they respect this setting automatically.    */
    @media (prefers-reduced-motion: reduce) {
        .marker-pulse,
        .crossfade-pulse-text,
        .live-bpm-dot,
        .bpm-normalize-badge,
        .debug-overlay {
            animation: none;
        }

        /* Remove motion-dependent box-shadow transition */
        .mini-player {
            transition: none;
        }
    }
</style>
