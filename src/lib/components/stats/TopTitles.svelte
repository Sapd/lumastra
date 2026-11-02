<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { TopTitleItem } from '$lib/types/personal-stats';
    import { getCatalogPosterSrcSet } from '$lib/utils/image-utils';
    import { Icon, Trophy, Film } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        movies: TopTitleItem[];
        shows: TopTitleItem[];
    }

    let { movies = [], shows = [] }: Props = $props();

    let hasAny = $derived(movies.length > 0 || shows.length > 0);

    function plays(count: number): string {
        return m.stats_top_titles_plays({ count: count.toLocaleString(getLocale()) });
    }

    function duration(seconds: number): string {
        if (seconds < 3600) {
            return m.stats_top_titles_minutes({ count: Math.max(1, Math.round(seconds / 60)) });
        }
        return m.stats_top_titles_hours({
            count: (seconds / 3600).toLocaleString(getLocale(), { maximumFractionDigits: 1 }),
        });
    }

    // Shows: how much of the series was watched ("58 of 62 episodes"), not the
    // old sessions-per-library-episode ratio ("1.6× watched"), which read as a
    // rewatch count and was not one. Movies: how often it was finished, since a
    // play count counted every resume. Both add the time spent.
    function metricLabel(item: TopTitleItem): string {
        const time = duration(item.totalWatchSeconds);
        if (item.mediaType === 'series' && item.episodesWatched !== undefined) {
            const episodes = item.episodeCount
                ? m.stats_top_titles_episodes_of({
                      watched: item.episodesWatched,
                      total: item.episodeCount,
                  })
                : m.stats_top_titles_episodes({ count: item.episodesWatched });
            return `${episodes} · ${time}`;
        }
        if (item.mediaType === 'movie' && item.finishedCount !== undefined) {
            return item.finishedCount > 0
                ? `${m.stats_top_titles_finished({ count: item.finishedCount })} · ${time}`
                : time;
        }
        return plays(item.watchCount);
    }
</script>

{#if hasAny}
    <div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
        <div class="flex items-center gap-2 mb-4">
            <Icon src={Trophy} class="w-5 h-5 text-amber-400" aria-hidden="true" />
            <h3 class="text-lg font-bold text-white">{m.stats_top_titles_title()}</h3>
        </div>

        {#each [{ label: m.stats_top_titles_movies(), items: movies }, { label: m.stats_top_titles_shows(), items: shows }] as group (group.label)}
            {#if group.items.length > 0}
                <div class="mb-5 last:mb-0">
                    <p class="text-muted mb-3">{group.label}</p>
                    <ul class="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1" aria-label={group.label}>
                        {#each group.items as item (item.internalId ?? item.title)}
                            <li class="shrink-0 w-28">
                                <div
                                    class="aspect-[2/3] rounded-lg overflow-hidden bg-gray-700/60 border border-gray-600/40">
                                    {#if item.posterUrl && item.internalId}
                                        <img
                                            src={item.posterUrl}
                                            srcset={getCatalogPosterSrcSet(item.internalId)}
                                            sizes="112px"
                                            alt={item.title}
                                            loading="lazy"
                                            class="w-full h-full object-cover" />
                                    {:else}
                                        <div
                                            class="w-full h-full flex items-center justify-center text-gray-500">
                                            <Icon src={Film} class="w-8 h-8" aria-hidden="true" />
                                        </div>
                                    {/if}
                                </div>
                                <p
                                    class="mt-2 text-sm text-white font-medium truncate"
                                    title={item.title}>
                                    {item.title}
                                </p>
                                <p class="text-caption text-xs">
                                    {[metricLabel(item), item.year].filter(Boolean).join(' · ')}
                                </p>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/if}
        {/each}
    </div>
{/if}
