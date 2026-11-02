<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { retryImage } from './retry-image';
    import * as m from '$lib/paraglide/messages';
    import { musicCoverUrl } from '$lib/utils/music-cover';
    import { openAlbumModal } from '$lib/utils/modal-utils';
    import { page } from '$app/stores';
    import Skeleton from '$lib/components/ui/Skeleton.svelte';

    interface Props {
        id: string;
        title: string;
        artistName?: string | null;
        year?: number | string | null;
        /**
         * True when the album row carries its own `custom_poster_url`. NOT a
         * "has a cover at all" flag: an album with none inherits its artist's
         * photo through the byte route, so the card probes and lets `onerror`
         * fall through to the note glyph.
         */
        hasCustomPoster?: boolean;
        onClick?: () => void;
    }

    let { id, title, artistName, year, hasCustomPoster = false, onClick }: Props = $props();

    const src = $derived(musicCoverUrl({ id, size: 'thumb', hasOwnPoster: hasCustomPoster }));

    const sonicEnabled = $derived($page.data?.features?.sonicEmbeddings === true);
    // Which URL failed, rather than a bare boolean: an unkeyed `{#each}` reuses
    // this component across albums, and a failure recorded for one would
    // otherwise stick to the next and hide a cover that resolves fine.
    let failedSrc = $state<string | null>(null);
    const posterOk = $derived(failedSrc !== src);
    // Fade the cover in once decoded; a shimmer placeholder holds the box until
    // then so lazy covers don't flash blank rectangles.
    let imageLoaded = $state(false);
    let imgEl: HTMLImageElement | undefined = $state();

    // A cached cover may be `complete` before `onload` binds — flip the flag so
    // the shimmer doesn't linger.
    $effect(() => {
        if (imgEl?.complete && imgEl.naturalWidth > 0) imageLoaded = true;
    });

    function handleClick(): void {
        if (onClick) {
            onClick();
        } else {
            openAlbumModal(id, { sonicEnabled });
        }
    }
</script>

<button
    type="button"
    onclick={handleClick}
    class="group flex flex-col gap-2 rounded-lg p-2 transition-colors hover:bg-surface-800/50">
    <div class="relative aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
        {#if posterOk}
            <img
                bind:this={imgEl}
                {src}
                alt={title}
                class="h-full w-full object-cover transition-[opacity,transform] duration-300 group-hover:scale-105 {imageLoaded
                    ? 'opacity-100'
                    : 'opacity-0'}"
                loading="lazy"
                onload={() => (imageLoaded = true)}
                use:retryImage={{ src, onerror: () => (failedSrc = src) }} />
            {#if !imageLoaded}
                <div class="absolute inset-0" aria-hidden="true">
                    <Skeleton width="w-full" height="h-full" rounded="none" />
                </div>
            {/if}
        {:else}
            <div class="flex h-full w-full items-center justify-center bg-surface-700">
                <span class="text-3xl text-surface-500">♪</span>
            </div>
        {/if}
    </div>
    <div class="min-w-0">
        <p data-media-card-title {title} class="truncate text-sm font-medium text-white">
            {title}
        </p>
        <p data-media-card-subtitle class="truncate text-xs text-surface-400">
            {artistName ?? m.music_unknown_artist()}
            {#if year}
                <span class="text-surface-500"> · {year}</span>
            {/if}
        </p>
    </div>
</button>
