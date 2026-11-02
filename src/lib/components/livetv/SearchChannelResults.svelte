<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import LazyMount from '$lib/components/ui/LazyMount.svelte';
    import ChannelCard from './ChannelCard.svelte';

    let {
        channels,
        now,
        onclick,
    }: {
        channels: LiveTvStation[];
        now: number;
        onclick: (channel: LiveTvStation) => void;
    } = $props();

    // Divisible by every grid column count: chunk boundaries keep the same rows.
    const CHUNK_SIZE = 24;
    let chunks = $derived(
        Array.from({ length: Math.ceil(channels.length / CHUNK_SIZE) }, (_, index) =>
            channels.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        ),
    );
</script>

{#snippet cards(chunk: LiveTvStation[])}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each chunk as channel (channel.id)}
            <ChannelCard {channel} {now} {onclick} showFullTitles />
        {/each}
    </div>
{/snippet}

<!-- New results reset deferred mounts; clock ticks preserve mounted cards. -->
{#key channels}
    <div class="space-y-3">
        {#each chunks as chunk, index (chunk[0].id)}
            <div
                class="chunk"
                style="--rows-1: {chunk.length}; --rows-2: {Math.ceil(
                    chunk.length / 2,
                )}; --rows-3: {Math.ceil(chunk.length / 3)}; --rows-4: {Math.ceil(
                    chunk.length / 4,
                )}">
                {#if index === 0}
                    {@render cards(chunk)}
                {:else}
                    <LazyMount minHeight="calc(var(--rows) * 132px - 12px)" rootMargin="800px 0px">
                        {#snippet placeholder()}<div aria-hidden="true"></div>{/snippet}
                        {@render cards(chunk)}
                    </LazyMount>
                {/if}
            </div>
        {/each}
    </div>
{/key}

<style>
    /* Reserve multi-line search rows; mounted cards grow to fit the full title. */
    .chunk {
        --rows: var(--rows-1);
    }
    @media (min-width: 640px) {
        .chunk {
            --rows: var(--rows-2);
        }
    }
    @media (min-width: 1024px) {
        .chunk {
            --rows: var(--rows-3);
        }
    }
    @media (min-width: 1280px) {
        .chunk {
            --rows: var(--rows-4);
        }
    }
</style>
