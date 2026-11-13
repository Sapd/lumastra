<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Horizontal drag-scroll row of MUSIC result cards for the AI assistant.
     * Tracks play on click (musicPlayerStore); albums/artists open their modal.
     * Square album-art tiles distinguish music from the portrait movie cards.
     */
    import {
        Icon,
        Play,
        MusicalNote,
        ChevronUp,
        ChevronDown,
    } from 'svelte-hero-icons';
    import type { RecommendedMusic } from '$lib/types/assistant';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { openAlbumModal, openArtistModal } from '$lib/utils/modal-utils';
    import { dragScroll } from '$lib/utils/drag-scroll';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        items: RecommendedMusic[];
    }
    let { items }: Props = $props();

    let collapsed = $state(false);

    const trackItems = $derived(items.filter((i) => i.mediaType === 'track'));

    function toMusicTrack(item: RecommendedMusic): MusicTrack {
        // No artwork field here: the player store derives canonical images from
        // the catalog route (track→album→artist fallback) on every ingress, which
        // is also where item.posterUrl came from.
        return musicTrackFromCard({
            id: item.id, title: item.title,
            artists: [{ id: item.artistId ?? null, title: item.artistName ?? '' }],
            album: item.albumId ? { id: item.albumId, title: item.albumTitle ?? '' } : null,
        });
    }

    function handleClick(item: RecommendedMusic) {
        if (item.mediaType === 'track') {
            void musicPlayerStore.startPlayback(toMusicTrack(item));
        } else if (item.mediaType === 'album') {
            openAlbumModal(item.id);
        } else {
            openArtistModal(item.id);
        }
    }

    function playAll() {
        if (trackItems.length === 0) return;
        void musicPlayerStore.startPlayback(toMusicTrack(trackItems[0]));
        for (const t of trackItems.slice(1)) {
            musicPlayerStore.addToQueue(toMusicTrack(t));
        }
    }
</script>

{#if items.length > 0}
    <div class="assistant-music-section bg-surface-800 border-t border-surface-700 px-4 py-3">
        <div class="between mb-2">
            <div class="flex items-center gap-2">
                <Icon src={MusicalNote} class="w-4 h-4 text-primary-500" />
                <h3 class="text-xs font-semibold text-primary-400">
                    {m.assistant_music_count({ count: items.length })}
                </h3>
            </div>
            <div class="flex items-center gap-1">
                {#if !collapsed && trackItems.length > 1}
                    <button
                        type="button"
                        onclick={playAll}
                        class="btn btn-sm variant-ghost-surface hover:variant-filled-surface flex items-center gap-1 text-xs"
                        aria-label={m.assistant_play_all_aria()}>
                        <Icon src={Play} class="w-4 h-4" aria-hidden="true" />
                        <span class="hidden sm:inline">{m.assistant_play_all()}</span>
                    </button>
                {/if}
                <button
                    type="button"
                    onclick={() => (collapsed = !collapsed)}
                    class="btn btn-sm variant-ghost-surface p-1 hover:variant-filled-surface"
                    aria-label={collapsed ? m.assistant_show_music() : m.assistant_hide_music()}
                    aria-expanded={!collapsed}>
                    <Icon
                        src={collapsed ? ChevronDown : ChevronUp}
                        class="w-5 h-5"
                        aria-hidden="true" />
                </button>
            </div>
        </div>

        {#if !collapsed}
            <div
                use:dragScroll
                class="flex gap-2 overflow-x-auto pb-2 cursor-grab active:cursor-grabbing select-none">
                {#each items as item, itemIdx (`${item.id}-${item.mediaType}-${itemIdx}`)}
                    <div
                        class="music-card bg-surface-700 rounded-lg overflow-hidden shrink-0 w-36 hover:ring-2 hover:ring-primary-500 transition-all text-left"
                        role="button"
                        tabindex="0"
                        onclick={() => handleClick(item)}
                        onkeydown={(e) => e.key === 'Enter' && handleClick(item)}>
                        <div class="relative aspect-square bg-surface-600">
                            {#if item.posterUrl}
                                <img
                                    src={item.posterUrl}
                                    alt={item.title}
                                    class="w-full h-full object-cover"
                                    loading="lazy" />
                            {:else}
                                <div
                                    class="w-full h-full center bg-gradient-to-br from-surface-600 to-surface-700">
                                    <Icon src={MusicalNote} class="w-10 h-10 text-surface-400" />
                                </div>
                            {/if}
                            {#if item.mediaType === 'track'}
                                <button
                                    type="button"
                                    onclick={stopPropagation(() => handleClick(item))}
                                    class="absolute bottom-2 right-2 w-9 h-9 rounded-full bg-primary-600 hover:bg-primary-500 center shadow-lg"
                                    aria-label={m.assistant_play_track({ title: item.title })}>
                                    <Icon src={Play} class="w-5 h-5 text-white" />
                                </button>
                            {/if}
                        </div>
                        <div class="p-2">
                            <h4
                                class="text-xs font-semibold text-white truncate"
                                title={item.title}>
                                {item.title}
                            </h4>
                            <p
                                class="text-[10px] text-surface-300 truncate"
                                title={item.artistName ?? ''}>
                                {item.artistName ??
                                    (item.mediaType === 'artist' ? m.assistant_artist_label() : '')}
                            </p>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
{/if}

<style>
    .music-card {
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
</style>
