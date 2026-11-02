<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages.js';
    import { onMount, onDestroy, untrack } from 'svelte';
    import { Icon, XMark, Check, Play, QueueList } from 'svelte-hero-icons';
    import { fade, fly } from 'svelte/transition';
    import { isEpisode, isMovie, isSeries } from '$lib/shared/media-types';
    import { getCatalogPosterUrl, getCatalogThumbUrl } from '$lib/utils/image-utils';
    import { page } from '$app/stores';
    import { getPlaylistItems } from '$lib/api/playlists.js';

    interface Props {
        // Props
        playlistId: number;
        currentPosition: number;
        // currentItemId is passed but not currently used - keep for future reference
        currentItemId?: string | null;
        playlistName?: string;
        isOpen?: boolean;
        readOnly?: boolean; // When true, disables item selection (for watch party guests)
        onclose?: () => void;
        onselectitem?: (detail: {
            itemId: string;
            playlistId: number;
            position: number;
            title: string;
        }) => void;
    }

    let {
        playlistId,
        currentPosition,
        currentItemId = null,
        playlistName = '',
        isOpen = false,
        readOnly = false,
        onclose,
        onselectitem,
    }: Props = $props();

    // Playlist item data
    interface PlaylistEntry {
        id: number;
        mediaId: string | null; // internal UUID — always prefer over any external ID
        title: string;
        seriesName: string | null;
        seasonNumber: number | null;
        episodeNumber: number | null;
        mediaType: string;
        position: number;
        watched: boolean;
        posterPath: string | null;
    }

    interface PlaylistData {
        id: number;
        name: string;
        totalItems: number;
    }

    let items: PlaylistEntry[] = $state([]);
    let playlist = $state<PlaylistData | null>(null);
    let loading = $state(false);
    let error = $state<string | null>(null);
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;

    let requestVersion = 0;
    onDestroy(() => {
        requestVersion++;
        if (scrollTimer !== null) clearTimeout(scrollTimer);
    });

    // Get item thumbnail URL — mediaId is the internal UUID. Episodes only
    // ever have their own artwork under image type 'thumb' — 'poster' has no
    // per-episode source and inherits season/series art instead.
    function getItemThumbnailUrl(item: PlaylistEntry): string | null {
        if (item.mediaId) {
            return isEpisode(item.mediaType)
                ? getCatalogThumbUrl(item.mediaId, { size: 'thumb' })
                : getCatalogPosterUrl(item.mediaId, { size: 'thumb' });
        }
        if (item.posterPath) {
            return item.posterPath;
        }
        return null;
    }

    // Handle image error
    function handleImageError(event: Event) {
        const img = event.currentTarget as HTMLImageElement;
        img.style.display = 'none';
        const fallback = img.nextElementSibling as HTMLElement;
        if (fallback) fallback.classList.remove('hidden');
    }

    // Format item display title
    function getItemDisplayTitle(item: PlaylistEntry): string {
        if (item.seasonNumber !== null && item.episodeNumber !== null) {
            return `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')} - ${item.title}`;
        }
        return item.title;
    }

    // Get item subtitle (series name for episodes)
    function getItemSubtitle(item: PlaylistEntry): string | null {
        return item.seriesName || null;
    }

    // Fetch playlist items from the playback-context endpoint
    async function fetchPlaylistItems() {
        if (!playlistId) return;

        const version = ++requestVersion;
        const targetPlaylistId = playlistId;
        const isCurrent = () => version === requestVersion && targetPlaylistId === playlistId;
        loading = true;
        error = null;
        playlist = null;
        items = [];
        try {
            let offset = 0;
            for (;;) {
                const { data, error: apiErr } = await getPlaylistItems(targetPlaylistId, offset);
                if (!isCurrent()) return;
                if (apiErr || !data) {
                    error = m.error_load_playlist_items();
                    return;
                }
                playlist = {
                    id: targetPlaylistId,
                    name: playlistName,
                    totalItems: data.page.total ?? items.length + data.items.length,
                };
                items = [
                    ...items,
                    ...data.items.map((item) => ({
                        ...item,
                        seriesName: item.seriesName ?? null,
                        seasonNumber: item.seasonNumber ?? null,
                        episodeNumber: item.episodeNumber ?? null,
                        posterPath: item.posterPath ?? null,
                    })),
                ];
                if (!data.page.hasMore || data.items.length === 0) break;
                offset += data.items.length;
            }
        } catch (err) {
            console.error('[PlaylistBrowser] Failed to fetch playlist items:', err);
            if (isCurrent()) error = m.error_load_playlist_items();
        } finally {
            if (isCurrent()) loading = false;
        }
    }

    function canPlayVideo(item: PlaylistEntry): boolean {
        return (
            !!item.mediaId &&
            (isMovie(item.mediaType) || isSeries(item.mediaType) || isEpisode(item.mediaType))
        );
    }

    // Handle item click — use internal UUID (mediaId) exclusively
    function handleItemClick(item: PlaylistEntry) {
        if (readOnly) return; // Watch party guests cannot select items
        if (!item.mediaId || !canPlayVideo(item)) return; // No internal UUID — item is not navigable
        if (item.position === currentPosition) return; // Already playing

        onselectitem?.({
            itemId: item.mediaId,
            playlistId,
            position: item.position,
            title: item.title,
        });
    }

    // Close the browser
    function close() {
        onclose?.();
    }

    // Handle escape key
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            event.stopImmediatePropagation(); // Prevent VideoPlayer from also handling this ESC
            close();
        }
    }

    // Scroll to current item when mounted
    function scrollToCurrentItem() {
        if (scrollTimer !== null) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            const currentEl = document.querySelector('.playlist-item-current');
            if (currentEl) {
                currentEl.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
            }
        }, 100);
    }

    let lastFetchedPlaylistId: number | null = null;
    let wasOpen = false;

    // Initialize when opened — use untrack for guard variables to avoid tracking them as dependencies
    $effect(() => {
        if (isOpen && playlistId) {
            const shouldFetch = untrack(() => !wasOpen || playlistId !== lastFetchedPlaylistId);
            if (shouldFetch) {
                lastFetchedPlaylistId = playlistId;
                wasOpen = true;
                fetchPlaylistItems();
            }
        }
        untrack(() => {
            wasOpen = isOpen;
        });
    });

    // Scroll to current item when items load
    $effect(() => {
        if (items.length > 0) {
            scrollToCurrentItem();
        }
    });

    onMount(() => {
        // Use capture phase to intercept ESC before VideoPlayer handles it
        window.addEventListener('keydown', handleKeydown, true);
        return () => window.removeEventListener('keydown', handleKeydown, true);
    });
