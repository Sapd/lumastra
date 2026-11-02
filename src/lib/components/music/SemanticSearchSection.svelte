<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import { SectionRenderer } from '$lib/components/sections';
    import SectionSkeleton from './SectionSkeleton.svelte';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { mapMusicTrackToItem } from '$lib/utils/mapMusicTrackToItem';
    import { createEmbeddingSearch } from './useEmbeddingSearch.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        kind: 'sound' | 'lyrics';
        endpoint: string;
        query: string;
        enabled: boolean;
        hiddenTrackIds?: ReadonlySet<string>;
        onitemClick?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemPlay?: (data: {
            section: PageSection;
            item: UniversalMediaItem;
        }) => void | Promise<void>;
        onitemMore?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemRemove?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
    }

    let {
        kind,
        endpoint,
        query,
        enabled,
        hiddenTrackIds,
        onitemClick,
        onitemPlay,
        onitemMore,
        onitemRemove,
    }: Props = $props();

    const es = createEmbeddingSearch(() => endpoint);

    let expanded = $state(false);

    // Fix 4: compute label once and reuse in section $derived.
    const label = $derived(
        kind === 'sound' ? m.music_semantic_sounds_like() : m.music_semantic_lyrics_about(),
    );
    const sectionId = $derived(`music-${kind}-search`);
    const contentId = $derived(`${sectionId}-content`);

    /** The PageSection passed to SectionRenderer — filtered by hiddenTrackIds. */
    let section = $derived.by((): PageSection => {
        const items = es.tracks.map(mapMusicTrackToItem).filter((item) => !hiddenTrackIds?.has(item.itemKey ?? item.id));
        return {
            id: sectionId,
            type: 'carousel',
            title: label,
            items,
            meta: {
                hoverPopupEnabled: false,
                showMoreButton: false,
                // Matches the FTS results above — search cards trade shelf
                // density for readable titles (see MusicSearchResults).
                cardWidthOverride: 'w-40',
                rows: 2,
            },
        };
    });

    function toggle(): void {
        // Fix 5: don't allow expansion when query is empty/whitespace.
        if (!query.trim()) return;
        expanded = !expanded;
        if (expanded && es.fetchedForQuery !== query && es.inFlightQuery !== query) {
            // Fix 2: skip refetch when a request for this query is already in flight.
            if (!enabled) return;
            void es.search(query);
        }
    }

    // When query changes: abort in-flight, collapse, and clear cached results.
    // This is the cost wall — editing the search box kills the in-flight request
    // and never shows stale results. The effect cleanup function runs before the
    // next execution (i.e., when `query` changes).
    $effect(() => {
        // Establish reactive dependency on `query`.
        const _q = query;
        return () => {
            // Runs when `query` changes before the next effect execution.
            void _q;
            es.reset();
            expanded = false;
        };
    });

    onDestroy(() => {
        es.dispose();
    });
</script>

{#if enabled}
    <div>
        <!-- Disclosure header — only fetches on first expand -->
        <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            data-testid="semantic-section-{kind}"
            class="flex w-full items-center justify-between gap-3 rounded-lg border border-surface-700/40 bg-surface-800/40 px-4 py-3 text-left transition-colors hover:border-surface-600/60 hover:bg-surface-700/40"
            onclick={toggle}>
            <span class="flex items-center gap-2">
                <span class="text-sm font-semibold text-surface-200">{label}</span>
                {#if query}
                    <span class="text-xs text-surface-400">"{query}"</span>
                {/if}
            </span>
            <span
                class="text-surface-400 transition-transform {expanded ? 'rotate-90' : ''}"
                aria-hidden="true">
                &#9654;
            </span>
        </button>

        <!-- Collapsible content panel -->
        <div id={contentId} class:hidden={!expanded}>
            {#if es.loading}
                <div class="mt-3">
                    <SectionSkeleton variant="track-carousel" count={6} />
                </div>
            {:else if es.errorMsg}
                <div
                    class="mt-3 rounded-lg border border-surface-700/40 bg-surface-800/40 px-4 py-3 text-sm text-surface-400"
                    role="alert">
                    {es.errorMsg}
                </div>
            {:else if es.tracks.length === 0 && es.fetchedForQuery !== null}
                <!-- Empty state after a completed fetch -->
                <div class="mt-3 py-6 text-center text-sm text-surface-400">
                    {#if kind === 'sound'}
                        <p>{m.music_semantic_empty_sound({ query: es.resolvedQuery })}</p>
                        <p class="mt-1 text-xs text-surface-500">
                            {m.music_semantic_empty_sound_hint()}
                        </p>
                    {:else}
                        <p>{m.music_semantic_empty_lyrics({ query: es.resolvedQuery })}</p>
                    {/if}
                </div>
            {:else if es.tracks.length > 0}
                <div class="mt-3">
                    <SectionRenderer
                        {section}
                        {onitemClick}
                        {onitemPlay}
                        {onitemMore}
                        {onitemRemove} />
                </div>
            {/if}
        </div>
    </div>
{/if}
