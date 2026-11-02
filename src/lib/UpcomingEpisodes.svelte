<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
import { pickVariantUrl } from '$lib/utils/image-utils.js';
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import {
        Icon,
        CalendarDays,
        ChevronDown,
        ChevronUp,
        Cog6Tooth,
        Check,
        Clock,
        ArrowPath,
        EyeSlash,
        XMark,
    } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import {
        formatDate,
        getDaysUntil,
        getWeekdayShort,
        isRecentEpisode,
    } from '$lib/utils/date-formatting';
    import { LoadingState, EmptyState } from '$lib/components/ui';
    import { SectionRenderer } from '$lib/components/sections';
    import { createCollapseHandler } from '$lib/utils/ui-state';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { openMediaModal, confirmDialog } from '$lib/utils/modal-utils';
    import {
        handleItemRequest as handleItemRequestShared,
        handleItemMore as handleItemMoreShared,
    } from '$lib/components/foryou/item-handlers';
    import { env } from '$env/dynamic/public';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import { page } from '$app/stores';
    import type { PageSection, UniversalMediaItem, Badge } from '$lib/types/server-driven-ui';
    import * as m from '$lib/paraglide/messages';
    import * as contentApi from '$lib/api/content';
    import type { MediaPreview } from '$lib/schemas/api-media-preview';
    import { url } from '$lib/paths';

    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    const requestUrl = env.PUBLIC_REQUESTURL || '';

    interface ExcludedSeries {
        /** Flag row id, the handle for unmuting. */
        id: string;
        seriesName: string;
        excludedAt: string;
    }

    /** An upcoming episode plus the ids that key a mute (catalog series UUID, TMDB TV id). */
    type UpcomingRow = MediaPreview;

    /**
     * One row's worth of upcoming-episode data for a single series: the
     * earliest upcoming episode (shown as the row) plus how many additional
     * upcoming episodes for that series were folded into it.
     */
    interface SeriesEpisodeGroup {
        representative: UpcomingRow;
        additionalCount: number;
    }

    let upcomingEpisodes: UpcomingRow[] = $state([]);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let watchedSeriesCount = $state(0);
    let isCollapsed = $state(false);
    let showSettings = $state(false);
    let showExcludedManager = $state(false);
    let episodeLimit = $state(10);
    let excludedSeries: ExcludedSeries[] = $state([]);
    let loadingExcluded = $state(false);

    const collapseHandler = createCollapseHandler('upcoming-episodes-collapsed');

    // =========================================================================
    // Group episodes by series
    // =========================================================================

    /**
     * Parse an air date into epoch milliseconds for sorting purposes. Missing
     * or unparsable dates sort last (treated as "unknown, furthest out").
     */
    function airDateSortKey(sonarrAirDate: string | undefined): number {
        if (!sonarrAirDate) return Number.POSITIVE_INFINITY;
        const ms = new Date(sonarrAirDate).getTime();
        return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
    }

    /**
     * Collapse multiple upcoming episodes of the same series into a single
     * row: the earliest upcoming episode becomes the representative, and the
     * rest are counted so the UI can render "+N more" alongside it.
     *
     * - Grouping key is `seriesName` (matches the id/exclude-series keying
     *   used elsewhere in this file).
     * - Within a group, episodes are sorted by air date ascending; unknown/
     *   unparsable dates sort last. Ties (e.g. two episodes airing the same
     *   day) keep their original relative order (stable sort).
     * - Groups are ordered by their representative's air date ascending, so
     *   the overall list stays sorted by "earliest upcoming episode per
     *   series" — same contract as the ungrouped list had.
     */
    function groupUpcomingEpisodesBySeries(episodes: UpcomingRow[]): SeriesEpisodeGroup[] {
        const seriesOrder: string[] = [];
        const bySeriesName = new Map<string, UpcomingRow[]>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- transient local inside a pure grouping function, never reactive state

        for (const episode of episodes) {
            const key = episode.context?.series?.id ?? episode.id;
            const existing = bySeriesName.get(key);
            if (existing) {
                existing.push(episode);
            } else {
                bySeriesName.set(key, [episode]);
                seriesOrder.push(key);
            }
        }

        const groups: SeriesEpisodeGroup[] = seriesOrder.map((key) => {
            const seriesEpisodes = bySeriesName.get(key) ?? [];
            const sorted = [...seriesEpisodes].sort(
                (a, b) => airDateSortKey(a.context?.airDate) - airDateSortKey(b.context?.airDate),
            );
            const [representative, ...rest] = sorted;
            return { representative, additionalCount: rest.length };
        });

        return groups.sort(
            (a, b) =>
                airDateSortKey(a.representative.context?.airDate) -
                airDateSortKey(b.representative.context?.airDate),
        );
    }

    // =========================================================================
    // Transform episode group to UniversalMediaItem
    // =========================================================================

    function transformUpcomingEpisodeItem(group: SeriesEpisodeGroup): UniversalMediaItem {
        const episode = group.representative;
        const badges: Badge[] = [];

        // Add "NEW" badge for recent episodes
        if (isRecentEpisode(episode.context?.airDate)) {
            badges.push({ text: m.upcoming_new_badge(), color: 'success' });
        }

        // Build subtitle with "S1E7 · Episode Title · +N more" format. Drop
        // the episode title when it's just the S/E label (no real title
        // supplied) to avoid "S1E7 · S1E7". Append the existing
        // upcoming_more_episodes() paraglide key when other upcoming
        // episodes of this series were folded into this row.
        const episodeInfo =
            episode.context?.seasonNumber && episode.context?.episodeNumber
                ? `S${episode.context?.seasonNumber}E${episode.context?.episodeNumber}`
                : '';
        const episodeTitle = episode.title && episode.title !== episodeInfo ? episode.title : '';
        const moreLabel =
            group.additionalCount > 0
                ? m.upcoming_more_episodes({ count: group.additionalCount })
                : '';
        const subtitle = [episodeInfo, episodeTitle, moreLabel].filter(Boolean).join(' · ');

        // Relative time + weekday, e.g. "in 10 days · Fri". Weekday helps place
        // longer look-aheads; falls back to the formatted date for today.
        const relative = getDaysUntil(episode.context?.airDate);
        const airDateInfo = relative
            ? [relative, getWeekdayShort(episode.context?.airDate)].filter(Boolean).join(' · ')
            : formatDate(episode.context?.airDate);

        // Determine poster URL with size optimization
        const descriptor = episode.images.thumb ?? episode.images.poster;
        const imageUrl = descriptor
            ? url(pickVariantUrl(descriptor, 'card'))
            : FALLBACK_IMAGE;

        return {
            id: `${episode.id}-${episode.context?.seasonNumber}-${episode.context?.episodeNumber}`,
            externalIds: mediaPreviewToUniversal(episode).externalIds,
            mediaType: 'episode',
            title: episode.context?.series?.title ?? episode.title,
            seriesId: episode.context?.series?.id,
            subtitle,
            image: imageUrl,
            overview: episode.overview,
            isAvailable: episode.availability?.hasFile || false,
            canRequest: episode.availability?.canRequest ?? false,
            badges,
            seasonNumber: episode.context?.seasonNumber,
            episodeNumber: episode.context?.episodeNumber,
            seriesName: episode.context?.series?.title ?? episode.title,
            releaseDate: airDateInfo,
            clickData: {
                episode,
                airDate: episode.context?.airDate,
                airDateDisplay: airDateInfo,
            },
        };
    }

    // Build reactive section from episodes
    let section: PageSection = $derived({
        id: 'upcoming-list',
        type: 'list',
        title: '',
        items: groupUpcomingEpisodesBySeries(upcomingEpisodes).map(transformUpcomingEpisodeItem),
        meta: {
            showRemoveButton: true, // Used as "exclude series" button
            showMoreButton: false,
            accentColor: 'primary',
        },
    });

    // =========================================================================
    // Data Loading
    // =========================================================================

    async function loadUpcomingEpisodeItems(refresh = false) {
        if (!browser) return;

        loading = true;
        error = null;

        try {
            const { data, error: apiError } = await contentApi.getUpcoming(
                episodeLimit,
                refresh || undefined,
            );
            if (apiError) {
                throw new Error(apiError);
            }

            // New contract: {items, page} — items are RecommendationItem shape.
            // Normalize to UpcomingEpisodeItem so the rest of the component works unchanged.
            upcomingEpisodes = data?.items ?? [];
            // watchedSeriesCount is no longer in the contract — leave at 0.
            watchedSeriesCount = 0;
        } catch (e) {
            error = e instanceof Error ? e.message : 'Unknown error';
            console.error('Failed to load upcoming episodes:', e);
        } finally {
            loading = false;
        }
    }

    // =========================================================================
    // Excluded Series Management
    // =========================================================================

    async function loadExcludedSeries() {
        if (!browser) return;
        loadingExcluded = true;
        try {
            const { data } = await contentApi.getExcludedSeries();
            if (data) {
                excludedSeries = (data.items || []) as ExcludedSeries[];
            }
        } catch (err) {
            console.error('Failed to load excluded series:', err);
        } finally {
            loadingExcluded = false;
        }
    }

    /** A row can be muted only by id; one with neither a catalog id nor a TMDB id cannot. */
    function canExcludeItem(item: UniversalMediaItem): boolean {
        const episode = item.clickData?.episode as UpcomingRow | undefined;
        return !!(episode?.context?.series?.catalogId || episode?.ids.tmdb);
    }

    async function excludeSeries(seriesName: string, episode?: UpcomingRow) {
        const key = episode?.context?.series?.catalogId
            ? { mediaId: episode.context?.series?.catalogId }
            : episode?.ids.tmdb
              ? { tmdbId: episode.ids.tmdb }
              : null;
        if (!key) return;
        try {
            const { error } = await contentApi.excludeSeries({
                seriesName,
                ...key,
                mediaType: 'series',
            });

            if (!error) {
                // Remove the series from the list locally
                upcomingEpisodes = upcomingEpisodes.filter((ep) => !isSameSeries(ep, episode));
                toasts.success(m.upcoming_series_excluded(), 3000);
                // Refresh excluded list if manager is open
                if (showExcludedManager) {
                    await loadExcludedSeries();
                }
            } else {
                toasts.error(m.toast_hide_failed());
            }
        } catch (err) {
            console.error('Failed to exclude series:', err);
            toasts.error(m.toast_hide_failed());
        }
    }

    /** Same series by catalog id, else TMDB id, else name. */
    function isSameSeries(a: UpcomingRow, b: UpcomingRow | undefined): boolean {
        if (!b) return false;
        return a.context?.series?.id === b.context?.series?.id;
    }

    async function unexcludeSeries(id: string) {
        try {
            const { error } = await contentApi.unexcludeSeries(id);

            if (!error) {
                excludedSeries = excludedSeries.filter((s) => s.id !== id);
                // Reload upcoming episodes to show the unexcluded series
                await loadUpcomingEpisodeItems(true);
            } else {
                toasts.error(m.toast_restore_failed());
            }
        } catch (err) {
            console.error('Failed to unexclude series:', err);
            toasts.error(m.toast_restore_failed());
        }
    }

    async function promptExcludeSeries(item: UniversalMediaItem) {
        const episode = item.clickData?.episode as UpcomingRow | undefined;
        const seriesName = item.seriesName || episode?.context?.series?.title || item.title;
        if (!canExcludeItem(item)) return;

        try {
            await confirmDialog({
                title: m.upcoming_exclude_series(),
                body: m.upcoming_exclude_series_title({ seriesName }),
                confirmText: m.upcoming_exclude_series_confirm(),
                cancelText: m.upcoming_exclude_series_cancel(),
            });
            excludeSeries(seriesName, episode);
        } catch {
            // User cancelled
        }
    }

    function toggleExcludedManager() {
        showExcludedManager = !showExcludedManager;
        if (showExcludedManager && excludedSeries.length === 0) {
            loadExcludedSeries();
        }
    }

    // =========================================================================
    // Episode ID Resolution (for Sonarr episodes)
    // =========================================================================

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function handleEpisodeClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        const episode = item.clickData?.episode as UpcomingRow | undefined;

        // Open the episode modal with all available data
        openMediaModal(
            {
                title: item.title,
                overview: item.overview,
                mediaType: 'episode',
                externalIds: item.externalIds,
                seriesInternalId: item.seriesId,
                seriesName: item.seriesName || episode?.context?.series?.title,
                seasonNumber: item.seasonNumber || episode?.context?.seasonNumber,
                episodeNumber: item.episodeNumber || episode?.context?.episodeNumber,
                sonarrSeriesId: undefined,
                sonarrAirDate: episode?.context?.airDate,
                sonarrHasFile: episode?.availability?.hasFile,
                canRequest: item.canRequest,
                isAvailable: item.isAvailable,
            },
            item.image || FALLBACK_IMAGE,
        );
    }

    async function handleEpisodePlay(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        const episode = item.clickData?.episode as UpcomingRow | undefined;

        if (!episode || !item.isAvailable) return;

        // Sonarr episodes need to be resolved to a playback ID first
        const episodeId = episode.catalogId;
        if (episodeId) {
            void navigateToWatch(episodeId);
        } else {
            toasts.info(m.upcoming_episode_not_playable());
        }
    }

    function handleItemRemove(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        promptExcludeSeries(item);
    }

    // =========================================================================
    // UI Controls
    // =========================================================================

    function toggleCollapsed() {
        isCollapsed = collapseHandler.toggle(isCollapsed);
    }

    function toggleSettings() {
        showSettings = !showSettings;
    }

    function updateLimit() {
        if (browser && localStorage) {
            localStorage.setItem('upcomingEpisodesLimit', episodeLimit.toString());
        }
        loadUpcomingEpisodeItems(true); // Refresh on limit change
    }

    function handleRefresh() {
        loadUpcomingEpisodeItems(true);
    }

    onMount(() => {
        isCollapsed = collapseHandler.loadState();

        if (browser && localStorage) {
            const savedLimit = localStorage.getItem('upcomingEpisodesLimit');
            if (savedLimit) {
                episodeLimit = parseInt(savedLimit) || 10;
            }
        }
        loadUpcomingEpisodeItems();
    });
