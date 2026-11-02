<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { EmbeddingSample } from '$lib/schemas/admin-types';
    import { getMediaTypeBadge } from '$lib/components/admin/media/media-type-badge';
    import * as aiApi from '$lib/api/ai';

    interface Props {
        /** Media types to show in filter dropdown. Omit for all types. */
        mediaTypes?: string[];
        /** Called when a search result is clicked, with the internal UUID. */
        onselect?: (id: string) => void;
    }

    let { mediaTypes, onselect }: Props = $props();

    let searchQuery = $state('');
    let mediaTypeFilter = $state('all');
    let searchResults: EmbeddingSample[] = $state([]);
    let isSearching = $state(false);

    const searchEmbeddings = async () => {
        if (!searchQuery.trim()) {
            searchResults = [];
            return;
        }
        isSearching = true;
        try {
            const typeParam = mediaTypeFilter !== 'all' ? mediaTypeFilter : undefined;
            const { data, error: searchError } = await aiApi.searchEmbeddings(
                searchQuery,
                typeParam,
            );
            if (!searchError && data) {
                searchResults = data.results;
            }
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            isSearching = false;
        }
    };

    // Filter options: 'all' + each media type from prop
    let filterOptions = $derived(
        mediaTypes
            ? [
                  { value: 'all', label: 'All' },
                  ...mediaTypes.map((t) => {
                      const badge = getMediaTypeBadge(t);
                      return { value: t, label: badge.label };
                  }),
              ]
            : [
                  { value: 'all', label: 'All' },
                  { value: 'movie', label: 'Movies' },
                  { value: 'tv', label: 'TV' },
              ],
    );
</script>

<div class="card-base">
    <h3 class="text-sm font-medium text-surface-300 mb-3">Search by Title</h3>
    <div class="flex gap-2 mb-3">
        <input
            type="text"
            bind:value={searchQuery}
            placeholder="Search media by title..."
            class="flex-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white placeholder-surface-400 focus:outline-hidden focus:border-blue-500"
            onkeydown={(e) => e.key === 'Enter' && searchEmbeddings()} />
        <select
            bind:value={mediaTypeFilter}
            class="bg-surface-700 border border-surface-600 rounded-lg px-2 py-2 text-sm text-white focus:outline-hidden focus:border-blue-500">
            {#each filterOptions as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
            {/each}
        </select>
        <button class="btn btn-sm btn-blue" onclick={searchEmbeddings} disabled={isSearching}>
            {isSearching ? '...' : 'Search'}
        </button>
    </div>
    {#if searchResults.length > 0}
        <div class="space-y-1 max-h-48 overflow-y-auto">
            {#each searchResults as item, itemIdx ((item.id ?? '') + '-' + itemIdx)}
                {@const badge = getMediaTypeBadge(item.mediaType)}
                <button
                    type="button"
                    class="flex items-center gap-2 text-sm p-2 bg-surface-700/50 rounded w-full text-left {onselect
                        ? 'hover:bg-surface-600/50 cursor-pointer'
                        : ''}"
                    onclick={() => {
                        const id = item.externalIds?.internal;
                        if (id && onselect) onselect(id);
                    }}>
                    <span class="px-1.5 py-0.5 text-xs rounded border {badge.class}">
                        {badge.label}
                    </span>
                    <span class="text-blue-400 font-mono text-xs"
                        >{item.externalIds?.internal?.slice(0, 8) ?? 'N/A'}</span>
                    <span class="text-white flex-1 truncate">{item.title}</span>
                </button>
            {/each}
        </div>
    {:else if searchQuery && !isSearching}
        <p class="text-muted">No results found</p>
    {/if}
</div>
