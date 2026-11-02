<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, Cube, Trash, ArrowPath } from 'svelte-hero-icons';
    import CacheSection from './CacheSection.svelte';
    import type { StandaloneCache } from '$lib/types/cache-stats';
    import { getHitRateColor } from '$lib/utils/cache-utils';

    interface Props {
        /**
         * Standalone LRU caches section
         */
        caches: StandaloneCache[];
        totalEntries?: number;
        totalMaxSize?: number;
        overallHitRate?: number;
        clearing: string | null;
        onClear: (cacheName: string) => void;
        onClearAll: () => void;
    }

    let {
        caches,
        totalEntries = 0,
        totalMaxSize = 0,
        overallHitRate = 0,
        clearing,
        onClear,
        onClearAll,
    }: Props = $props();
</script>

<CacheSection>
    {#snippet header()}
        <h3 class="text-xl font-bold text-white flex items-center gap-2">
            <Icon src={Cube} class="w-6 h-6 text-cyan-400" />
            Standalone LRU Caches
        </h3>
        <div class="flex items-center gap-4">
            <span class="text-muted">
                Total: <span class="text-cyan-400 font-semibold">{totalEntries}</span>
                / {totalMaxSize} entries ({(overallHitRate * 100).toFixed(1)}% hit rate)
            </span>
            <button
                class="btn btn-sm btn-soft-red flex items-center gap-1.5"
                onclick={onClearAll}
                disabled={clearing !== null}>
                {#if clearing === 'all'}
                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                {:else}
                    <Icon src={Trash} class="w-4 h-4" />
                {/if}
                Clear All
            </button>
        </div>
    {/snippet}
    {#snippet content()}
        <div class="overflow-x-auto">
            <table class="w-full">
                <thead>
                    <tr class="text-left text-surface-400 text-sm border-b border-surface-700">
                        <th class="pb-3 font-semibold">Cache</th>
                        <th class="pb-3 font-semibold">Category</th>
                        <th class="pb-3 font-semibold text-right">Hits</th>
                        <th class="pb-3 font-semibold text-right">Misses</th>
                        <th class="pb-3 font-semibold text-right">Evictions</th>
                        <th class="pb-3 font-semibold text-right">Hit Rate</th>
                        <th class="pb-3 font-semibold text-right">Size</th>
                        <th class="pb-3 font-semibold text-center">Actions</th>
                    </tr>
                </thead>
                <tbody class="text-sm">
                    {#each caches as cache (cache.name)}
                        {@const hitRatePercent = (cache.hitRate || 0) * 100}
                        <tr class="border-b border-surface-800 hover:bg-surface-800/50">
                            <td class="py-4">
                                <div>
                                    <span class="font-medium text-white">{cache.name}</span>
                                    <p class="text-caption mt-0.5">
                                        {cache.description}
                                    </p>
                                </div>
                            </td>
                            <td class="py-4">
                                <span
                                    class="px-2 py-0.5 text-xs rounded-full {cache.category ===
                                    'playback'
                                        ? 'bg-cyan-900/50 text-cyan-400'
                                        : cache.category === 'media'
                                          ? 'bg-purple-900/50 text-purple-400'
                                          : cache.category === 'auth'
                                            ? 'bg-yellow-900/50 text-yellow-400'
                                            : 'bg-surface-700 text-surface-400'}">
                                    {cache.category}
                                </span>
                            </td>
                            <td class="py-4 text-right text-green-400">{cache.hits}</td>
                            <td class="py-4 text-right text-red-400">{cache.misses}</td>
                            <td class="py-4 text-right text-yellow-400">{cache.evictions}</td>
                            <td class="py-4 text-right">
                                <span class="font-semibold {getHitRateColor(hitRatePercent)}">
                                    {hitRatePercent.toFixed(1)}%
                                </span>
                            </td>
                            <td class="py-4 text-right">
                                <span class="text-cyan-400">{cache.size}</span>
                                <span class="text-surface-500">/ {cache.maxSize}</span>
                            </td>
                            <td class="py-4 text-center">
                                <button
                                    class="btn btn-sm btn-soft-red flex items-center gap-1 mx-auto !py-1 !text-xs"
                                    onclick={() => onClear(cache.name)}
                                    disabled={clearing !== null}>
                                    {#if clearing === cache.name}
                                        <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
                                    {:else}
                                        <Icon src={Trash} class="w-3 h-3" />
                                    {/if}
                                    Clear
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/snippet}
</CacheSection>
