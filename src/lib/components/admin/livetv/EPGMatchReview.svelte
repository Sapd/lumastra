<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { apiGet, apiPut } from '$lib/api/client.js';
    import {
        EpgMatchReviewResponseSchema,
        EpgChannelSearchResponseSchema,
        ChannelUpdatedResponseSchema,
        type EpgMatchReviewResponse,
        type EpgMatchReviewItem,
        type EpgChannelSearchResult,
    } from '$lib/schemas/livetv.js';
    import { epgConfidenceBadge } from './epg-confidence-display.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import * as m from '$lib/paraglide/messages.js';
    import { markLogoFailed, usableLogo } from '$lib/components/livetv/failed-logos.svelte.js';

    // ── State ─────────────────────────────────────────────────────────

    let data = $state<EpgMatchReviewResponse | null>(null);
    let loading = $state(true);
    let activeFilter = $state<'all' | 'mismatches' | 'unmatched'>('all');

    // Inline search state
    let expandedChannelId = $state<string | null>(null);
    let searchQuery = $state('');
    let searchResults = $state<EpgChannelSearchResult[]>([]);
    let searchLoading = $state(false);
    let selectedIndex = $state(-1);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let searchSeq = 0;
    let searchInputEl = $state<HTMLInputElement | null>(null);

    $effect(() => {
        return () => {
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    });

    // The confidence badge is `epgConfidenceBadge` in
    // `epg-confidence-display.ts`. It was a record keyed on
    // `EpgMatchConfidenceLevel` here, checked by nothing — tsgo skips `.svelte`
    // and svelte-check-native does not flag a broken key in a component-local
    // record — and the row CALLS `.label()` on the result, so a level added to
    // the schema would have thrown out of the render rather than showing a
    // blank badge.

    // ── Data loading ──────────────────────────────────────────────────

    async function loadData(): Promise<void> {
        loading = true;
        const { data: result, error } = await apiGet(
            `/api/admin/livetv/epg/review?filter=${activeFilter}`,
            EpgMatchReviewResponseSchema,
        );
        if (error) {
            toasts.error(error);
        } else if (result) {
            data = result;
        }
        loading = false;
    }

    $effect(() => {
        // Re-fetch when filter changes
        const _filter = activeFilter;
        untrack(() => loadData());
    });

    $effect(() => {
        if (expandedChannelId && searchInputEl) {
            searchInputEl.focus();
        }
    });

    // ── Search ────────────────────────────────────────────────────────

    function handleSearchInput(query: string): void {
        searchQuery = query;
        selectedIndex = -1;

        if (debounceTimer) clearTimeout(debounceTimer);

        if (query.length < 2) {
            searchResults = [];
            searchLoading = false;
            return;
        }

        searchLoading = true;
        debounceTimer = setTimeout(() => doSearch(query), 300);
    }

    async function doSearch(query: string): Promise<void> {
        const seq = ++searchSeq;

        const channel = data?.channels.find((ch) => ch.id === expandedChannelId);
        if (!channel?.sourceId) return;

        const { data: result, error } = await apiGet(
            `/api/admin/livetv/epg/search?q=${encodeURIComponent(query)}&sourceId=${channel.sourceId}`,
            EpgChannelSearchResponseSchema,
        );

        // Discard stale response if a newer search was fired
        if (seq !== searchSeq) return;

        if (error) {
            searchResults = [];
        } else if (result) {
            searchResults = result.results;
        }
        searchLoading = false;
    }

    // ── Keyboard navigation ───────────────────────────────────────────

    function handleSearchKeydown(event: KeyboardEvent): void {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, searchResults.length - 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
        } else if (event.key === 'Enter' && selectedIndex >= 0) {
            event.preventDefault();
            const selected = searchResults[selectedIndex];
            if (selected) handleSelectMatch(selected);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
        }
    }

    // ── Match/Unmatch actions ─────────────────────────────────────────

    async function handleSelectMatch(epgChannel: EpgChannelSearchResult): Promise<void> {
        if (!expandedChannelId || !data) return;

        const channelId = expandedChannelId;
        const previousChannels = JSON.parse(JSON.stringify(data.channels));

        // Optimistic update
        const idx = data.channels.findIndex((ch) => ch.id === channelId);
        if (idx >= 0) {
            data.channels[idx] = {
                ...data.channels[idx],
                epgChannelId: epgChannel.id,
                epgDisplayName: epgChannel.displayName,
                confidenceLevel: 'manual',
                confidenceScore: 1.0,
                matchSignals: ['manual'],
                isManualOverride: true,
            };
        }

        closeSearch();

        const { error } = await apiPut(
            `/api/admin/livetv/channels/${channelId}/epg`,
            ChannelUpdatedResponseSchema,
            { epgChannelId: epgChannel.id },
        );

        if (error) {
            // Rollback
            if (data) data.channels = previousChannels;
            toasts.error(m.admin_livetv_epg_save_error());
        }
    }

    async function handleUnmatch(channelId: string): Promise<void> {
        if (!data) return;

        const previousChannels = JSON.parse(JSON.stringify(data.channels));

        // Optimistic update
        const idx = data.channels.findIndex((ch) => ch.id === channelId);
        if (idx >= 0) {
            data.channels[idx] = {
                ...data.channels[idx],
                epgChannelId: undefined,
                epgDisplayName: undefined,
                confidenceLevel: 'unmatched',
                confidenceScore: undefined,
                matchSignals: undefined,
                isManualOverride: false,
                currentProgram: undefined,
            };
        }

        const { error } = await apiPut(
            `/api/admin/livetv/channels/${channelId}/epg`,
            ChannelUpdatedResponseSchema,
            { epgChannelId: null },
        );

        if (error) {
            if (data) data.channels = previousChannels;
            toasts.error(m.admin_livetv_epg_save_error());
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────

    function toggleExpand(channelId: string): void {
        if (expandedChannelId === channelId) {
            closeSearch();
        } else {
            expandedChannelId = channelId;
            searchQuery = '';
            searchResults = [];
            selectedIndex = -1;
        }
    }

    function closeSearch(): void {
        expandedChannelId = null;
        searchQuery = '';
        searchResults = [];
        selectedIndex = -1;
        searchLoading = false;
        if (debounceTimer) clearTimeout(debounceTimer);
    }
</script>

<div class="space-y-4">
    <!-- Stats bar -->
    {#if data}
        <p class="text-sm text-surface-400">
            {m.admin_livetv_epg_stats({
                matched: data.stats.matched,
                lowConfidence: data.stats.lowConfidence,
                unmatched: data.stats.unmatched,
            })}
        </p>
    {/if}

    <!-- Filter tabs -->
    <div class="flex gap-1 border-b border-surface-700">
        <button
            class="px-3 py-1.5 text-sm font-medium rounded-t transition-colors {activeFilter ===
            'all'
                ? 'bg-surface-800 text-white border-b-2 border-yellow-500'
                : 'text-surface-400 hover:text-surface-200'}"
            onclick={() => (activeFilter = 'all')}>
            {m.admin_livetv_epg_filter_all()}
        </button>
        <button
            class="px-3 py-1.5 text-sm font-medium rounded-t transition-colors {activeFilter ===
            'mismatches'
                ? 'bg-surface-800 text-white border-b-2 border-yellow-500'
                : 'text-surface-400 hover:text-surface-200'}"
            onclick={() => (activeFilter = 'mismatches')}>
            {m.admin_livetv_epg_filter_low_confidence()}
        </button>
        <button
            class="px-3 py-1.5 text-sm font-medium rounded-t transition-colors {activeFilter ===
            'unmatched'
                ? 'bg-surface-800 text-white border-b-2 border-yellow-500'
                : 'text-surface-400 hover:text-surface-200'}"
            onclick={() => (activeFilter = 'unmatched')}>
            {m.admin_livetv_epg_filter_unmatched()}
        </button>
    </div>

    <!-- Channel list -->
    {#if loading}
        <div class="space-y-2">
            {#each Array(5) as _, i (i)}
                <div class="bg-surface-800 rounded-lg px-4 py-3">
                    <div class="h-6 bg-surface-700 rounded animate-pulse"></div>
                </div>
            {/each}
        </div>
    {:else if data && data.channels.length > 0}
        <div class="bg-surface-800 rounded-lg overflow-hidden divide-y divide-surface-700">
            {#each data.channels as channel (channel.id)}
                <!-- Channel row -->
                <div>
                    <div
                        role="button"
                        tabindex="0"
                        class="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-750 transition-colors text-left cursor-pointer"
                        onclick={() => toggleExpand(channel.id)}
                        onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleExpand(channel.id);
                            }
                        }}>
                        <!-- Logo -->
                        {#if usableLogo(channel.images?.primary?.href)}
                            <img
                                src={channel.images?.primary?.href}
                                alt=""
                                class="w-8 h-8 rounded object-contain bg-surface-900 flex-shrink-0"
                                width="32"
                                height="32"
                                loading="lazy"
                                onerror={() => markLogoFailed(channel.images?.primary?.href)} />
                        {:else}
                            <div class="w-8 h-8 rounded bg-surface-900 flex-shrink-0"></div>
                        {/if}

                        <!-- Name + EPG info -->
                        <div class="flex-1 min-w-0">
                            <div class="text-sm font-medium text-surface-100 truncate">
                                {channel.adminDisplayName ?? channel.name}
                            </div>
                            {#if channel.epgDisplayName}
                                <div class="text-xs text-surface-500 truncate">
                                    EPG: {channel.epgDisplayName}
                                </div>
                            {/if}
                        </div>

                        <!-- Current program -->
                        {#if channel.currentProgram}
                            <div
                                class="hidden sm:block text-xs text-surface-500 max-w-[200px] truncate">
                                <span class="text-yellow-500 font-medium"
                                    >{m.admin_livetv_epg_current_program()}</span>
                                {channel.currentProgram.title}
                            </div>
                        {/if}

                        <!-- Confidence badge -->
                        <span
                            class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border flex-shrink-0 {epgConfidenceBadge(
                                channel.confidenceLevel,
                            ).color}">
                            {epgConfidenceBadge(channel.confidenceLevel).label}
                        </span>

                        <!-- Unmatch button -->
                        {#if channel.confidenceLevel !== 'unmatched'}
                            <button
                                class="text-surface-500 hover:text-red-400 transition-colors flex-shrink-0 p-1"
                                title={m.admin_livetv_epg_unmatch()}
                                onclick={(e) => {
                                    e.stopPropagation();
                                    handleUnmatch(channel.id);
                                }}>
                                &times;
                            </button>
                        {/if}
                    </div>

                    <!-- Inline search (expanded) -->
                    {#if expandedChannelId === channel.id}
                        <div class="px-4 pb-3 pt-1">
                            <div class="relative">
                                <input
                                    bind:this={searchInputEl}
                                    type="text"
                                    class="w-full bg-surface-900 border border-surface-600 rounded px-3 py-2 text-sm text-surface-100 placeholder-surface-500 focus:border-yellow-500 focus:outline-none"
                                    placeholder={m.admin_livetv_epg_search_placeholder()}
                                    value={searchQuery}
                                    oninput={(e) => handleSearchInput(e.currentTarget.value)}
                                    onkeydown={handleSearchKeydown} />

                                <!-- Search results dropdown -->
                                {#if searchQuery.length >= 2}
                                    <div
                                        class="absolute z-10 mt-1 w-full bg-surface-900 border border-surface-600 rounded-lg shadow-xl max-h-60 overflow-y-auto">
                                        {#if searchLoading}
                                            <div class="px-3 py-2 text-sm text-surface-500">
                                                ...
                                            </div>
                                        {:else if searchResults.length === 0}
                                            <div class="px-3 py-2 text-sm text-surface-500">
                                                {m.admin_livetv_epg_no_results()}
                                            </div>
                                        {:else}
                                            {#each searchResults as result, i (result.id)}
                                                <button
                                                    class="w-full px-3 py-2 text-sm text-left flex items-center gap-2 transition-colors {i ===
                                                    selectedIndex
                                                        ? 'bg-yellow-500/20 text-yellow-200'
                                                        : 'text-surface-300 hover:bg-surface-800'}"
                                                    onclick={() => handleSelectMatch(result)}
                                                    onmouseenter={() => (selectedIndex = i)}>
                                                    {#if result.iconUrl}
                                                        <img
                                                            src={result.iconUrl}
                                                            alt=""
                                                            class="w-5 h-5 rounded object-contain bg-surface-800 flex-shrink-0" />
                                                    {/if}
                                                    <span class="truncate"
                                                        >{result.displayName}</span>
                                                </button>
                                            {/each}
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {:else}
        <div class="bg-surface-800 rounded-lg p-8 text-center">
            <p class="text-surface-400">{m.admin_livetv_epg_no_results()}</p>
        </div>
    {/if}
</div>
