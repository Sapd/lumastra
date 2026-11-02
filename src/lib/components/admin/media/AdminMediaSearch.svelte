<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { browser } from '$app/environment';
    import { resolve } from '$lib/paths';
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import {
        getCatalogPosterUrl,
        getCatalogThumbUrl,
        getCatalogBackdropUrl,
    } from '$lib/utils/image-utils';
    import { getMediaTypeBadge } from './media-type-badge';
    import {
        isEpisode as _isEpisode,
        isSeason as _isSeason,
        isSeries as _isSeries,
    } from '$lib/shared/media-types';
    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import { z } from 'zod';
    import { apiGet } from '$lib/api/client.js';

    interface SearchResult {
        id: string;
        title: string | null;
        mediaType: string;
        year: number | null;
        seasonNumber: number | null;
        episodeNumber: number | null;
        parentId: string | null;
        parentTitle?: string;
        grandparentTitle?: string;
        seasonCount?: number;
        episodeCount?: number;
        hasFile: boolean;
    }

    interface RecentItem {
        id: string;
        title: string;
        mediaType: string;
        year: number | null;
    }

    interface ResultGroup {
        label: string;
        results: SearchResult[];
    }

    const RECENT_KEY = 'admin:recent-media';
    const MAX_RECENT = 8;
    const DEBOUNCE_MS = 150;
    // The search API emits the public vocabulary ('series'); 'tv' stays for
    // anything still sending the storage value.
    const GROUP_ORDER: Record<string, number> = {
        series: 1,
        tv: 1,
        movie: 2,
        artist: 3,
        album: 4,
        season: 5,
        episode: 6,
        track: 7,
    };

    function getGroupLabel(type: string): string {
        switch (type) {
            case 'series':
            case 'tv':
                return m.media_filter_series();
            case 'movie':
                return m.media_filter_movies();
            case 'artist':
                return m.media_filter_artists();
            case 'album':
                return m.media_filter_albums();
            case 'season':
                return m.seasons();
            case 'episode':
                return m.media_filter_episodes();
            case 'track':
                return m.media_filter_tracks();
            default:
                return type;
        }
    }

    let searchQuery = $state('');
    let searchResults = $state<SearchResult[]>([]);
    let isOpen = $state(false);
    let isLoading = $state(false);
    let selectedIndex = $state(-1);
    let inputEl = $state<HTMLInputElement | null>(null);
    let containerEl = $state<HTMLDivElement | null>(null);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Flat list of navigable items for keyboard nav
    let flatItems = $derived.by((): Array<SearchResult | RecentItem> => {
        if (searchQuery.trim().length >= 2 && searchResults.length > 0) {
            // The rendered (grouped) order: the highlighted row's index comes
            // from getFlatIndex over the groups, so Enter must open the same row.
            return grouped.flatMap((g) => g.results);
        }
        if (searchQuery.trim().length < 2) {
            return getRecent();
        }
        return [];
    });

    let grouped = $derived.by((): ResultGroup[] => {
        if (searchQuery.trim().length < 2) return [];
        const groups: Record<string, SearchResult[]> = {};
        for (const r of searchResults) {
            const key = r.mediaType === 'tv' ? 'series' : r.mediaType;
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        }
        return Object.entries(groups)
            .map(([type, results]) => ({
                label: getGroupLabel(type),
                order: GROUP_ORDER[type] ?? 99,
                results,
            }))
            .sort((a, b) => a.order - b.order);
    });

    function getRecent(): RecentItem[] {
        if (!browser) return [];
        try {
            const raw = localStorage.getItem(RECENT_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    export function trackRecent(item: RecentItem): void {
        if (!browser) return;
        try {
            const recent = getRecent().filter((r) => r.id !== item.id);
            recent.unshift(item);
            localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
        } catch {
            /* localStorage full or unavailable */
        }
    }

    function open(): void {
        isOpen = true;
        selectedIndex = -1;
    }

    function close(): void {
        isOpen = false;
        selectedIndex = -1;
    }

    let searchSeq = 0;

    /** Drops a pending or in-flight search, so its results can't reappear. */
    function cancelSearch(): void {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        searchSeq++;
        isLoading = false;
    }

    function handleInput(): void {
        cancelSearch();
        const seq = searchSeq;
        const q = searchQuery.trim();
        if (q.length < 2) {
            searchResults = [];
            isLoading = false;
            open();
            return;
        }
        isLoading = true;
        const MediaSearchResponseSchema = z.object({ results: z.array(z.unknown()) }).passthrough();
        debounceTimer = setTimeout(async () => {
            try {
                const { data, error } = await apiGet(
                    `/api/admin/media/search?q=${encodeURIComponent(q)}`,
                    MediaSearchResponseSchema,
                );
                // Results for 'ab' must not overwrite those for 'abc'.
                if (seq !== searchSeq) return;
                if (!error && data?.results) {
                    searchResults = data.results as SearchResult[];
                } else {
                    searchResults = [];
                    if (error) toasts.error(m.admin_toast_search_failed());
                }
            } finally {
                if (seq === searchSeq) isLoading = false;
            }
        }, DEBOUNCE_MS);
    }

    function navigateTo(item: SearchResult | RecentItem): void {
        cancelSearch();
        close();
        searchQuery = '';
        searchResults = [];
        goto(resolve(`/admin/library/media/${item.id}`));
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (!isOpen) return;

        const items = flatItems;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            const item = items[selectedIndex];
            if (item) navigateTo(item);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (searchQuery) {
                cancelSearch();
                searchQuery = '';
                searchResults = [];
            } else {
                close();
                inputEl?.blur();
            }
        }
    }

    function handleGlobalKeydown(e: KeyboardEvent): void {
        // '/' shortcut when not in an input
        if (
            e.key === '/' &&
            !e.metaKey &&
            !e.ctrlKey &&
            !(e.target instanceof HTMLInputElement) &&
            !(e.target instanceof HTMLTextAreaElement) &&
            !(e.target instanceof HTMLSelectElement)
        ) {
            e.preventDefault();
            inputEl?.focus();
            open();
        }
    }

    // Click outside to close
    function handleDocumentClick(e: MouseEvent): void {
        if (containerEl && !containerEl.contains(e.target as Node)) {
            close();
        }
    }

    $effect(() => {
        if (!browser) return;
        document.addEventListener('keydown', handleGlobalKeydown);
        document.addEventListener('click', handleDocumentClick);
        return () => {
            document.removeEventListener('keydown', handleGlobalKeydown);
            document.removeEventListener('click', handleDocumentClick);
        };
    });

    // Scroll selected item into view
    $effect(() => {
        if (selectedIndex < 0) return;
        const el = containerEl?.querySelector(`[data-index="${selectedIndex}"]`);
        el?.scrollIntoView({ block: 'nearest' });
    });

    function posterUrl(id: string): string {
        return getCatalogPosterUrl(id, { size: 'thumb' });
    }

    function thumbUrl(id: string): string {
        return getCatalogThumbUrl(id, { size: 'thumb' });
    }

    function thumbFallback(e: Event, id: string): void {
        const img = e.currentTarget as HTMLImageElement;
        const fallback = getCatalogBackdropUrl(id, { size: 'thumb' });
        if (img.src !== fallback) {
            img.src = fallback;
        }
    }

    function contextLine(r: SearchResult): string {
        if (_isEpisode(r.mediaType)) {
            const parts: string[] = [];
            if (r.grandparentTitle) parts.push(r.grandparentTitle);
            else if (r.parentTitle) parts.push(r.parentTitle);
            if (r.seasonNumber != null && r.episodeNumber != null) {
                parts.push(
                    `S${String(r.seasonNumber).padStart(2, '0')}E${String(r.episodeNumber).padStart(2, '0')}`,
                );
            }
            return parts.join(' \u203a ');
        }
        if (_isSeason(r.mediaType)) {
            const parts: string[] = [];
            if (r.parentTitle) parts.push(r.parentTitle);
            if (r.seasonNumber != null) parts.push(m.season({ number: r.seasonNumber }));
            return parts.join(' \u203a ');
        }
        if (_isSeries(r.mediaType) && r.seasonCount) {
            const sc = r.seasonCount;
            const ec = r.episodeCount ?? 0;
            const seasonLabel = sc !== 1 ? m.seasons() : m.misc_season();
            const episodeLabel = ec !== 1 ? m.episodes_plural() : m.episode_singular();
            return `${sc} ${seasonLabel}, ${ec} ${episodeLabel}`;
        }
        if (r.mediaType === 'track' || r.mediaType === 'album') {
            if (r.parentTitle) return r.parentTitle;
        }
        return '';
    }

    function highlightMatch(text: string | null): string {
        if (!text) return '';
        const escapedText = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const q = searchQuery.trim();
        if (q.length < 2) return escapedText;
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        return escapedText.replace(
            regex,
            '<mark class="bg-primary-500/30 text-white rounded-sm px-0.5">$1</mark>',
        );
    }

    function isEpisodeType(mediaType: string): boolean {
        return _isEpisode(mediaType);
    }

    // Track flat index across grouped results
    function getFlatIndex(groupIdx: number, itemIdx: number): number {
        let idx = 0;
        for (let g = 0; g < groupIdx; g++) {
            idx += grouped[g].results.length;
        }
        return idx + itemIdx;
    }
</script>

<div class="relative" bind:this={containerEl}>
    <!-- Search input -->
    <div class="relative">
        <Icon
            src={MagnifyingGlass}
            class="w-4 h-4 text-surface-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
            bind:this={inputEl}
            type="text"
            placeholder={m.admin_placeholder_search_by_title()}
            class="w-48 focus:w-72 bg-surface-800/60 border border-surface-700/50 rounded-lg pl-9 pr-16 py-2 text-sm text-surface-100
                   focus:border-primary-500 focus:outline-none transition-all duration-200"
            bind:value={searchQuery}
            oninput={handleInput}
            onfocus={open}
            onkeydown={handleKeydown} />
        {#if searchQuery}
            <button
                class="absolute right-8 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 transition-colors"
                onmousedown={(e) => {
                    e.preventDefault();
                    cancelSearch();
                    searchQuery = '';
                    searchResults = [];
                    inputEl?.focus();
                }}>
                <Icon src={XMark} class="w-3.5 h-3.5" />
            </button>
        {/if}
        <kbd
            class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-surface-500 bg-surface-700/60 border border-surface-600/50
                   rounded px-1 py-0.5 font-mono pointer-events-none {isOpen ? 'hidden' : ''}">
            /
        </kbd>
    </div>

    <!-- Dropdown panel -->
    {#if isOpen}
        <div
            class="absolute z-50 top-full right-0 mt-2 w-[480px] rounded-xl bg-surface-800 border border-surface-700/50
                   shadow-2xl shadow-black/40 overflow-hidden">
            <!-- Recent items (no query) -->
            {#if searchQuery.trim().length < 2}
                {@const recent = getRecent()}
                {#if recent.length > 0}
                    <div class="px-3 pt-3 pb-1.5">
                        <span
                            class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                            {m.admin_media_search_recent()}
                        </span>
                    </div>
                    <div class="max-h-[400px] overflow-y-auto pb-1">
                        {#each recent as item, i (item.id)}
                            {@const badge = getMediaTypeBadge(item.mediaType)}
                            <button
                                data-index={i}
                                class="w-full text-left px-3 py-2 flex items-center gap-3 transition-colors
                                       {selectedIndex === i
                                    ? 'bg-primary-500/15'
                                    : 'hover:bg-surface-700/40'}"
                                onclick={() => navigateTo(item)}
                                onmousedown={(e) => {
                                    e.preventDefault();
                                    navigateTo(item);
                                }}
                                onmouseenter={() => (selectedIndex = i)}>
                                <img
                                    src={posterUrl(item.id)}
                                    alt=""
                                    class="w-8 h-12 rounded object-cover bg-surface-700 shrink-0" />
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm text-surface-100 truncate font-medium">
                                        {item.title}
                                    </p>
                                    <div class="flex items-center gap-1.5 mt-0.5">
                                        <span
                                            class="text-[10px] px-1.5 py-0.5 rounded border font-medium {badge.class}">
                                            {badge.label}
                                        </span>
                                        {#if item.year}
                                            <span class="text-xs text-surface-500"
                                                >{item.year}</span>
                                        {/if}
                                    </div>
                                </div>
                            </button>
                        {/each}
                    </div>
                {:else}
                    <div class="px-4 py-8 text-center text-sm text-surface-500">
                        {m.admin_media_search_type_to_search()}
                    </div>
                {/if}
            {:else if isLoading}
                <div class="px-4 py-8 text-center text-sm text-surface-500">
                    <div
                        class="inline-block w-4 h-4 border-2 border-surface-500 border-t-transparent rounded-full animate-spin mr-2">
                    </div>
                    {m.admin_media_search_searching()}
                </div>
            {:else if searchResults.length === 0}
                <div class="px-4 py-8 text-center text-sm text-surface-500">
                    {m.search_no_results_for({ query: searchQuery })}
                </div>
            {:else}
                <!-- Grouped search results -->
                <div class="max-h-[480px] overflow-y-auto">
                    {#each grouped as group, groupIdx (group.label)}
                        <div class="px-3 pt-3 pb-1.5 flex items-center gap-2">
                            <span
                                class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                                {group.label}
                            </span>
                            <span class="text-[10px] text-surface-600 tabular-nums">
                                {group.results.length}
                            </span>
                        </div>
                        {#each group.results as result, itemIdx (result.id)}
                            {@const flatIdx = getFlatIndex(groupIdx, itemIdx)}
                            {@const badge = getMediaTypeBadge(result.mediaType)}
                            {@const ctx = contextLine(result)}
                            {@const isEp = isEpisodeType(result.mediaType)}
                            <button
                                data-index={flatIdx}
                                class="w-full text-left px-3 py-2 flex items-center gap-3 transition-colors
                                       {selectedIndex === flatIdx
                                    ? 'bg-primary-500/15'
                                    : 'hover:bg-surface-700/40'}"
                                onclick={() => navigateTo(result)}
                                onmousedown={(e) => {
                                    e.preventDefault();
                                    navigateTo(result);
                                }}
                                onmouseenter={() => (selectedIndex = flatIdx)}>
                                <!-- Thumbnail: landscape for episodes, portrait for everything else -->
                                {#if isEp}
                                    <img
                                        src={thumbUrl(result.id)}
                                        onerror={(e) => thumbFallback(e, result.id)}
                                        alt=""
                                        class="w-16 h-9 rounded object-cover bg-surface-700 shrink-0" />
                                {:else}
                                    <img
                                        src={posterUrl(result.id)}
                                        alt=""
                                        class="w-8 h-12 rounded object-cover bg-surface-700 shrink-0" />
                                {/if}
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm text-surface-100 truncate font-medium">
                                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                        {@html highlightMatch(result.title)}
                                    </p>
                                    <div class="flex items-center gap-1.5 mt-0.5">
                                        {#if ctx}
                                            <span class="text-xs text-surface-400 truncate">
                                                {ctx}
                                            </span>
                                            <span class="text-surface-600">&middot;</span>
                                        {/if}
                                        {#if result.year}
                                            <span class="text-xs text-surface-500 shrink-0">
                                                {result.year}
                                            </span>
                                        {/if}
                                        {#if result.hasFile}
                                            <span
                                                class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0"
                                                title={m.media_plain_has_files()}></span>
                                        {/if}
                                    </div>
                                </div>
                                <span
                                    class="text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 {badge.class}">
                                    {badge.label}
                                </span>
                            </button>
                        {/each}
                    {/each}
                </div>
                <!-- Footer -->
                <div
                    class="px-3 py-2 border-t border-surface-700/50 flex items-center justify-between text-[10px] text-surface-500">
                    <span>{m.search_result_count({ count: searchResults.length })}</span>
                    <span>
                        <kbd
                            class="bg-surface-700/60 border border-surface-600/50 rounded px-1 py-0.5 font-mono"
                            >&uarr;&darr;</kbd>
                        {m.search_navigate()}
                        <kbd
                            class="bg-surface-700/60 border border-surface-600/50 rounded px-1 py-0.5 font-mono ml-1.5"
                            >&crarr;</kbd>
                        {m.search_open()}
                        <kbd
                            class="bg-surface-700/60 border border-surface-600/50 rounded px-1 py-0.5 font-mono ml-1.5"
                            >esc</kbd>
                        {m.close()}
                    </span>
                </div>
            {/if}
        </div>
    {/if}
</div>
