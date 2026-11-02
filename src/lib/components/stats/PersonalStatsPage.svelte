<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { apiGet } from '$lib/api/client';
    import type {
        StatsPeriod,
        OverviewStats,
        WatchTimeStats,
        PeakHoursStats,
        CompletionStats,
        GenreStats,
        KeywordStats,
        DeviceStats,
        QualityStats as QualityStatsType,
        RatingStats,
        TasteProfileStats,
        FunRecords,
        TopTitlesStats,
    } from '$lib/types/personal-stats';
    import { AllStatsResponseSchema } from '$lib/schemas/api-stats-responses';
    import StatsOverview from './StatsOverview.svelte';
    import ViewingPersonality from './ViewingPersonality.svelte';
    import WatchTimeChart from './WatchTimeChart.svelte';
    import PeakHoursHeatmap from './PeakHoursHeatmap.svelte';
    import CompletionAnalysis from './CompletionAnalysis.svelte';
    import GenreBreakdown from './GenreBreakdown.svelte';
    import KeywordCloud from './KeywordCloud.svelte';
    import DeviceBreakdown from './DeviceBreakdown.svelte';
    import QualityStatsComponent from './QualityStats.svelte';
    import RatingBehavior from './RatingBehavior.svelte';
    import TasteProfile from './TasteProfile.svelte';
    import FunRecordsComponent from './FunRecords.svelte';
    import TopTitles from './TopTitles.svelte';
    import EmptyStatsState from './EmptyStatsState.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        username: string;
        isOwnStats?: boolean;
    }

    let { username, isOwnStats = false }: Props = $props();

    let period: StatsPeriod = $state('all');
    let loading = $state(true);
    /** true only on the very first load; subsequent period switches use stale-content overlay */
    let initialLoad = $state(true);
    let error = $state<string | null>(null);

    // Stats data with proper types
    interface StatsResponse<T> {
        type: string;
        period?: string;
        stats?: T;
        insufficientData?: boolean;
        sessionCount?: number;
        minRequired?: number;
        message?: string;
    }

    let overviewData = $state<StatsResponse<OverviewStats> | null>(null);
    let watchTimeData = $state<StatsResponse<WatchTimeStats> | null>(null);
    let peakHoursData = $state<StatsResponse<PeakHoursStats> | null>(null);
    let completionData = $state<StatsResponse<CompletionStats> | null>(null);
    let genresData = $state<StatsResponse<GenreStats> | null>(null);
    let keywordsData = $state<StatsResponse<KeywordStats> | null>(null);
    let devicesData = $state<StatsResponse<DeviceStats> | null>(null);
    let qualityData = $state<StatsResponse<QualityStatsType> | null>(null);
    let ratingsData = $state<StatsResponse<RatingStats> | null>(null);
    let tasteProfileData = $state<StatsResponse<TasteProfileStats> | null>(null);
    let recordsData = $state<StatsResponse<FunRecords> | null>(null);
    let topTitlesData = $state<StatsResponse<TopTitlesStats> | null>(null);

    let baseUrl = $derived(isOwnStats ? '/api/my-stats' : `/api/stats/${username}`);

    /** True when there is any content already displayed (used for stale-content overlay). */
    let hasContent = $derived(
        overviewData !== null ||
            watchTimeData !== null ||
            peakHoursData !== null ||
            completionData !== null ||
            genresData !== null,
    );

    function wrapStat<T>(
        type: string,
        stats: T | undefined,
        insufficientData?: boolean,
        sessionCount?: number,
    ): StatsResponse<T> | null {
        if (insufficientData && type === 'overview') {
            return {
                type,
                insufficientData: true,
                sessionCount,
                minRequired: 1,
            };
        }
        if (stats === undefined) return null;
        return { type, period, stats: stats as T };
    }

    async function loadStats() {
        loading = true;
        error = null;

        try {
            const { data, error: fetchError } = await apiGet(
                `${baseUrl}/all?period=${period}`,
                AllStatsResponseSchema,
            );

            if (fetchError || !data) {
                error = m.stats_error_load_failed();
                return;
            }

            const s = data.stats;
            overviewData = wrapStat(
                'overview',
                s.overview,
                data.insufficientData,
                data.sessionCount,
            );
            watchTimeData = wrapStat('watch-time', s.watchTime);
            peakHoursData = wrapStat('peak-hours', s.peakHours);
            completionData = wrapStat('completion', s.completion);
            genresData = wrapStat('genres', s.genres);
            keywordsData = wrapStat('keywords', s.keywords);
            devicesData = wrapStat('devices', s.devices);
            qualityData = wrapStat('quality', s.quality);
            ratingsData = wrapStat('ratings', s.ratings);
            tasteProfileData = wrapStat('taste-profile', s.tasteProfile);
            recordsData = wrapStat('records', s.records);
            topTitlesData = wrapStat('top-titles', s.topTitles);
        } catch (e) {
            // Log the raw error server-side; never expose internals to the UI.
            console.error('[PersonalStatsPage] loadStats error:', e);
            error = m.stats_error_load_failed();
        } finally {
            loading = false;
            initialLoad = false;
        }
    }

    function handlePeriodChange(newPeriod: StatsPeriod) {
        if (newPeriod === period || loading) return;
        period = newPeriod;
        loadStats();
    }

    onMount(() => {
        loadStats();
    });

    // Period options — $derived so labels re-evaluate if locale changes at runtime.
    let periodOptions: { value: StatsPeriod; label: string }[] = $derived([
        { value: '7d', label: m.stats_period_7d() },
        { value: '30d', label: m.stats_period_30d() },
        { value: '90d', label: m.stats_period_90d() },
        { value: 'all', label: m.stats_period_all() },
    ]);

    /**
     * Which grid children in the 2-col section are currently visible.
     * Used to determine orphan-last-child treatment.
     */
    let visibleGridChildren = $derived(
        [
            genresData?.stats,
            devicesData?.stats,
            completionData?.stats,
            keywordsData?.stats,
            qualityData?.stats,
            tasteProfileData?.stats,
        ].filter(Boolean).length,
    );

    let lastChildSpansFull = $derived(visibleGridChildren % 2 !== 0);
