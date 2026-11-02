<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages.js';
    import { getWatchStats } from '$lib/api/watch-stats';
    import type { MediaStatRow } from '$lib/schemas/api-watch-stats-response';
    import MediaCarousel from './MediaCarousel.svelte';

    let topMovies: MediaStatRow[] = $state([]);
    let topTVShows: MediaStatRow[] = $state([]);
    let mostCompleted: MediaStatRow[] = $state([]);
    let loaded = $state(false);
    let loading = $state(false);
    let moviesTimeframe: 'AllTime' | 'LastWeek' | 'LastMonth' | 'LastYear' = $state('AllTime');
    let moviesLoading = $state(false);

    // Load all media sections
    export async function load() {
        if (loaded || loading) return;
        loading = true;

        try {
            const [moviesResponse, tvShowsResponse, completedResponse] = await Promise.allSettled([
                getWatchStats({
                    type: 'movies',
                    limit: 20,
                    timeframe: moviesTimeframe,
                }),
                getWatchStats({
                    type: 'tvshows',
                    limit: 20,
                    timeframe: 'AllTime',
                }),
                getWatchStats({
                    type: 'tvshows-completion',
                    limit: 20,
                    timeframe: 'AllTime',
                }),
            ]);

            // Process movies - API returns { success: true, stats: [...] }
            if (moviesResponse.status === 'fulfilled') {
                topMovies = (moviesResponse.value.data?.stats as MediaStatRow[]) ?? [];
            }

            // Process TV shows - API returns { success: true, stats: [...] }
            if (tvShowsResponse.status === 'fulfilled') {
                topTVShows = (tvShowsResponse.value.data?.stats as MediaStatRow[]) ?? [];
            }

            // Process completed shows - API returns { success: true, stats: [...] }
            if (completedResponse.status === 'fulfilled') {
                mostCompleted = (completedResponse.value.data?.stats as MediaStatRow[]) ?? [];
            }

            loaded = true;
        } catch (error) {
            console.error('Failed to load popular media stats:', error);
        } finally {
            loading = false;
        }
    }

    // Handle movies timeframe change
    async function handleMoviesTimeframeChange(timeframe: string) {
        moviesTimeframe = timeframe as 'AllTime' | 'LastWeek' | 'LastMonth' | 'LastYear';
        moviesLoading = true;

        try {
            const { data } = await getWatchStats({
                type: 'movies',
                limit: 20,
                timeframe: moviesTimeframe,
            });
            topMovies = (data?.stats as MediaStatRow[]) ?? [];
        } catch (error) {
            console.error('Failed to load movies for timeframe:', timeframe, error);
        } finally {
            moviesLoading = false;
        }
    }

    // Check if any content is available
    let hasContent = $derived(
        topMovies.length > 0 || topTVShows.length > 0 || mostCompleted.length > 0,
    );
</script>

{#if loading && !loaded}
    <!-- Loading skeleton -->
    <div class="popular-stats-section space-y-10">
        <div class="space-y-4">
            <div class="h-8 bg-gray-700 rounded w-48 animate-pulse"></div>
            <div class="flex gap-3 overflow-hidden">
                {#each Array(6) as _, i (i)}
                    <div class="shrink-0 w-48 space-y-2">
                        <div class="bg-gray-700 aspect-[2/3] rounded-lg animate-pulse"></div>
                        <div class="h-4 bg-gray-700 rounded w-3/4 animate-pulse"></div>
                        <div class="h-3 bg-gray-700 rounded w-1/2 animate-pulse"></div>
                    </div>
                {/each}
            </div>
        </div>
    </div>
{:else if loaded && hasContent}
    <div class="popular-stats-section">
        <!-- Section Divider -->
        <div class="stats-divider">
            <span>{m.stats_popular_content()}</span>
        </div>

        <div class="space-y-10 mt-6">
            <!-- Top Movies -->
            {#if topMovies.length > 0 || moviesLoading}
                <MediaCarousel
                    title={m.stats_top_movies()}
                    items={topMovies}
                    type="movies"
                    showTimeframeSelector={true}
                    selectedTimeframe={moviesTimeframe}
                    onTimeframeChange={handleMoviesTimeframeChange}
                    isLoading={moviesLoading} />
            {/if}

            <!-- Top TV Shows -->
            {#if topTVShows.length > 0}
                <MediaCarousel
                    title={m.stats_most_popular_tv()}
                    items={topTVShows}
                    type="tvshows" />
            {/if}

            <!-- Most Completed Shows -->
            {#if mostCompleted.length > 0}
                <MediaCarousel
                    title={m.stats_most_completed_tv()}
                    items={mostCompleted}
                    type="completion" />
            {/if}
        </div>
    </div>
{/if}

<style lang="postcss">
    .popular-stats-section {
        padding: 0 1rem;
    }

    .stats-divider {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin: 2rem 0 1.5rem;
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .stats-divider::before,
    .stats-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: linear-gradient(to right, transparent, var(--color-surface-600), transparent);
    }
</style>
