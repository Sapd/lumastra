<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { RadioStationApiItem } from '$lib/schemas/radio';

    interface Props {
        station: RadioStationApiItem & { nowPlaying?: string | null };
    }

    let { station }: Props = $props();

    const posterThumb = $derived(station.images?.poster?.thumb);

    function playStation(): void {
        musicPlayerStore.play(musicTrackFromCard({
            id: station.id, title: station.name,
            artists: [{ id: null, title: station.genre ?? m.music_internet_radio() }],
            isRadio: true,
        }));
    }
</script>

<button
    class="group flex flex-col overflow-hidden rounded-xl bg-surface-800/50 transition-all hover:bg-surface-800 hover:shadow-lg"
    onclick={playStation}>
    <div class="aspect-square w-full bg-surface-700">
        {#if posterThumb}
            <img
                src={posterThumb}
                alt={station.name}
                class="h-full w-full object-cover transition-transform group-hover:scale-105"
                loading="lazy" />
        {:else}
            <div class="flex h-full w-full items-center justify-center">
                <span class="text-4xl text-surface-500">📻</span>
            </div>
        {/if}
    </div>
    <div class="flex flex-col gap-1 p-3">
        <p class="truncate text-sm font-medium text-white">{station.name}</p>
        {#if station.genre}
            <p class="truncate text-xs text-surface-400">{station.genre}</p>
        {/if}
        {#if station.nowPlaying}
            <p class="truncate text-xs text-primary-400">
                ♪ {station.nowPlaying}
            </p>
        {/if}
    </div>
</button>