</script>

<section class="card variant-soft p-6">
    <header class="flex items-center gap-3 mb-6 flex-wrap">
        <Icon src={CalendarDays} class="h-6 w-6 text-primary-500 shrink-0" />
        <!-- `.h2`'s default size wrapped this heading onto up to 4 lines at
             375px alongside the icon/badge/controls — scale it down on
             narrow viewports and let it grow back at sm+. -->
        <h2 class="h2 text-lg sm:text-2xl min-w-0">{m.upcoming_your_new_next_episodes()}</h2>
        {#if watchedSeriesCount > 0}
            <span class="badge variant-ghost-surface text-xs">
                {watchedSeriesCount}
                {m.upcoming_series_followed()}
            </span>
        {/if}

        <!-- Settings and Collapse Controls -->
        <div class="flex items-center gap-2 ml-auto">
            <button
                class="btn btn-sm variant-soft-surface"
                onclick={handleRefresh}
                disabled={loading}
                title={m.upcoming_refresh()}>
                <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
            </button>

            <button
                class="btn btn-sm variant-soft-surface"
                onclick={toggleExcludedManager}
                title={m.upcoming_manage_excluded()}>
                <Icon src={EyeSlash} class="h-4 w-4" />
            </button>

            <button
                class="btn btn-sm variant-soft-surface"
                onclick={toggleSettings}
                title={m.upcoming_settings()}>
                <Icon src={Cog6Tooth} class="h-4 w-4" />
            </button>

            <button
                class="btn btn-sm variant-soft-surface"
                onclick={toggleCollapsed}
                title={isCollapsed ? m.btn_expand() : m.btn_collapse()}>
                <Icon src={isCollapsed ? ChevronDown : ChevronUp} class="h-4 w-4" />
            </button>
        </div>
    </header>

    <!-- Settings Panel -->
    {#if showSettings && !isCollapsed}
        <div class="card variant-ghost-surface p-4 mb-4">
            <h3 class="h4 mb-3">{m.upcoming_display_settings()}</h3>
            <div class="flex items-center gap-3">
                <label class="text-sm text-surface-300" for="episode-limit">
                    {m.upcoming_episode_count()}
                </label>
                <input
                    id="episode-limit"
                    type="number"
                    bind:value={episodeLimit}
                    min="1"
                    max="50"
                    class="input w-20 text-sm"
                    onchange={updateLimit} />
                <button class="btn btn-sm variant-filled-primary" onclick={updateLimit}>
                    {m.upcoming_update()}
                </button>
            </div>
        </div>
    {/if}

    <!-- Excluded Series Manager Panel -->
    {#if showExcludedManager && !isCollapsed}
        <div class="card variant-ghost-surface p-4 mb-4">
            <div class="between mb-3">
                <h3 class="h4 flex items-center gap-2">
                    <Icon src={EyeSlash} class="h-5 w-5 text-warning-500" />
                    {m.upcoming_excluded_series()}
                </h3>
                <button class="btn btn-sm variant-ghost-surface" onclick={toggleExcludedManager}>
                    <Icon src={XMark} class="h-4 w-4" />
                </button>
            </div>

            {#if loadingExcluded}
                <p class="text-surface-400 text-sm">{m.upcoming_loading()}</p>
            {:else if excludedSeries.length === 0}
                <p class="text-surface-400 text-sm">
                    {m.upcoming_no_excluded_series()}
                </p>
            {:else}
                <div class="space-y-2">
                    {#each excludedSeries as series (series.id)}
                        <div class="between p-2 rounded bg-surface-700/50">
                            <span class="text-sm text-surface-200">{series.seriesName}</span>
                            <button
                                class="btn btn-sm variant-soft-success"
                                onclick={() => unexcludeSeries(series.id)}>
                                {m.upcoming_unexclude()}
                            </button>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- Main Content - Hidden when collapsed -->
    {#if !isCollapsed}
        {#if loading}
            <LoadingState loading={true} loadingMessage={m.upcoming_loading()} />
        {:else if error}
            <div class="text-center py-8">
                <p class="text-error-500">{m.error_loading({ error })}</p>
            </div>
        {:else if upcomingEpisodes.length === 0}
            <EmptyState
                icon={CalendarDays}
                title={m.upcoming_no_episodes()}
                description={watchedSeriesCount === 0
                    ? m.upcoming_watch_series()
                    : m.upcoming_no_planned_episodes({
                          count: watchedSeriesCount,
                      })}
                variant="minimal" />
        {:else}
            <SectionRenderer
                {section}
                {hasRequestPermission}
                canRemoveItem={canExcludeItem}
                onitemClick={handleEpisodeClick}
                onitemPlay={handleEpisodePlay}
                onitemRequest={(d) =>
                    handleItemRequestShared(d, requestsEnabled, requestUrl, hasRequestPermission)}
                onitemMore={handleItemMoreShared}
                onitemRemove={handleItemRemove} />

            {#if upcomingEpisodes.length > 0}
                <footer class="text-center mt-6">
                    <p class="text-surface-500 text-sm">
                        {m.upcoming_footer_text()}
                    </p>
                </footer>
            {/if}
        {/if}
    {:else}
        <!-- Collapsed state - show first episode as preview -->
        {#if loading}
            <div class="text-center py-4">
                <p class="text-surface-400">{m.upcoming_loading()}</p>
            </div>
        {:else if section.items.length > 0}
            {@const firstItem = section.items[0]}
            {@const previewEpisode = firstItem.clickData?.episode as UpcomingRow | undefined}
            {@const previewEpisodeInfo =
                firstItem.seasonNumber && firstItem.episodeNumber
                    ? `S${firstItem.seasonNumber}E${firstItem.episodeNumber}`
                    : ''}
            <div class="space-y-4">
                <!-- Show first episode -->
                <div
                    class="card variant-ghost-surface p-4 hover:variant-soft-surface transition-colors opacity-75">
                    <div class="flex items-start gap-4">
                        <!-- Series Poster -->
                        <div class="shrink-0">
                            <img
                                src={firstItem.image}
                                alt="{firstItem.title} poster"
                                class="w-12 h-18 object-cover rounded-md bg-surface-600"
                                loading="lazy" />
                        </div>

                        <div class="flex-1 min-w-0 flex items-start justify-between">
                            <div class="flex-1 min-w-0">
                                <!-- Series and Episode Info -->
                                <div class="flex items-center gap-2 mb-1">
                                    <h3 class="font-bold text-primary-400 truncate text-sm">
                                        {firstItem.title}
                                    </h3>
                                    {#if firstItem.seasonNumber && firstItem.episodeNumber}
                                        <span class="badge variant-soft-primary text-xs">
                                            S{firstItem.seasonNumber}E{firstItem.episodeNumber}
                                        </span>
                                    {/if}
                                    {#if firstItem.isAvailable}
                                        <Icon
                                            src={Check}
                                            class="h-3 w-3 text-success-500"
                                            title={m.upcoming_episode_available()} />
                                    {/if}
                                </div>

                                <!-- Episode Title -->
                                <p class="text-surface-300 text-sm truncate">
                                    {previewEpisode?.title &&
                                    previewEpisode.title !== previewEpisodeInfo
                                        ? previewEpisode.title
                                        : ''}
                                </p>

                                <!-- Watch Button for Available Episodes -->
                                {#if firstItem.isAvailable}
                                    <div class="mt-2">
                                        <button
                                            class="btn variant-filled-primary btn-sm"
                                            onclick={() =>
                                                handleEpisodePlay({
                                                    section,
                                                    item: firstItem,
                                                })}>
                                            <span class="text-xs">▶ {m.upcoming_watch()}</span>
                                        </button>
                                    </div>
                                {/if}
                            </div>

                            <!-- Air Date -->
                            <div class="flex flex-col items-end text-right ml-4">
                                <div class="flex items-center gap-1 text-surface-300">
                                    <Icon src={Clock} class="h-3 w-3" />
                                    <span class="text-xs">
                                        {firstItem.releaseDate || ''}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Show count of additional episodes -->
                {#if section.items.length > 1}
                    <div class="text-center">
                        <p class="text-surface-500 text-sm">
                            {m.upcoming_and_more({
                                count: section.items.length - 1,
                            })}
                        </p>
                    </div>
                {/if}
            </div>
        {:else}
            <div class="text-center py-4">
                <p class="text-surface-400">{m.upcoming_no_upcoming()}</p>
            </div>
        {/if}
    {/if}
</section>

<style>
    /* Styles handled by SectionRenderer - keeping minimal overrides if needed */
</style>
