<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { musicGenreIcon } from '$lib/utils/music-genre-icon';
    import { Z } from '$lib/utils/z-index';
    import { musicPlayerStore, currentRadioNowPlaying } from '$lib/stores/music-player.store';
    import type { AutoplaySeed } from '$lib/schemas/autoplay-seed';
    import { MusicTrackSchema, type MusicTrack, type QueueItem } from '$lib/schemas/music';
    import QueueTrackItem from './QueueTrackItem.svelte';
    import TrackArtistLine from './TrackArtistLine.svelte';
    import TrackTitleLine from './TrackTitleLine.svelte';
    import QueueHistorySection from './QueueHistorySection.svelte';
    import QueueSelectionBanner from './QueueSelectionBanner.svelte';
    import QueueAddTab from './QueueAddTab.svelte';
    import LyricsPanel from './LyricsPanel.svelte';
    import CrossfadeSettings from './CrossfadeSettings.svelte';
    import { openAlbumModal, openArtistModal } from '$lib/utils/modal-utils';
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { Icon, Signal, Sparkles } from 'svelte-hero-icons';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import { buildMusicTrackMenu } from './music-track-menu';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Whether the MiniPlayer's up-next preview strip is visible */
        upNextVisible?: boolean;
        /** Whether the debug overlay is active (adds extra bottom offset) */
        debugOverlay?: boolean;
        /** Whether a music-kind modal is open (lift panel above modal layer) */
        overMusicModal?: boolean;
    }

    let { upNextVisible = false, debugOverlay = false, overMusicModal = false }: Props = $props();

    const flipDurationMs = 150;
    const DND_TYPE = 'music-queue-item';

    let localQueue = $state<QueueItem[]>([]);
    let isDragging = $state(false);
    let isExternalDragOver = $state(false);
    // Remember which panel the user was on before opening lyrics, so that
    // clicking the Lyrics tab again returns them to that panel (instead of
    // always snapping back to 'queue', which loses context for Settings/Add
    // users).
    let previousPanel = $state<'queue' | 'settings' | 'add'>('queue');

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

    // ── "Now Playing" context menu ───────────────────────────────────────
    // The Up Next rows get theirs from QueueTrackItem; the now-playing row is
    // hand-rolled markup, so it needs its own.
    let nowPlayingMenuPos = $state<{ x: number; y: number } | null>(null);

    let nowPlayingMenuItems: ContextMenuEntry[] = $derived(
        buildMusicTrackMenu($musicPlayerStore.currentTrack, {
            sonicEnabled,
            alchemyEnabled,
            isAdmin,
            navigate: goToMusicPath,
        }),
    );

    function goToMusicPath(path: string): void {
        void import('$app/navigation').then(({ goto }) => goto(resolve(path)));
    }

    function handleNowPlayingContextMenu(e: MouseEvent): void {
        if (nowPlayingMenuItems.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        nowPlayingMenuPos = { x: e.clientX, y: e.clientY };
    }

    // Sync queue from store when not dragging
    $effect(() => {
        if (!isDragging) {
            localQueue = [...$musicPlayerStore.queue];
        }
    });

    // Queue zone handlers
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
        // Merge: append any store items that arrived mid-drag (e.g. smart-queue
        // fetchNextTrack) that are not already in the reordered set.  This
        // preserves the user's drag order while keeping items the store appended
        // while !isDragging was blocked.
        const localIds = new Set(cleaned.map((i) => i.id));
        const storeQueue = $musicPlayerStore.queue;
        const newItems = storeQueue.filter((i) => !localIds.has(i.id));
        const merged = [...cleaned, ...newItems];
        localQueue = merged;
        musicPlayerStore.reorderQueue(merged);
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
</script>

<div
    class="queue-panel fixed right-0 max-h-[65vh] overflow-hidden border-t border-l border-surface-500/20 bg-surface-900/95 backdrop-blur-lg transition-[bottom] duration-300 ease-out"
    class:over-music-modal={overMusicModal}
    style="bottom: calc({(upNextVisible ? 10 : 6.5) + (debugOverlay ? 2 : 0)}rem + {overMusicModal
        ? '0px'
        : 'var(--music-bottom-nav-h, 0px)'}); z-index: {overMusicModal
        ? Z.MUSIC_OVER_MODAL
        : Z.MUSIC_QUEUE};">
    {#if $musicPlayerStore.currentTrack?.isRadio}
        <!-- ═══ RADIO VIEW — live stream, no queue/lyrics/settings ═══ -->
        <!-- pb-6: extra bottom padding so the last metadata line doesn't
             sit flush against the MiniPlayer's seekbar below. -->
        <div class="max-h-[calc(65vh)] overflow-y-auto p-4 pb-6">
            <!-- Header row with LIVE pill -->
            <div class="mb-3 flex items-center justify-between">
                <h3 class="text-xs uppercase text-surface-400">
                    {m.music_now_playing_label()}
                </h3>
                <span
                    class="inline-flex items-center gap-1 rounded-full bg-red-600/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
                    <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400"> </span>
                    {m.player_live()}
                </span>
            </div>

            <!-- Station card -->
            <div class="mb-4 flex items-center gap-3">
                {#if $musicPlayerStore.currentTrack.images?.primary?.variants?.thumb}
                    <img
                        src={$musicPlayerStore.currentTrack.images.primary?.variants?.thumb}
                        alt=""
                        class="h-14 w-14 shrink-0 rounded-lg object-cover" />
                {:else}
                    <div
                        class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-700">
                        <span class="text-2xl text-surface-500">♪</span>
                    </div>
                {/if}
                <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-bold text-white">
                        {$musicPlayerStore.currentTrack.title}
                    </p>
                    {#if $musicPlayerStore.currentTrack.artists.map((a) => a.title).join(', ')}
                        <p class="truncate text-xs text-surface-400">
                            {$musicPlayerStore.currentTrack.artists.map((a) => a.title).join(', ')}
                        </p>
                    {/if}
                </div>
            </div>

            <!-- Live now-playing metadata -->
            {#if $currentRadioNowPlaying}
                {@const np = $currentRadioNowPlaying}
                {@const djShowSubtitle = [np.dj.name ? `🎤 ${np.dj.name}` : null, np.show.name]
                    .filter(Boolean)
                    .join(' · ')}
                {#if np.track.title}
                    <p class="mb-1 truncate text-sm text-primary-400">
                        ♪ {np.track.title}
                        {#if np.track.artist}
                            <span class="text-surface-500"> · </span>
                            {#if np.track.artistId}
                                <button
                                    type="button"
                                    class="hover:text-primary-300 hover:underline"
                                    onclick={() => openArtistModal(np.track.artistId ?? '')}>
                                    {np.track.artist}
                                </button>
                            {:else}
                                {np.track.artist}
                            {/if}
                        {/if}
                    </p>
                {/if}
                {#if djShowSubtitle}
                    <p class="mb-1 truncate text-xs text-surface-400">
                        {djShowSubtitle}
                    </p>
                {/if}
                {#if np.show.description}
                    <p class="mb-3 line-clamp-2 text-xs text-surface-500">
                        {np.show.description}
                    </p>
                {/if}
                {#if np.upNext.title}
                    {@const upNextLine = [np.upNext.title, np.upNext.artist]
                        .filter(Boolean)
                        .join(' · ')}
                    <div class="mt-3 border-t border-surface-700 pt-3">
                        <h3 class="mb-1 text-xs uppercase text-surface-400">
                            {m.music_queue_up_next()}
                        </h3>
                        <p class="truncate text-xs text-surface-300">
                            {upNextLine}
                        </p>
                    </div>
                {/if}
            {/if}
        </div>
    {:else}
        <!-- ═══ NORMAL MUSIC VIEW ═══ -->
        <!-- Tab navigation -->
        <!-- Tab navigation: role="tab" requires aria-selected (not aria-pressed). -->
        <div class="flex overflow-x-auto border-b border-surface-700 px-4" role="tablist">
            <button
                role="tab"
                class="min-h-[44px] shrink-0 whitespace-nowrap px-4 text-sm font-medium transition-colors {$musicPlayerStore.activePanel ===
                'queue'
                    ? 'text-primary-400'
                    : 'text-surface-400 hover:text-surface-200'}"
                aria-selected={$musicPlayerStore.activePanel === 'queue'}
                onclick={() => musicPlayerStore.setActivePanel('queue')}>
                {m.music_queue_tab()}
            </button>
            <button
                role="tab"
                class="min-h-[44px] shrink-0 whitespace-nowrap px-4 text-sm font-medium transition-colors {$musicPlayerStore.activePanel ===
                'add'
                    ? 'text-primary-400'
                    : 'text-surface-400 hover:text-surface-200'}"
                aria-selected={$musicPlayerStore.activePanel === 'add'}
                onclick={() => musicPlayerStore.setActivePanel('add')}>
                {m.music_add_tab()}
            </button>
            <!-- Never disabled. If lyrics resolve to unavailable while the lyrics
                 tab is active, the user still needs to be able to click it to
                 toggle back to queue. The "(none)" hint below signals the state
                 without trapping the user. -->
            <button
                role="tab"
                class="min-h-[44px] shrink-0 whitespace-nowrap px-4 text-sm font-medium transition-colors {$musicPlayerStore.activePanel ===
                'lyrics'
                    ? 'text-primary-400'
                    : $musicPlayerStore.lyricsStatus === 'unavailable'
                      ? 'text-surface-600 hover:text-surface-400'
                      : 'text-surface-400 hover:text-surface-200'}"
                aria-selected={$musicPlayerStore.activePanel === 'lyrics'}
                onclick={() => {
                    const current = $musicPlayerStore.activePanel;
                    if (current === 'lyrics') {
                        musicPlayerStore.setActivePanel(previousPanel);
                    } else {
                        // `current` is narrowed to non-'lyrics' by the branch above,
                        // so the old ternary guard was provably dead.
                        previousPanel = current;
                        musicPlayerStore.setActivePanel('lyrics');
                    }
                }}>
                <span class="inline-flex items-center gap-1.5">
                    {m.music_lyrics_tab()}
                    {#if $musicPlayerStore.lyricsStatus === 'unavailable'}
                        ({m.music_lyrics_none()})
                    {/if}
                </span>
            </button>
            <button
                role="tab"
                class="min-h-[44px] shrink-0 whitespace-nowrap px-4 text-sm font-medium transition-colors {$musicPlayerStore.activePanel ===
                'settings'
                    ? 'text-primary-400'
                    : 'text-surface-400 hover:text-surface-200'}"
                aria-selected={$musicPlayerStore.activePanel === 'settings'}
                onclick={() => musicPlayerStore.setActivePanel('settings')}>
                {m.settings()}
            </button>
        </div>

        <div class="max-h-[calc(65vh-44px)] overflow-y-auto p-4">
            {#if $musicPlayerStore.activePanel === 'queue'}
                {#if $musicPlayerStore.autoplaySeed}
                    <!-- Seed badge with dismiss -->
                    <div
                        class="flex items-center justify-between border-b border-surface-700 px-4 py-3">
                        <div class="flex items-center gap-2">
                            <span class="text-lg"
                                >{getSeedEmoji($musicPlayerStore.autoplaySeed)}</span>
                            <span class="font-semibold text-white"
                                >{getSeedLabel($musicPlayerStore.autoplaySeed)}</span>
                        </div>
                        <button
                            class="text-xs text-surface-400 hover:text-red-400"
                            onclick={() => musicPlayerStore.clearAutoplaySeed()}>
                            {m.music_autoplay_stop()}
                        </button>
                    </div>
                {/if}

                <QueueSelectionBanner />

                <!-- Autoplay toggle -->
                <div class="mb-3 flex items-center justify-between">
                    <Tooltip
                        text={$musicPlayerStore.autoplayEnabled
                            ? m.music_autoplay_on_tooltip()
                            : m.music_autoplay_off_tooltip()}
                        position="bottom">
                        <button
                            class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors {$musicPlayerStore.autoplayEnabled
                                ? 'bg-primary-500/10 text-primary-400'
                                : 'text-surface-500 hover:text-surface-300'}"
                            onclick={() => musicPlayerStore.toggleAutoplay()}>
                            <Icon src={Signal} class="h-3.5 w-3.5" />
                            {$musicPlayerStore.autoplayEnabled
                                ? m.music_autoplay_label()
                                : m.music_autoplay_off_label()}
                        </button>
                    </Tooltip>
                </div>

                <QueueHistorySection />

                <!-- Now Playing -->
                {#if $musicPlayerStore.currentTrack}
                    <div class="mb-4">
                        <div class="mb-2 flex items-center gap-1.5">
                            <h3 class="text-xs uppercase text-surface-400">
                                {m.music_now_playing_label()}
                            </h3>
                            {#if $musicPlayerStore.isCrossfading}
                                <span
                                    class="inline-flex animate-pulse items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                                    ↔ {m.music_fading_in_label()}
                                </span>
                            {/if}
                        </div>
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="flex items-center gap-3"
                            oncontextmenu={handleNowPlayingContextMenu}>
                            {#if $musicPlayerStore.currentTrack.images?.primary?.variants?.thumb}
                                <img
                                    src={$musicPlayerStore.currentTrack.images.primary?.variants
                                        ?.thumb}
                                    alt=""
                                    class="h-12 w-12 rounded" />
                            {:else}
                                <div
                                    class="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-surface-700">
                                    <span class="text-xl text-surface-500">♪</span>
                                </div>
                            {/if}
                            <div class="min-w-0 flex-1">
                                <p class="truncate text-sm font-medium text-white">
                                    <TrackTitleLine
                                        title={$musicPlayerStore.currentTrack.title}
                                        artists={$musicPlayerStore.currentTrack.artists}
                                        remixerArtists={$musicPlayerStore.currentTrack
                                            .remixerArtists} />
                                </p>
                                <p class="truncate text-xs text-surface-400">
                                    <TrackArtistLine
                                        artist={$musicPlayerStore.currentTrack.artists
                                            .map((a) => a.title)
                                            .join(', ') ?? ''}
                                        artists={$musicPlayerStore.currentTrack.artists}
                                        artistId={$musicPlayerStore.currentTrack.artists[0]?.id ??
                                            undefined} />{#if $musicPlayerStore.currentTrack.album?.title}<span
                                            class="text-surface-500">
                                            &nbsp;·&nbsp;</span
                                        >{#if $musicPlayerStore.currentTrack.album?.id}<button
                                                class="hover:text-primary-400 hover:underline"
                                                onclick={() =>
                                                    openAlbumModal(
                                                        $musicPlayerStore.currentTrack?.album?.id ??
                                                            '',
                                                    )}
                                                >{$musicPlayerStore.currentTrack.album
                                                    ?.title}</button
                                            >{:else}{$musicPlayerStore.currentTrack.album
                                                ?.title}{/if}{/if}
                                </p>
                            </div>
                        </div>
                    </div>
                {/if}

                <!-- Up Next (unified queue: smart + user items) -->
                {#if $musicPlayerStore.currentTrack}
                    <div class="mb-4">
                        <div class="mb-2 flex items-center justify-between">
                            <h3
                                class="flex items-center gap-1.5 text-xs uppercase text-surface-400">
                                {m.music_queue_up_next()}
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
                            <div class="flex items-center gap-3 rounded-lg bg-surface-800/50 p-3">
                                <div
                                    class="h-4 w-4 animate-spin rounded-full border-2 border-surface-600 border-t-primary-400">
                                </div>
                                <span class="text-xs text-surface-500"
                                    >{m.music_queue_finding_next()}</span>
                            </div>
                        {/if}

                        <div
                            use:dndzone={{
                                items: localQueue,
                                flipDurationMs,
                                type: DND_TYPE,
                                dropTargetStyle: {
                                    outline: '2px dashed rgba(var(--color-primary-500-rgb) / 0.4)',
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
                            aria-busy={isDragging}
                            class="min-h-[48px] rounded-lg {isExternalDragOver
                                ? 'outline outline-2 outline-primary-400/60'
                                : ''}">
                            {#if localQueue.length === 0 && !$musicPlayerStore.smartQueueLoading}
                                <div
                                    class="flex items-center justify-center py-3 text-xs text-surface-600">
                                    {m.music_queue_drag_tracks_here()}
                                </div>
                            {/if}
                            {#each localQueue as item, idx (item.id)}
                                <div
                                    animate:flip={{ duration: flipDurationMs }}
                                    aria-label={item.track.title}>
                                    <QueueTrackItem
                                        track={item.track}
                                        nextTrack={localQueue[idx + 1]?.track}
                                        source={item.source}
                                        showDragHandle={true}
                                        showDismiss={item.source === 'smart'}
                                        {isAdmin}
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
            {:else if $musicPlayerStore.activePanel === 'add'}
                <QueueAddTab />
            {:else if $musicPlayerStore.activePanel === 'lyrics'}
                <LyricsPanel />
            {:else if $musicPlayerStore.activePanel === 'settings'}
                <CrossfadeSettings />
            {/if}
        </div>
    {/if}
</div>

{#if nowPlayingMenuPos}
    <ContextMenu
        x={nowPlayingMenuPos.x}
        y={nowPlayingMenuPos.y}
        items={nowPlayingMenuItems}
        title={$musicPlayerStore.currentTrack?.title}
        subtitle={$musicPlayerStore.currentTrack?.artists.map((a) => a.title).join(', ')}
        onClose={() => (nowPlayingMenuPos = null)} />
{/if}

<style>
    .queue-panel {
        width: min(520px, 100vw);
    }

    /* On mobile, take full width */
    @media (max-width: 639px) {
        .queue-panel {
            left: 0;
            width: 100vw;
        }
    }

    /* Desktop-only: lift queue panel above the modal layer when a music-kind
       modal is open. Mirrors MiniPlayer.svelte's .over-music-modal rule so the
       sibling panel clears ModalContainer's backdrop (z-index 1000+index).
       Z.MUSIC_OVER_MODAL (1050). */
    @media (min-width: 769px) {
        .queue-panel.over-music-modal {
            z-index: 1050;
        }
    }
</style>
