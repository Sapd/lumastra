<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';
    import { useAutoRefresh } from '$lib/utils/use-auto-refresh.svelte';
    import {
        Icon,
        ArrowPath,
        XCircle,
        CircleStack,
        ChartBarSquare,
        Fire,
        PlayCircle,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import {
        AdminPageHeader,
        StatCard,
        NamespaceTable,
        FilesystemCacheSection,
        StandaloneCacheSection,
        SubtitleCacheCard,
    } from '$lib/components/admin';
    import { handleCacheAction } from '$lib/utils/cache-utils';
    import type { CacheStatsResponse } from '$lib/types/cache-stats';
    import * as adminApi from '$lib/api/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { modals } from '$lib/stores/modal.store';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';

    let cacheStats = $state<CacheStatsResponse | null>(null);
    let cacheStatsLoading = $state(false);
    let clearingFilesystemCache = $state<string | null>(null);
    let clearingStandaloneCache = $state<string | null>(null);
    let clearingSubtitleCache = $state<string | null>(null);

    useAutoRefresh(loadCacheStats, 30000);

    async function loadCacheStats() {
        cacheStatsLoading = true;
        try {
            const { data } = await adminApi.getCacheStats();
            cacheStats = data ?? null;
        } catch (error) {
            console.error('Failed to load cache stats:', error);
        } finally {
            cacheStatsLoading = false;
        }
    }

    const clearCache = async (namespace: string) => {
        await handleCacheAction({
            confirmMsg: '',
            apiEndpoint: '/api/cache-stats?action=clear',
            payload: { namespace },
            successMsg: m.admin_cache_cleared_success({ name: namespace }),
            errorMsg: m.admin_cache_clear_failed(),
            onSuccess: loadCacheStats,
        });
    };

    const clearAllCaches = () => {
        // Developer area (admin IA redesign, spec §3.7): the most
        // destructive action on this page gets the proper confirm modal
        // instead of a raw browser confirm() — the other per-namespace
        // clear buttons below keep handleCacheAction's confirm() as-is
        // (narrower blast radius, out of this step's scope).
        modals.open(ConfirmModal, {
            title: m.route_admin_cache_clear_all(),
            body: m.route_admin_cache_clear_all_confirm(),
            confirmText: m.route_admin_cache_clear_all(),
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                await handleCacheAction({
                    confirmMsg: '',
                    apiEndpoint: '/api/cache-stats?action=clear-all',
                    successMsg: m.route_admin_cache_clear_all_success(),
                    errorMsg: m.route_admin_cache_clear_all_error(),
                    onSuccess: loadCacheStats,
                });
            },
        });
    };

    const clearFilesystemCache = async (cacheName: string) => {
        clearingFilesystemCache = cacheName;
        await handleCacheAction({
            confirmMsg: m.admin_cache_clear_fs_confirm({ name: cacheName }),
            apiEndpoint: '/api/cache-stats?action=clear-filesystem',
            payload: { cacheName },
            successMsg: m.admin_cache_fs_cleared_success({ name: cacheName }),
            errorMsg: m.admin_cache_fs_clear_failed(),
            onSuccess: loadCacheStats,
        });
        clearingFilesystemCache = null;
    };

    const clearAllFilesystemCaches = async () => {
        clearingFilesystemCache = 'all';
        await handleCacheAction({
            confirmMsg: m.route_admin_cache_clear_filesystem_confirm(),
            apiEndpoint: '/api/cache-stats?action=clear-all-filesystem',
            successMsg: m.route_admin_cache_clear_filesystem_success(),
            errorMsg: m.route_admin_cache_clear_filesystem_error(),
            onSuccess: loadCacheStats,
        });
        clearingFilesystemCache = null;
    };

    let runningImageCleanup = $state(false);
    const runImageCacheCleanup = async () => {
        runningImageCleanup = true;
        // Non-destructive: only deletes expired (TTL-based) and over-budget
        // entries. Skip the confirm dialog — it's the same passive cleanup
        // that runs on startup. try/finally so a thrown handleCacheAction
        // doesn't permanently disable the button until page reload.
        try {
            await handleCacheAction({
                confirmMsg: '',
                apiEndpoint: '/api/cache-stats?action=cleanup-image-cache',
                successMsg: m.route_admin_cache_image_cleanup_success(),
                errorMsg: m.route_admin_cache_image_cleanup_error(),
                onSuccess: loadCacheStats,
            });
        } finally {
            runningImageCleanup = false;
        }
    };

    const clearStandaloneCache = async (cacheName: string) => {
        clearingStandaloneCache = cacheName;
        await handleCacheAction({
            confirmMsg: m.admin_cache_clear_standalone_confirm({ name: cacheName }),
            apiEndpoint: '/api/cache-stats?action=clear-standalone',
            payload: { cacheName },
            successMsg: m.admin_cache_cleared_success({ name: cacheName }),
            errorMsg: m.admin_cache_standalone_clear_failed(),
            onSuccess: loadCacheStats,
        });
        clearingStandaloneCache = null;
    };

    const clearAllStandaloneCaches = async () => {
        clearingStandaloneCache = 'all';
        await handleCacheAction({
            confirmMsg: m.admin_cache_clear_all_standalone_confirm(),
            apiEndpoint: '/api/cache-stats?action=clear-all-standalone',
            successMsg: m.admin_cache_all_standalone_cleared_success(),
            errorMsg: m.admin_cache_all_standalone_clear_failed(),
            onSuccess: loadCacheStats,
        });
        clearingStandaloneCache = null;
    };

    const clearSubtitleCache = async (type: 'memory' | 'file' | 'cleanup') => {
        const actionMap = {
            memory: 'clear-subtitle-memory',
            file: 'clear-subtitle-file',
            cleanup: 'cleanup-subtitle-file',
        };

        const confirmMap = {
            memory: m.admin_cache_subtitle_memory_confirm(),
            file: m.admin_cache_subtitle_file_confirm(),
            cleanup: '',
        };
        const successMap = {
            memory: m.admin_cache_subtitle_memory_success(),
            file: m.admin_cache_subtitle_file_success(),
            cleanup: m.admin_cache_subtitle_cleanup_success(),
        };
        const errorMap = {
            memory: m.admin_cache_subtitle_memory_error(),
            file: m.admin_cache_subtitle_file_error(),
            cleanup: m.admin_cache_subtitle_cleanup_error(),
        };

        clearingSubtitleCache = type;
        await handleCacheAction({
            confirmMsg: confirmMap[type],
            apiEndpoint: `/api/cache-stats?action=${actionMap[type]}`,
            successMsg: successMap[type],
            errorMsg: errorMap[type],
            onSuccess: loadCacheStats,
        });
        clearingSubtitleCache = null;
    };
