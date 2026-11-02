<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    /**
     * NewEpisodeBanner - "New episodes available": newly released episodes of
     * series the user follows, one card per series (rule:
     * src/lib/server/services/new-release-rule.ts). Back-catalogue arrivals
     * (fulfilled requests, season packs) are never in here.
     */
    import { Icon, PlayCircle, ChevronRight, XMark, Sparkles, EyeSlash } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';

    /**
     * One card per series from GET /api/for-you/new-episodes: an episode
     * MediaPreview plus `newEpisodes` (count, watchedEpisodeCount).
     */
    import type { NewEpisodeAlert as NewEpisodeAlertItem } from '$lib/schemas/api-for-you-responses';
    import { url } from '$lib/paths';

    interface Props {
        alerts?: NewEpisodeAlertItem[];
        // Callbacks
        ondismiss?: (detail: {
            seriesName: string;
            /**
             * Internal series UUID — required for the server-side dismissal
             * persist (P3). Optional in the type so callers without a
             * resolved id still trigger the optimistic UI removal; the
             * dismissal just won't persist across reload in that case.
             */
            seriesInternalId?: string;
        }) => void;
        onexclude?: (detail: {
            seriesName: string;
            /** Internal series UUID — scopes the optimistic removal so a
             *  same-named sibling series isn't over-removed (L3). */
            seriesInternalId?: string;
        }) => void;
        onopenSeries?: (detail: {
            seriesName: string;
            seriesInternalId?: string;
            ids: Record<string, string>;
        }) => void;
        onwatch?: (detail: {
            seriesName: string;
            seasonNumber: number;
            episodeNumber: number;
            ids: Record<string, string>;
        }) => void;
    }

    let { alerts = [], ondismiss, onexclude, onopenSeries, onwatch }: Props = $props();

    // Only show top 3 alerts
    let displayAlerts = $derived(alerts.slice(0, 3));
    let hasAlerts = $derived(displayAlerts.length > 0);

    function formatEpisode(season: number, episode: number): string {
        return `S${season}E${episode}`;
    }

    function formatAirDate(dateStr: string): string {
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return dateStr;
        const now = new Date();

        // L4: compare calendar days in LOCAL time. The previous fixed
        // 86_400_000ms subtraction compared an air date stored at UTC
        // midnight against the local `now`, so the day boundary drifted by
        // the UTC offset (and broke across DST) — producing "yesterday" for
        // today's episode in negative-UTC zones and never "today" for a
        // future-dated air date. Zeroing both to local midnight first makes
        // the difference an exact whole number of calendar days.
        const startOfDay = (d: Date): number =>
            new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const MS_PER_DAY = 1000 * 60 * 60 * 24;
        const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / MS_PER_DAY);

        // Future or today's air date → "today" (guards the negative case so a
        // tomorrow-dated episode doesn't fall through to "days ago").
        if (diffDays <= 0) return m.new_episodes_today();
        if (diffDays === 1) return m.new_episodes_yesterday();
        if (diffDays < 7) return m.new_episodes_days_ago({ count: diffDays });
        return date.toLocaleDateString();
    }

    function handleOpenSeries(alert: NewEpisodeAlertItem) {
        onopenSeries?.({
            seriesName: alert.context?.series?.title ?? alert.title,
            seriesInternalId: alert.context?.series?.catalogId ?? undefined,
            ids: {
                ...alert.ids,
                ...(alert.context?.series?.catalogId
                    ? { internal: alert.context.series.catalogId }
                    : {}),
            },
        });
    }

    function handleDismiss(alert: NewEpisodeAlertItem, event: Event) {
        event.stopPropagation();
        ondismiss?.({
            seriesName: alert.context?.series?.title ?? alert.title,
            // Use canonical internal UUID from ids{} or the top-level seriesId
            seriesInternalId: alert.context?.series?.catalogId ?? undefined,
        });
    }

    function handleExclude(alert: NewEpisodeAlertItem, event: Event) {
        event.stopPropagation();
        onexclude?.({
            seriesName: alert.context?.series?.title ?? alert.title,
            seriesInternalId: alert.context?.series?.catalogId ?? undefined,
        });
    }

    function handleWatchClick(alert: NewEpisodeAlertItem, event: Event) {
        event.stopPropagation();
        onwatch?.({
            seriesName: alert.context?.series?.title ?? alert.title,
            seasonNumber: alert.context?.seasonNumber ?? 0,
            episodeNumber: alert.context?.episodeNumber ?? 0,
            ids: {
                ...alert.ids,
                ...(alert.context?.series?.catalogId
                    ? { internal: alert.context.series.catalogId }
                    : {}),
            },
        });
    }
</script>

