<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { imageFromIds, handleImageError as handleImgError } from '$lib/utils/image-utils';
    import type { ExternalIds } from '$lib/types/api-common';

    interface Props {
        rank: number;
        title: string;
        year?: number | null;
        rating?: number | null;
        externalIds?: ExternalIds | null;
        mediaType?: 'movie' | 'tv';
        metadata?: string | null;
        stats?: Array<{
            label: string;
            value: string | number;
            color: string;
        }>;
    }

    let {
        rank,
        title,
        year = null,
        rating = null,
        externalIds = null,
        mediaType = 'movie',
        metadata = null,
        stats = [],
    }: Props = $props();

    // Generate gradient color based on rank
    let gradientColors = $derived(
        rank === 1
            ? 'from-yellow-500 to-yellow-600'
            : rank === 2
              ? 'from-surface-400 to-surface-500'
              : rank === 3
                ? 'from-orange-600 to-orange-700'
                : 'from-blue-500 to-blue-600',
    );

    let posterUrl = $derived(
        externalIds ? imageFromIds(externalIds, 'poster', mediaType, { size: 'thumb' }) : null,
    );

    function handleImageError(e: Event) {
        handleImgError(e, { hideOnError: true });
    }
</script>

<div
    class="bg-surface-700/50 rounded-lg p-3 border border-surface-600/50 hover:border-surface-500 transition-all">
    <div class="between gap-4">
        <!-- Left: Rank, Poster, Title -->
        <div class="flex items-center gap-3 flex-1 min-w-0">
            <!-- Rank Badge -->
            <div
                class="w-8 h-8 center rounded-full bg-gradient-to-br {gradientColors} text-white font-bold text-sm shrink-0 shadow-lg">
                #{rank}
            </div>

            <!-- Poster -->
            {#if posterUrl}
                <div class="w-12 h-18 bg-surface-600 rounded-md overflow-hidden shrink-0">
                    <img
                        src={posterUrl}
                        alt="{title} poster"
                        class="w-full h-full object-cover"
                        loading="lazy"
                        onerror={handleImageError} />
                </div>
            {/if}

            <!-- Title & Metadata -->
            <div class="min-w-0 flex-1">
                <h4 class="font-medium text-white truncate">{title}</h4>
                <div class="flex items-center gap-2 mt-0.5">
                    {#if year}
                        <span class="text-hint">{year}</span>
                    {/if}
                    {#if rating}
                        <span class="text-xs text-yellow-500">⭐ {rating.toFixed(1)}</span>
                    {/if}
                </div>
                {#if metadata}
                    <p class="text-caption mt-0.5 truncate">
                        {metadata}
                    </p>
                {/if}
            </div>
        </div>

        <!-- Right: Stats -->
        {#if stats.length > 0}
            <div class="flex items-center gap-4 shrink-0">
                {#each stats as stat, statIdx (stat.label + '-' + statIdx)}
                    <div class="text-center">
                        <div class="text-hint">{stat.label}</div>
                        <div class="text-sm font-bold {stat.color}">
                            {stat.value}
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</div>
