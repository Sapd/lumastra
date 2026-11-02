<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- Shared episode artwork: the descriptor already resolves landscape fallback. -->
<script lang="ts">
    import { Icon, Play } from 'svelte-hero-icons';
    import { pickVariant } from '$lib/utils/image-utils';
    import type { ImageSet } from '$lib/schemas/api-image-descriptor';

    interface StillEpisode {
        id: string;
        name?: string;
        imageTag?: string;
        images?: ImageSet;
        /** False when the episode has no image of its own. */
        hasOwnStill?: boolean;
        externalIds?: Record<string, string | undefined>;
    }

    interface Props {
        episode: StillEpisode;
        resolvedSeriesId: string | undefined;
        /** Catalog image size. The row renders small ('thumb', 250w); the hover panel large ('card', 480w). */
        size?: 'thumb' | 'card';
        /** Sizing/shape classes applied to the image and both placeholder states. */
        class?: string;
        width?: number;
        height?: number;
    }

    let {
        episode,
        size = 'thumb',
        class: className = 'w-24 h-14',
        width = 96,
        height = 56,
    }: Props = $props();

    let imageUrl = $derived(pickVariant(episode.images?.thumb, size) ?? episode.imageTag);
</script>

{#if imageUrl}
    <img
        src={imageUrl}
        alt={episode.name}
        {width}
        {height}
        class="{className} object-cover rounded-md bg-surface-800"
        loading="lazy"
        onerror={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            img.style.display = 'none';
            const fallback = img.nextElementSibling as HTMLElement | null;
            if (fallback) fallback.style.display = 'flex';
        }} />
    <div class="{className} rounded-md bg-surface-800 center" style="display: none">
        <Icon src={Play} class="w-6 h-6 text-surface-500" />
    </div>
{:else}
    <div class="{className} rounded-md bg-surface-800 center">
        <Icon src={Play} class="w-6 h-6 text-surface-500" />
    </div>
{/if}
