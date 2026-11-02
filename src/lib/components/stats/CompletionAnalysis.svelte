<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, CheckCircle, XCircle, Film, Tv } from 'svelte-hero-icons';
    import type { CompletionStats } from '$lib/types/personal-stats';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        data: CompletionStats;
    }

    let { data }: Props = $props();

    // Colors for completion buckets
    const bucketColors: Record<string, string> = {
        '0-10%': 'bg-red-500',
        '10-25%': 'bg-orange-500',
        '25-50%': 'bg-yellow-500',
        '50-75%': 'bg-blue-500',
        '75-90%': 'bg-cyan-500',
        '90-100%': 'bg-green-500',
        Unknown: 'bg-gray-500',
    };

    // Sort buckets in order
    const bucketOrder = ['0-10%', '10-25%', '25-50%', '50-75%', '75-90%', '90-100%', 'Unknown'];
    let sortedBuckets = $derived(
        bucketOrder
            .map((b) => data.buckets.find((bucket) => bucket.bucket === b))
            .filter((b): b is NonNullable<typeof b> => b !== undefined && b.count > 0),
    );

    // All-zero guard: check if there is any meaningful completion data
    let hasCompletionData = $derived(
        data.overallCompletionRate > 0 ||
            data.movieCompletionRate > 0 ||
            data.episodeCompletionRate > 0 ||
            sortedBuckets.length > 0,
    );

    type AbandonedItem = CompletionStats['abandonedContent'][number];

    /** "S1E2 · Episode title" for an episode, null for a film. */
    function episodeLabel(item: AbandonedItem): string | null {
        if (!item.seriesName) return null;
        const code =
            item.seasonNumber !== undefined && item.episodeNumber !== undefined
                ? `S${item.seasonNumber}E${item.episodeNumber}`
                : null;
        return [code, item.title].filter(Boolean).join(' · ');
    }

    /** Return a display label for a bucket key, translating "Unknown". */
    function bucketLabel(bucket: string): string {
        return bucket === 'Unknown' ? m.misc_unknown() : bucket;
    }
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="between mb-6">
        <div class="flex items-center gap-2">
            <Icon src={CheckCircle} class="w-5 h-5 text-green-400" aria-hidden="true" />
            <h2 class="text-lg font-bold text-white">
                {m.stats_completion_title()}
            </h2>
        </div>
        <div class="text-right">
            <p class="text-2xl font-bold text-green-400">
                {data.overallCompletionRate}%
            </p>
            <p class="text-hint">{m.stats_completion_overall()}</p>
        </div>
    </div>

    {#if !hasCompletionData}
        <!-- All-zero empty guard -->
        <p class="text-muted text-center py-4">{m.stats_completion_no_data()}</p>
    {:else}
        <!-- Completion rates by type -->
        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-blue-900/30 rounded-lg p-4 border border-blue-700/30">
                <div class="flex items-center gap-2 mb-1">
                    <Icon src={Film} class="w-4 h-4 text-blue-400" aria-hidden="true" />
                    <span class="text-muted">{m.stats_completion_movies()}</span>
                </div>
                <p class="text-xl font-bold text-blue-300">
                    {data.movieCompletionRate}%
                </p>
            </div>
            <div class="bg-purple-900/30 rounded-lg p-4 border border-purple-700/30">
                <div class="flex items-center gap-2 mb-1">
                    <Icon src={Tv} class="w-4 h-4 text-purple-400" aria-hidden="true" />
                    <span class="text-muted">{m.stats_completion_episodes()}</span>
                </div>
                <p class="text-xl font-bold text-purple-300">
                    {data.episodeCompletionRate}%
                </p>
            </div>
        </div>

        <!-- Completion distribution -->
        {#if sortedBuckets.length > 0}
            <div class="mb-6">
                <p class="text-muted">
                    {m.stats_completion_distribution()}
                </p>
                <p class="text-caption mb-3">{m.stats_completion_distribution_hint()}</p>
                <ul role="list" class="space-y-2" aria-label={m.stats_completion_distribution()}>
                    {#each sortedBuckets as bucket (bucket.bucket)}
                        <li
                            role="listitem"
                            class="flex items-center gap-3"
                            aria-label={m.stats_completion_bucket_aria({
                                label: bucketLabel(bucket.bucket),
                                percentage: bucket.percentage,
                                count: bucket.count,
                            })}>
                            <span class="text-hint w-16 shrink-0"
                                >{bucketLabel(bucket.bucket)}</span>
                            <div
                                class="flex-1 bg-gray-700 rounded-full h-4 overflow-hidden"
                                role="img"
                                aria-hidden="true">
                                <div
                                    class="{bucketColors[bucket.bucket] ||
                                        'bg-gray-500'} h-4 rounded-full transition-all duration-500"
                                    style="width: {bucket.percentage}%">
                                </div>
                            </div>
                            <!-- Count moved outside bar to fix white-on-color contrast issue -->
                            <span class="text-caption w-10 text-right shrink-0 tabular-nums"
                                >{bucket.count}</span>
                            <span class="text-caption w-10 text-right shrink-0 tabular-nums"
                                >{bucket.percentage < 1 && bucket.count > 0
                                    ? '< 1'
                                    : bucket.percentage}%</span>
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}

        <!-- Average drop-off point -->
        {#if data.avgDropOffPoint > 0}
            <div class="mb-6 p-3 bg-orange-900/20 rounded-lg border border-orange-700/30">
                <p class="text-muted">{m.stats_completion_drop_off()}</p>
                <p class="text-lg font-semibold text-orange-400">
                    {m.stats_completion_into_content({
                        value: data.avgDropOffPoint,
                    })}
                </p>
            </div>
        {/if}

        <!-- Abandoned content list -->
        {#if data.abandonedContent.length > 0}
            <div class="border-t border-gray-700 pt-4">
                <div class="flex items-center gap-2 mb-3">
                    <Icon src={XCircle} class="w-4 h-4 text-red-400" aria-hidden="true" />
                    <div>
                        <p class="text-muted">
                            {m.stats_completion_abandoned()}
                        </p>
                        <p class="text-caption">{m.stats_completion_abandoned_hint()}</p>
                    </div>
                </div>
                <!-- tabindex on the scroll container (div) keeps keyboard-focus on the
                     scrollable region while the list semantics stay on the <ul>. -->
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                    tabindex="0"
                    role="region"
                    aria-label={m.stats_completion_abandoned()}
                    class="max-h-48 overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                    <ul role="list" class="space-y-2">
                        {#each data.abandonedContent as item, abandonedIdx (item.title + '__' + abandonedIdx)}
                            {@const heading = item.seriesName || item.title}
                            {@const episode = episodeLabel(item)}
                            <li class="between bg-gray-700/30 rounded-lg p-3">
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm text-white truncate" title={heading}>
                                        {heading}
                                    </p>
                                    {#if episode}
                                        <p class="text-caption truncate" title={episode}>
                                            {episode}
                                        </p>
                                    {/if}
                                    <p class="text-hint">
                                        {m.stats_completion_started_times({
                                            count: item.timesStarted,
                                        })}
                                    </p>
                                </div>
                                {#if item.maxCompletion !== undefined}
                                    <div class="text-right ml-4 shrink-0">
                                        <p class="text-sm font-medium text-orange-400">
                                            {Math.round(item.maxCompletion)}%
                                        </p>
                                        <p class="text-caption">
                                            {m.stats_completion_furthest()}
                                        </p>
                                    </div>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                </div>
                {#if data.abandonedContent.length > 5}
                    <p class="text-hint text-xs mt-2 text-right">
                        {m.stats_completion_abandoned_showing({
                            count: data.abandonedContent.length,
                        })}
                    </p>
                {/if}
            </div>
        {/if}
    {/if}
</div>
