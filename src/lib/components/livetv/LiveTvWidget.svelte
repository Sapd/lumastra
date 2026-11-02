<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { isPromotedLiveTvChannel } from '$lib/shared/livetv-availability.js';
    import { onMount, tick } from 'svelte';
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import { SectionRenderer } from '$lib/components/sections';
    import { getLiveTvChannels } from '$lib/api/playback.js';
    import { getLiveTvFavorites } from '$lib/api/livetv-favorites.js';
    import {
        liveTvChannelToWhatsOnItem,
        orderFavoritesFirst,
    } from '$lib/shared/livetv-transforms.js';
    import type { PageSection } from '$lib/types/server-driven-ui';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        initialSection?: PageSection | null;
        onvisibilityChange?: (detail: { visible: boolean }) => void;
    }

    let { initialSection, onvisibilityChange }: Props = $props();

    // Apply i18n title to server-provided section (server can't access Paraglide)
    // svelte-ignore state_referenced_locally
    let section: PageSection | undefined = $state(
        initialSection ? { ...initialSection, title: m.livetv_whats_on_now() } : undefined,
    );
    // svelte-ignore state_referenced_locally
    let hasContent = $state(!!initialSection?.items?.length);

    // Match the 20-card SSR preview. A refresh returns the entire lineup
    // (thousands of stations on large installations); mounting all of it in
    // one horizontal row makes Safari's layout work stall vertical scrolling.
    // Keep every station available, but only mount another batch when asked.
    const CHANNEL_BATCH_SIZE = 20;
    let visibleChannelCount = $state(CHANNEL_BATCH_SIZE);
    let query = $state('');
    let programTitles = $state.raw<Record<string, { current: string; next: string }>>({});
    let normalizedQuery = $derived(query.trim().toLowerCase());
    // Search the complete lineup before slicing the render batch. Only the
    // now/next pair is indexed; this is not a full programme-guide search.
    let matchingItems = $derived.by(() => {
        const items = section?.items ?? [];
        if (!normalizedQuery) return items;
        return items.flatMap((item) => {
            const programs = programTitles[item.id];
            const currentMatch =
                item.title.toLowerCase().includes(normalizedQuery) ||
                (programs?.current ?? item.subtitle ?? '').toLowerCase().includes(normalizedQuery);
            const nextTitle = programs?.next ?? '';
            const nextMatch = nextTitle.toLowerCase().includes(normalizedQuery);
            if (!currentMatch && !nextMatch) return [];
            return [
                nextMatch && !currentMatch
                    ? { ...item, contextLabel: m.livetv_whats_on_next({ program: nextTitle }) }
                    : item,
            ];
        });
    });
    let visibleSection = $derived(
        section
            ? {
                  ...section,
                  items: matchingItems.slice(0, visibleChannelCount),
                  meta: {
                      ...section.meta,
                      ...(normalizedQuery
                          ? {
                                emptyState: {
                                    message: m.livetv_no_search_results({ query: query.trim() }),
                                },
                            }
                          : {}),
                  },
              }
            : undefined,
    );
    let canLoadMore = $derived(matchingItems.length > visibleChannelCount);

    function showMoreChannels(): void {
        visibleChannelCount = Math.min(
            visibleChannelCount + CHANNEL_BATCH_SIZE,
            matchingItems.length,
        );
    }

    async function setSearch(value: string): Promise<void> {
        query = value;
        visibleChannelCount = CHANNEL_BATCH_SIZE;
        await tick();
        // A query may replace the cards while the user is at the far right.
        // Reset only this row, preserving page position and search focus.
        const carousel = rowEl?.querySelector<HTMLElement>('.carousel-scroll');
        if (carousel) carousel.scrollLeft = 0;
        rowEl?.querySelector<HTMLInputElement>('.whats-on-search')?.focus({ preventScroll: true });
    }

    // Report initial visibility from server data

    // The per-card "Ends in X" subtitles in the SSR seed are built server-side in
    // the default locale, and the raw endTime isn't carried on the seeded item,
    // so only a client fetch can re-localize them. That fetch is the full
    // lineup (~180 KB on prod), so with a seed it waits until the row is on (or
    // about to scroll onto) the screen, where the English text could actually
    // be seen. Without a seed there's nothing to show yet, so fetch right away.
    let rowEl: HTMLDivElement | undefined = $state();
    let inView = $state(false);
    let lastRefreshAt = 0;
    let refreshGeneration = 0;

    onMount(() => {
        onvisibilityChange?.({ visible: hasContent });
        if (!initialSection?.items?.length) void refreshChannels();
    });

    $effect(() => {
        if (!rowEl) return;
        const observer = new IntersectionObserver(
            (entries) => {
                inView = entries.some((e) => e.isIntersecting);
            },
            { rootMargin: '400px 0px' },
        );
        observer.observe(rowEl);
        return () => observer.disconnect();
    });

    $effect(() => {
        if (inView && Date.now() - lastRefreshAt >= 60_000) void refreshChannels();
    });

    function clearSection(): void {
        section = undefined;
        hasContent = false;
        onvisibilityChange?.({ visible: false });
    }

    async function refreshChannels(): Promise<void> {
        const generation = ++refreshGeneration;
        lastRefreshAt = Date.now();
        // Favorites only reorder the row; if they fail to load, keep the
        // lineup order rather than dropping the row.
        const [result, favorites] = await Promise.all([getLiveTvChannels(), getLiveTvFavorites()]);

        if (generation !== refreshGeneration) return;

        // A fetch *error* is not authoritative — the lineup we already show is
        // more useful than an empty widget during a transient blip, so keep it.
        if (result.error) {
            if (!section) clearSection();
            return;
        }

        const now = Date.now();
        const favoriteStationIds = favorites.data?.stationIds ?? [];
        const channels = orderFavoritesFirst(
            result.data?.items ?? [],
            favoriteStationIds,
            (ch) => ch.id,
        ).filter(
            (ch) =>
                ch.isVisible &&
                (!result.data?.availability ||
                    isPromotedLiveTvChannel(ch.feedId, result.data.availability)),
        );
        programTitles = Object.fromEntries(
            channels.map((ch) => [
                ch.id,
                { current: ch.nowNext.current?.title ?? '', next: ch.nowNext.next?.title ?? '' },
            ]),
        );
        const items = channels.map((ch) => liveTvChannelToWhatsOnItem(ch, now, m.livetv_ends_in));

        // A successful empty response IS authoritative: nothing is airing, so
        // whatever we're showing has ended and must go. The old guard only
        // cleared when `section` was already undefined, which meant an existing
        // lineup survived every subsequent empty refresh — leaving "What's On
        // Now" advertising programs that finished hours ago.
        if (items.length === 0) {
            clearSection();
            return;
        }

        section = {
            id: 'live-tv-whats-on-now',
            title: m.livetv_whats_on_now(),
            type: 'carousel',
            meta: { cardVariant: 'backdrop' },
            items,
        };
        hasContent = true;
        onvisibilityChange?.({ visible: true });
    }

    // Auto-refresh every 60 seconds while the row is on screen (skip when the
    // tab is hidden). Also refresh when the tab becomes visible again.
    $effect(() => {
        const interval = setInterval(() => {
            if (!document.hidden && inView) {
                refreshChannels();
            }
        }, 60_000);

        function onVisibilityChange(): void {
            if (!document.hidden && inView) {
                refreshChannels();
            }
        }

        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    });