</script>

{#if isOpen}
    <!-- Backdrop -->
    <button
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.PLAYER_SIDEBAR};"
        transition:fade={{ duration: 200 }}
        onclick={close}
        aria-label={m.player_close_playlist_browser()}></button>

    <!-- Drawer -->
    <div
        class="player-drawer fixed right-0 top-0 bottom-0 w-[400px] max-w-[90vw] flex flex-col"
        style="z-index: {Z.PLAYER_SIDEBAR_CONTENT};"
        transition:fly={{ x: 400, duration: 300 }}>
        <!-- Header -->
        <div class="player-drawer-header">
            <div class="flex items-center gap-3 flex-1 min-w-0">
                <Icon src={QueueList} class="w-5 h-5 text-primary-400 shrink-0" />
                <div class="flex-1 min-w-0">
                    <h2 class="text-lg font-semibold truncate">
                        {playlist?.name || playlistName || m.player_playlist_fallback()}
                    </h2>
                    {#if playlist}
                        <div class="text-xs text-surface-400">
                            {currentPosition + 1} / {playlist.totalItems}
                        </div>
                    {/if}
                </div>
            </div>
            <button
                class="p-2 hover:bg-surface-700 rounded-lg transition-colors"
                onclick={close}
                aria-label={m.btn_close()}>
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </div>

        <!-- Items List -->
        <div class="flex-1 overflow-y-auto playlist-items-list">
            {#if loading}
                <div class="center p-8">
                    <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                </div>
            {:else if error}
                <div class="text-center text-error-400 p-8">
                    {error}
                </div>
            {:else if items.length === 0}
                <div class="text-center text-surface-400 p-8">
                    {m.empty_no_content()}
                </div>
            {:else}
                {#each items as item (item.id)}
                    {@const isCurrentItem = item.position === currentPosition}
                    {@const thumbnailUrl = getItemThumbnailUrl(item)}
                    {@const subtitle = getItemSubtitle(item)}
                    {@const canPlay = canPlayVideo(item)}
                    {@const isDisabled = !canPlay || (readOnly && !isCurrentItem)}
                    <button
                        class="w-full flex gap-3 p-3 transition-colors text-left border-b border-surface-800 {isCurrentItem
                            ? 'bg-surface-800 playlist-item-current'
                            : ''} {isDisabled
                            ? 'opacity-50 cursor-not-allowed'
                            : 'hover:bg-surface-800'}"
                        onclick={() => handleItemClick(item)}
                        disabled={isDisabled}>
                        <!-- Position number -->
                        <div class="w-6 shrink-0 text-center text-sm text-surface-400 pt-2">
                            {item.position + 1}
                        </div>

                        <!-- Thumbnail -->
                        <div class="relative shrink-0">
                            {#if thumbnailUrl}
                                <img
                                    src={thumbnailUrl}
                                    alt={item.title}
                                    class="w-16 h-24 rounded object-cover"
                                    onerror={handleImageError} />
                                <div class="hidden">
                                    <div
                                        class="w-16 h-24 rounded bg-surface-700 flex items-center justify-center text-surface-400">
                                        <Icon src={Play} class="w-5 h-5" />
                                    </div>
                                </div>
                            {:else}
                                <div
                                    class="w-16 h-24 rounded bg-surface-700 flex items-center justify-center text-surface-400">
                                    <Icon src={Play} class="w-5 h-5" />
                                </div>
                            {/if}

                            <!-- Playing indicator -->
                            {#if isCurrentItem}
                                <div class="absolute inset-0 bg-primary-500/30 rounded center">
                                    <div class="w-8 h-8 bg-primary-500 rounded-full center">
                                        <Icon src={Play} class="w-4 h-4 text-white" solid />
                                    </div>
                                </div>
                            {/if}
                        </div>

                        <!-- Item Info -->
                        <div class="flex-1 min-w-0">
                            <div class="flex items-start justify-between gap-2">
                                <div class="flex-1 min-w-0">
                                    {#if subtitle}
                                        <div class="text-xs text-surface-400 truncate mb-0.5">
                                            {subtitle}
                                        </div>
                                    {/if}
                                    <div class="text-sm font-medium truncate">
                                        {getItemDisplayTitle(item)}
                                    </div>
                                    <div class="text-xs text-surface-500 mt-0.5 capitalize">
                                        {isEpisode(item.mediaType)
                                            ? m.media_episode()
                                            : isMovie(item.mediaType)
                                              ? m.media_movie()
                                              : item.mediaType}
                                    </div>
                                </div>
                                {#if item.watched}
                                    <Icon
                                        src={Check}
                                        class="w-4 h-4 text-green-400 shrink-0"
                                        solid />
                                {/if}
                            </div>
                        </div>
                    </button>
                {/each}
            {/if}
        </div>
    </div>
{/if}

<style>
    .playlist-items-list::-webkit-scrollbar {
        width: 4px;
    }

    .playlist-items-list::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 2px;
    }

    .playlist-items-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
    }

    .playlist-items-list::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
    }
</style>
