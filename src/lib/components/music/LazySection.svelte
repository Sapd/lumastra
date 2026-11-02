<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { SectionRenderer } from '$lib/components/sections';
    import SectionSkeleton from './SectionSkeleton.svelte';
    import { fetchSectionCached } from './lazy-section-fetch';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

    interface Props {
        url: string;
        skeletonVariant: 'track-carousel' | 'artist-row' | 'album-carousel';
        skeletonCount?: number;
        /** Row count of the *loaded* section, so the skeleton reserves the same
         *  height (genre / Quick Picks carousels are 2-row — see SectionSkeleton). */
        skeletonRows?: number;
        rootMargin?: string;
        /**
         * Base URL for "load more" expansion (e.g. the genre section endpoint).
         * When set, the section becomes inline-expandable: scrolling to the
         * carousel's right edge or clicking "Load more" fetches another batch
         * from `${loadMoreUrl}?exclude=<shown ids>&limit=N` and appends it.
         * Omit for non-expandable sections (default behavior unchanged).
         */
        loadMoreUrl?: string;
        /** Track IDs to hide from the fetched section (e.g. user-dismissed tracks). */
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
        skeletonRows = 1,
        rootMargin = '200px',
        loadMoreUrl,
        hiddenTrackIds,
        onitemClick,
        onitemPlay,
        onitemMore,
        onitemRemove,
    }: Props = $props();

    const FETCH_TIMEOUT_MS = 15_000;
    /** Tracks appended per "load more" request. */
    const LOAD_MORE_COUNT = 20;
    /**
     * Cap on total items in an expandable carousel. Bounds both the UI (a
     * carousel isn't meant to hold a whole library) and the `exclude` query
     * param length. A batch can overshoot this by up to LOAD_MORE_COUNT, so
     * the real ceiling is ~120 UUIDs (~4.5 KB) — comfortably under the 8 KB
     * request-line limit on the prod edge (nginx default).
     */
    const MAX_ITEMS = 100;

    let section = $state<PageSection | null>(null);
    let error = $state(false);
    let fetched = $state(false);
    /** True while a manual retry is re-fetching, so the skeleton (not the blank
     *  spacer) shows even though `fetched` was already flipped true by doFetch. */
    let retrying = $state(false);
    let container: HTMLElement | undefined = $state();
    let loadingMore = $state(false);
    /** Set once the genre is exhausted (a batch returns nothing new) or capped. */
    let noMore = $state(false);

    /** The fetched section with dismissed tracks removed. */
    let visibleSection = $derived.by((): PageSection | null => {
        if (!section || !hiddenTrackIds || hiddenTrackIds.size === 0) return section;
        const filtered = section.items.filter(
            (item) => !hiddenTrackIds.has(item.itemKey ?? item.id),
        );
        if (filtered.length === section.items.length) return section;
        return { ...section, items: filtered, meta: { ...section.meta } };
    });
    let observer: IntersectionObserver | null = null;

    async function doFetch(): Promise<void> {
        if (fetched) return;
        fetched = true;
        // Routed through the shared cache + concurrency limiter (see
        // lazy-section-fetch): caps the initial request storm and serves repeat
        // views from cache. dependency_unavailable (503) collapses like an empty
        // section — Retry can't fix it — instead of latching a dead-end row.
        const result = await fetchSectionCached(url);
        if (result.kind === 'error') {
            error = true;
            return;
        }
        if (result.kind === 'empty') return;
        section = result.body as PageSection | null;
    }

    /**
     * Reset the latched error/fetched state and re-run the fetch. The original
     * doFetch sets `fetched = true` before the await and disconnects the observer,
     * so a transient failure would otherwise leave a permanent "Couldn't load"
     * dead end. This gives the user an explicit retry.
     */
    async function retry(): Promise<void> {
        if (retrying) return;
        error = false;
        fetched = false;
        retrying = true;
        try {
            await doFetch();
        } finally {
            retrying = false;
        }
    }

    /** Internal track IDs currently displayed (used as the `exclude` set). */
    function shownTrackIds(): string[] {
        if (!section) return [];
        return section.items
            .map((item) => item.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
    }

    let canLoadMore = $derived(
        !!loadMoreUrl &&
            !!section &&
            section.items.length > 0 &&
            section.items.length < MAX_ITEMS &&
            !noMore,
    );

    async function loadMore(): Promise<void> {
        if (!loadMoreUrl || loadingMore || noMore || !section) return;
        if (section.items.length >= MAX_ITEMS) {
            noMore = true;
            return;
        }
        loadingMore = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const exclude = shownTrackIds();
            const params = new URLSearchParams({
                exclude: exclude.join(','),
                limit: String(LOAD_MORE_COUNT),
            });
            const res = await fetch(`${loadMoreUrl}?${params.toString()}`, {
                signal: controller.signal,
            });
            if (!res.ok) {
                noMore = true;
                return;
            }
            const payload = (await res.json()) as PageSection | null;
            const incoming = payload?.items ?? [];
            // Belt-and-suspenders client dedup: the server already excludes the
            // shown IDs, but a concurrent fetch could overlap. Drop any repeats.
            const shownSet = new SvelteSet(section.items.map((item) => item.itemKey ?? item.id));
            const fresh = incoming.filter((item) => {
                const id = item.itemKey ?? item.id;
                if (shownSet.has(id)) return false;
                shownSet.add(id);
                return true;
            });
            if (fresh.length === 0) {
                noMore = true;
                return;
            }
            section = {
                ...section,
                items: [...section.items, ...fresh],
                meta: { ...section.meta },
            };
            // A short batch means the genre pool is nearly drained — stop here.
            if (fresh.length < LOAD_MORE_COUNT) noMore = true;
        } catch {
            noMore = true;
        } finally {
            clearTimeout(timer);
            loadingMore = false;
        }
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

        if (container) {
            observer.observe(container);
        }
    });

    onDestroy(() => {
        observer?.disconnect();
        observer = null;
    });
</script>

<!-- Collapse to display:none once fetched-empty so the parent's `space-y` gap doesn't
     reserve a hole for content-less sections (e.g. Because You Listened / Sonic Fingerprint
     / Smart Mixes when the data is sparse — which left a large gap between Top Artists and
     Recently Added). The node stays in the DOM so the intersection-observer ref is valid
     until the fetch settles; only the empty, already-fetched state is hidden. -->
<div bind:this={container} class:hidden={fetched && !error && !visibleSection}>
    {#if error}
        <div class="flex items-center gap-3">
            <p class="text-surface-400 text-sm">Couldn't load this section.</p>
            <button
                type="button"
                class="text-primary-400 hover:text-primary-300 text-sm font-medium underline"
                onclick={retry}>
                Retry
            </button>
        </div>
    {:else if visibleSection}
        <SectionRenderer
            section={visibleSection}
            {canLoadMore}
            {loadingMore}
            onsectionReachEnd={loadMore}
            {onitemClick}
            {onitemPlay}
            {onitemMore}
            {onitemRemove} />
    {:else if !fetched || retrying}
        <SectionSkeleton variant={skeletonVariant} count={skeletonCount} rows={skeletonRows} />
    {:else}
        <!-- fetched && !error && section == null: server returned no content.
             Render a min-height spacer so the layout doesn't shift (CLS). -->
        <div class="min-h-[1px]" aria-hidden="true"></div>
    {/if}
</div>
