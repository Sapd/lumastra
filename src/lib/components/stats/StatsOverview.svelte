<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { OverviewStats } from '$lib/types/personal-stats';
    import { Icon, Clock, Film, Tv, CheckCircle, XCircle, PlayCircle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        data: OverviewStats;
    }

    let { data }: Props = $props();

    // Share of the titles touched in the period that were finished. Both counts
    // are per title (see OverviewStatsSchema), so they add up to the titles.
    const finishedShare = $derived(
        data.completedCount + data.abandonedCount > 0
            ? Math.round((data.completedCount / (data.completedCount + data.abandonedCount)) * 100)
            : 0,
    );
</script>

<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
    <!-- Total Watch Time -->
    <div
        class="bg-gradient-to-br from-blue-900/50 to-blue-800/30 rounded-xl p-4 border border-blue-700/30">
        <dl>
            <dt class="flex items-center gap-2 mb-2">
                <Icon src={Clock} class="w-5 h-5 text-blue-400" aria-hidden="true" />
                <span class="text-gray-300 text-xs uppercase tracking-wide"
                    >{m.stats_overview_watch_time()}</span>
            </dt>
            <dd class="text-2xl font-bold text-white truncate">
                {data.totalWatchTimeFormatted}
            </dd>
        </dl>
    </div>

    <!-- Total Sessions -->
    <div
        class="bg-gradient-to-br from-purple-900/50 to-purple-800/30 rounded-xl p-4 border border-purple-700/30">
        <dl>
            <dt class="flex items-center gap-2 mb-2">
                <Icon src={PlayCircle} class="w-5 h-5 text-purple-400" aria-hidden="true" />
                <span class="text-gray-300 text-xs uppercase tracking-wide"
                    >{m.stats_overview_sessions()}</span>
            </dt>
            <dd class="text-2xl font-bold text-white truncate">
                {data.totalSessions.toLocaleString(getLocale())}
            </dd>
            <dd class="text-gray-300 text-xs mt-1 truncate">
                {m.stats_overview_unique_content({
                    count: data.uniqueContent.toLocaleString(getLocale()),
                })}
            </dd>
        </dl>
    </div>

    <!-- Movies Watched -->
    <div
        class="bg-gradient-to-br from-green-900/50 to-green-800/30 rounded-xl p-4 border border-green-700/30">
        <dl>
            <dt class="flex items-center gap-2 mb-2">
                <Icon src={Film} class="w-5 h-5 text-green-400" aria-hidden="true" />
                <span class="text-gray-300 text-xs uppercase tracking-wide"
                    >{m.stats_overview_movies()}</span>
            </dt>
            <dd class="text-2xl font-bold text-white truncate">
                {data.moviesWatched.toLocaleString(getLocale())}
            </dd>
        </dl>
    </div>

    <!-- Episodes Watched -->
    <div
        class="bg-gradient-to-br from-cyan-900/50 to-cyan-800/30 rounded-xl p-4 border border-cyan-700/30">
        <dl>
            <dt class="flex items-center gap-2 mb-2">
                <Icon src={Tv} class="w-5 h-5 text-cyan-400" aria-hidden="true" />
                <span class="text-gray-300 text-xs uppercase tracking-wide"
                    >{m.stats_overview_episodes()}</span>
            </dt>
            <dd class="text-2xl font-bold text-white truncate">
                {data.episodesWatched.toLocaleString(getLocale())}
            </dd>
        </dl>
    </div>

    <!-- Completed -->
    <div
        class="bg-gradient-to-br from-emerald-900/50 to-emerald-800/30 rounded-xl p-4 border border-emerald-700/30">
        <dl>
            <dt class="flex items-center gap-2 mb-2">
                <Icon src={CheckCircle} class="w-5 h-5 text-emerald-400" aria-hidden="true" />
                <span class="text-gray-300 text-xs uppercase tracking-wide"
                    >{m.stats_overview_completed()}</span>
            </dt>
            <dd class="text-2xl font-bold text-white truncate">
                {data.completedCount.toLocaleString(getLocale())}
            </dd>
            <dd class="text-gray-300 text-xs mt-1 truncate">
                {m.stats_overview_finished_share({ value: finishedShare })}
            </dd>
        </dl>
    </div>

    <!-- Abandoned -->
    <div
        class="bg-gradient-to-br from-orange-900/50 to-orange-800/30 rounded-xl p-4 border border-orange-700/30">
        <dl>
            <dt class="flex items-center gap-2 mb-2">
                <Icon src={XCircle} class="w-5 h-5 text-orange-400" aria-hidden="true" />
                <span class="text-gray-300 text-xs uppercase tracking-wide"
                    >{m.stats_overview_unfinished()}</span>
            </dt>
            <dd class="text-2xl font-bold text-white truncate">
                {data.abandonedCount.toLocaleString(getLocale())}
            </dd>
            <dd class="text-gray-300 text-xs mt-1 truncate">
                {m.stats_overview_unfinished_hint()}
            </dd>
        </dl>
    </div>
</div>