</script>

<div class="container mx-auto px-4 pt-24 pb-8 max-w-7xl">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
            <h1 class="text-3xl font-bold text-white">
                {#if isOwnStats}
                    {m.stats_my_statistics()}
                {:else}
                    {m.stats_user_statistics({ username })}
                {/if}
            </h1>
            <p class="text-gray-400 mt-1">{m.stats_subtitle()}</p>
        </div>

        <!-- Period Selector -->
        <div role="group" aria-label={m.stats_period_selector_label()} class="flex gap-2">
            {#each periodOptions as opt (opt.value)}
                <button
                    class="px-4 py-2 rounded-lg text-sm font-medium transition-colors
					{period === opt.value ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
                    aria-pressed={period === opt.value}
                    disabled={loading}
                    onclick={() => handlePeriodChange(opt.value)}>
                    {opt.label}
                </button>
            {/each}
        </div>
    </div>

    <!--
        aria-live region announces loading/error transitions to screen readers.
        role="status" is a polite live region — does not interrupt current speech.
    -->
    <div role="status" aria-live="polite" aria-atomic="true" class="sr-only">
        {#if loading}
            {m.stats_loading()}
        {:else if error}
            {error}
        {/if}
    </div>

    <!--
        First load: show a full spinner (no content yet).
        Subsequent period switches: keep stale content visible behind an overlay
        so the UI does not flash to a blank 400px spinner on every tab change.
    -->
    {#if initialLoad && loading}
        <div class="center min-h-[400px]">
            <div class="text-center">
                <span
                    class="loading-spinner loading-spinner-lg loading-spinner-primary mx-auto mb-4"
                    aria-hidden="true"></span>
                <p class="text-gray-400">{m.stats_loading()}</p>
            </div>
        </div>
    {:else if error && (!hasContent || overviewData?.insufficientData)}
        <div class="bg-red-900/30 border border-red-500/50 rounded-lg p-6 text-center">
            <p class="text-red-400">{error}</p>
            <button class="btn btn-red mt-4" onclick={loadStats}>
                {m.stats_retry()}
            </button>
        </div>
    {:else if overviewData?.insufficientData}
        <EmptyStatsState
            sessionCount={overviewData.sessionCount || 0}
            minRequired={overviewData.minRequired || 1} />
    {:else}
        <!--
            Content wrapper — when a period switch is in progress, dim the stale
            content and block pointer interaction instead of replacing with a spinner.
        -->
        <div
            class={loading ? 'opacity-50 pointer-events-none transition-opacity duration-150' : ''}>
            <!-- Error banner shown over stale content (period-switch error) -->
            {#if error}
                <div
                    class="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-6 flex items-center justify-between gap-4">
                    <p class="text-red-400 text-sm">{error}</p>
                    <button class="btn btn-sm btn-red shrink-0" onclick={loadStats}>
                        {m.stats_retry()}
                    </button>
                </div>
            {/if}

            <!-- Overview Section -->
            {#if overviewData?.stats}
                <StatsOverview data={overviewData.stats} />
            {:else}
                <!-- overviewData is null but not insufficientData — parse error / API drift -->
                <EmptyStatsState sessionCount={0} minRequired={1} />
            {/if}

            <!-- Viewing Personality (archetype + "hours of your life") -->
            {#if overviewData?.stats && overviewData.stats.totalWatchTimeSeconds > 0}
                <div class="mt-8">
                    <ViewingPersonality
                        totalWatchTimeSeconds={overviewData.stats.totalWatchTimeSeconds}
                        nightOwlScore={recordsData?.stats?.nightOwlScore ?? 0}
                        weekendWarriorScore={peakHoursData?.stats?.weekendWarriorScore ?? 0}
                        bingeScore={recordsData?.stats?.bingeScore ?? 0}
                        completionRate={completionData?.stats?.overallCompletionRate ?? 0} />
                </div>
            {/if}

            <!-- Top Titles (most-watched movies & shows, with posters) -->
            {#if topTitlesData?.stats && (topTitlesData.stats.movies.length > 0 || topTitlesData.stats.shows.length > 0)}
                <div class="mt-8">
                    <TopTitles
                        movies={topTitlesData.stats.movies}
                        shows={topTitlesData.stats.shows} />
                </div>
            {/if}

            <!-- Watch Time Trends (full width) -->
            {#if watchTimeData?.stats && !watchTimeData.insufficientData}
                <div class="mt-8">
                    <WatchTimeChart data={watchTimeData.stats} {period} />
                </div>
            {/if}

            <!-- Peak Hours Heatmap (full width) -->
            {#if peakHoursData?.stats && !peakHoursData.insufficientData}
                <div class="mt-8">
                    <PeakHoursHeatmap data={peakHoursData.stats} />
                </div>
            {/if}

            <!-- Two Column Layout for Charts (only render when at least one child is visible) -->
            {#if visibleGridChildren > 0}
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
                    <!-- Genre Breakdown -->
                    {#if genresData?.stats && !genresData.insufficientData}
                        <GenreBreakdown data={genresData.stats} />
                    {/if}

                    <!-- Device Breakdown -->
                    {#if devicesData?.stats && !devicesData.insufficientData}
                        <DeviceBreakdown data={devicesData.stats} />
                    {/if}

                    <!-- Completion Analysis -->
                    {#if completionData?.stats && !completionData.insufficientData}
                        <CompletionAnalysis data={completionData.stats} />
                    {/if}

                    <!-- Keywords -->
                    {#if keywordsData?.stats && !keywordsData.insufficientData}
                        <KeywordCloud data={keywordsData.stats} />
                    {/if}

                    <!-- Quality Stats -->
                    {#if qualityData?.stats && !qualityData.insufficientData}
                        <QualityStatsComponent data={qualityData.stats} />
                    {/if}

                    <!-- Taste Profile — span full width if it would be an orphan -->
                    {#if tasteProfileData?.stats && !tasteProfileData.insufficientData}
                        <div class={lastChildSpansFull ? 'lg:col-span-2' : ''}>
                            <TasteProfile
                                data={tasteProfileData.stats}
                                genres={(genresData?.stats?.genres ?? [])
                                    .slice(0, 6)
                                    .map((g) => g.genreName)}
                                keywords={(keywordsData?.stats?.keywords ?? [])
                                    .slice(0, 8)
                                    .map((k) => k.keyword)} />
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- Rating Behavior (full width) -->
            {#if ratingsData?.stats && !ratingsData.insufficientData}
                <div class="mt-8">
                    <RatingBehavior data={ratingsData.stats} />
                </div>
            {/if}

            <!-- Fun Records -->
            {#if recordsData?.stats && !recordsData.insufficientData}
                <div class="mt-8">
                    <FunRecordsComponent data={recordsData.stats} />
                </div>
            {/if}
        </div>
    {/if}
</div>
