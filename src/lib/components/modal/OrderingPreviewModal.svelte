<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { onMount } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { Icon, XMark, ChevronDown, ChevronRight } from 'svelte-hero-icons';
    import { modals } from '$lib/stores/modal.store';
    import { getSeasonColor, getUniqueSeasons } from '$lib/utils/season-colors';
    import { slide } from 'svelte/transition';
    import { orderingGroupTypeLabel } from './ordering-group-type';
    import { previewCoverage, type SeasonTotal } from './ordering-preview-coverage';

    interface PreviewEpisode {
        originalSeason: number;
        originalEpisode: number;
        name: string;
        newGroupIndex: number;
        newPositionInGroup: number;
        absoluteNumber: number | null;
    }

    interface PreviewGroup {
        displayLabel: string;
        episodeCount: number;
        originalRange: string;
        displayRange: string;
    }

    interface Props {
        modalId?: string;
        name: string;
        type: string;
        /** Provider group type code (TMDB 1–7); absent on older responses. */
        providerType?: number;
        /** The series' own season sizes; absent when the provider could not be asked. */
        seasonTotals?: SeasonTotal[];
        totalEpisodes: number;
        groups: PreviewGroup[];
        episodes: PreviewEpisode[];
    }

    let { name, type, providerType, seasonTotals, totalEpisodes, groups, episodes }: Props =
        $props();

    let coverage = $derived(previewCoverage(episodes, seasonTotals));
    let seasonTotalByNumber = $derived(
        new Map(coverage.seasons.map((s) => [s.seasonNumber, s.total])),
    );
    let untouchedLabel = $derived(
        coverage.untouchedSeasons
            .map((n) => (n === 0 ? m.ordering_preview_specials() : m.player_season({ number: n })))
            .join(', '),
    );

    // Derived: organize episodes by original season (left column)
    let originalSeasons = $derived.by(() => {
        const map = new SvelteMap<number, PreviewEpisode[]>();
        for (const ep of episodes) {
            const list = map.get(ep.originalSeason) ?? [];
            list.push(ep);
            map.set(ep.originalSeason, list);
        }
        for (const list of map.values()) {
            list.sort((a, b) => a.originalEpisode - b.originalEpisode);
        }
        return map;
    });

    // Derived: organize episodes by new group (right column)
    let reorderedGroups = $derived.by(() => {
        const map = new SvelteMap<number, PreviewEpisode[]>();
        for (const ep of episodes) {
            const list = map.get(ep.newGroupIndex) ?? [];
            list.push(ep);
            map.set(ep.newGroupIndex, list);
        }
        for (const list of map.values()) {
            list.sort((a, b) => a.newPositionInGroup - b.newPositionInGroup);
        }
        return map;
    });

    let seasons = $derived(getUniqueSeasons(episodes));

    // Stats: count episodes that moved to a different group than their original season index
    let movedAcrossSeasons = $derived(
        episodes.filter((ep) => {
            const originalSeasonIdx = seasons.indexOf(ep.originalSeason);
            return ep.newGroupIndex !== originalSeasonIdx;
        }).length,
    );

    // Expand/collapse state per section
    // When autoExpand is true, all sections start expanded and we track which are collapsed.
    // When autoExpand is false, all sections start collapsed and we track which are expanded.
    let expandedLeft = new SvelteSet<number>();
    let expandedRight = new SvelteSet<number>();
    let collapsedLeft = new SvelteSet<number>();
    let collapsedRight = new SvelteSet<number>();
    let autoExpand = $derived(totalEpisodes <= 50);

    function toggleLeft(season: number): void {
        if (autoExpand) {
            if (collapsedLeft.has(season)) {
                collapsedLeft.delete(season);
            } else {
                collapsedLeft.add(season);
            }
        } else {
            if (expandedLeft.has(season)) {
                expandedLeft.delete(season);
            } else {
                expandedLeft.add(season);
            }
        }
    }

    function toggleRight(groupIdx: number): void {
        if (autoExpand) {
            if (collapsedRight.has(groupIdx)) {
                collapsedRight.delete(groupIdx);
            } else {
                collapsedRight.add(groupIdx);
            }
        } else {
            if (expandedRight.has(groupIdx)) {
                expandedRight.delete(groupIdx);
            } else {
                expandedRight.add(groupIdx);
            }
        }
    }

    function isLeftExpanded(season: number): boolean {
        return autoExpand ? !collapsedLeft.has(season) : expandedLeft.has(season);
    }

    function isRightExpanded(groupIdx: number): boolean {
        return autoExpand ? !collapsedRight.has(groupIdx) : expandedRight.has(groupIdx);
    }

    /** Get source season breakdown for a group */
    function getGroupSourceBreakdown(groupIdx: number): Array<{ season: number; count: number }> {
        const eps = reorderedGroups.get(groupIdx) ?? [];
        const counts = new SvelteMap<number, number>();
        for (const ep of eps) {
            counts.set(ep.originalSeason, (counts.get(ep.originalSeason) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([season, count]) => ({ season, count }));
    }

    function epKey(ep: PreviewEpisode): string {
        return `${ep.originalSeason}-${ep.originalEpisode}`;
    }

    // SVG line tracking — element refs and computed lines
    let containerEl = $state<HTMLDivElement | null>(null);
    const leftRefs = new SvelteMap<string, HTMLElement>();
    const rightRefs = new SvelteMap<string, HTMLElement>();
    let lines = $state<
        Array<{
            x1: number;
            y1: number;
            x2: number;
            y2: number;
            color: string;
            key: string;
        }>
    >([]);
    let hoveredEpKey = $state<string | null>(null);
    let svgHeight = $state(0);

    // Block-level flow lines for collapsed sections
    let blockLines = $state<
        Array<{
            x1: number;
            y1: number;
            x2: number;
            y2: number;
            color: string;
            key: string;
            width: number;
        }>
    >([]);

    const leftHeaderRefs = new SvelteMap<number, HTMLElement>();
    const rightHeaderRefs = new SvelteMap<number, HTMLElement>();

    function recalcLines(): void {
        if (!containerEl) return;
        svgHeight = containerEl.scrollHeight;
        const containerRect = containerEl.getBoundingClientRect();
        const scrollTop = containerEl.scrollTop;
        const newLines: typeof lines = [];
        const flowMap = new SvelteMap<string, { season: number; group: number; count: number }>();

        for (const ep of episodes) {
            const key = epKey(ep);
            const seasonExpanded = isLeftExpanded(ep.originalSeason);
            const groupExpanded = isRightExpanded(ep.newGroupIndex);

            if (seasonExpanded && groupExpanded) {
                const leftEl = leftRefs.get(key);
                const rightEl = rightRefs.get(key);
                if (!leftEl || !rightEl) continue;

                const leftRect = leftEl.getBoundingClientRect();
                const rightRect = rightEl.getBoundingClientRect();

                newLines.push({
                    x1: leftRect.right - containerRect.left,
                    y1: leftRect.top + leftRect.height / 2 - containerRect.top + scrollTop,
                    x2: rightRect.left - containerRect.left,
                    y2: rightRect.top + rightRect.height / 2 - containerRect.top + scrollTop,
                    color: getSeasonColor(ep.originalSeason).hex,
                    key,
                });
            } else {
                const flowKey = `${ep.originalSeason}→${ep.newGroupIndex}`;
                const existing = flowMap.get(flowKey);
                if (existing) {
                    existing.count++;
                } else {
                    flowMap.set(flowKey, {
                        season: ep.originalSeason,
                        group: ep.newGroupIndex,
                        count: 1,
                    });
                }
            }
        }

        lines = newLines;

        // Block-level flow lines
        const newBlockLines: typeof blockLines = [];
        for (const [, flow] of flowMap) {
            const leftEl = leftHeaderRefs.get(flow.season);
            const rightEl = rightHeaderRefs.get(flow.group);
            if (!leftEl || !rightEl) continue;

            const leftRect = leftEl.getBoundingClientRect();
            const rightRect = rightEl.getBoundingClientRect();

            const width = Math.max(2, Math.min(8, Math.log2(flow.count + 1) * 2));

            newBlockLines.push({
                x1: leftRect.right - containerRect.left,
                y1: leftRect.top + leftRect.height / 2 - containerRect.top + scrollTop,
                x2: rightRect.left - containerRect.left,
                y2: rightRect.top + rightRect.height / 2 - containerRect.top + scrollTop,
                color: getSeasonColor(flow.season).hex,
                key: `block-${flow.season}-${flow.group}`,
                width,
            });
        }
        blockLines = newBlockLines;
    }

    function bindLeftRef(node: HTMLElement, key: string): { destroy: () => void } {
        leftRefs.set(key, node);
        return { destroy: () => leftRefs.delete(key) };
    }

    function bindRightRef(node: HTMLElement, key: string): { destroy: () => void } {
        rightRefs.set(key, node);
        return { destroy: () => rightRefs.delete(key) };
    }

    function bindLeftHeaderRef(node: HTMLElement, season: number): { destroy: () => void } {
        leftHeaderRefs.set(season, node);
        return { destroy: () => leftHeaderRefs.delete(season) };
    }

    function bindRightHeaderRef(node: HTMLElement, groupIdx: number): { destroy: () => void } {
        rightHeaderRefs.set(groupIdx, node);
        return { destroy: () => rightHeaderRefs.delete(groupIdx) };
    }

    // Recalc on expand/collapse changes
    $effect(() => {
        // Track reactive SvelteSet changes
        void [...expandedLeft];
        void [...expandedRight];
        void [...collapsedLeft];
        void [...collapsedRight];
        // Recalc immediately for non-transition changes
        requestAnimationFrame(recalcLines);
        // Recalc again after slide transition completes (150ms duration + buffer)
        const timer = setTimeout(() => requestAnimationFrame(recalcLines), 200);
        return () => clearTimeout(timer);
    });

    onMount(() => {
        // Initial line calculation after layout settles
        requestAnimationFrame(recalcLines);
    });

    // Edge case detection
    let isNoData = $derived(episodes.length === 0);
    let isSingleGroup = $derived(groups.length <= 1 && !isNoData);
    let isIdenticalOrder = $derived(
        !isNoData &&
            !isSingleGroup &&
            episodes.every((ep) => {
                const originalSeasonIdx = seasons.indexOf(ep.originalSeason);
                return ep.newGroupIndex === originalSeasonIdx;
            }),
    );
</script>

<div
    class="w-[900px] max-w-[95vw] bg-surface-900 rounded-xl shadow-2xl border border-surface-700/50 flex flex-col max-h-[80vh]">
    <!-- Header -->
    <div class="flex items-center gap-3 px-5 py-3.5 border-b border-surface-700/50 shrink-0">
        <div class="flex-1 min-w-0">
            <h2 class="text-base font-semibold text-surface-100 truncate">
                {name}
            </h2>
            <div class="flex items-center gap-2 mt-0.5">
                <span class="text-xs px-1.5 py-0.5 rounded bg-surface-700/60 text-surface-300"
                    >{orderingGroupTypeLabel(providerType, type)}</span>
                <span class="text-xs text-surface-500"
                    >{totalEpisodes} episodes · {groups.length} groups</span>
            </div>
        </div>
        <button
            class="p-1.5 rounded-lg hover:bg-surface-700/60 transition-colors text-surface-400 hover:text-surface-100"
            onclick={() => modals.close()}
            aria-label={m.ordering_preview_close_aria()}>
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </div>

    {#if !isNoData && ((coverage.notInOrdering ?? 0) > 0 || coverage.untouchedSeasons.length > 0)}
        <div
            class="px-5 py-2 border-b border-surface-700/30 shrink-0 text-xs space-y-1"
            role="note">
            {#if (coverage.notInOrdering ?? 0) > 0}
                <p class="text-yellow-300/90">
                    {m.ordering_preview_not_in_ordering({
                        count: coverage.notInOrdering ?? 0,
                    })}
                </p>
            {/if}
            {#if coverage.untouchedSeasons.length > 0}
                <p class="text-surface-400">
                    {m.ordering_preview_untouched_seasons({ seasons: untouchedLabel })}
                </p>
            {/if}
        </div>
    {/if}

    {#if isNoData}
        <div class="flex-1 flex items-center justify-center py-12 text-surface-500 text-sm">
            {m.ordering_preview_no_data()}
        </div>
    {:else if isSingleGroup}
        <div class="flex-1 flex items-center justify-center py-12 text-surface-500 text-sm">
            {m.ordering_preview_single_group()}
        </div>
    {:else if isIdenticalOrder}
        <div class="flex-1 flex items-center justify-center py-12 text-surface-500 text-sm">
            {m.ordering_preview_identical()}
        </div>
    {:else}
        <!-- Color legend -->
        <div
            class="flex items-center gap-3 px-5 py-2 border-b border-surface-700/30 shrink-0 flex-wrap">
            {#each seasons as season (season)}
                {@const color = getSeasonColor(season)}
                <div class="flex items-center gap-1.5 text-xs">
                    <span class="w-2.5 h-2.5 rounded-full shrink-0 {color.dot}"></span>
                    <span class="text-surface-400">S{String(season).padStart(2, '0')}</span>
                </div>
            {/each}
        </div>

        <!-- Two-column layout -->
        <div
            class="flex-1 overflow-y-auto overflow-x-hidden relative"
            bind:this={containerEl}
            onscroll={recalcLines}>
            <!-- SVG overlay (desktop only) -->
            <svg
                class="absolute top-0 left-0 w-full pointer-events-none overflow-visible hidden md:block"
                style="z-index: 1; height: {svgHeight}px;"
                role="img"
                aria-label={m.ordering_preview_svg_aria()}>
                {#each blockLines as line (line.key)}
                    {@const midX = (line.x1 + line.x2) / 2}
                    <path
                        d="M {line.x1} {line.y1} C {midX} {line.y1}, {midX} {line.y2}, {line.x2} {line.y2}"
                        fill="none"
                        stroke={line.color}
                        stroke-width={line.width}
                        stroke-opacity={hoveredEpKey ? 0.08 : 0.3} />
                {/each}
                {#each lines as line (line.key)}
                    {@const midX = (line.x1 + line.x2) / 2}
                    {@const isHovered = hoveredEpKey === line.key}
                    {@const dimmed = hoveredEpKey !== null && !isHovered}
                    <path
                        d="M {line.x1} {line.y1} C {midX} {line.y1}, {midX} {line.y2}, {line.x2} {line.y2}"
                        fill="none"
                        stroke={line.color}
                        stroke-width={isHovered ? 2.5 : 1.5}
                        stroke-opacity={dimmed ? 0.1 : isHovered ? 0.9 : 0.4} />
                {/each}
            </svg>

            <div class="flex flex-col md:flex-row gap-0 md:gap-0 relative" style="z-index: 2;">
                <!-- Left column: Original order -->
                <div class="flex-1 min-w-0 md:pr-8">
                    <div
                        class="px-4 py-2 text-xs font-medium text-surface-500 uppercase tracking-wider sticky top-0 bg-surface-900/95 backdrop-blur-sm z-10">
                        {m.ordering_preview_original_order()}
                    </div>
                    <div role="list" class="px-2 pb-3">
                        {#each seasons as season (season)}
                            {@const eps = originalSeasons.get(season) ?? []}
                            {@const color = getSeasonColor(season)}
                            {@const seasonTotal = seasonTotalByNumber.get(season) ?? null}
                            <div class="mb-1">
                                <!-- Season header -->
                                <button
                                    use:bindLeftHeaderRef={season}
                                    class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors hover:bg-surface-800/60 text-left"
                                    onclick={() => toggleLeft(season)}>
                                    <Icon
                                        src={isLeftExpanded(season) ? ChevronDown : ChevronRight}
                                        class="w-3.5 h-3.5 text-surface-500 shrink-0" />
                                    <span class="w-2 h-2 rounded-full shrink-0 {color.dot}"></span>
                                    <span class="text-surface-200 font-medium"
                                        >{m.player_season({
                                            number: season,
                                        })}</span>
                                    <span
                                        class="text-xs ml-auto {seasonTotal !== null &&
                                        seasonTotal > eps.length
                                            ? 'text-yellow-400/80'
                                            : 'text-surface-500'}"
                                        >{seasonTotal !== null && seasonTotal !== eps.length
                                            ? m.ordering_preview_ep_count_of({
                                                  count: eps.length,
                                                  total: seasonTotal,
                                              })
                                            : m.ordering_preview_ep_count({
                                                  count: eps.length,
                                              })}</span>
                                </button>

                                <!-- Episode rows -->
                                {#if isLeftExpanded(season)}
                                    <div
                                        transition:slide={{ duration: 150 }}
                                        onintroend={recalcLines}
                                        onoutroend={recalcLines}
                                        role="list">
                                        {#each eps as ep (epKey(ep))}
                                            {@const key = epKey(ep)}
                                            <div
                                                use:bindLeftRef={key}
                                                class="flex items-center gap-2 pl-8 pr-2 py-1 text-xs rounded transition-colors
													{hoveredEpKey === key ? 'bg-surface-700/60' : 'hover:bg-surface-800/40'}"
                                                onmouseenter={() => (hoveredEpKey = key)}
                                                onmouseleave={() => (hoveredEpKey = null)}
                                                role="listitem">
                                                <span
                                                    class="w-1.5 h-1.5 rounded-full shrink-0 {color.dot} md:hidden"
                                                ></span>
                                                <span
                                                    class="text-surface-500 tabular-nums w-8 shrink-0"
                                                    >E{String(ep.originalEpisode).padStart(
                                                        2,
                                                        '0',
                                                    )}</span>
                                                <span class="text-surface-300 truncate"
                                                    >{ep.name}</span>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                </div>

                <!-- Right column: Reordered -->
                <div
                    class="flex-1 min-w-0 md:pl-8 border-t md:border-t-0 md:border-l border-surface-700/30">
                    <div
                        class="px-4 py-2 text-xs font-medium text-surface-500 uppercase tracking-wider sticky top-0 bg-surface-900/95 backdrop-blur-sm z-10">
                        {m.ordering_preview_reordered()}
                    </div>
                    <div role="list" class="px-2 pb-3">
                        {#each groups as group, groupIdx (groupIdx)}
                            {@const eps = reorderedGroups.get(groupIdx) ?? []}
                            {@const breakdown = getGroupSourceBreakdown(groupIdx)}
                            <div class="mb-1">
                                <!-- Group header -->
                                <button
                                    use:bindRightHeaderRef={groupIdx}
                                    class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors hover:bg-surface-800/60 text-left"
                                    onclick={() => toggleRight(groupIdx)}>
                                    <Icon
                                        src={isRightExpanded(groupIdx) ? ChevronDown : ChevronRight}
                                        class="w-3.5 h-3.5 text-surface-500 shrink-0" />
                                    <span class="text-surface-200 font-medium truncate"
                                        >{group.displayLabel}</span>
                                    <span class="text-xs text-surface-500 ml-auto shrink-0"
                                        >{m.ordering_preview_ep_count({
                                            count: eps.length,
                                        })}</span>
                                </button>
                                <!-- Source breakdown chips -->
                                <div class="flex items-center gap-2 pl-8 pb-1 flex-wrap">
                                    {#each breakdown as src (src.season)}
                                        {@const srcColor = getSeasonColor(src.season)}
                                        <span
                                            class="flex items-center gap-1 text-xs text-surface-500">
                                            <span class="w-1.5 h-1.5 rounded-full {srcColor.dot}"
                                            ></span>
                                            {m.ordering_preview_from_season({
                                                count: src.count,
                                                season: src.season,
                                            })}
                                        </span>
                                    {/each}
                                </div>

                                <!-- Episode rows -->
                                {#if isRightExpanded(groupIdx)}
                                    <div
                                        transition:slide={{ duration: 150 }}
                                        onintroend={recalcLines}
                                        onoutroend={recalcLines}
                                        role="list">
                                        {#each eps as ep (epKey(ep))}
                                            {@const key = epKey(ep)}
                                            {@const color = getSeasonColor(ep.originalSeason)}
                                            <div
                                                use:bindRightRef={key}
                                                class="flex items-center gap-2 pl-8 pr-2 py-1 text-xs rounded transition-colors
													{hoveredEpKey === key ? 'bg-surface-700/60' : 'hover:bg-surface-800/40'}"
                                                onmouseenter={() => (hoveredEpKey = key)}
                                                onmouseleave={() => (hoveredEpKey = null)}
                                                role="listitem">
                                                <span
                                                    class="w-1.5 h-1.5 rounded-full shrink-0 {color.dot}"
                                                ></span>
                                                <span
                                                    class="text-surface-500 tabular-nums w-6 shrink-0"
                                                    >#{ep.newPositionInGroup + 1}</span>
                                                <span class="text-surface-300 truncate"
                                                    >{ep.name}</span>
                                                <span
                                                    class="text-xs text-surface-600 ml-auto shrink-0 tabular-nums"
                                                    >[S{ep.originalSeason}]</span>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                </div>
            </div>
        </div>

        <!-- Stats bar -->
        <div
            class="flex items-center gap-4 px-5 py-2.5 border-t border-surface-700/50 shrink-0 text-xs text-surface-500">
            <span
                >{m.ordering_preview_total_episodes({
                    count: totalEpisodes,
                })}</span>
            <span class="w-px h-3 bg-surface-700/50"></span>
            <span
                >{m.ordering_preview_moved({
                    count: movedAcrossSeasons,
                })}</span>
            <span class="w-px h-3 bg-surface-700/50"></span>
            <span
                >{m.ordering_preview_seasons_groups({
                    seasons: seasons.length,
                    groups: groups.length,
                })}</span>
        </div>
    {/if}
</div>
