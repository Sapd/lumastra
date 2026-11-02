<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Icon, FolderOpen, Trash, ArrowPath, Sparkles } from 'svelte-hero-icons';
    import CacheSection from './CacheSection.svelte';
    import type {
        FilesystemCache,
        FilesystemCacheBudget,
        FilesystemCacheLastCleanup,
        FilesystemCacheImageFormats,
    } from '$lib/types/cache-stats';
    import { formatDate } from '$lib/utils/cache-utils';

    interface Props {
        caches: FilesystemCache[];
        totalSize: string;
        totalFiles: number;
        /** IMAGE_CACHE_MAX_BYTES vs current usage — Tier 1 */
        budget?: FilesystemCacheBudget;
        /** Last cleanup-run summary persisted in Valkey — Tier 2 */
        lastCleanup?: FilesystemCacheLastCleanup | null;
        /** Active AVIF/WebP/pre-gen mode — Tier 3 */
        imageFormats?: FilesystemCacheImageFormats;
        clearing: string | null;
        /** True while a manual cleanup is in flight — disables the button */
        cleaningUp?: boolean;
        onClear: (cacheName: string) => void;
        onClearAll: () => void;
        /** Triggers /api/cache-stats?action=cleanup-image-cache — Tier 2 */
        onCleanupNow?: () => void;
    }

    let {
        caches,
        totalSize,
        totalFiles,
        budget,
        lastCleanup,
        imageFormats,
        clearing,
        cleaningUp = false,
        onClear,
        onClearAll,
        onCleanupNow,
    }: Props = $props();

    // Color the budget bar by pressure: green under 75%, amber 75-90%, red 90+.
    const budgetBarClass = $derived.by(() => {
        if (!budget) return 'bg-blue-500';
        if (budget.percentUsed >= 90) return 'bg-red-500';
        if (budget.percentUsed >= 75) return 'bg-amber-500';
        return 'bg-emerald-500';
    });

    function formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
    }

    /** Duration formatter — sub-second cleanups read in ms; longer runs in s
     *  so multi-minute walks don't render as "248172 ms". */
    function formatDuration(ms: number): string {
        if (ms < 1000) return `${ms} ms`;
        return `${(ms / 1000).toFixed(1)} s`;
    }

    /**
     * Picks a relative-time string (e.g. "2 hours ago") for a cleanup
     * timestamp. Falls back to absolute time for runs older than a day.
     */
    function relativeTime(iso: string): string {
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return iso;
        const deltaMs = Date.now() - then;
        if (deltaMs < 60_000) return 'just now';
        if (deltaMs < 3_600_000) {
            const m = Math.round(deltaMs / 60_000);
            return `${m} minute${m === 1 ? '' : 's'} ago`;
        }
        if (deltaMs < 86_400_000) {
            const h = Math.round(deltaMs / 3_600_000);
            return `${h} hour${h === 1 ? '' : 's'} ago`;
        }
        return new Date(iso).toLocaleString();
    }
</script>

