<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { EmbeddingLookupResult } from '$lib/schemas/admin-types';
    import { getMediaTypeBadge } from '$lib/components/admin/media/media-type-badge';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import * as aiApi from '$lib/api/ai';

    interface Props {
        /** Pre-fill lookup key (e.g. from search widget). */
        initialKey?: string;
        /** Called when a result is found, with the internal UUID. */
        onselect?: (id: string) => void;
    }

    let { initialKey, onselect }: Props = $props();

    let mediaKey = $state('');
    let lookupResults: (EmbeddingLookupResult & {
        mdblistKeywords?: string[];
        streamingServices?: string[];
        imdbId?: string;
        tmdbRating?: number;
        popularity?: number;
        voteCount?: number;
    })[] = $state([]);
    let isLookingUp = $state(false);
    let lookupError = $state('');

    $effect(() => {
        if (initialKey) {
            mediaKey = initialKey;
            lookupEmbedding();
        }
    });

    const lookupEmbedding = async () => {
        if (!mediaKey.trim()) {
            lookupResults = [];
            lookupError = '';
            return;
        }
        isLookingUp = true;
        lookupError = '';
        try {
            const { data, error: apiError } = await aiApi.lookupEmbedding(mediaKey);
            if (!apiError && data) {
                lookupResults = data.result
                    ? [
                          data.result as EmbeddingLookupResult & {
                              mdblistKeywords?: string[];
                              streamingServices?: string[];
                              imdbId?: string;
                              tmdbRating?: number;
                              popularity?: number;
                              voteCount?: number;
                          },
                      ]
                    : [];
                if (lookupResults.length === 0) {
                    lookupError = 'No embedding found for this media key';
                } else {
                    const internalId = lookupResults[0]?.externalIds?.internal;
                    if (internalId && onselect) onselect(internalId);
                }
            } else {
                lookupError = apiError || 'Lookup failed';
                lookupResults = [];
            }
        } catch (err) {
            console.error('Lookup failed:', err);
            lookupError = 'Network error';
        } finally {
            isLookingUp = false;
        }
    };
</script>

<div class="card-base">
    <h3 class="text-sm font-medium text-surface-300 mb-3">Lookup by Media Key</h3>
    <div class="flex gap-2 mb-3">
        <input
            type="text"
            bind:value={mediaKey}
            placeholder="UUID or tmdb:550:movie"
            class="flex-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white placeholder-surface-400 focus:outline-hidden focus:border-blue-500 font-mono"
            onkeydown={(e) => e.key === 'Enter' && lookupEmbedding()} />
        <button class="btn btn-sm btn-blue" onclick={lookupEmbedding} disabled={isLookingUp}>
            {isLookingUp ? '...' : 'Lookup'}
        </button>
    </div>
    <p class="text-hint mb-3">
        Format: <code class="text-surface-300">uuid</code> or
        <code class="text-surface-300">provider:id:mediaType</code>
        (e.g., <code class="text-surface-300">tmdb:550:movie</code>)
    </p>
    {#if lookupError}
        <p class="text-red-400 text-sm">{lookupError}</p>
    {/if}
    {#if lookupResults.length > 0}
        <div class="space-y-3 max-h-64 overflow-y-auto">
            {#each lookupResults as item, itemIdx ((item.externalIds?.internal ?? item.title ?? '') + '-' + itemIdx)}
                {@const badge = getMediaTypeBadge(item.mediaType)}
                <div class="p-3 bg-surface-700/50 rounded-lg text-sm">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="px-2 py-0.5 text-xs rounded border {badge.class}">
                            {badge.label}
                        </span>
                        <span class="font-medium text-white">{item.title}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <span class="text-surface-400">Media Key:</span>
                        <span class="text-surface-200 font-mono text-[10px]"
                            >{mediaCompositeKey(item.externalIds, item.mediaType)}</span>
                        {#if item.imdbId}
                            <span class="text-surface-400">IMDB ID:</span>
                            <span class="text-surface-200">{item.imdbId}</span>
                        {/if}
                        <span class="text-surface-400">Library Embedding:</span>
                        <span
                            class={item.hasLibraryEmbedding ? 'text-green-400' : 'text-surface-500'}
                            >{item.hasLibraryEmbedding ? 'Yes' : 'No'}</span>
                        <span class="text-surface-400">Discovery Embedding:</span>
                        <span
                            class={item.hasDiscoveryEmbedding
                                ? 'text-green-400'
                                : 'text-surface-500'}
                            >{item.hasDiscoveryEmbedding ? 'Yes' : 'No'}</span>
                        {#if item.mdblistScore}
                            <span class="text-surface-400">MDBList Score:</span>
                            <span class="text-surface-200">{item.mdblistScore}%</span>
                        {/if}
                        {#if item.tmdbRating}
                            <span class="text-surface-400">TMDB Rating:</span>
                            <span class="text-surface-200">{item.tmdbRating}/10</span>
                        {/if}
                        <span class="text-surface-400">Genres:</span>
                        <span class="text-surface-200">{item.genres?.length || 0}</span>
                        <span class="text-surface-400">Actors:</span>
                        <span class="text-surface-200">{item.actors?.length || 0}</span>
                        <span class="text-surface-400">Directors:</span>
                        <span class="text-surface-200">{item.directors?.length || 0}</span>
                    </div>
                    {#if item.overview}
                        <div class="mt-2 text-hint">
                            <span class="font-medium">Overview:</span>
                            <span class="text-surface-300">
                                {item.overview.substring(0, 150)}{item.overview.length > 150
                                    ? '...'
                                    : ''}</span>
                        </div>
                    {/if}
                    {#if item.streamingServices?.length}
                        <div class="mt-2 text-xs">
                            <span class="text-surface-400">Streaming:</span>
                            <span class="text-surface-300">
                                {item.streamingServices.slice(0, 5).join(', ')}</span>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
