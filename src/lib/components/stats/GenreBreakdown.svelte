<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { GenreStats } from '$lib/types/personal-stats';
    import ActivityChart from '$lib/components/ActivityChart.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        data: GenreStats;
    }

    let { data }: Props = $props();

    // Guard: only proceed when there is real genre data
    let hasGenres = $derived(data.genres.length > 0);

    // Chart and list both show up to 10 genres (aligned)
    let topGenres = $derived(data.genres.slice(0, 10));

    // Transform data for chart — mirrors topGenres exactly
    let chartData = $derived(
        topGenres.map((genre) => ({
            label: genre.genreName,
            count: genre.contentCount,
            minutes: Math.round(genre.totalSeconds / 60),
            percentage: genre.percentage,
        })),
    );
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="between mb-4">
        <div>
            <h3 class="text-lg font-bold text-white">
                {m.stats_genre_title()}
            </h3>
            {#if hasGenres}
                <p class="text-muted">
                    {m.stats_genre_favorite({ genre: data.topGenre })}
                </p>
            {:else}
                <p class="text-muted">{m.stats_genre_no_data()}</p>
            {/if}
        </div>
        <div class="text-right">
            <span class="text-hint">{m.stats_genre_diversity()}</span>
            <p class="text-lg font-bold text-purple-400">
                {data.diversityScore}%
            </p>
        </div>
    </div>

    {#if hasGenres}
        <!-- No fixed height here: the chart is h-64 itself and prints its summary
             line below, which a fixed-height wrapper pushed over the genre list. -->
        <div>
            <ActivityChart
                data={chartData}
                title={m.stats_genre_title()}
                type="doughnut"
                color="#8b5cf6"
                valueType="minutes"
                showWrapper={false}
                tooltipFilterLabel={m.stats_chart_items_filter_1min()}
                summaryLabel={() => m.stats_genre_summary()} />
        </div>

        <!-- Genre list — aligned with chart (top 10) -->
        <div class="mt-4 space-y-2">
            {#each topGenres as genre (genre.genreName)}
                <div class="between text-sm">
                    <span class="text-gray-300 min-w-0 truncate mr-2">{genre.genreName}</span>
                    <div class="flex items-center gap-3 flex-shrink-0">
                        <span class="text-gray-500">{genre.totalFormatted}</span>
                        <span class="text-purple-400 font-medium w-12 text-right"
                            >{genre.percentage}%</span>
                    </div>
                </div>
            {/each}
        </div>
    {:else}
        <div class="relative h-64 center">
            <div class="text-center">
                <p class="text-gray-400 font-medium">{m.stats_chart_no_data()}</p>
                <p class="text-muted mt-1">{m.stats_chart_no_data_hint()}</p>
            </div>
        </div>
    {/if}
</div>
