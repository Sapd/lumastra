<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { FunRecords } from '$lib/types/personal-stats';
    import { Icon, Trophy, Moon, Fire, ArrowPathRoundedSquare, Clock } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        data: FunRecords;
    }

    let { data }: Props = $props();

    // Defensive: handle both old and new data formats
    let rewatchedMovies = $derived(data?.mostRewatchedMovies ?? []);
    let rewatchedSeries = $derived(data?.mostRewatchedSeries ?? []);

    /**
     * Reformat a raw HH:MM or HH24:MI string from the service into a
     * locale-aware time string using the user's locale preference.
     */
    function formatWatchTime(raw: string): string {
        // raw is "HH:MM" (24h) from the DB — parse into a Date for Intl formatting
        const [hStr, mStr] = raw.split(':');
        const h = parseInt(hStr ?? '0', 10);
        const minute = parseInt(mStr ?? '0', 10);
        if (isNaN(h) || isNaN(minute)) return raw;
        const d = new Date(2000, 0, 1, h, minute, 0);
        return d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
    }
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="flex items-center gap-2 mb-6">
        <Icon src={Trophy} class="w-5 h-5 text-yellow-400" aria-hidden="true" />
        <h3 class="text-lg font-bold text-white">{m.stats_records_title()}</h3>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <!-- Longest Session — always rendered; shows placeholder when no data -->
        <div class="bg-purple-900/30 rounded-lg p-4 border border-purple-700/30">
            <div class="flex items-center gap-2 mb-2">
                <Icon src={Clock} class="w-4 h-4 text-purple-400" aria-hidden="true" />
                <span class="text-hint uppercase">{m.stats_records_longest_session()}</span>
            </div>
            {#if data.longestSession}
                <p class="text-xl font-bold text-purple-300">
                    {data.longestSession.durationFormatted}
                </p>
                <!-- Show episode title primary; series name as secondary line -->
                <p class="text-muted truncate" title={data.longestSession.title}>
                    {data.longestSession.title}
                </p>
                {#if data.longestSession.seriesName}
                    <p
                        class="text-xs text-gray-500 truncate"
                        title={data.longestSession.seriesName}>
                        {data.longestSession.seriesName}
                    </p>
                {/if}
            {:else}
                <p class="text-xl font-bold text-purple-300" aria-label={m.stats_records_no_data()}>
                    —
                </p>
            {/if}
        </div>

        <!-- Night Owl Score -->
        <div class="bg-indigo-900/30 rounded-lg p-4 border border-indigo-700/30">
            <div class="flex items-center gap-2 mb-2">
                <Icon src={Moon} class="w-4 h-4 text-indigo-400" aria-hidden="true" />
                <span class="text-hint uppercase">{m.stats_records_night_owl()}</span>
            </div>
            <p class="text-xl font-bold text-indigo-300">
                {data.nightOwlScore}%
            </p>
            <p class="text-muted">
                {m.stats_records_sessions_late_night()}
            </p>
        </div>

        <!-- Binge Score -->
        <div class="bg-orange-900/30 rounded-lg p-4 border border-orange-700/30">
            <div class="flex items-center gap-2 mb-2">
                <Icon src={Fire} class="w-4 h-4 text-orange-400" aria-hidden="true" />
                <span class="text-hint uppercase">{m.stats_records_binge_days()}</span>
            </div>
            <p class="text-xl font-bold text-orange-300">
                {data.totalBingeDays}
            </p>
            <p class="text-muted">{m.stats_records_marathons()}</p>
            {#if data.bingeScore > 0}
                <p class="text-xs text-orange-400 mt-1">
                    {m.stats_records_binge_score({
                        score: Math.min(100, Math.round(data.bingeScore)),
                    })}
                </p>
            {/if}
        </div>

        <!-- Watch Streak -->
        <div class="bg-green-900/30 rounded-lg p-4 border border-green-700/30">
            <div class="flex items-center gap-2 mb-2">
                <Icon
                    src={ArrowPathRoundedSquare}
                    class="w-4 h-4 text-green-400"
                    aria-hidden="true" />
                <span class="text-hint uppercase">{m.stats_records_longest_streak()}</span>
            </div>
            <p class="text-xl font-bold text-green-300">
                {m.stats_records_days({ count: data.longestStreak })}
            </p>
            <p class="text-muted">
                {m.stats_records_current({ count: data.currentStreak })}
            </p>
        </div>
    </div>

    <!-- Most Rewatched Movies -->
    {#if rewatchedMovies.length > 0}
        <div class="mt-6 pt-6 border-t border-gray-700">
            <h4 class="text-muted uppercase tracking-wide mb-4">
                {m.stats_records_most_rewatched_movies()}
            </h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {#each rewatchedMovies.slice(0, 3) as item, index (item.title + '__' + index)}
                    <div class="bg-gray-700/50 rounded-lg p-3 flex items-center gap-3">
                        <div
                            class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-sm font-bold text-white shrink-0"
                            aria-hidden="true">
                            {index + 1}
                        </div>
                        {#if item.posterUrl}
                            <img
                                src={item.posterUrl}
                                alt="{item.title} poster"
                                loading="lazy"
                                class="w-10 aspect-[2/3] rounded object-cover shrink-0 bg-gray-600"
                                onerror={(e) => {
                                    const t = e.currentTarget as HTMLElement;
                                    if (t) t.style.display = 'none';
                                }} />
                        {/if}
                        <div class="flex-1 min-w-0">
                            <p class="text-sm text-white truncate" title={item.title}>
                                {item.title}
                            </p>
                            <p class="text-hint">
                                {#if item.timesCompleted >= 2}
                                    {m.stats_records_completed_times({
                                        count: item.timesCompleted,
                                    })}
                                {:else}
                                    {m.stats_records_started_times({
                                        count: item.timesStarted,
                                    })}
                                {/if}
                            </p>
                            {#if item.totalWatchTimeFormatted}
                                <p class="text-xs text-gray-500">{item.totalWatchTimeFormatted}</p>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Most Rewatched Series -->
    {#if rewatchedSeries.length > 0}
        <div class="mt-6 pt-6 border-t border-gray-700">
            <h4 class="text-muted uppercase tracking-wide mb-4">
                {m.stats_records_most_rewatched_series()}
            </h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {#each rewatchedSeries.slice(0, 3) as item, index ((item.seriesName ?? item.title) + '__' + index)}
                    <div class="bg-gray-700/50 rounded-lg p-3 flex items-center gap-3">
                        <div
                            class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-sm font-bold text-white shrink-0"
                            aria-hidden="true">
                            {index + 1}
                        </div>
                        {#if item.posterUrl}
                            <img
                                src={item.posterUrl}
                                alt="{item.seriesName ?? item.title} poster"
                                loading="lazy"
                                class="w-10 aspect-[2/3] rounded object-cover shrink-0 bg-gray-600"
                                onerror={(e) => {
                                    const t = e.currentTarget as HTMLElement;
                                    if (t) t.style.display = 'none';
                                }} />
                        {/if}
                        <div class="flex-1 min-w-0">
                            <p
                                class="text-sm text-white truncate"
                                title={item.seriesName ?? item.title}>
                                {item.seriesName ?? item.title}
                            </p>
                            <!-- timesCompleted = episodes finished more than once,
                                 timesStarted = distinct episodes watched. -->
                            <p class="text-hint">
                                {m.stats_records_episodes_rewatched({
                                    count: item.timesCompleted,
                                    total: item.timesStarted,
                                })}
                            </p>
                            {#if item.totalWatchTimeFormatted}
                                <p class="text-xs text-gray-500">{item.totalWatchTimeFormatted}</p>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Typical viewing window (p10–p90 of start time) — stable, unlike raw min/max -->
    {#if data.typicalViewingWindow}
        <div class="mt-6 pt-6 border-t border-gray-700 text-center">
            <p class="text-hint">{m.stats_records_viewing_window()}</p>
            <p class="text-lg font-medium text-cyan-400">
                {formatWatchTime(data.typicalViewingWindow.start)} – {formatWatchTime(
                    data.typicalViewingWindow.end,
                )}
            </p>
            <p class="text-xs text-gray-500">
                {m.stats_records_viewing_window_median({
                    time: formatWatchTime(data.typicalViewingWindow.median),
                })}
            </p>
        </div>
    {/if}
</div>
