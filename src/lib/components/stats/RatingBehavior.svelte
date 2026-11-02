<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { RatingStats } from '$lib/types/personal-stats';
    import { Icon, Star } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        data: RatingStats;
    }

    let { data }: Props = $props();

    // Find the max count for scaling
    let maxCount = $derived(Math.max(...data.distribution.map((d) => d.count), 1));

    // Calculate rating category counts
    // Downvote: 1-3, Upvote: 4-8, Super Like: 9-10
    let downvoteCount = $derived(
        data.distribution.filter((d) => d.rating <= 3).reduce((sum, d) => sum + d.count, 0),
    );
    let upvoteCount = $derived(
        data.distribution
            .filter((d) => d.rating >= 4 && d.rating <= 8)
            .reduce((sum, d) => sum + d.count, 0),
    );
    let superLikeCount = $derived(
        data.distribution.filter((d) => d.rating >= 9).reduce((sum, d) => sum + d.count, 0),
    );

    // Totals for Movie/TV legend
    let totalMovies = $derived(data.distribution.reduce((sum, d) => sum + d.movieCount, 0));
    let totalTv = $derived(data.distribution.reduce((sum, d) => sum + d.tvCount, 0));

    // Whether to show the distribution (guard contradictory empty-state)
    let showDistribution = $derived(data.totalRatings > 0 || data.distribution.length > 0);

    function getBarHeight(count: number): string {
        return `${(count / maxCount) * 100}%`;
    }

    function getRatingColor(rating: number): string {
        if (rating >= 8) return 'bg-green-500';
        if (rating >= 6) return 'bg-blue-500';
        if (rating >= 4) return 'bg-yellow-500';
        return 'bg-red-500';
    }

    // Get emoji indicator for specific ratings
    function getRatingEmoji(rating: number): string | null {
        // The values the quick-rate buttons write: dislike 2 (the card menu's
        // older path writes 1), liked 8, loved 10. The heart sat on 9, a value
        // no quick button writes.
        if (rating === 2) return '👎';
        if (rating === 8) return '👍';
        if (rating === 10) return '❤️';
        return null;
    }

    // Build per-bar tooltip: localized "Rating X: N ratings"
    function getBarTooltip(rating: number, count: number): string {
        return m.stats_ratings_bar_label({ rating, count });
    }

    // Rounded display values
    let avgRatingDisplay = $derived(
        Number(data.avgRating).toLocaleString(getLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
        }),
    );
    let medianRatingDisplay = $derived(
        Number(data.medianRating).toLocaleString(getLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
        }),
    );
    let ratingFrequencyDisplay = $derived(
        Number(data.ratingFrequency).toLocaleString(getLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
        }),
    );
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="between mb-6 flex-wrap gap-y-3">
        <div>
            <div class="flex items-center gap-2">
                <Icon src={Star} class="w-5 h-5 text-yellow-400" aria-hidden="true" />
                <h3 class="text-lg font-bold text-white">
                    {m.stats_ratings_title()}
                </h3>
            </div>
            <p class="text-caption mt-1">{m.stats_ratings_scope()}</p>
        </div>
        <div class="flex items-center gap-4 flex-wrap">
            <div class="text-center">
                <p class="text-2xl font-bold text-yellow-400">
                    {data.totalRatings.toLocaleString(getLocale())}
                </p>
                <p class="text-hint">{m.stats_ratings_total()}</p>
            </div>
            <div class="text-center">
                <p class="text-2xl font-bold text-blue-400">{avgRatingDisplay}</p>
                <p class="text-hint">{m.stats_ratings_average()}</p>
            </div>
            <div class="text-center">
                <p class="text-2xl font-bold text-teal-400">{medianRatingDisplay}</p>
                <p class="text-hint">{m.stats_ratings_median()}</p>
            </div>
            <div class="text-center">
                <p class="text-2xl font-bold text-purple-400">
                    {ratingFrequencyDisplay}
                </p>
                <p class="text-hint">
                    {m.stats_ratings_per_month()}
                </p>
            </div>
        </div>
    </div>

    <!-- Rating Categories with Emojis -->
    <div class="center gap-8 mb-6 py-4 bg-gray-900/30 rounded-lg">
        <div class="text-center">
            <p class="text-2xl font-bold text-red-400">
                {downvoteCount.toLocaleString(getLocale())}
            </p>
            <p class="text-2xl mt-1" role="img" aria-label={m.stats_ratings_downvote()}>👎</p>
            <p class="text-xs text-hint mt-1">{m.stats_ratings_downvote()}</p>
        </div>
        <div class="text-center">
            <p class="text-2xl font-bold text-blue-400">
                {upvoteCount.toLocaleString(getLocale())}
            </p>
            <p class="text-2xl mt-1" role="img" aria-label={m.stats_ratings_upvote()}>👍</p>
            <p class="text-xs text-hint mt-1">{m.stats_ratings_upvote()}</p>
        </div>
        <div class="text-center">
            <p class="text-2xl font-bold text-pink-400">
                {superLikeCount.toLocaleString(getLocale())}
            </p>
            <p class="text-2xl mt-1" role="img" aria-label={m.stats_ratings_super_like()}>❤️</p>
            <p class="text-xs text-hint mt-1">{m.stats_ratings_super_like()}</p>
        </div>
    </div>

    {#if showDistribution}
        <!-- Rating Distribution Bar Chart -->
        <div role="img" aria-label={m.stats_ratings_distribution_label()} class="mb-2">
            <div class="flex items-end justify-between gap-2 h-40 mb-2">
                {#each Array.from({ length: 10 }, (_, i) => i + 1) as rating (rating)}
                    {@const ratingData = data.distribution.find((d) => d.rating === rating)}
                    {@const count = ratingData?.count ?? 0}
                    {@const emoji = getRatingEmoji(rating)}
                    <div class="flex-1 flex flex-col items-center">
                        <Tooltip text={getBarTooltip(rating, count)} position="top" fixed>
                            <div
                                class="w-full bg-gray-700 rounded-t flex flex-col justify-end h-32 transition-transform hover:scale-105"
                                role="img"
                                aria-label={getBarTooltip(rating, count)}>
                                {#if count > 0}
                                    <div
                                        class="{getRatingColor(
                                            rating,
                                        )} rounded-t transition-all duration-500 flex items-end justify-center min-h-[20px]"
                                        style="height: {getBarHeight(count)}">
                                        <span class="text-xs text-white font-medium pb-1"
                                            >{count}</span>
                                    </div>
                                {/if}
                            </div>
                        </Tooltip>
                        <span class="text-hint mt-2" aria-hidden="true">{rating}</span>
                        {#if emoji}
                            <span class="text-sm" aria-hidden="true">{emoji}</span>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>

        <!-- Movie vs TV Breakdown -->
        <div class="center gap-6 mt-4 pt-4 border-t border-gray-700">
            <div class="flex items-center gap-2">
                <!-- Circle shape discriminator for Movies -->
                <div class="w-3 h-3 bg-blue-500 rounded-full" aria-hidden="true"></div>
                <span class="text-muted"
                    >{m.stats_ratings_movies({
                        count: totalMovies,
                    })}</span>
            </div>
            <div class="flex items-center gap-2">
                <!-- Square shape discriminator for TV Shows -->
                <div class="w-3 h-3 bg-purple-500 rounded-none" aria-hidden="true"></div>
                <span class="text-muted"
                    >{m.stats_ratings_tv({
                        count: totalTv,
                    })}</span>
            </div>
        </div>
    {:else}
        <div class="text-center py-8">
            <p class="text-gray-500">{m.stats_ratings_no_data()}</p>
        </div>
    {/if}
</div>