</script>

<div bind:this={rowEl}>
    {#if hasContent && visibleSection}
        <SectionRenderer
            section={visibleSection}
            {canLoadMore}
            onsectionReachEnd={showMoreChannels}>
            {#snippet headerControls()}
                <div class="relative w-full sm:w-80">
                    <Icon
                        src={MagnifyingGlass}
                        class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                    <input
                        type="search"
                        class="whats-on-search w-full rounded-lg border border-surface-600 bg-surface-900/70 py-1.5 pl-8 pr-9 text-sm text-surface-100 placeholder:text-surface-400 focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-400"
                        aria-label={m.livetv_search_placeholder()}
                        placeholder={m.livetv_search_placeholder()}
                        value={query}
                        oninput={(event) => setSearch(event.currentTarget.value)}
                        onkeydown={(event) => {
                            if (event.key === 'Escape' && query) {
                                event.preventDefault();
                                event.stopPropagation();
                                void setSearch('');
                            }
                        }} />
                    {#if query}
                        <button
                            type="button"
                            class="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-surface-400 hover:bg-surface-700 hover:text-white focus-visible:outline-2 focus-visible:outline-primary-400"
                            aria-label={m.btn_clear_search()}
                            onclick={() => setSearch('')}>
                            <Icon src={XMark} class="h-4 w-4" />
                        </button>
                    {/if}
                </div>
            {/snippet}
        </SectionRenderer>
    {/if}
</div>

<style>
    .whats-on-search::-webkit-search-cancel-button {
        -webkit-appearance: none;
    }
</style>
