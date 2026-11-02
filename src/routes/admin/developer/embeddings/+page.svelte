<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import type {
        EmbeddingOverviewStats,
        VideoEmbeddingStats,
        MusicEmbeddingStats,
        EmbeddingPreviewsResponse,
        EmbeddingTextResponse,
    } from '$lib/schemas/admin-types';
    import {
        AdminPageHeader,
        DataQualityMetric,
        EmbeddingSearchWidget,
        EmbeddingLookupWidget,
    } from '$lib/components/admin';
    import { Tabs } from '$lib/components/ui';

    type TabItem = {
        id: string;
        label: string;
        badge?: string | number;
    };
    import { getMediaTypeBadge } from '$lib/components/admin/media/media-type-badge';
    import * as aiApi from '$lib/api/ai';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';
    import { isMovie, isSeries } from '$lib/shared/media-types.js';

    // ── Helpers ─────────────────────────────────────────────────────────
    const getExternalLabel = (
        externalIds: Record<string, string | undefined> | undefined,
    ): string | null => {
        if (!externalIds) return null;
        for (const [key, val] of Object.entries(externalIds)) {
            if (key !== 'internal' && val) return `${key}:${val}`;
        }
        return null;
    };

    const formatRelativeTime = (dateStr: string | undefined): string => {
        if (!dateStr) return m.route_admin_embeddings_unknown();
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return m.calendar_today();
        if (diffDays === 1) return m.date_yesterday();
        if (diffDays < 7) return m.date_days_ago({ count: diffDays });
        if (diffDays < 30)
            return m.route_admin_api_tokens_weeks_ago({ count: Math.floor(diffDays / 7) });
        return date.toLocaleDateString();
    };

    // ── State ───────────────────────────────────────────────────────────
    let overviewStats = $state<EmbeddingOverviewStats | null>(null);
    let videoStats = $state<VideoEmbeddingStats | null>(null);
    let musicStats = $state<MusicEmbeddingStats | null>(null);
    let embeddingPreviews = $state<EmbeddingPreviewsResponse | null>(null);
    let loading = $state(true);
    let videoLoading = $state(false);
    let musicLoading = $state(false);
    let videoError = $state(false);
    let musicError = $state(false);
    let activeTab = $state('video');

    // Section visibility
    let showNoExternalSection = $state(false);
    let showQualityDetails = $state(false);
    let showRecentActivity = $state(true);

    // Search → Lookup bridge
    let videoLookupKey = $state<string | undefined>(undefined);
    let musicLookupKey = $state<string | undefined>(undefined);

    // Selected item for embedding text detail panel
    let videoSelectedId = $state<string | undefined>(undefined);
    let musicSelectedId = $state<string | undefined>(undefined);
    let videoEmbeddingText = $state<EmbeddingTextResponse | null>(null);
    let musicEmbeddingText = $state<EmbeddingTextResponse | null>(null);
    let videoEmbeddingLoading = $state(false);
    let musicEmbeddingLoading = $state(false);

    let videoTextRequest = 0;
    let musicTextRequest = 0;
    onDestroy(() => {
        videoTextRequest++;
        musicTextRequest++;
    });

    const loadEmbeddingText = async (id: string, tab: 'video' | 'music'): Promise<void> => {
        const request = tab === 'video' ? ++videoTextRequest : ++musicTextRequest;
        const isCurrent = (): boolean =>
            request === (tab === 'video' ? videoTextRequest : musicTextRequest);
        if (tab === 'video') {
            videoEmbeddingLoading = true;
            videoEmbeddingText = null;
        } else {
            musicEmbeddingLoading = true;
            musicEmbeddingText = null;
        }
        try {
            const { data, error } = await aiApi.getEmbeddingText(id);
            if (isCurrent() && !error && data) {
                if (tab === 'video') {
                    videoEmbeddingText = data;
                } else {
                    musicEmbeddingText = data;
                }
            }
        } catch (err) {
            console.error('Failed to load embedding text:', err);
        } finally {
            if (isCurrent() && tab === 'video') {
                videoEmbeddingLoading = false;
            } else if (isCurrent()) {
                musicEmbeddingLoading = false;
            }
        }
    };

    const selectVideoItem = (id: string): void => {
        videoSelectedId = id;
        videoLookupKey = id;
        loadEmbeddingText(id, 'video');
    };

    const selectMusicItem = (id: string): void => {
        musicSelectedId = id;
        musicLookupKey = id;
        loadEmbeddingText(id, 'music');
    };

    // ── Tab items ───────────────────────────────────────────────────────
    let tabItems: TabItem[] = $derived(
        tabItemsOf(searchMeta).map((tab) => ({
            ...tab,
            badge: tab.id === 'video' ? videoBadge : musicBadge,
        })),
    );
    let videoBadge = $derived(
        overviewStats?.mediaTypeBreakdown
            .filter(
                (b: { mediaType: string; count: number }) =>
                    isMovie(b.mediaType) || isSeries(b.mediaType),
            )
            .reduce((s: number, b: { count: number }) => s + b.count, 0) ?? undefined,
    );
    let musicBadge = $derived(
        overviewStats?.mediaTypeBreakdown.find(
            (b: { mediaType: string }) => b.mediaType === 'track',
        )?.count ?? undefined,
    );

    // ── Derived scores ──────────────────────────────────────────────────
    let dataQualityScore = $derived.by(() => {
        if (!videoStats || !overviewStats) return 0;
        const videoCount = overviewStats.mediaTypeBreakdown
            .filter((b) => isMovie(b.mediaType) || isSeries(b.mediaType))
            .reduce((s, b) => s + b.count, 0);
        if (videoCount === 0) return 0;
        const q = videoStats.dataQuality;
        return Math.round(
            (1 - q.missingOverview / videoCount) * 40 +
                (1 - q.missingGenres / videoCount) * 30 +
                (1 - q.missingActors / videoCount) * 20 +
                (q.withMdblistScore / videoCount) * 10,
        );
    });

    let musicQualityScore = $derived.by(() => {
        if (!musicStats || musicStats.totalTracks === 0) return 0;
        const t = musicStats.totalTracks;
        const q = musicStats.dataQuality;
        return Math.round(
            (1 - q.missingArtist / t) * 40 +
                (1 - q.missingGenre / t) * 30 +
                (1 - q.missingAlbum / t) * 20 +
                (1 - q.missingBpm / t) * 10,
        );
    });

    // ── Loaders ─────────────────────────────────────────────────────────
    const loadOverviewStats = async (): Promise<void> => {
        loading = true;
        try {
            const { data, error } = await aiApi.getEmbeddingStats();
            if (!error) {
                overviewStats = data ?? null;
            }
        } catch (error) {
            console.error('Failed to load overview stats:', error);
            toasts.error(getErrorMessage(error, m.route_admin_embeddings_load_overview_error()));
        } finally {
            loading = false;
        }
    };

    const loadVideoStats = async (): Promise<void> => {
        videoError = false;
        videoLoading = true;
        try {
            const { data, error } = await aiApi.getVideoEmbeddingStats();
            if (error || !data) {
                videoError = true;
            } else {
                videoStats = data;
            }
        } catch (error) {
            console.error('Failed to load video stats:', error);
            toasts.error(getErrorMessage(error, m.route_admin_embeddings_load_video_error()));
            videoError = true;
        } finally {
            videoLoading = false;
        }
    };

    const loadMusicStats = async (): Promise<void> => {
        musicError = false;
        musicLoading = true;
        try {
            const { data, error } = await aiApi.getMusicEmbeddingStats();
            if (error || !data) {
                musicError = true;
            } else {
                musicStats = data;
            }
        } catch (error) {
            console.error('Failed to load music stats:', error);
            toasts.error(getErrorMessage(error, m.route_admin_embeddings_load_music_error()));
            musicError = true;
        } finally {
            musicLoading = false;
        }
    };

    const loadEmbeddingPreviews = async (): Promise<void> => {
        try {
            const { data, error } = await aiApi.getEmbeddingPreviews();
            if (!error) {
                embeddingPreviews = data ?? null;
            }
        } catch (error) {
            console.error('Failed to load embedding previews:', error);
        }
    };

    // ── Lazy loading via $effect ────────────────────────────────────────
    $effect(() => {
        if (activeTab === 'video' && !videoStats && !videoLoading && !videoError) {
            loadVideoStats();
        } else if (activeTab === 'music' && !musicStats && !musicLoading && !musicError) {
            loadMusicStats();
        }
    });

    // ── Refresh all ─────────────────────────────────────────────────────
    const refreshAll = (): void => {
        overviewStats = null;
        videoStats = null;
        musicStats = null;
        videoLoading = false;
        musicLoading = false;
        videoError = false;
        musicError = false;
        loadOverviewStats();
        loadEmbeddingPreviews();
    };

    // ── Init ────────────────────────────────────────────────────────────
    onMount(() => {
        loadOverviewStats();
        loadEmbeddingPreviews();
    });
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/developer/embeddings']}
        title={m.route_admin_embeddings_title()}
        description={m.route_admin_embeddings_description()}>
        <a
            href={resolve('/admin/vod-embeddings')}
            class="btn btn-sm btn-secondary flex items-center gap-2">
            VOD Coverage
        </a>
        <button
            class="btn btn-sm btn-blue flex items-center gap-2"
            onclick={refreshAll}
            disabled={loading}>
            {#if loading}
                <span class="loading-spinner"></span>
            {/if}
            {m.btn_refresh()}
        </button>
    </AdminPageHeader>

    <!-- ═══════════════════════════════════════════════════════════════ -->
    <!-- Overview Section (always loaded)                               -->
    <!-- ═══════════════════════════════════════════════════════════════ -->
    {#if overviewStats}
        <!-- Compact Overview: total + embedding source coverage -->
        <div class="card-base">
            <div class="flex flex-wrap items-center gap-6">
                <div>
                    <p class="text-label">{m.admin_embeddings_total_items()}</p>
                    <p class="text-2xl font-bold text-white">
                        {overviewStats.totalItems.toLocaleString()}
                    </p>
                </div>
                <div class="h-10 w-px bg-surface-700 hidden sm:block"></div>
                {#each overviewStats.embeddingSourceBreakdown as src (src.source)}
                    <div>
                        <p class="text-label capitalize">{src.source}</p>
                        <p class="text-2xl font-bold text-blue-400">
                            {src.count.toLocaleString()}
                        </p>
                    </div>
                {/each}
            </div>
        </div>
    {:else}
        <div class="card-base p-8">
            <div class="center-col gap-3">
                <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                <p class="text-surface-400">{m.loading()}</p>
            </div>
        </div>
    {/if}

    <!-- ═══════════════════════════════════════════════════════════════ -->
    <!-- Tabs: Video / Music                                            -->
    <!-- ═══════════════════════════════════════════════════════════════ -->
    <Tabs items={tabItems} bind:active={activeTab} syncToUrl variant="underline">
        {#snippet children({ active })}
            {#if active === 'video'}
                <!-- ─── Video Tab ─────────────────────────────────── -->
                {#if videoLoading && !videoStats}
                    <div class="card-base p-8">
                        <div class="center-col gap-3">
                            <span class="loading-spinner loading-spinner-lg loading-spinner-primary"
                            ></span>
                            <p class="text-surface-400">
                                {m.loading()}
                            </p>
                        </div>
                    </div>
                {:else if videoStats && overviewStats}
                    {@const videoCount = overviewStats.mediaTypeBreakdown
                        .filter((b) => isMovie(b.mediaType) || isSeries(b.mediaType))
                        .reduce((s, b) => s + b.count, 0)}
                    <div class="space-y-4">
                        <!-- Data Quality -->
                        <div class="card-base">
                            <button
                                class="w-full between text-left"
                                onclick={() => (showQualityDetails = !showQualityDetails)}>
                                <div>
                                    <h3 class="text-subtitle font-medium">
                                        {m.route_admin_embeddings_data_quality()}
                                        <span
                                            class="ml-2 text-sm {dataQualityScore >= 80
                                                ? 'text-green-400'
                                                : dataQualityScore >= 60
                                                  ? 'text-yellow-400'
                                                  : 'text-red-400'}">
                                            {dataQualityScore}%
                                        </span>
                                    </h3>
                                    <p class="text-caption">
                                        {m.admin_embeddings_quality_avg_caption({
                                            chars: videoStats.dataQuality.avgOverviewLength,
                                            actors: videoStats.dataQuality.avgActorCount,
                                            genres: videoStats.dataQuality.avgGenreCount,
                                        })}
                                    </p>
                                </div>
                                <span class="text-muted">{showQualityDetails ? '▼' : '▶'}</span>
                            </button>

                            {#if showQualityDetails}
                                <div
                                    class="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                    <DataQualityMetric
                                        label="MDBList Score"
                                        value={videoStats.dataQuality.withMdblistScore}
                                        total={videoCount}
                                        description={m.admin_embeddings_items_enriched({
                                            count: videoStats.dataQuality.withMdblistScore.toLocaleString(),
                                        })}
                                        color="bg-green-500" />

                                    <DataQualityMetric
                                        label={m.admin_embeddings_streaming_services()}
                                        value={videoStats.dataQuality.withStreamingServices}
                                        total={videoCount}
                                        description={m.admin_embeddings_items_streaming_info({
                                            count: videoStats.dataQuality.withStreamingServices.toLocaleString(),
                                        })}
                                        color="bg-blue-500" />

                                    <DataQualityMetric
                                        label={m.admin_embeddings_has_overview()}
                                        value={videoCount - videoStats.dataQuality.missingOverview}
                                        total={videoCount}
                                        description={m.admin_embeddings_overview_missing_short({
                                            missing: videoStats.dataQuality.missingOverview,
                                            short: videoStats.dataQuality.veryShortOverview,
                                        })}
                                        color="bg-blue-500"
                                        thresholds={{
                                            good: 100,
                                            warning: 80,
                                        }} />

                                    <DataQualityMetric
                                        label={m.admin_embeddings_has_genres()}
                                        value={videoCount - videoStats.dataQuality.missingGenres}
                                        total={videoCount}
                                        description={m.admin_embeddings_items_missing_genres({
                                            count: videoStats.dataQuality.missingGenres,
                                        })}
                                        color="bg-blue-500"
                                        thresholds={{
                                            good: 100,
                                            warning: 80,
                                        }} />

                                    <DataQualityMetric
                                        label={m.admin_embeddings_has_actors()}
                                        value={videoCount - videoStats.dataQuality.missingActors}
                                        total={videoCount}
                                        description={m.admin_embeddings_items_missing_actors({
                                            count: videoStats.dataQuality.missingActors.toLocaleString(),
                                        })}
                                        color="bg-blue-500"
                                        thresholds={{
                                            good: 100,
                                            warning: 80,
                                        }} />

                                    <DataQualityMetric
                                        label={m.admin_embeddings_has_directors()}
                                        value={videoCount - videoStats.dataQuality.missingDirectors}
                                        total={videoCount}
                                        description={m.admin_embeddings_items_missing_directors({
                                            count: videoStats.dataQuality.missingDirectors.toLocaleString(),
                                        })}
                                        color="bg-blue-500"
                                        thresholds={{ warning: 50 }} />
                                </div>
                            {/if}
                        </div>

                        <!-- Embedding Coverage -->
                        <div class="card-base">
                            <h3 class="text-subtitle font-medium mb-3">
                                {m.route_admin_embeddings_coverage()}
                            </h3>
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <div class="text-center p-3 bg-subtle">
                                    <p class="text-2xl font-bold text-green-400">
                                        {videoStats.embeddingCoverage.libraryEmbeddings.toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.route_admin_embeddings_coverage_library()}
                                    </p>
                                    <p class="text-caption">
                                        {m.route_admin_embeddings_coverage_library_desc()}
                                    </p>
                                </div>
                                <div class="text-center p-3 bg-subtle">
                                    <p class="text-2xl font-bold text-blue-400">
                                        {videoStats.embeddingCoverage.primaryProviderEmbeddings.toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.route_admin_embeddings_coverage_discovery()}
                                    </p>
                                    <p class="text-caption">
                                        {m.route_admin_embeddings_coverage_discovery_desc()}
                                    </p>
                                </div>
                                <div class="text-center p-3 bg-subtle">
                                    <p class="text-2xl font-bold text-purple-400">
                                        {videoStats.embeddingCoverage.bothEmbeddings.toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.route_admin_embeddings_coverage_both()}
                                    </p>
                                    <p class="text-caption">
                                        {m.route_admin_embeddings_coverage_both_desc()}
                                    </p>
                                </div>
                                <div class="text-center p-3 bg-subtle">
                                    <p
                                        class="text-2xl font-bold {videoStats.embeddingCoverage
                                            .noEmbeddings > 0
                                            ? 'text-red-400'
                                            : 'text-surface-400'}">
                                        {videoStats.embeddingCoverage.noEmbeddings.toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.route_admin_embeddings_coverage_none()}
                                    </p>
                                    <p class="text-caption">
                                        {m.route_admin_embeddings_coverage_none_desc()}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <!-- Recent Activity -->
                        <div class="card-base">
                            <button
                                class="w-full between text-left"
                                onclick={() => (showRecentActivity = !showRecentActivity)}>
                                <h3 class="text-sm font-medium text-surface-300">
                                    {m.route_admin_embeddings_recent_activity()}
                                </h3>
                                <span class="text-muted">{showRecentActivity ? '▼' : '▶'}</span>
                            </button>
                            {#if showRecentActivity && videoStats.recentItems.length > 0}
                                <div class="mt-3 space-y-2">
                                    {#each videoStats.recentItems as item (item.id)}
                                        {@const badge = getMediaTypeBadge(item.mediaType)}
                                        <button
                                            type="button"
                                            class="flex items-center gap-2 text-sm p-2 bg-surface-700/50 rounded w-full text-left hover:bg-surface-600/50 cursor-pointer {videoSelectedId ===
                                            item.externalIds?.internal
                                                ? 'ring-1 ring-blue-500'
                                                : ''}"
                                            onclick={() => {
                                                const id = item.externalIds?.internal;
                                                if (id) selectVideoItem(id);
                                            }}>
                                            <span
                                                class="px-2 py-0.5 text-xs rounded border {badge.class}">
                                                {badge.label}
                                            </span>
                                            <span
                                                class="text-blue-400 font-mono text-xs"
                                                title={item.externalIds?.internal ?? ''}
                                                >{item.externalIds?.internal?.slice(0, 8) ??
                                                    'N/A'}</span>
                                            {#if getExternalLabel(item.externalIds)}
                                                <span class="text-surface-500 font-mono text-xs"
                                                    >{getExternalLabel(item.externalIds)}</span>
                                            {/if}
                                            <span class="text-white flex-1 truncate"
                                                >{item.title}</span>
                                            <span class="text-caption"
                                                >{formatRelativeTime(item.createdAt)}</span>
                                        </button>
                                    {/each}
                                </div>
                            {/if}
                        </div>

                        <!-- Items without External Match -->
                        {#if videoStats.noExternalIdItems.length > 0}
                            <div class="bg-surface-800 rounded-lg p-4 border border-yellow-600/30">
                                <button
                                    class="w-full between text-left"
                                    onclick={() =>
                                        (showNoExternalSection = !showNoExternalSection)}>
                                    <div>
                                        <h3 class="text-sm font-medium text-yellow-400">
                                            {m.route_admin_embeddings_no_external_match()}
                                        </h3>
                                        <p class="text-hint">
                                            {m.admin_embeddings_no_provider_id({
                                                count: videoStats.noExternalIdItems.length,
                                            })}
                                        </p>
                                    </div>
                                    <span class="text-muted"
                                        >{showNoExternalSection ? '▼' : '▶'}</span>
                                </button>
                                {#if showNoExternalSection}
                                    <div class="mt-3 space-y-2 max-h-48 overflow-y-auto">
                                        {#each videoStats.noExternalIdItems as item (item.id)}
                                            {@const badge = getMediaTypeBadge(item.mediaType)}
                                            <div
                                                class="flex items-center gap-2 text-sm p-2 bg-surface-700/50 rounded">
                                                <span
                                                    class="px-2 py-0.5 text-xs rounded border {badge.class}">
                                                    {badge.label}
                                                </span>
                                                <span class="text-surface-300 flex-1"
                                                    >{item.title}</span>
                                                <span
                                                    class="text-surface-500 font-mono text-xs"
                                                    title={item.externalIds?.internal ?? ''}
                                                    >{item.externalIds?.internal?.slice(0, 8) ??
                                                        'N/A'}</span>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {/if}

                        <!-- Search & Lookup -->
                        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <EmbeddingSearchWidget
                                mediaTypes={['movie', 'tv']}
                                onselect={selectVideoItem} />
                            <EmbeddingLookupWidget
                                initialKey={videoLookupKey}
                                onselect={selectVideoItem} />
                        </div>

                        <!-- Embedding Text Detail Panel -->
                        {#if videoSelectedId}
                            <div class="card-base">
                                <div class="between mb-3">
                                    <div>
                                        <h3 class="text-sm font-medium text-surface-300">
                                            {m.admin_embeddings_embedding_text()}
                                        </h3>
                                        {#if videoEmbeddingText}
                                            <p class="text-caption mt-1">
                                                <span class="font-medium text-white"
                                                    >{videoEmbeddingText.title}</span>
                                                <span
                                                    class="ml-2 px-1.5 py-0.5 text-xs rounded border {getMediaTypeBadge(
                                                        videoEmbeddingText.mediaType,
                                                    ).class}">
                                                    {getMediaTypeBadge(videoEmbeddingText.mediaType)
                                                        .label}
                                                </span>
                                                <span class="ml-2 text-surface-500"
                                                    >{m.admin_embeddings_n_chars({
                                                        count: videoEmbeddingText.embeddingText
                                                            .length,
                                                    })}</span>
                                            </p>
                                        {/if}
                                    </div>
                                    {#if videoEmbeddingLoading}
                                        <span
                                            class="loading-spinner loading-spinner-primary w-4 h-4"
                                        ></span>
                                    {/if}
                                </div>
                                {#if videoEmbeddingLoading}
                                    <div class="flex items-center gap-3 py-4">
                                        <span
                                            class="loading-spinner loading-spinner-primary w-4 h-4"
                                        ></span>
                                        <p class="text-muted">{m.loading()}</p>
                                    </div>
                                {:else if videoEmbeddingText}
                                    <pre
                                        class="bg-surface-900 rounded p-3 text-xs text-green-400 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{videoEmbeddingText.embeddingText}</pre>
                                {/if}
                            </div>
                        {/if}

                        <!-- Random Sample -->
                        <div class="card-base">
                            <div class="between mb-3">
                                <h3 class="text-sm font-medium text-surface-300">
                                    {m.route_admin_embeddings_random_sample()}
                                </h3>
                                <button
                                    class="text-blue-400 hover:text-blue-300 text-xs underline"
                                    onclick={() => {
                                        videoStats = null;
                                    }}>
                                    {m.btn_refresh()}
                                </button>
                            </div>
                            <div
                                class="grid grid-cols-1 md:grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                                {#each videoStats.sample as item (item.id)}
                                    {@const badge = getMediaTypeBadge(item.mediaType)}
                                    {@const extLabel = getExternalLabel(item.externalIds)}
                                    <button
                                        type="button"
                                        class="flex items-center gap-2 text-sm p-2 bg-surface-700/50 rounded w-full text-left hover:bg-surface-600/50 cursor-pointer {videoSelectedId ===
                                        item.externalIds?.internal
                                            ? 'ring-1 ring-blue-500'
                                            : ''}"
                                        onclick={() => {
                                            const id = item.externalIds?.internal;
                                            if (id) selectVideoItem(id);
                                        }}>
                                        <span
                                            class="px-1.5 py-0.5 text-xs rounded border {badge.class}">
                                            {badge.label}
                                        </span>
                                        <span
                                            class="text-blue-400 font-mono text-xs"
                                            title={item.externalIds?.internal ?? ''}
                                            >{item.externalIds?.internal?.slice(0, 8) ??
                                                'N/A'}</span>
                                        {#if extLabel}
                                            <span class="text-surface-500 font-mono text-xs"
                                                >{extLabel}</span>
                                        {/if}
                                        <span class="text-white truncate flex-1">{item.title}</span>
                                    </button>
                                {/each}
                            </div>
                        </div>
                    </div>
                {:else if videoError}
                    <div class="card-base p-8">
                        <div class="center-col gap-3">
                            <p class="text-red-400">
                                {m.route_admin_embeddings_video_error()}
                            </p>
                            <button class="btn btn-sm btn-blue" onclick={loadVideoStats}
                                >{m.retry()}</button>
                        </div>
                    </div>
                {/if}
            {:else if active === 'music'}
                <!-- ─── Music Tab ─────────────────────────────────── -->
                {#if musicLoading && !musicStats}
                    <div class="card-base p-8">
                        <div class="center-col gap-3">
                            <span class="loading-spinner loading-spinner-lg loading-spinner-primary"
                            ></span>
                            <p class="text-surface-400">{m.loading()}</p>
                        </div>
                    </div>
                {:else if musicStats}
                    <div class="space-y-4">
                        <!-- Music Embedding Coverage -->
                        <div class="card-base">
                            <h3 class="text-subtitle font-medium mb-3">
                                {m.route_admin_embeddings_music_coverage()}
                            </h3>
                            <div class="grid grid-cols-3 gap-4">
                                <div class="text-center p-3 bg-subtle">
                                    <p class="text-2xl font-bold text-fuchsia-400">
                                        {musicStats.totalTracks.toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.admin_embeddings_total_tracks()}
                                    </p>
                                </div>
                                <div class="text-center p-3 bg-subtle">
                                    <p class="text-2xl font-bold text-green-400">
                                        {musicStats.withEmbedding.toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.admin_embeddings_with()}
                                    </p>
                                    <p class="text-caption">
                                        {musicStats.totalTracks > 0
                                            ? Math.round(
                                                  (musicStats.withEmbedding /
                                                      musicStats.totalTracks) *
                                                      100,
                                              )
                                            : 0}%
                                    </p>
                                </div>
                                <div class="text-center p-3 bg-subtle">
                                    <p
                                        class="text-2xl font-bold {musicStats.totalTracks -
                                            musicStats.withEmbedding >
                                        0
                                            ? 'text-red-400'
                                            : 'text-surface-400'}">
                                        {(
                                            musicStats.totalTracks - musicStats.withEmbedding
                                        ).toLocaleString()}
                                    </p>
                                    <p class="text-hint">
                                        {m.admin_embeddings_without()}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <!-- Track Data Quality -->
                        <div class="card-base">
                            <h3 class="text-subtitle font-medium mb-3">
                                {m.route_admin_embeddings_track_quality()}
                                <span
                                    class="ml-2 text-sm {musicQualityScore >= 80
                                        ? 'text-green-400'
                                        : musicQualityScore >= 60
                                          ? 'text-yellow-400'
                                          : 'text-red-400'}">
                                    {musicQualityScore}%
                                </span>
                            </h3>
                            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                <DataQualityMetric
                                    label={m.admin_embeddings_has_artist()}
                                    value={musicStats.totalTracks -
                                        musicStats.dataQuality.missingArtist}
                                    total={musicStats.totalTracks}
                                    description={m.admin_embeddings_tracks_missing_artist({
                                        count: musicStats.dataQuality.missingArtist,
                                    })}
                                    color="bg-fuchsia-500"
                                    thresholds={{ good: 100, warning: 80 }} />

                                <DataQualityMetric
                                    label={m.admin_embeddings_has_album()}
                                    value={musicStats.totalTracks -
                                        musicStats.dataQuality.missingAlbum}
                                    total={musicStats.totalTracks}
                                    description={m.admin_embeddings_tracks_missing_album({
                                        count: musicStats.dataQuality.missingAlbum,
                                    })}
                                    color="bg-fuchsia-500"
                                    thresholds={{ good: 100, warning: 80 }} />

                                <DataQualityMetric
                                    label={m.admin_embeddings_has_genre()}
                                    value={musicStats.totalTracks -
                                        musicStats.dataQuality.missingGenre}
                                    total={musicStats.totalTracks}
                                    description={m.admin_embeddings_tracks_missing_genre({
                                        count: musicStats.dataQuality.missingGenre,
                                        avg: musicStats.dataQuality.avgGenreCount,
                                    })}
                                    color="bg-fuchsia-500"
                                    thresholds={{ good: 100, warning: 80 }} />

                                <DataQualityMetric
                                    label={m.admin_embeddings_has_bpm()}
                                    value={musicStats.totalTracks -
                                        musicStats.dataQuality.missingBpm}
                                    total={musicStats.totalTracks}
                                    description={m.admin_embeddings_tracks_missing_bpm({
                                        count: musicStats.dataQuality.missingBpm,
                                    })}
                                    color="bg-blue-500"
                                    thresholds={{ warning: 50 }} />

                                <DataQualityMetric
                                    label={m.admin_embeddings_has_embedding()}
                                    value={musicStats.withEmbedding}
                                    total={musicStats.totalTracks}
                                    description={m.admin_embeddings_tracks_without_embedding({
                                        count: musicStats.totalTracks - musicStats.withEmbedding,
                                    })}
                                    color="bg-blue-500"
                                    thresholds={{ warning: 50 }} />
                            </div>
                        </div>

                        <!-- Recent Tracks -->
                        {#if musicStats.recentTracks.length > 0}
                            <div class="card-base">
                                <h3 class="text-sm font-medium text-surface-300 mb-3">
                                    {m.route_admin_embeddings_recent_tracks()}
                                </h3>
                                <div class="space-y-2">
                                    {#each musicStats.recentTracks as track (track.id)}
                                        <button
                                            type="button"
                                            class="flex items-center gap-2 text-sm p-2 bg-surface-700/50 rounded w-full text-left hover:bg-surface-600/50 cursor-pointer {musicSelectedId ===
                                            track.id
                                                ? 'ring-1 ring-fuchsia-500'
                                                : ''}"
                                            onclick={() => selectMusicItem(track.id)}>
                                            <span
                                                class="text-xs {track.hasEmbedding
                                                    ? 'text-green-400'
                                                    : 'text-surface-500'}"
                                                title={track.hasEmbedding
                                                    ? m.media_filter_has_embedding()
                                                    : m.admin_embeddings_no_embedding()}>
                                                {track.hasEmbedding ? '●' : '○'}
                                            </span>
                                            <span class="text-white flex-1 truncate"
                                                >{track.title}</span>
                                            <span class="text-surface-400 truncate"
                                                >{track.artist}</span>
                                            {#if track.album}
                                                <span
                                                    class="text-surface-500 truncate hidden md:inline"
                                                    >{track.album}</span>
                                            {/if}
                                        </button>
                                    {/each}
                                </div>
                            </div>
                        {/if}

                        <!-- Search & Lookup -->
                        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <EmbeddingSearchWidget
                                mediaTypes={['track']}
                                onselect={selectMusicItem} />
                            <EmbeddingLookupWidget
                                initialKey={musicLookupKey}
                                onselect={selectMusicItem} />
                        </div>

                        <!-- Embedding Text Detail Panel -->
                        {#if musicSelectedId}
                            <div class="card-base">
                                <div class="between mb-3">
                                    <div>
                                        <h3 class="text-sm font-medium text-surface-300">
                                            {m.admin_embeddings_embedding_text()}
                                        </h3>
                                        {#if musicEmbeddingText}
                                            <p class="text-caption mt-1">
                                                <span class="font-medium text-white"
                                                    >{musicEmbeddingText.title}</span>
                                                <span
                                                    class="ml-2 px-1.5 py-0.5 text-xs rounded border {getMediaTypeBadge(
                                                        musicEmbeddingText.mediaType,
                                                    ).class}">
                                                    {getMediaTypeBadge(musicEmbeddingText.mediaType)
                                                        .label}
                                                </span>
                                                <span class="ml-2 text-surface-500"
                                                    >{m.admin_embeddings_n_chars({
                                                        count: musicEmbeddingText.embeddingText
                                                            .length,
                                                    })}</span>
                                            </p>
                                        {/if}
                                    </div>
                                    {#if musicEmbeddingLoading}
                                        <span
                                            class="loading-spinner loading-spinner-primary w-4 h-4"
                                        ></span>
                                    {/if}
                                </div>
                                {#if musicEmbeddingLoading}
                                    <div class="flex items-center gap-3 py-4">
                                        <span
                                            class="loading-spinner loading-spinner-primary w-4 h-4"
                                        ></span>
                                        <p class="text-muted">{m.loading()}</p>
                                    </div>
                                {:else if musicEmbeddingText}
                                    <pre
                                        class="bg-surface-900 rounded p-3 text-xs text-fuchsia-400 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{musicEmbeddingText.embeddingText}</pre>
                                {/if}
                            </div>
                        {/if}

                        <!-- Random Sample -->
                        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div class="card-base">
                                <div class="between mb-3">
                                    <h3 class="text-sm font-medium text-surface-300">
                                        {m.route_admin_embeddings_random_sample()}
                                    </h3>
                                    <button
                                        class="text-blue-400 hover:text-blue-300 text-xs underline"
                                        onclick={() => {
                                            musicStats = null;
                                        }}>
                                        {m.btn_refresh()}
                                    </button>
                                </div>
                                <div class="space-y-1 max-h-48 overflow-y-auto">
                                    {#each musicStats.sample as track (track.id)}
                                        <button
                                            type="button"
                                            class="flex items-center gap-2 text-sm p-2 bg-surface-700/50 rounded w-full text-left hover:bg-surface-600/50 cursor-pointer {musicSelectedId ===
                                            track.id
                                                ? 'ring-1 ring-fuchsia-500'
                                                : ''}"
                                            onclick={() => selectMusicItem(track.id)}>
                                            <span
                                                class="text-xs {track.hasEmbedding
                                                    ? 'text-green-400'
                                                    : 'text-surface-500'}">
                                                {track.hasEmbedding ? '●' : '○'}
                                            </span>
                                            <span class="text-white truncate flex-1"
                                                >{track.title}</span>
                                            <span class="text-surface-400 truncate"
                                                >{track.artist}</span>
                                        </button>
                                    {/each}
                                </div>
                            </div>
                        </div>
                    </div>
                {:else if musicError}
                    <div class="card-base p-8">
                        <div class="center-col gap-3">
                            <p class="text-red-400">
                                {m.route_admin_embeddings_music_error()}
                            </p>
                            <button class="btn btn-sm btn-blue" onclick={loadMusicStats}
                                >{m.retry()}</button>
                        </div>
                    </div>
                {/if}
            {/if}
        {/snippet}
    </Tabs>

    <!-- ═══════════════════════════════════════════════════════════════ -->
    <!-- Random Embedding Preview (always visible, below tabs)          -->
    <!-- ═══════════════════════════════════════════════════════════════ -->
    <div class="card-base">
        <div class="between mb-4">
            <div>
                <h3 class="text-sm font-medium text-surface-300">
                    {m.route_admin_embeddings_random_preview()}
                </h3>
                <p class="text-caption mt-1">
                    {m.route_admin_embeddings_preview_description()}
                </p>
            </div>
            <button
                class="text-blue-400 hover:text-blue-300 text-xs underline"
                onclick={loadEmbeddingPreviews}>{m.common_refresh()}</button>
        </div>

        {#if embeddingPreviews?.previews}
            <div class="space-y-3">
                {#each embeddingPreviews.previews as preview (`${preview.title}-${preview.type}`)}
                    {@const badge = getMediaTypeBadge(preview.type)}
                    <div
                        class="border border-surface-700 rounded-lg p-3 hover:border-surface-600 transition-colors">
                        <div class="flex flex-wrap items-center gap-2 mb-2">
                            <span class="px-2 py-0.5 text-xs rounded bg-blue-600">
                                {preview.source}
                            </span>
                            <span class="px-2 py-0.5 text-xs rounded border {badge.class}">
                                {badge.label}
                            </span>
                            <span class="font-medium text-white text-sm">{preview.title}</span>
                            {#if preview.primaryExternalId}
                                <span class="text-hint font-mono"
                                    >#{preview.primaryExternalId}</span>
                            {/if}
                            {#if preview.rawData?.hasMdblistData}
                                <span class="badge badge-success">MDBList</span>
                            {/if}
                        </div>

                        <div
                            class="bg-surface-900 rounded p-2 text-xs text-green-400 font-mono break-words max-h-24 overflow-y-auto">
                            {preview.embeddingText}
                        </div>
                    </div>
                {/each}
            </div>
        {:else}
            <div class="flex items-center gap-3">
                <span class="loading-spinner loading-spinner-primary w-4 h-4"></span>
                <p class="text-muted">{m.loading()}</p>
            </div>
        {/if}

        <div class="mt-4 p-3 bg-surface-700/30 rounded-lg text-hint">
            <p>
                <strong>{m.route_admin_embeddings_how_it_works()}</strong>
                {m.route_admin_embeddings_how_it_works_body()}
            </p>
        </div>
    </div>
</div>