<CacheSection>
    {#snippet header()}
        <h3 class="text-xl font-bold text-white flex items-center gap-2">
            <Icon src={FolderOpen} class="w-6 h-6 text-amber-400" />
            Filesystem Image Caches
            {#if imageFormats}
                <!-- Tier 3: AVIF status badge so operators can see at a glance
                     whether the AVIF tier is on and which pre-gen mode is
                     active without opening the config screen. -->
                {#if imageFormats.avifEnabled}
                    <span
                        class="ml-2 inline-flex items-center gap-1 rounded bg-purple-500/20 px-2 py-0.5 text-xs font-semibold text-purple-300">
                        <Icon src={Sparkles} class="w-3 h-3" />
                        AVIF · {imageFormats.avifPregenMode}
                    </span>
                {:else}
                    <span
                        class="ml-2 inline-flex items-center rounded bg-surface-700 px-2 py-0.5 text-xs font-semibold text-surface-400">
                        AVIF off
                    </span>
                {/if}
                {#if !imageFormats.webpEnabled}
                    <span
                        class="ml-1 inline-flex items-center rounded bg-yellow-500/20 px-2 py-0.5 text-xs font-semibold text-yellow-300">
                        WebP off
                    </span>
                {/if}
            {/if}
        </h3>
        <div class="flex items-center gap-4">
            <span class="text-sm text-surface-400">
                Total: <span class="text-amber-400 font-semibold">{totalSize}</span>
                ({totalFiles} files)
            </span>
            {#if onCleanupNow}
                <button
                    class="btn btn-sm btn-soft-blue flex items-center gap-1.5"
                    onclick={onCleanupNow}
                    disabled={cleaningUp || clearing !== null}
                    title="Run TTL + size-budget cleanup now">
                    {#if cleaningUp}
                        <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                    {:else}
                        <Icon src={ArrowPath} class="w-4 h-4" />
                    {/if}
                    Run cleanup
                </button>
            {/if}
            <button
                class="btn btn-sm btn-soft-red flex items-center gap-1.5"
                onclick={onClearAll}
                disabled={clearing !== null || cleaningUp}>
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
        <!-- Tier 1: budget bar. Showing the cap visually is the difference
             between "I think we have headroom" and "we're 92% full, the next
             cleanup will start evicting". -->
        {#if budget}
            <div class="mb-4 rounded-lg bg-surface-800/50 p-4">
                <div class="mb-2 flex items-center justify-between text-sm">
                    <span class="font-medium text-white"> Cache size budget </span>
                    <span class="text-surface-400">
                        <span class="font-semibold text-white">{budget.usedFormatted}</span>
                        / {budget.budgetFormatted}
                        {#if budget.budgetBytes > 0}
                            <span class="ml-1 text-surface-500">
                                ({budget.percentUsed}%)
                            </span>
                        {/if}
                    </span>
                </div>
                {#if budget.budgetBytes > 0}
                    <div class="h-2 w-full overflow-hidden rounded-full bg-surface-700">
                        <div
                            class="h-full transition-all duration-300 {budgetBarClass}"
                            style="width: {budget.percentUsed}%">
                        </div>
                    </div>
                    {#if !budget.withinBudget}
                        <p class="mt-2 text-xs text-red-400">
                            Over budget — the next cleanup pass will evict oldest files until under
                            the limit.
                        </p>
                    {/if}
                {:else}
                    <p class="mt-1 text-xs text-surface-500">
                        IMAGE_CACHE_MAX_BYTES = 0 — size enforcement disabled.
                    </p>
                {/if}
            </div>
        {/if}

        <!-- Tier 2: last-cleanup summary. Renders as a compact strip below
             the budget bar so the two pieces of info read together. -->
        {#if lastCleanup}
            <div
                class="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-surface-800/30 p-3 text-xs sm:grid-cols-4">
                <div>
                    <div class="text-surface-500">Last cleanup</div>
                    <div class="font-medium text-surface-200">
                        {relativeTime(lastCleanup.finishedAt)}
                    </div>
                </div>
                <div>
                    <div class="text-surface-500">Expired (TTL) freed</div>
                    <div class="font-medium text-surface-200">
                        {formatBytes(lastCleanup.ttlFreedBytes)}
                        <span class="text-surface-500">({lastCleanup.ttlDeletedFiles} files)</span>
                    </div>
                </div>
                <div>
                    <div class="text-surface-500">Over-budget freed</div>
                    <div class="font-medium text-surface-200">
                        {formatBytes(lastCleanup.budgetDeletedBytes)}
                        <span class="text-surface-500"
                            >({lastCleanup.budgetDeletedFiles} files)</span>
                    </div>
                </div>
                <div>
                    <div class="text-surface-500">Run duration</div>
                    <div class="font-medium text-surface-200">
                        {formatDuration(lastCleanup.durationMs)}
                        {#if !lastCleanup.success}
                            <span class="ml-1 text-red-400">(errors)</span>
                        {/if}
                    </div>
                </div>
            </div>
        {:else}
            <!-- Distinguish "never run" from "data not loaded yet"
                 so a fresh deploy doesn't look like a broken admin page. -->
            <div class="mb-4 rounded-lg bg-surface-800/30 p-3 text-xs text-surface-500">
                Image cache cleanup has not run yet (or its summary has not been recorded). It runs
                automatically on startup if IMAGE_CACHE_CLEANUP_ON_STARTUP is enabled — or click
                "Run cleanup" above.
            </div>
        {/if}

        <div class="overflow-x-auto">
            <table class="w-full">
                <thead>
                    <tr class="text-left text-surface-400 text-sm border-b border-surface-700">
                        <th class="pb-3 font-semibold">Cache</th>
                        <th class="pb-3 font-semibold">Path</th>
                        <th class="pb-3 font-semibold text-right"
                            >{m.card_file_info_files_label()}</th>
                        <th class="pb-3 font-semibold text-right">{m.card_file_info_size()}</th>
                        <th class="pb-3 font-semibold text-center">Formats</th>
                        <th class="pb-3 font-semibold text-right">{m.browse_oldest()}</th>
                        <th class="pb-3 font-semibold text-right">{m.browse_newest()}</th>
                        <th class="pb-3 font-semibold text-center">Actions</th>
                    </tr>
                </thead>
                <tbody class="text-sm">
                    {#each caches as cache (cache.name)}
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
                                <code
                                    class="text-xs text-surface-500 bg-surface-800 px-2 py-1 rounded"
                                    >{cache.path}</code>
                            </td>
                            <td class="py-4 text-right">
                                {#if cache.exists}
                                    <span class="text-blue-400">{cache.fileCount}</span>
                                {:else}
                                    <span class="text-surface-600">-</span>
                                {/if}
                            </td>
                            <td class="py-4 text-right">
                                {#if cache.exists}
                                    <span class="text-amber-400 font-medium"
                                        >{cache.totalSizeFormatted}</span>
                                {:else}
                                    <span class="text-surface-600">-</span>
                                {/if}
                            </td>
                            <td class="py-4 text-center">
                                <!-- Tier 3: render only the format buckets
                                     that have entries so the cell stays
                                     compact — most caches are 1 or 2 formats. -->
                                {#if cache.exists && cache.formatBreakdown}
                                    {@const fb = cache.formatBreakdown}
                                    <div
                                        class="flex flex-wrap items-center justify-center gap-1 text-xs">
                                        {#if fb.avif > 0}
                                            <span
                                                class="rounded bg-purple-500/20 px-1.5 py-0.5 text-purple-300"
                                                >AVIF {fb.avif}</span>
                                        {/if}
                                        {#if fb.webp > 0}
                                            <span
                                                class="rounded bg-blue-500/20 px-1.5 py-0.5 text-blue-300"
                                                >WebP {fb.webp}</span>
                                        {/if}
                                        {#if fb.jpg > 0}
                                            <span
                                                class="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300"
                                                >JPG {fb.jpg}</span>
                                        {/if}
                                        {#if fb.png > 0}
                                            <span
                                                class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300"
                                                >PNG {fb.png}</span>
                                        {/if}
                                        {#if fb.other > 0}
                                            <span
                                                class="rounded bg-surface-600/40 px-1.5 py-0.5 text-surface-400"
                                                >other {fb.other}</span>
                                        {/if}
                                    </div>
                                {:else}
                                    <span class="text-surface-600">-</span>
                                {/if}
                            </td>
                            <td class="py-4 text-right text-surface-400"
                                >{formatDate(cache.oldestFile)}</td>
                            <td class="py-4 text-right text-surface-400"
                                >{formatDate(cache.newestFile)}</td>
                            <td class="py-4 text-center">
                                {#if cache.exists && cache.fileCount > 0}
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
                                {:else}
                                    <span class="text-surface-600 text-xs">Empty</span>
                                {/if}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/snippet}
</CacheSection>
