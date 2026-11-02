<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';
    import { resolve } from '$lib/paths';
    import { Icon, Sparkles, LightBulb, Clock, Star } from 'svelte-hero-icons';
    import type { TasteProfileStats } from '$lib/types/personal-stats';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        data: TasteProfileStats;
        /** Top genre names (already ordered), for the "taste in words" chips. */
        genres?: string[];
        /** Top keyword/tag names (already ordered), for the chips. */
        keywords?: string[];
    }

    let { data, genres = [], keywords = [] }: Props = $props();

    // "Taste in words": a compact, scannable set of chips built from the genres
    // and keywords the page already loaded — far more legible than raw weight
    // bars. Deduped, genres first, capped so the row stays tidy.
    let tasteChips = $derived.by((): string[] => {
        const seen: Record<string, true> = {};
        const chips: string[] = [];
        for (const label of [...genres, ...keywords]) {
            const trimmed = label?.trim();
            if (!trimmed) continue;
            const dedupeKey = trimmed.toLowerCase();
            if (seen[dedupeKey]) continue;
            seen[dedupeKey] = true;
            chips.push(trimmed);
            if (chips.length >= 10) break;
        }
        return chips;
    });

    // Format preference as percentage
    function formatPref(value: number): number {
        return Math.round(value * 100);
    }

    // Get color based on weight
    function getWeightColor(value: number): string {
        if (value >= 0.3) return 'text-green-400';
        if (value >= 0.2) return 'text-blue-400';
        if (value >= 0.1) return 'text-yellow-400';
        return 'text-gray-400';
    }

    function getBarColor(value: number): string {
        if (value >= 0.3) return 'bg-green-500';
        if (value >= 0.2) return 'bg-blue-500';
        if (value >= 0.1) return 'bg-yellow-500';
        return 'bg-gray-500';
    }

    // Text label for the strength of a weight value (non-color signal for a11y)
    function getWeightLabel(value: number): string {
        if (value >= 0.3) return m.stats_taste_weight_strong();
        if (value >= 0.2) return m.stats_taste_weight_moderate();
        if (value >= 0.1) return m.stats_taste_weight_low();
        return m.stats_taste_weight_minimal();
    }

    /**
     * Map server-emitted English insight strings to localized messages.
     * The service generates a fixed set of token-like strings; we match them
     * here instead of rendering the raw English. Unknown strings are shown
     * verbatim as a safe fallback (they're developer-authored, not user data).
     */
    const INSIGHT_MAP: Record<string, () => string> = {
        'Rate more content to build your taste profile': () => m.stats_taste_insight_rate_more(),
        'You prefer content already in the library': () => m.stats_taste_insight_prefers_library(),
        'You enjoy discovering new content to request': () =>
            m.stats_taste_insight_open_to_discover(),
        'Critic ratings influence your preferences': () => m.stats_taste_insight_critic_influence(),
        'You tend to follow popular trends': () => m.stats_taste_insight_popular_trends(),
        'You prefer newer releases': () => m.stats_taste_insight_newer_releases(),
        'Your taste is well-balanced across different factors': () =>
            m.stats_taste_insight_well_balanced(),
    };

    function localizeInsight(raw: string): string {
        return INSIGHT_MAP[raw]?.() ?? raw;
    }

    // Profile age display: 0 days → "Just created"
    function formatProfileAge(days: number): string {
        if (days === 0) return m.stats_taste_just_created();
        return m.stats_taste_profile_age({ days });
    }
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="between mb-6">
        <div class="flex items-center gap-2">
            <Icon src={Sparkles} class="w-5 h-5 text-purple-400" aria-hidden="true" />
            <h3 class="text-lg font-bold text-white">
                {m.stats_taste_title()}
            </h3>
        </div>
        {#if data.hasProfile}
            <div class="text-right">
                <p class="text-muted">{m.stats_taste_based_on()}</p>
                <p class="text-lg font-semibold text-purple-400">
                    {m.stats_taste_ratings({ count: data.totalRatings })}
                </p>
            </div>
        {/if}
    </div>

    {#if !data.hasProfile}
        <!-- No profile state -->
        <div class="text-center py-8">
            <div class="w-16 h-16 bg-gray-700 rounded-full center mx-auto mb-4">
                <Icon src={Sparkles} class="w-8 h-8 text-gray-500" aria-hidden="true" />
            </div>
            <h4 class="text-lg font-medium text-white mb-2">
                {m.stats_taste_no_profile()}
            </h4>
            <p class="text-muted max-w-md mx-auto">
                {m.stats_taste_no_profile_desc()}
            </p>
            <!-- /rating does not exist as a standalone route; the Rating Mode lives on the home page -->
            <a href={resolve('/')} class="btn btn-purple mt-4 text-sm font-medium">
                <Icon src={Star} class="w-4 h-4" aria-hidden="true" />
                {m.stats_taste_start_rating()}
            </a>
        </div>
    {:else}
        <!-- Preference weights -->
        <div class="space-y-4 mb-6">
            <!-- Availability preference -->
            <div>
                <div class="between mb-1">
                    <span class="text-muted">{m.stats_taste_library_pref()}</span>
                    <span class="{getWeightColor(data.availabilityPreference)} text-sm font-medium">
                        {formatPref(data.availabilityPreference)}%
                        <span class="text-xs font-normal ml-1"
                            >({getWeightLabel(data.availabilityPreference)})</span>
                    </span>
                </div>
                <div
                    class="w-full bg-gray-700 rounded-full h-2"
                    role="progressbar"
                    aria-valuenow={formatPref(data.availabilityPreference)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={m.stats_taste_bar_label({
                        name: m.stats_taste_library_pref(),
                        value: formatPref(data.availabilityPreference),
                    })}>
                    <div
                        class="{getBarColor(
                            data.availabilityPreference,
                        )} h-2 rounded-full transition-all duration-500"
                        style="width: {formatPref(data.availabilityPreference)}%">
                    </div>
                </div>
                <p class="text-caption mt-1">
                    {data.availabilityPreference > 0.6
                        ? m.stats_taste_prefers_library()
                        : data.availabilityPreference < 0.4
                          ? m.stats_taste_open_discover()
                          : m.stats_taste_balanced()}
                </p>
            </div>

            <!-- Quality weight -->
            <div>
                <div class="between mb-1">
                    <span class="text-muted">{m.stats_taste_quality()}</span>
                    <span class="{getWeightColor(data.qualityWeight)} text-sm font-medium">
                        {formatPref(data.qualityWeight)}%
                        <span class="text-xs font-normal ml-1"
                            >({getWeightLabel(data.qualityWeight)})</span>
                    </span>
                </div>
                <div
                    class="w-full bg-gray-700 rounded-full h-2"
                    role="progressbar"
                    aria-valuenow={formatPref(data.qualityWeight)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={m.stats_taste_bar_label({
                        name: m.stats_taste_quality(),
                        value: formatPref(data.qualityWeight),
                    })}>
                    <div
                        class="{getBarColor(
                            data.qualityWeight,
                        )} h-2 rounded-full transition-all duration-500"
                        style="width: {formatPref(data.qualityWeight)}%">
                    </div>
                </div>
                <p class="text-caption mt-1">
                    {data.qualityWeight > 0.3
                        ? m.stats_taste_quality_high()
                        : data.qualityWeight < 0.1
                          ? m.stats_taste_quality_low()
                          : m.stats_taste_quality_moderate()}
                </p>
            </div>

            <!-- Popularity weight -->
            <div>
                <div class="between mb-1">
                    <span class="text-muted">{m.stats_taste_popularity()}</span>
                    <span class="{getWeightColor(data.popularityWeight)} text-sm font-medium">
                        {formatPref(data.popularityWeight)}%
                        <span class="text-xs font-normal ml-1"
                            >({getWeightLabel(data.popularityWeight)})</span>
                    </span>
                </div>
                <div
                    class="w-full bg-gray-700 rounded-full h-2"
                    role="progressbar"
                    aria-valuenow={formatPref(data.popularityWeight)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={m.stats_taste_bar_label({
                        name: m.stats_taste_popularity(),
                        value: formatPref(data.popularityWeight),
                    })}>
                    <div
                        class="{getBarColor(
                            data.popularityWeight,
                        )} h-2 rounded-full transition-all duration-500"
                        style="width: {formatPref(data.popularityWeight)}%">
                    </div>
                </div>
                <p class="text-caption mt-1">
                    {data.popularityWeight > 0.2
                        ? m.stats_taste_popularity_high()
                        : m.stats_taste_popularity_low()}
                </p>
            </div>

            <!-- Recency weight -->
            <div>
                <div class="between mb-1">
                    <span class="text-muted">{m.stats_taste_recency()}</span>
                    <span class="{getWeightColor(data.recencyWeight)} text-sm font-medium">
                        {formatPref(data.recencyWeight)}%
                        <span class="text-xs font-normal ml-1"
                            >({getWeightLabel(data.recencyWeight)})</span>
                    </span>
                </div>
                <div
                    class="w-full bg-gray-700 rounded-full h-2"
                    role="progressbar"
                    aria-valuenow={formatPref(data.recencyWeight)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={m.stats_taste_bar_label({
                        name: m.stats_taste_recency(),
                        value: formatPref(data.recencyWeight),
                    })}>
                    <div
                        class="{getBarColor(
                            data.recencyWeight,
                        )} h-2 rounded-full transition-all duration-500"
                        style="width: {formatPref(data.recencyWeight)}%">
                    </div>
                </div>
                <p class="text-caption mt-1">
                    {data.recencyWeight > 0.2
                        ? m.stats_taste_recency_high()
                        : m.stats_taste_recency_low()}
                </p>
            </div>
        </div>

        <!-- Taste in words: chips from top genres + keywords -->
        {#if tasteChips.length > 0}
            <div class="border-t border-gray-700 pt-4 mb-4">
                <div class="flex items-center gap-2 mb-3">
                    <Icon src={Sparkles} class="w-4 h-4 text-purple-400" aria-hidden="true" />
                    <span class="text-muted">{m.stats_taste_in_words()}</span>
                </div>
                <ul class="flex flex-wrap gap-2" aria-label={m.stats_taste_in_words()}>
                    {#each tasteChips as chip (chip)}
                        <li
                            class="px-3 py-1 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-200 text-sm">
                            {chip}
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}

        <!-- All-time note: TasteProfile is not period-filtered -->
        <p class="text-caption text-xs mb-4">{m.stats_taste_all_time_note()}</p>

        <!-- AI Insights -->
        {#if data.insights.length > 0}
            <div class="border-t border-gray-700 pt-4">
                <div class="flex items-center gap-2 mb-3">
                    <Icon src={LightBulb} class="w-4 h-4 text-yellow-400" aria-hidden="true" />
                    <span class="text-muted">{m.stats_taste_insights()}</span>
                </div>
                <div class="space-y-2">
                    {#each data.insights as insight, i (i)}
                        <div class="bg-gray-700/30 rounded-lg p-3 text-subtitle">
                            {localizeInsight(insight)}
                        </div>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Profile metadata -->
        <div class="between mt-4 pt-4 border-t border-gray-700 text-caption">
            <div class="flex items-center gap-1">
                <Icon src={Clock} class="w-3 h-3" aria-hidden="true" />
                <span>{formatProfileAge(data.profileAge)}</span>
            </div>
            {#if data.lastActivity}
                <span
                    >{m.stats_taste_last_activity({
                        date: new SvelteDate(data.lastActivity).toLocaleDateString(getLocale()),
                    })}</span>
            {/if}
        </div>
    {/if}
</div>
