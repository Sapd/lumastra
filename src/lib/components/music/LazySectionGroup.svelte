<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { SectionRenderer } from '$lib/components/sections';
    import SectionSkeleton from './SectionSkeleton.svelte';
    import { fetchSectionCached } from './lazy-section-fetch';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

    interface Props {
        url: string;
        skeletonVariant: 'track-carousel' | 'artist-row' | 'album-carousel';
        skeletonCount?: number;
        rootMargin?: string;
        /** Track IDs to hide from fetched sections (e.g. user-dismissed tracks). */
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
        url,
        skeletonVariant,
        skeletonCount = 6,
        rootMargin = '200px',
        hiddenTrackIds,
        onitemClick,
        onitemPlay,
        onitemMore,
        onitemRemove,
    }: Props = $props();

    let sections = $state<PageSection[]>([]);
    let error = $state(false);
    let fetched = $state(false);
    let container: HTMLElement | undefined = $state();

    /** Fetched sections with dismissed tracks removed. */
    let visibleSections = $derived.by((): PageSection[] => {
        if (!hiddenTrackIds || hiddenTrackIds.size === 0) return sections;
        return sections.map((section) => {
            const filtered = section.items.filter(
                (item) =>
                    !hiddenTrackIds.has(item.itemKey ?? item.id),
            );
            if (filtered.length === section.items.length) return section;
            return { ...section, items: filtered, meta: { ...section.meta } };
        });
    });
    let observer: IntersectionObserver | null = null;

    async function doFetch(): Promise<void> {
        if (fetched) return;
        fetched = true;
        // Routed through the shared cache + concurrency limiter (see
        // lazy-section-fetch). dependency_unavailable (503) collapses like an
        // empty section instead of latching a dead-end error row.
        const result = await fetchSectionCached(url);
        if (result.kind === 'error') {
            error = true;
            return;
        }
        if (result.kind === 'empty') return;
        const payload = result.body as { sections?: PageSection[] } | null;
        sections = payload?.sections ?? [];
    }

    onMount(() => {
        if (typeof IntersectionObserver === 'undefined') {
            void doFetch();
            return;
        }
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        void doFetch();
                        observer?.disconnect();
                        observer = null;
                        return;
                    }
                }
            },
            { rootMargin },
        );
        if (container) observer.observe(container);
    });

    onDestroy(() => {
        observer?.disconnect();
        observer = null;
    });
</script>

<div bind:this={container} class="space-y-6">
    {#if error}
        <p class="text-surface-400 text-sm">Couldn't load this section.</p>
    {:else if visibleSections.length > 0}
        {#each visibleSections as section (section.id)}
            <SectionRenderer {section} {onitemClick} {onitemPlay} {onitemMore} {onitemRemove} />
        {/each}
    {:else if !fetched}
        <SectionSkeleton variant={skeletonVariant} count={skeletonCount} />
    {:else}
        <!-- fetched && !error && sections == []: server returned no content.
             Render a min-height spacer so the layout doesn't shift (CLS). -->
        <div class="min-h-[1px]" aria-hidden="true"></div>
    {/if}
</div>
