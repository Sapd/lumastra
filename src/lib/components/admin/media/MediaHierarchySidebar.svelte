<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChevronDown, ChevronRight, ChevronLeft, Film } from 'svelte-hero-icons';
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { onMount } from 'svelte';
    import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import {
        getCatalogPosterUrl,
        getCatalogBackdropUrl,
        getCatalogThumbUrl,
    } from '$lib/utils/image-utils';
    import { getMediaHierarchy } from '$lib/api/admin';
    /** Fallback handler: if thumb fails, try backdrop */
    function thumbFallback(e: Event, id: string): void {
        const img = e.currentTarget as HTMLImageElement;
        const fallback = backdropUrl(id);
        if (img.src !== fallback) {
            img.src = fallback;
        }
    }

    interface EpisodeNode {
        id: string;
        title: string | null;
        episodeNumber: number | null;
        seasonNumber: number | null;
        externalIds: { jellyfin?: string };
        hasFile: boolean;
        isOrderingSegment?: boolean;
    }

    interface SeasonNode {
        id: string;
        title: string | null;
        seasonNumber: number;
        episodeCount: number;
        externalIds: { jellyfin?: string };
        episodes: EpisodeNode[];
    }

    interface SeriesInfo {
        id: string;
        title: string;
        externalIds: { jellyfin?: string };
    }

    interface Props {
        artworkRevision?: number;
        seriesId: string;
        currentItemId: string;
        activeSeason?: number | null;
        reorderMode?: boolean;
        collapsed?: boolean;
        ontoggle?: () => void;
        onseasonselect?: (seasonNumber: number) => void;
        onepisodeselect?: (episodeId: string) => void;
        onreorderstart?: () => void;
        onreordercancel?: () => void;
        onreordersave?: (items: Array<{ id: string; episodeNumber: number }>) => void;
    }

    let {
        seriesId,
        artworkRevision = 0,
        currentItemId,
        activeSeason = null,
        reorderMode = false,
        collapsed = false,
        ontoggle,
        onseasonselect,
        onepisodeselect,
        onreorderstart,
        onreordercancel,
        onreordersave,
    }: Props = $props();

    let series = $state<SeriesInfo | null>(null);
    let seasons = $state<SeasonNode[]>([]);
    let loading = $state(true);
    let loadError = $state(false);
    let expandedSeasons = new SvelteSet<number>();
    let asideEl = $state<HTMLElement | undefined>(undefined);

    // The server renders this pane before the viewport width is known, and the
    // page's auto-collapse (narrow windows) only runs after hydration. Until
    // then, below that width, show the bare rail instead of an expanded pane
    // stuck on "Loading..." for as long as hydration takes.
    let hydrated = $state(false);
    onMount(() => {
        hydrated = true;
    });

    // Scroll the active item into view when navigation, data, or expansion changes
    $effect(() => {
        void currentItemId;
        void seasons;
        void expandedSeasons.size;
        if (!asideEl) return;
        const handle = setTimeout(() => {
            const el = asideEl?.querySelector('[data-current="true"]') as HTMLElement | null;
            el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 50);
        return () => clearTimeout(handle);
    });

    // Reorder state
    let reorderItems = $state<EpisodeNode[]>([]);
    let reorderDirty = $state(false);
    let reorderSeasonNumber = $state<number | null>(null);
    const flipDurationMs = 200;

    function enterReorder(seasonNumber: number): void {
        const season = seasons.find((s) => s.seasonNumber === seasonNumber);
        if (!season) return;
        reorderItems = season.episodes.map((ep) => ({ ...ep }));
        reorderSeasonNumber = seasonNumber;
        reorderDirty = false;
        onreorderstart?.();
    }

    function handleDndConsider(e: CustomEvent<{ items: EpisodeNode[] }>): void {
        reorderItems = e.detail.items;
    }

    function handleDndFinalize(e: CustomEvent<{ items: EpisodeNode[] }>): void {
        reorderItems = e.detail.items.filter((i) => i.id !== SHADOW_PLACEHOLDER_ITEM_ID);
        reorderDirty = true;
    }

    function saveReorder(): void {
        onreordersave?.(
            reorderItems.map((ep, index) => ({
                id: ep.id,
                episodeNumber: index + 1,
            })),
        );
        reorderItems = [];
        reorderSeasonNumber = null;
        reorderDirty = false;
    }

    function cancelReorder(): void {
        reorderItems = [];
        reorderSeasonNumber = null;
        reorderDirty = false;
        onreordercancel?.();
    }

    // Auto-enter reorder for expanded season when reorderMode activates
    $effect(() => {
        if (reorderMode && activeSeason != null && reorderSeasonNumber == null) {
            enterReorder(activeSeason);
        }
        if (!reorderMode && reorderSeasonNumber != null) {
            reorderItems = [];
            reorderSeasonNumber = null;
            reorderDirty = false;
        }
    });

    // Load hierarchy (re-runs when seriesId changes)
    $effect(() => {
        void seriesId; // track dependency
        void loadHierarchy();
    });

    // Auto-expand active season
    $effect(() => {
        if (activeSeason != null) {
            expandedSeasons.add(activeSeason);
        }
    });

    async function loadHierarchy(): Promise<void> {
        loading = true;
        loadError = false;
        try {
            const { data, error } = await getMediaHierarchy(seriesId);
            if (error || !data) {
                loadError = true;
                return;
            }
            series = data.series;
            seasons = [...data.seasons].sort(
                (a, b) =>
                    (a.seasonNumber === 0 ? Infinity : a.seasonNumber) -
                    (b.seasonNumber === 0 ? Infinity : b.seasonNumber),
            );

            // Auto-expand the season containing the current item
            if (currentItemId !== seriesId) {
                for (const s of data.seasons) {
                    if (s.episodes.some((ep) => ep.id === currentItemId)) {
                        expandedSeasons.add(s.seasonNumber);
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn('[MediaHierarchySidebar] Failed to load hierarchy', e);
            loadError = true;
        } finally {
            loading = false;
        }
    }

    function toggleSeason(seasonNumber: number): void {
        if (expandedSeasons.has(seasonNumber)) {
            expandedSeasons.delete(seasonNumber);
        } else {
            expandedSeasons.add(seasonNumber);
        }
        onseasonselect?.(seasonNumber);
    }

    function tabParam(): string {
        const source = new URL(window.location.href).searchParams;
        const params = new SvelteURLSearchParams();
        for (const key of ['tab', 'section']) {
            const value = source.get(key);
            if (value) params.set(key, value);
        }
        return params.size ? `?${params.toString()}` : '';
    }

    function navigateToEpisode(episodeId: string): void {
        onepisodeselect?.(episodeId);
        goto(resolve(`/admin/library/media/${episodeId}`) + tabParam());
    }

    function navigateToSeries(): void {
        goto(resolve(`/admin/library/media/${seriesId}`) + tabParam());
    }

    function posterUrl(id: string): string {
        // Use the catalog proxy for all items — it handles local → TMDB → Jellyfin fallback.
        return getCatalogPosterUrl(id, { size: 'thumb' }) + `&v=${artworkRevision}`;
    }

    function backdropUrl(id: string): string {
        return getCatalogBackdropUrl(id, { size: 'thumb' }) + `&v=${artworkRevision}`;
    }

    function episodeThumbUrl(id: string): string {
        return getCatalogThumbUrl(id, { size: 'thumb' }) + `&v=${artworkRevision}`;
    }
</script>

<label class="block w-full min-w-0 px-3 py-2 text-xs text-surface-300 md:hidden">
    {m.media_redesign_picker()}
    <select
        aria-label={m.media_redesign_picker()}
        value={currentItemId}
        class="mt-1 block w-full min-w-0 max-w-full rounded-lg border border-surface-700 bg-surface-800 p-2 text-sm"
        onchange={(event) => {
            void goto(resolve(`/admin/library/media/${event.currentTarget.value}`) + tabParam());
        }}>
        {#if series}<option value={seriesId}>{series.title}</option>{/if}
        {#each seasons as season (season.id)}
            <optgroup
                label={season.seasonNumber === 0
                    ? m.media_redesign_specials()
                    : m.admin_mediaedit_season_n({ number: season.seasonNumber })}>
                <option value={season.id}
                    >{season.seasonNumber === 0
                        ? m.media_redesign_specials()
                        : m.admin_mediaedit_season_n({ number: season.seasonNumber })}</option>
                {#each season.episodes as episode (episode.id)}<option value={episode.id}
                        >E{episode.episodeNumber ?? '?'} · {episode.title ?? '—'}</option
                    >{/each}
            </optgroup>
        {/each}
    </select>
</label>
<aside
    bind:this={asideEl}
    class="{collapsed
        ? 'w-10'
        : hydrated
          ? 'w-72'
          : 'w-10 xl:w-72'} shrink-0 border-r border-surface-700/50 bg-surface-900/50 hidden md:flex flex-col sticky top-0 max-h-screen overflow-hidden">
    {#if collapsed}
        <button
            type="button"
            class="p-2 text-surface-500 hover:text-surface-300 transition-colors flex items-center justify-center"
            aria-expanded={!collapsed}
            title={m.media_sidebar_expand()}
            onclick={() => ontoggle?.()}>
            <Icon src={ChevronRight} class="w-4 h-4" />
        </button>
    {:else}
        <div
            class="{hydrated
                ? 'flex'
                : 'hidden xl:flex'} items-center justify-end px-1 py-1 border-b border-surface-700/50 shrink-0">
            <button
                type="button"
                class="p-1.5 text-surface-500 hover:text-surface-300 transition-colors rounded"
                aria-expanded={!collapsed}
                title={m.media_sidebar_collapse()}
                onclick={() => ontoggle?.()}>
                <Icon src={ChevronLeft} class="w-4 h-4" />
            </button>
        </div>
    {/if}
    {#if collapsed}
        <!-- Rail only; hierarchy content is not rendered while collapsed. -->
    {:else if loading}
        <div
            class="{hydrated
                ? 'flex'
                : 'hidden xl:flex'} items-center justify-center py-8 text-surface-500 text-sm">
            {m.media_sidebar_loading()}
        </div>
    {:else if loadError}
        <div class="flex items-center justify-center py-8 text-red-400 text-sm">
            Failed to load hierarchy
        </div>
    {:else if series}
        <!-- Series header with poster -->
        <button
            data-current={currentItemId === seriesId && activeSeason == null ? 'true' : undefined}
            class="p-3 flex items-center gap-3 hover:bg-surface-800/40 transition-colors border-b border-surface-700/50 text-left w-full
				{currentItemId === seriesId && activeSeason == null ? 'bg-primary-500/10' : ''}"
            onclick={navigateToSeries}>
            <img
                src={posterUrl(series.id)}
                alt="{series.title} poster"
                class="w-10 h-14 rounded object-cover bg-surface-700 shrink-0" />
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-surface-100 truncate">
                    {series.title}
                </p>
                <p class="text-xs text-surface-500">
                    {m.series_seasons_count({ count: seasons.length })}
                </p>
            </div>
        </button>

        <!-- Season/Episode tree -->
        <nav class="flex-1 overflow-y-auto">
            {#each seasons as season (season.id)}
                <!-- Season row -->
                <div>
                    <div class="flex items-center">
                        <!-- Chevron toggle: expand/collapse only -->
                        <button
                            class="p-2 text-surface-500 hover:text-surface-300 transition-colors shrink-0"
                            title={expandedSeasons.has(season.seasonNumber)
                                ? m.btn_collapse()
                                : m.btn_expand()}
                            onclick={(e) => {
                                e.stopPropagation();
                                if (expandedSeasons.has(season.seasonNumber)) {
                                    expandedSeasons.delete(season.seasonNumber);
                                } else {
                                    expandedSeasons.add(season.seasonNumber);
                                }
                            }}>
                            <Icon
                                src={expandedSeasons.has(season.seasonNumber)
                                    ? ChevronDown
                                    : ChevronRight}
                                class="w-3.5 h-3.5" />
                        </button>
                        <!-- Season label: navigates to season detail + expands -->
                        <button
                            data-current={currentItemId === season.id ? 'true' : undefined}
                            class="flex-1 flex items-center gap-2 pr-3 py-2 text-left hover:bg-surface-800/40 transition-colors text-sm
                            {currentItemId === season.id
                                ? 'bg-primary-500/10 text-primary-400'
                                : activeSeason === season.seasonNumber
                                  ? 'text-primary-400'
                                  : 'text-surface-300'}"
                            onclick={() => {
                                expandedSeasons.add(season.seasonNumber);
                                onseasonselect?.(season.seasonNumber);
                                goto(resolve(`/admin/library/media/${season.id}`) + tabParam());
                            }}>
                            <img
                                src={posterUrl(season.id)}
                                alt=""
                                class="w-5 h-7 rounded object-cover bg-surface-700 shrink-0" />
                            <span class="flex-1 truncate">
                                {season.seasonNumber === 0
                                    ? m.episode_picker_specials()
                                    : m.season_label({ number: season.seasonNumber })}
                            </span>
                            <span
                                class="text-xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded-full shrink-0">
                                {season.episodeCount}
                            </span>
                        </button>
                    </div>

                    <!-- Episodes (expanded) -->
                    {#if expandedSeasons.has(season.seasonNumber)}
                        {#if reorderMode && reorderSeasonNumber === season.seasonNumber}
                            <!-- Draggable episode list -->
                            <div
                                use:dndzone={{
                                    items: reorderItems,
                                    flipDurationMs,
                                    dropTargetStyle: {
                                        outline:
                                            '2px dashed rgba(var(--color-primary-500-rgb) / 0.5)',
                                        borderRadius: '4px',
                                    },
                                }}
                                onconsider={handleDndConsider}
                                onfinalize={handleDndFinalize}
                                class="ml-4 border-l border-primary-500/30">
                                {#each reorderItems as ep, index (ep.id)}
                                    <div
                                        animate:flip={{
                                            duration: flipDurationMs,
                                        }}
                                        class="flex items-center gap-2 pl-3 pr-3 py-1.5 cursor-grab active:cursor-grabbing text-xs
                                            {currentItemId === ep.id
                                            ? 'bg-primary-500/10'
                                            : 'hover:bg-surface-800/40'}">
                                        <span class="text-surface-500 font-mono w-4 shrink-0"
                                            >{index + 1}</span>
                                        <img
                                            src={episodeThumbUrl(ep.id)}
                                            onerror={(e) => thumbFallback(e, ep.id)}
                                            alt=""
                                            class="w-12 h-7 rounded object-cover bg-surface-700 shrink-0" />
                                        <span class="flex-1 truncate text-surface-300"
                                            >{ep.title ?? 'Untitled'}</span>
                                        {#if ep.hasFile}
                                            <Icon
                                                src={Film}
                                                class="w-3 h-3 text-green-400 shrink-0" />
                                        {/if}
                                    </div>
                                {/each}
                            </div>
                            <!-- Save/Cancel -->
                            <div class="ml-4 flex gap-2 p-2">
                                <button
                                    class="btn variant-ghost-surface text-xs px-3 py-1"
                                    onclick={cancelReorder}>
                                    Cancel
                                </button>
                                <button
                                    class="btn variant-filled-primary text-xs px-3 py-1"
                                    onclick={saveReorder}
                                    disabled={!reorderDirty}>
                                    Save
                                </button>
                            </div>
                        {:else}
                            <!-- Normal episode list -->
                            <div class="ml-4 border-l border-surface-700/30">
                                {#each season.episodes as ep (ep.id)}
                                    <button
                                        data-current={currentItemId === ep.id ? 'true' : undefined}
                                        class="w-full flex items-center gap-2 pl-4 pr-3 py-1.5 text-left hover:bg-surface-800/40 transition-colors text-xs
                                            {currentItemId === ep.id
                                            ? 'bg-primary-500/10 text-primary-400'
                                            : 'text-surface-400'}
                                            {ep.isOrderingSegment
                                            ? 'opacity-40'
                                            : !ep.externalIds?.jellyfin && !ep.hasFile
                                              ? 'opacity-30'
                                              : ''}"
                                        onclick={() => navigateToEpisode(ep.id)}>
                                        <img
                                            src={episodeThumbUrl(ep.id)}
                                            onerror={(e) => thumbFallback(e, ep.id)}
                                            alt=""
                                            class="w-10 h-6 rounded object-cover bg-surface-700 shrink-0" />
                                        <span class="font-mono text-surface-500 shrink-0 w-6">
                                            {ep.episodeNumber ?? '?'}
                                        </span>
                                        <span class="flex-1 truncate">
                                            {ep.title ?? 'Untitled'}
                                        </span>
                                        {#if ep.isOrderingSegment}
                                            <span class="text-[10px] text-surface-500 shrink-0"
                                                >(segment)</span>
                                        {/if}
                                        {#if ep.hasFile}
                                            <Icon
                                                src={Film}
                                                class="w-3 h-3 text-green-400 shrink-0" />
                                        {/if}
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    {/if}
                </div>
            {/each}
        </nav>
    {/if}
</aside>