{#if hasAlerts}
    <div class="new-episode-banner mb-6">
        <!-- Header -->
        <div class="flex items-center gap-2 mb-3">
            <div
                class="center w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-600">
                <Icon src={Sparkles} class="w-4 h-4 text-white" />
            </div>
            <h3 class="text-lg font-semibold text-white">
                {m.new_episodes_available()}
            </h3>
            {#if displayAlerts.length > 1}
                <span class="badge badge-success">
                    {displayAlerts.length}
                </span>
            {/if}
        </div>

        <!-- Alert Cards -->
        <div class="grid gap-3 {displayAlerts.length === 1 ? '' : 'md:grid-cols-2 lg:grid-cols-3'}">
            {#each displayAlerts as alert (alert.id)}
                <div
                    class="group relative flex items-start gap-4 p-4 rounded-xl bg-gradient-to-r from-surface-700/80 to-surface-800/80 border border-green-500/30 hover:border-green-500/50 hover:from-surface-700 hover:to-surface-800 transition-all duration-200 text-left w-full cursor-pointer"
                    onclick={() => handleOpenSeries(alert)}
                    onkeydown={(e) => e.key === 'Enter' && handleOpenSeries(alert)}
                    role="button"
                    tabindex="0">
                    <!-- Action buttons -->
                    <div
                        class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <!-- Exclude button: a mute is keyed by the series id -->
                        {#if alert.context?.series?.catalogId ?? undefined}
                            <Tooltip text={m.upcoming_exclude_series()} position="bottom" fixed>
                                <button
                                    class="p-1 rounded-full bg-surface-600/80 hover:bg-red-500/80 transition-colors"
                                    onclick={(e) => handleExclude(alert, e)}>
                                    <Icon
                                        src={EyeSlash}
                                        class="w-4 h-4 text-gray-400 hover:text-white" />
                                </button>
                            </Tooltip>
                        {/if}
                        <!-- Dismiss button -->
                        <Tooltip text={m.new_episodes_hide()} position="bottom" fixed>
                            <button
                                class="p-1 rounded-full bg-surface-600/80 hover:bg-surface-500 transition-colors"
                                onclick={(e) => handleDismiss(alert, e)}>
                                <Icon src={XMark} class="w-4 h-4 text-gray-400" />
                            </button>
                        </Tooltip>
                    </div>

                    <!-- Poster — new contract uses images{} hrefs, not flat posterUrl -->
                    <div class="relative shrink-0">
                        <img
                            src={url(
                                pickVariant(alert.images.poster, 'card') ??
                                    pickVariant(alert.images.thumb, 'card') ??
                                    '/placeholders/popcorn.jpg',
                            )}
                            alt={alert.context?.series?.title ?? alert.title}
                            class="w-16 h-24 object-cover rounded-lg shadow-lg"
                            loading="lazy" />
                        <!-- NEW: every card here is a new release (requests have their own row) -->
                        <div
                            class="absolute -top-1 -right-1 px-1.5 py-0.5 text-[10px] font-bold bg-green-500 text-white rounded shadow-sm">
                            {m.upcoming_new_badge()}
                        </div>
                    </div>

                    <!-- Content -->
                    <div class="flex-1 min-w-0">
                        <!-- Series name -->
                        <h4
                            class="font-semibold text-white truncate group-hover:text-green-400 transition-colors">
                            {alert.context?.series?.title ?? alert.title}
                        </h4>

                        <!-- Episode info -->
                        <div class="flex items-center gap-2 mt-1">
                            <span
                                class="px-2 py-0.5 text-xs font-medium bg-primary-500/20 text-primary-400 rounded">
                                {formatEpisode(
                                    alert.context?.seasonNumber ?? 0,
                                    alert.context?.episodeNumber ?? 0,
                                )}
                            </span>
                            <span class="text-muted truncate">
                                {alert.title}
                            </span>
                        </div>

                        <!-- Air date -->
                        <p class="text-caption mt-1">
                            {formatAirDate(alert.context?.airDate ?? '')}
                            {#if alert.newEpisodes.count > 1}
                                <span class="text-green-400">
                                    · {m.new_episodes_more_for_series({
                                        count: alert.newEpisodes.count - 1,
                                    })}</span>
                            {/if}
                        </p>

                        <!-- Watch button -->
                        <div class="flex items-center gap-2 mt-3">
                            <button
                                class="btn btn-sm btn-green flex items-center gap-1.5"
                                disabled={!alert.availability?.isAvailable}
                                onclick={(e) => handleWatchClick(alert, e)}>
                                <Icon src={PlayCircle} class="w-4 h-4" />
                                {m.new_episodes_watch()}
                            </button>
                            <span class="text-caption">
                                {m.new_episodes_watched_count({
                                    count: alert.newEpisodes.watchedEpisodeCount,
                                })}
                            </span>
                        </div>
                    </div>

                    <!-- Chevron -->
                    <div
                        class="shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <Icon src={ChevronRight} class="w-5 h-5 text-gray-400" />
                    </div>
                </div>
            {/each}
        </div>

        {#if alerts.length > 3}
            <p class="text-center text-muted mt-3">
                {m.new_episodes_more_series({ count: alerts.length - 3 })}
            </p>
        {/if}
    </div>
{/if}

<style lang="postcss">
    @reference "../../app.css";

    .new-episode-banner {
        /* Subtle glow effect */
        @apply relative;
    }

    .new-episode-banner::before {
        content: '';
        @apply absolute -inset-1 bg-gradient-to-r from-green-500/10 via-emerald-500/5 to-green-500/10 rounded-2xl blur-xl opacity-50;
        z-index: -1;
    }
</style>
