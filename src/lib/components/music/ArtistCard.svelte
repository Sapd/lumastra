<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { retryImage } from './retry-image';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { openArtistModal } from '$lib/utils/modal-utils';
    import { isVariousArtistsName, VARIOUS_ARTISTS_COVER_URL } from '$lib/shared/various-artists';
    import { page } from '$app/stores';
    import Skeleton from '$lib/components/ui/Skeleton.svelte';

    interface Props {
        id: string;
        title: string;
        subtitle?: string | null;
        hasCustomPoster?: boolean;
        isVariousArtists?: boolean;
        onClick?: () => void;
    }

    let {
        id,
        title,
        subtitle,
        hasCustomPoster = false,
        isVariousArtists,
        onClick,
    }: Props = $props();

    // Compilation/VA artists have no real upstream — short-circuit to the
    // canonical static image and ignore whatever the scanner or enrichment
    // plugin happened to attach. Prefer the server-computed flag (set at
    // ingest); fall back to a name-match for callers that don't pass it yet.
    const isVa = $derived(isVariousArtists ?? isVariousArtistsName(title));

    const sonicEnabled = $derived($page.data?.features?.sonicEmbeddings === true);
    const src = $derived(getCatalogPosterUrl(id, { size: 'thumb' }));
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
            openArtistModal(id, { sonicEnabled });
        }
    }
</script>

<button
    type="button"
    onclick={handleClick}
    class="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-surface-800/50">
    <div class="relative aspect-square w-full overflow-hidden rounded-full bg-surface-800">
        {#if isVa}
            <img
                src={VARIOUS_ARTISTS_COVER_URL}
                alt={title}
                class="h-full w-full object-cover transition-transform group-hover:scale-105"
                loading="lazy" />
        {:else if hasCustomPoster && posterOk}
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
                    <Skeleton width="w-full" height="h-full" rounded="full" />
                </div>
            {/if}
        {:else}
            <div class="flex h-full w-full items-center justify-center bg-surface-700">
                <span class="text-3xl text-surface-500">♪</span>
            </div>
        {/if}
    </div>
    <div class="min-w-0 w-full">
        <p data-media-card-title {title} class="truncate text-sm font-medium text-white">
            {title}
        </p>
        {#if subtitle}
            <p data-media-card-subtitle class="truncate text-xs text-surface-400">{subtitle}</p>
        {/if}
    </div>
</button>
