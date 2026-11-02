<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, PlayCircle } from 'svelte-hero-icons';
    import CacheSection from './CacheSection.svelte';
    import type { SubtitleCacheStats } from '$lib/types/cache-stats';
    import { calculateHitRate } from '$lib/utils/cache-utils';

    interface Props {
        /**
         * Subtitle cache section (L1 memory + L2 file)
         */
        subtitles: SubtitleCacheStats;
        clearing: string | null;
        onClear: (type: 'memory' | 'file' | 'cleanup') => void;
    }

    let { subtitles, clearing, onClear }: Props = $props();

    let memoryHitRate = $derived(
        calculateHitRate(subtitles.memory.stats.hits, subtitles.memory.stats.misses),
    );
</script>

<CacheSection>
    {#snippet header()}
        <h3 class="text-xl font-bold text-white flex items-center gap-2">
            <Icon src={PlayCircle} class="w-6 h-6 text-purple-400" />
            Subtitle Cache
        </h3>
        <span class="text-muted">Multi-layer caching</span>
    {/snippet}
    {#snippet content()}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- Memory Cache (L1) -->
            <div class="card-glass">
                <h4 class="text-lg font-semibold text-purple-400 mb-3">Memory Cache (L1)</h4>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-surface-400">Size:</span>
                        <span class="text-white font-semibold"
                            >{subtitles.memory.cacheSize} / 50</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Hits:</span>
                        <span class="text-green-400 font-semibold"
                            >{subtitles.memory.stats.hits}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Misses:</span>
                        <span class="text-red-400 font-semibold"
                            >{subtitles.memory.stats.misses}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Hit Rate:</span>
                        <span
                            class="font-semibold {memoryHitRate >= 50
                                ? 'text-green-400'
                                : 'text-yellow-400'}">
                            {memoryHitRate.toFixed(1)}%
                        </span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">TTL:</span>
                        <span class="text-surface-300">30 minutes</span>
                    </div>
                    <div class="mt-3">
                        <button
                            class="btn btn-sm btn-soft-purple w-full center gap-1.5"
                            onclick={() => onClear('memory')}
                            disabled={clearing === 'memory'}>
                            {#if clearing === 'memory'}
                                <span
                                    class="loading-spinner w-3 h-3"
                                    style="border-color: rgb(var(--color-purple-400-rgb) / 0.3); border-top-color: var(--color-purple-400);"
                                ></span>
                                Clearing...
                            {:else}
                                Clear Memory Cache
                            {/if}
                        </button>
                    </div>
                </div>
            </div>

            <!-- File Cache (L2) -->
            <div class="card-glass">
                <h4 class="text-lg font-semibold text-amber-400 mb-3">File Cache (L2)</h4>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-surface-400">Files:</span>
                        <span class="text-white font-semibold">{subtitles.file.totalFiles}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Size:</span>
                        <span class="text-amber-400 font-semibold"
                            >{subtitles.file.totalSizeFormatted}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Hits:</span>
                        <span class="text-green-400 font-semibold">{subtitles.file.hits}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Misses:</span>
                        <span class="text-red-400 font-semibold">{subtitles.file.misses}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">Hit Rate:</span>
                        <span
                            class="font-semibold {subtitles.file.hitRate >= 0.5
                                ? 'text-green-400'
                                : 'text-yellow-400'}">
                            {(subtitles.file.hitRate * 100).toFixed(1)}%
                        </span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-surface-400">TTL:</span>
                        <span class="text-surface-300">7 days</span>
                    </div>
                    <div class="mt-3 flex gap-2">
                        <button
                            class="btn btn-sm btn-soft-amber flex-1 center gap-1.5"
                            onclick={() => onClear('file')}
                            disabled={clearing === 'file'}>
                            {#if clearing === 'file'}
                                <span
                                    class="loading-spinner w-3 h-3"
                                    style="border-color: rgb(var(--color-warning-400-rgb) / 0.3); border-top-color: var(--color-warning-400);"
                                ></span>
                                Clearing...
                            {:else}
                                Clear
                            {/if}
                        </button>
                        <button
                            class="btn btn-sm btn-soft-blue flex-1 center gap-1.5"
                            onclick={() => onClear('cleanup')}
                            disabled={clearing === 'cleanup'}
                            title="Remove files older than 7 days">
                            {#if clearing === 'cleanup'}
                                <span class="loading-spinner loading-spinner-primary w-3 h-3"
                                ></span>
                                Cleaning...
                            {:else}
                                Cleanup
                            {/if}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div class="mt-4 text-caption space-y-1">
            <p>
                • <span class="text-purple-400">Memory (L1):</span> Fast in-memory cache, 30min TTL, cleaned
                every 5min
            </p>
            <p>
                • <span class="text-amber-400">File (L2):</span> Persistent file cache, 7 day TTL, cleaned
                daily
            </p>
            <p>
                • <span class="text-blue-400">FFmpeg (L3):</span> Direct extraction from media files (0.1-0.3s)
            </p>
            <p>
                • <span class="text-surface-400">Jellyfin (L4):</span> Fallback to Jellyfin API
            </p>
        </div>
    {/snippet}
</CacheSection>