</script>

<div class="space-y-8">
    <!-- Header -->
    <AdminPageHeader
        icon={adminPageIcons['/admin/developer/cache']}
        title={m.route_admin_cache_title()}
        description={m.route_admin_cache_description()}>
        <div class="flex gap-2">
            <button class="btn btn-blue" onclick={loadCacheStats} disabled={cacheStatsLoading}>
                <Icon src={ArrowPath} class="w-5 h-5 {cacheStatsLoading ? 'animate-spin' : ''}" />
                {m.route_admin_cache_refresh()}
            </button>
            <button class="btn btn-red" onclick={clearAllCaches} disabled={cacheStatsLoading}>
                <Icon src={XCircle} class="w-5 h-5" />
                {m.route_admin_cache_clear_all()}
            </button>
        </div>
    </AdminPageHeader>

    {#if cacheStatsLoading && !cacheStats}
        <div class="text-center py-20">
            <span class="loading-spinner loading-spinner-lg loading-spinner-primary mx-auto"></span>
            <p class="mt-4 text-surface-400 font-medium">
                {m.route_admin_cache_loading()}
            </p>
        </div>
    {:else if cacheStats}
        <!-- Overall Health & Metrics -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
            <StatCard
                title={m.route_admin_cache_l1_title()}
                subtitle={m.route_admin_cache_l1_subtitle()}
                value={cacheStats.health?.l1 ? m.route_admin_cache_healthy() : m.admin_error()}
                healthy={cacheStats.health?.l1}
                icon={CircleStack} />

            <StatCard
                icon={CircleStack}
                iconColor={cacheStats.health?.l2 ? 'text-blue-400' : 'text-yellow-400'}
                title={m.route_admin_cache_l2_title()}
                subtitle={m.route_admin_cache_l2_subtitle()}
                value={cacheStats.health?.l2
                    ? m.route_admin_cache_healthy()
                    : m.route_admin_cache_degraded()}
                valueColor={cacheStats.health?.l2 ? 'text-green-400' : 'text-yellow-400'}>
                {#if cacheStats.aggregate}
                    <div class="text-muted mt-2">
                        <p>
                            {m.admin_cache_l2_hits()}
                            <span class="text-blue-400 font-medium"
                                >{cacheStats.aggregate.totalL2Hits || 0}</span>
                        </p>
                        <p>
                            {m.admin_cache_l2_misses()}
                            <span class="text-surface-300 font-medium"
                                >{cacheStats.aggregate.totalL2Misses || 0}</span>
                        </p>
                        {#if cacheStats.aggregate.totalL2Errors > 0}
                            <p class="text-yellow-400 font-medium mt-1">
                                {m.admin_cache_connection_errors({
                                    count: cacheStats.aggregate.totalL2Errors,
                                })}
                            </p>
                        {/if}
                    </div>
                {/if}
            </StatCard>

            <StatCard
                icon={ChartBarSquare}
                iconColor="text-purple-400"
                title={m.route_admin_cache_hit_rate_title()}
                value="{(cacheStats.aggregate?.hitRate?.combined * 100 || 0).toFixed(1)}%"
                valueColor="text-purple-400">
                <p class="text-muted mt-2">
                    L1: {((cacheStats.aggregate?.hitRate?.l1 ?? 0) * 100).toFixed(1)}% • L2: {(
                        (cacheStats.aggregate?.hitRate?.l2 ?? 0) * 100
                    ).toFixed(1)}%
                </p>
            </StatCard>

            <StatCard
                icon={Fire}
                iconColor="text-orange-400"
                title={m.route_admin_cache_total_requests()}
                value={(cacheStats.aggregate?.totalL1Hits || 0) +
                    (cacheStats.aggregate?.totalL1Misses || 0)}
                valueColor="text-orange-400">
                <p class="text-muted mt-2">
                    {m.admin_cache_hits_count({ count: cacheStats.aggregate?.totalL1Hits || 0 })} •
                    {m.admin_cache_misses_count({
                        count: cacheStats.aggregate?.totalL1Misses || 0,
                    })}
                </p>
            </StatCard>
        </div>

        <!-- Cache Namespaces -->
        {#if cacheStats.namespaces}
            <NamespaceTable namespaces={cacheStats.namespaces} onClear={clearCache} />
        {/if}

        <!-- Filesystem Caches -->
        {#if cacheStats.filesystem}
            <FilesystemCacheSection
                caches={cacheStats.filesystem.caches}
                totalSize={cacheStats.filesystem.totalSizeFormatted}
                totalFiles={cacheStats.filesystem.totalFileCount}
                budget={cacheStats.filesystem.budget}
                lastCleanup={cacheStats.filesystem.lastCleanup}
                imageFormats={cacheStats.filesystem.imageFormats}
                clearing={clearingFilesystemCache}
                cleaningUp={runningImageCleanup}
                onClear={clearFilesystemCache}
                onClearAll={clearAllFilesystemCaches}
                onCleanupNow={runImageCacheCleanup} />
        {/if}

        <!-- Transcoding Cache (HLS Segments) -->
        {#if cacheStats.transcoding?.enabled}
            {@const tc = cacheStats.transcoding}
            <div class="card-gradient-lg">
                <div class="between mb-6">
                    <h3 class="text-xl font-bold text-white flex items-center gap-2">
                        <Icon src={PlayCircle} class="w-6 h-6 text-pink-400" />
                        {m.route_admin_cache_transcoding_title()}
                    </h3>
                    <span class="text-muted">Lumastra HLS</span>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_current_size()}
                        </p>
                        <p class="text-2xl font-bold text-pink-400">
                            {tc.currentSizeFormatted}
                        </p>
                        <p class="text-caption mt-1">
                            {#if tc.activeJobs > 0}
                                {m.admin_cache_active_jobs({ count: tc.activeJobs })}
                            {:else}
                                {m.route_admin_cache_no_active_jobs()}
                            {/if}
                        </p>
                    </div>

                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_max_size_24h()}
                        </p>
                        <p class="text-2xl font-bold text-orange-400">
                            {tc.maxSize24hFormatted}
                        </p>
                        {#if tc.maxSize24hTimestamp}
                            <p class="text-caption mt-1">
                                {new SvelteDate(tc.maxSize24hTimestamp).toLocaleDateString()}
                            </p>
                        {/if}
                    </div>

                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_directory()}
                        </p>
                        <p
                            class="text-lg font-medium {tc.exists
                                ? 'text-green-400'
                                : 'text-surface-500'}">
                            {tc.exists
                                ? m.route_admin_cache_exists()
                                : m.route_admin_cache_not_created()}
                        </p>
                        <p class="text-caption mt-1 truncate" title={tc.path}>
                            {tc.path}
                        </p>
                    </div>

                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_samples_24h()}
                        </p>
                        <p class="text-2xl font-bold text-blue-400">
                            {tc.sampleCount}
                        </p>
                        <p class="text-caption mt-1">
                            {m.route_admin_cache_every_5_min()}
                        </p>
                    </div>
                </div>
            </div>
        {/if}

        <!-- Preview Cache (content-addressed hover/scrub artifacts) -->
        {#if cacheStats.previewCache}
            {@const pc = cacheStats.previewCache}
            <div class="card-gradient-lg">
                <div class="between mb-6">
                    <h3 class="text-xl font-bold text-white flex items-center gap-2">
                        <Icon src={PlayCircle} class="w-6 h-6 text-cyan-400" />
                        {m.route_admin_cache_preview_title()}
                    </h3>
                    <span
                        class="text-sm font-medium {pc.enabled
                            ? 'text-green-400'
                            : 'text-surface-500'}">
                        {pc.enabled
                            ? m.route_admin_cache_preview_enabled()
                            : m.route_admin_cache_preview_disabled()}
                    </span>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_preview_size()}
                        </p>
                        <p class="text-2xl font-bold text-cyan-400">
                            {pc.totalBytesFormatted}
                        </p>
                        <p class="text-caption mt-1">
                            {pc.percentUsed}% •
                            {m.route_admin_cache_preview_budget({ budget: pc.maxBytesFormatted })}
                        </p>
                    </div>

                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_preview_entries()}
                        </p>
                        <p class="text-2xl font-bold text-blue-400">
                            {pc.entries}
                        </p>
                        <p class="text-caption mt-1">
                            {m.route_admin_cache_preview_ready_warming({
                                ready: pc.ready,
                                warming: pc.warming,
                            })}
                        </p>
                    </div>

                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_preview_hit_rate()}
                        </p>
                        <p class="text-2xl font-bold text-purple-400">
                            {(pc.hitRate * 100).toFixed(1)}%
                        </p>
                        <p class="text-caption mt-1">
                            {m.route_admin_cache_preview_hits_misses({
                                hits: pc.hits,
                                misses: pc.misses,
                            })}
                        </p>
                    </div>

                    <div class="card-glass">
                        <p class="text-muted mb-1">
                            {m.route_admin_cache_preview_evictions()}
                        </p>
                        <p class="text-2xl font-bold text-orange-400">
                            {pc.evictions}
                        </p>
                    </div>
                </div>
            </div>
        {/if}

        <!-- Standalone LRU Caches -->
        {#if cacheStats.standalone?.caches?.length}
            <StandaloneCacheSection
                caches={cacheStats.standalone.caches}
                totalEntries={cacheStats.standalone.aggregate?.totalEntries || 0}
                totalMaxSize={cacheStats.standalone.aggregate?.totalMaxSize || 0}
                overallHitRate={cacheStats.standalone.aggregate?.overallHitRate || 0}
                clearing={clearingStandaloneCache}
                onClear={clearStandaloneCache}
                onClearAll={clearAllStandaloneCaches} />
        {/if}

        <!-- Subtitle Cache -->
        {#if cacheStats.subtitles}
            <SubtitleCacheCard
                subtitles={cacheStats.subtitles}
                clearing={clearingSubtitleCache}
                onClear={clearSubtitleCache} />
        {/if}
    {:else}
        <div class="card-base">
            <p class="text-surface-400">{m.route_admin_cache_no_stats()}</p>
        </div>
    {/if}
</div>
