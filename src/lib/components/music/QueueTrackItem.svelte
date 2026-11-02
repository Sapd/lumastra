<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { MusicTrack } from '$lib/schemas/music';
    import TrackArtistLine from './TrackArtistLine.svelte';
    import TrackTitleLine from './TrackTitleLine.svelte';
    import {
        Icon,
        Sparkles,
        Bars3,
        PlayCircle,
        ChevronDoubleRight,
        UserCircle,
        MusicalNote,
        XMark,
        WrenchScrewdriver,
        EllipsisVertical,
        ArrowRight,
        Beaker,
        NoSymbol,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { dragHandle } from 'svelte-dnd-action';
    import {
        openAlbumModal,
        openArtistModal,
        openSimilarTracksModal,
    } from '$lib/utils/modal-utils';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { addTrackToPlaylistEntry } from '$lib/components/playlist/add-to-playlist-menu';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
    import * as m from '$lib/paraglide/messages';
    import { moodToColor, energyToColor } from '$lib/utils/mood-palette';
    import TrackVote from '$lib/components/music/TrackVote.svelte';
    import { openSwipeRow } from '$lib/stores/swipe-row.svelte';
    import {
        REVEAL_WIDTH,
        AXIS_LOCK_THRESHOLD,
        getSwipeRowStage,
        getSwipeRowRelease,
        isCancelledByVerticalDrag,
        getRowTranslate,
        getArmProgress,
        clampDragDistance,
    } from '$lib/utils/swipe-row-actions';

    interface Props {
        track: MusicTrack;
        /** The next track in the queue — used to compute the transition cue. */
        nextTrack?: MusicTrack;
        source?: 'smart' | 'user';
        showDragHandle?: boolean;
        showDismiss?: boolean;
        isAdmin?: boolean;
        /** Whether sonic-similarity features are enabled (FEATURE_MUSIC_SONIC). */
        sonicEnabled?: boolean;
        /** Whether Music Alchemy is enabled (FEATURE_MUSIC_ALCHEMY). */
        alchemyEnabled?: boolean;
        onclick?: () => void;
        ondismiss?: () => void;
        onremove?: () => void;
    }

    let {
        track,
        nextTrack,
        source = 'user',
        showDragHandle = false,
        showDismiss = false,
        isAdmin = false,
        sonicEnabled = false,
        alchemyEnabled = false,
        onclick,
        ondismiss,
        onremove,
    }: Props = $props();

    // ── Mood / energy color dot ───────────────────────────────────────────
    /**
     * The color dot shown on the right side of the queue row.
     * Priority: first mood tag > energy gradient > fallback.
     * Returns null if no acoustic data is present (dot hidden).
     */
    const moodDotColor = $derived.by((): string | null => {
        const af = track.audioFeatures;
        if (!af) return null;
        const tags = af.moodTags;
        if (tags && tags.length > 0) return moodToColor(tags[0]);
        if (af.energy !== undefined) return energyToColor(af.energy);
        return null;
    });

    /**
     * BPM transition cue between this track and the next.
     * Shows "120→140" style when consecutive tracks have BPM data.
     * The color indicates BPM compatibility (green = close, yellow = stretch, red = jump).
     */
    const transitionCue = $derived.by((): { label: string; color: string } | null => {
        if (!$musicPlayerStore.showBpm) return null;
        const outBpm = track.audioFeatures?.bpm;
        const inBpm = nextTrack?.audioFeatures?.bpm;
        if (!outBpm || !inBpm) return null;
        const ratio = Math.max(outBpm, inBpm) / Math.min(outBpm, inBpm);
        let color: string;
        if (ratio <= 1.06) {
            color = '#4ade80'; // green-400 — tight match
        } else if (ratio <= 1.15) {
            color = '#fbbf24'; // amber-400 — moderate stretch
        } else {
            color = '#f87171'; // red-400 — large gap
        }
        return {
            label: `${Math.round(outBpm)}→${Math.round(inBpm)}`,
            color,
        };
    });

    /** Mood dot tooltip text for accessibility */
    const moodDotTitle = $derived.by((): string => {
        const af = track.audioFeatures;
        if (!af) return '';
        const parts: string[] = [];
        if (af.moodTags && af.moodTags.length > 0) parts.push(af.moodTags.join(', '));
        if (af.energy !== undefined) parts.push(`energy ${Math.round(af.energy * 100)}%`);
        if ($musicPlayerStore.showBpm && af.bpm !== undefined) {
            parts.push(`${Math.round(af.bpm)} BPM`);
        }
        return parts.join(' · ');
    });

    let menuPos = $state<{ x: number; y: number } | null>(null);
    let moreButtonRef = $state<HTMLButtonElement | null>(null);

    // ── Swipe-to-reveal actions (mobile) ────────────────────────────────────
    // Swipe the row left to reveal like/dislike + remove; keep swiping past
    // the fully-open tray and the remove button grows to signal "release to
    // delete" — releasing past that point removes the track immediately.
    let swipeStartX = $state(0);
    let swipeStartY = $state(0);
    let dragDistance = $state(0);
    let dragging = $state(false);
    let axisLocked = $state<'x' | 'y' | null>(null);
    let ignoreGesture = $state(false);

    const isOpen = $derived(openSwipeRow.isOpen(track.id));
    const currentDistance = $derived(
        dragging ? clampDragDistance(dragDistance) : isOpen ? REVEAL_WIDTH : 0,
    );
    const swipeStage = $derived(getSwipeRowStage(currentDistance));
    const rowTranslate = $derived(getRowTranslate(currentDistance));
    const armProgress = $derived(getArmProgress(currentDistance));

    function handleSwipeTouchStart(e: TouchEvent): void {
        if (e.touches.length > 1) return;
        // Nested controls (drag handle, dismiss, 3-dot menu) own their own
        // taps — don't let incidental finger jitter during a tap get
        // mistaken for the start of a swipe and preventDefault() the click.
        const interactive = (e.target as HTMLElement).closest('button, [role="button"]');
        if (interactive && interactive !== e.currentTarget) {
            ignoreGesture = true;
            return;
        }
        ignoreGesture = false;
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        axisLocked = null;
        // Start from the pinned-open position so continuing to drag a
        // already-open row keeps tracking the finger.
        dragDistance = isOpen ? REVEAL_WIDTH : 0;
    }

    function handleSwipeTouchMove(e: TouchEvent): void {
        if (ignoreGesture) return;
        if (e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - swipeStartX;
        const dy = e.touches[0].clientY - swipeStartY;

        if (axisLocked === null) {
            if (Math.abs(dx) < AXIS_LOCK_THRESHOLD && Math.abs(dy) < AXIS_LOCK_THRESHOLD) return;
            axisLocked = isCancelledByVerticalDrag(dx, dy) ? 'y' : 'x';
            if (axisLocked === 'x') dragging = true;
        }
        if (axisLocked !== 'x') return;

        if (e.cancelable) e.preventDefault();
        const base = isOpen ? REVEAL_WIDTH : 0;
        dragDistance = base - dx;
    }

    function handleSwipeTouchEnd(): void {
        if (ignoreGesture) {
            ignoreGesture = false;
            return;
        }
        if (!dragging) return;
        const distance = currentDistance;
        dragging = false;
        axisLocked = null;
        const release = getSwipeRowRelease(distance);
        if (release === 'delete') {
            openSwipeRow.close(track.id);
            onremove?.();
        } else if (release === 'open') {
            openSwipeRow.open(track.id);
        } else {
            openSwipeRow.close(track.id);
        }
        dragDistance = 0;
    }

    function handleSwipeTouchCancel(): void {
        ignoreGesture = false;
        dragging = false;
        axisLocked = null;
        dragDistance = 0;
    }

    /** Tapping an open row closes it instead of triggering playback. */
    function handleRowClick(): void {
        if (isOpen) {
            openSwipeRow.close(track.id);
            return;
        }
        onclick?.();
    }

    function handleSwipeRemove(e: MouseEvent): void {
        e.stopPropagation();
        openSwipeRow.close(track.id);
        onremove?.();
    }

    function goToMusicPath(path: string): void {
        void import('$app/navigation').then(({ goto }) => goto(resolve(path)));
    }

    let menuItems: ContextMenuEntry[] = $derived.by((): ContextMenuEntry[] => {
        const out: ContextMenuEntry[] = [];
        out.push({
            label: m.music_queue_play_now(),
            icon: PlayCircle,
            onSelect: () => onclick?.(),
        });
        out.push({
            label: m.music_queue_play_next(),
            icon: ChevronDoubleRight,
            onSelect: () => {
                // addToQueueFront already removes the track from its current
                // position in the queue before re-inserting it at the front —
                // calling onremove() here would delete the freshly inserted entry.
                musicPlayerStore.addToQueueFront(track);
            },
        });
        if (onremove) {
            out.push({
                label: m.music_queue_remove(),
                icon: XMark,
                destructive: true,
                onSelect: () => onremove?.(),
            });
        }
        if (track.artists[0]?.id) {
            out.push({
                label: m.music_go_to_artist(),
                icon: UserCircle,
                onSelect: () => openArtistModal(track.artists[0]?.id ?? ''),
            });
        }
        if (track.album?.id) {
            out.push({
                label: m.music_go_to_album(),
                icon: MusicalNote,
                onSelect: () => openAlbumModal(track.album?.id ?? ''),
            });
        }
        if (sonicEnabled) {
            out.push({
                label: m.card_music_more_like_this(),
                icon: Sparkles,
                onSelect: () => openSimilarTracksModal(track.id, true),
            });
            out.push({
                label: m.card_music_song_paths(),
                icon: ArrowRight,
                onSelect: () => goToMusicPath('/music/path'),
            });
        }
        if (alchemyEnabled) {
            out.push({
                label: m.music_alchemy_context_add_seed(),
                icon: Beaker,
                onSelect: () => musicAlchemyStore.addSeed(track),
            });
            out.push({
                label: m.music_alchemy_context_add_avoid(),
                icon: NoSymbol,
                onSelect: () => musicAlchemyStore.addAvoid(track),
            });
            out.push({
                label: m.card_music_open_mixing_desk(),
                icon: Beaker,
                onSelect: () => goToMusicPath('/music/alchemy'),
            });
        }
        out.push(addTrackToPlaylistEntry(track));
        if (isAdmin) {
            out.push({
                label: m.music_manage_in_admin(),
                icon: WrenchScrewdriver,
                hideOnMobile: true,
                onSelect: () => {
                    if (typeof window === 'undefined') return;
                    window.open(
                        `/admin/library/media/${encodeURIComponent(track.id)}`,
                        '_blank',
                        'noopener,noreferrer',
                    );
                },
            });
        }
        return out;
    });

    function handleContextMenu(e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        menuPos = { x: e.clientX, y: e.clientY };
    }

    /** Opens the context menu anchored to the 3-dot button (for touch/mobile). */
    function openMenuFromButton(e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const btn = moreButtonRef;
        if (btn) {
            const rect = btn.getBoundingClientRect();
            menuPos = { x: rect.right, y: rect.bottom };
        } else {
            menuPos = { x: e.clientX, y: e.clientY };
        }
    }
</script>

<div class="relative overflow-hidden rounded-lg">
    <!-- Swipe-revealed actions (mobile): like/dislike + remove, tucked behind
         the row and exposed as it slides left. Hidden from a11y tree until
         revealed since the row's own keyboard/context-menu path covers the
         same actions. Also visually hidden while closed: the row above only
         covers it while fully opaque — without `invisible` the panel bleeds
         through it. -->
    <div
        class="absolute inset-y-0 right-0 flex items-stretch"
        class:invisible={swipeStage === 'closed'}
        style="width: {REVEAL_WIDTH}px;"
        aria-hidden={swipeStage === 'closed'}
        inert={swipeStage === 'closed'}>
        <div class="flex flex-1 items-center justify-center gap-1 bg-surface-800">
            <TrackVote trackId={track.id} size="md" />
        </div>
        <button
            type="button"
            class="flex w-11 shrink-0 items-center justify-center bg-red-500/90 text-white transition-transform"
            style="transform: scale({1 + armProgress * 0.7});"
            onclick={handleSwipeRemove}
            aria-label={m.music_queue_remove()}>
            <Icon src={XMark} class="h-5 w-5" />
        </button>
    </div>

    <div
        class="group relative flex min-h-[44px] w-full items-center gap-2 rounded-lg bg-surface-900 px-2 py-1 text-left transition-colors hover:bg-surface-800"
        style="transform: translateX(-{rowTranslate}px); transition: {dragging
            ? 'none'
            : 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)'};"
        role="button"
        tabindex="0"
        onclick={handleRowClick}
        oncontextmenu={handleContextMenu}
        ontouchstart={handleSwipeTouchStart}
        ontouchmove={handleSwipeTouchMove}
        ontouchend={handleSwipeTouchEnd}
        ontouchcancel={handleSwipeTouchCancel}
        onkeydown={(e) => {
            // Nested artist-link buttons (TrackArtistLine/TrackTitleLine) handle their
            // own activation; preventDefault here would cancel their native click synthesis.
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onclick?.();
            }
        }}>
        {#if showDragHandle}
            <div
                use:dragHandle
                class="shrink-0 cursor-grab text-surface-600 active:cursor-grabbing"
                aria-label={m.music_drag_to_reorder_aria()}
                tabindex="0"
                role="button">
                <Icon src={Bars3} class="h-4 w-4" />
            </div>
        {/if}

        {#if track.images?.primary?.variants?.thumb}
            <img
                src={track.images.primary?.variants?.thumb}
                alt={track.title}
                class="h-10 w-10 shrink-0 rounded" />
        {:else}
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-700">
                <span class="text-lg text-surface-500">♪</span>
            </div>
        {/if}

        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
                {#if source === 'smart'}
                    <Icon src={Sparkles} class="h-3 w-3 shrink-0 text-primary-400" />
                {/if}
                <p class="truncate text-sm text-surface-200">
                    <span class="hidden md:inline"
                        ><TrackTitleLine
                            title={track.title}
                            artists={track.artists}
                            remixerArtists={track.remixerArtists} /></span
                    ><span class="md:hidden">{track.title}</span>
                </p>
            </div>
            <p class="truncate text-xs text-surface-400">
                <!-- Desktop links, plain text on mobile: the whole row is tappable
                     there, so nested artist buttons would fight the row tap. -->
                <span class="hidden md:inline"
                    ><TrackArtistLine
                        artist={track.artists.map((a) => a.title).join(', ') ?? ''}
                        artists={track.artists}
                        artistId={track.artists[0]?.id ?? undefined} /></span
                ><span class="md:hidden">{track.artists.map((a) => a.title).join(', ')}</span
                >{#if track.album?.title}<span class="text-surface-500">
                        &nbsp;·&nbsp;</span
                    >{#if track.album?.id}<button
                            class="hidden hover:text-primary-400 hover:underline md:inline"
                            onclick={(e) => {
                                e.stopPropagation();
                                openAlbumModal(track.album?.id ?? '');
                            }}>{track.album?.title}</button
                        ><span class="md:hidden">{track.album?.title}</span>{:else}{track.album
                            ?.title}{/if}{/if}
            </p>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
            <!-- Mood/energy color dot — shows when acoustic data is available -->
            {#if moodDotColor !== null}
                <Tooltip text={moodDotTitle || 'Acoustic data'} position="left">
                    <span
                        class="inline-block h-2 w-2 shrink-0 rounded-full"
                        style="background-color: {moodDotColor};"
                        aria-hidden="true">
                    </span>
                </Tooltip>
            {:else if $musicPlayerStore.showBpm && track.audioFeatures?.bpm}
                <!-- Fallback: just show BPM when no mood/energy color -->
                <span class="tabular-nums text-xs text-surface-500 max-md:hidden">
                    {Math.round(track.audioFeatures.bpm)}
                </span>
            {/if}

            {#if showDismiss}
                <Tooltip text="Dismiss" position="left">
                    <button
                        class="rounded p-1 text-surface-500 hover:bg-surface-700 hover:text-white"
                        onclick={(e) => {
                            e.stopPropagation();
                            ondismiss?.();
                        }}
                        aria-label={m.music_dismiss_suggestion_aria()}>
                        <span class="text-sm">✕</span>
                    </button>
                </Tooltip>
            {/if}

            <!-- Like/dislike vote buttons — desktop only (mobile uses 3-dot menu).
             Hidden by default, revealed on row hover via the parent group class. -->
            <div class="hidden opacity-0 transition-opacity group-hover:opacity-100 md:flex">
                <TrackVote trackId={track.id} size="sm" />
            </div>

            <!-- 3-dot menu: visible on touch/mobile; on desktop the context menu
             is reachable via right-click so the button is hidden to reduce clutter. -->
            <button
                bind:this={moreButtonRef}
                type="button"
                class="min-h-[44px] min-w-[44px] rounded p-2 text-surface-500 hover:bg-surface-700 hover:text-white md:hidden"
                onclick={openMenuFromButton}
                aria-label={m.music_more_options_title()}
                aria-haspopup="true">
                <Icon src={EllipsisVertical} class="h-4 w-4" />
            </button>
        </div>
    </div>
</div>

<!-- Transition cue: small connector between consecutive queue rows showing BPM bridge -->
{#if transitionCue !== null}
    <div class="flex items-center gap-1.5 px-[3.25rem] py-0.5" aria-hidden="true">
        <div class="h-px flex-1 bg-surface-700/60"></div>
        <span
            class="font-mono text-[9px] tabular-nums leading-none"
            style="color: {transitionCue.color};">
            {transitionCue.label}
        </span>
        <div class="h-px flex-1 bg-surface-700/60"></div>
    </div>
{/if}

{#if menuPos}
    <ContextMenu
        x={menuPos.x}
        y={menuPos.y}
        title={track.title}
        subtitle={track.artists.map((a) => a.title).join(', ')}
        items={menuItems}
        onClose={() => (menuPos = null)} />
{/if}
