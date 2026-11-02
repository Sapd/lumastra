<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Presentational rating card: poster, title/year/genres, community score,
  concise overview, a single "View details" button, a "seen" badge, and the four
  direction overlay labels ("Not for me" / "Liked it" / "Loved it" / "Skip")
  whose opacity is driven by the caller's drag state. Owns no gesture logic —
  SwipeDeck wires the swipe-card action on its wrapper and passes drag
  direction/progress down as props so this component stays pure props-in.
-->
<script lang="ts">
    import { Icon, Star, Eye } from 'svelte-hero-icons';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { isSeries } from '$lib/shared/media-types';
    import type { RatingCandidate } from '$lib/schemas/api-ai-responses';
    import type { SwipeDirection } from '$lib/actions/swipe-math';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        item: RatingCandidate;
        /** Direction the drag currently points at (drives the matching overlay label), or null at rest. */
        dragDirection?: SwipeDirection | null;
        /** 0..1 drag progress toward commit — overlay label opacity. */
        dragProgress?: number;
        ondetails?: (item: RatingCandidate) => void;
    }

    let { item, dragDirection = null, dragProgress = 0, ondetails }: Props = $props();

    let posterUrl = $derived(
        imageFromIds(item.externalIds, 'poster', isSeries(item.mediaType) ? 'tv' : 'movie', {
            size: 'card',
        }),
    );

    let genreChips = $derived((item.genres ?? []).slice(0, 3));

    function overlayOpacity(direction: SwipeDirection): number {
        return dragDirection === direction ? dragProgress : 0;
    }

    function handleDetails(): void {
        ondetails?.(item);
    }
</script>

<div
    class="relative flex h-full min-h-[var(--deck-height)] w-full flex-col justify-end overflow-hidden rounded-2xl bg-surface-900 shadow-2xl select-none">
    <!-- Poster -->
    <div class="absolute inset-0">
        {#if posterUrl}
            <img
                src={posterUrl}
                alt=""
                class="h-full w-full object-cover"
                draggable="false"
                loading="lazy" />
        {:else}
            <div
                class="flex h-full w-full items-center justify-center bg-surface-800 text-surface-500">
                <Icon src={Star} class="h-16 w-16" />
            </div>
        {/if}
        <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent">
        </div>
    </div>

    <!-- Direction overlay labels — opacity driven by drag progress -->
    <div
        class="pointer-events-none absolute left-4 top-4 -rotate-12 rounded-lg border-4 border-red-500 px-3 py-1 text-lg font-black tracking-wide text-red-500 uppercase"
        aria-hidden="true"
        style="opacity: {overlayOpacity('left')}">
        {m.rating_not_for_me()}
    </div>
    <div
        class="pointer-events-none absolute right-4 top-4 rotate-12 rounded-lg border-4 border-green-500 px-3 py-1 text-lg font-black tracking-wide text-green-500 uppercase"
        aria-hidden="true"
        style="opacity: {overlayOpacity('right')}">
        {m.rating_liked()}
    </div>
    <div
        class="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-lg border-4 border-violet-500 px-3 py-1 text-lg font-black tracking-wide text-violet-400 uppercase"
        aria-hidden="true"
        style="opacity: {overlayOpacity('up')}">
        {m.rating_loved()}
    </div>
    <div
        class="pointer-events-none absolute bottom-28 left-1/2 -translate-x-1/2 rounded-lg border-4 border-surface-300 px-3 py-1 text-lg font-black tracking-wide text-surface-200 uppercase"
        aria-hidden="true"
        style="opacity: {overlayOpacity('down')}">
        {m.rating_skip()}
    </div>

    <!-- Info panel -->
    <div class="relative flex flex-col gap-2 p-4" data-testid="swipe-card-info">
        {#if item.source === 'watched'}
            <div
                data-testid="swipe-seen-badge"
                class="flex max-w-full items-center gap-1 self-start rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-surface-100 backdrop-blur-sm">
                <Icon src={Eye} class="h-3.5 w-3.5 shrink-0" />
                {m.rate_seen_badge()}
            </div>
        {/if}
        <div class="flex items-start justify-between gap-2">
            <h2 class="min-w-0 line-clamp-2 break-words text-xl font-bold leading-tight text-white">
                {item.title}
            </h2>
        </div>

        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-surface-200">
            <span
                >{isSeries(item.mediaType)
                    ? m.hero_media_type_series()
                    : m.hero_media_type_movie()}</span>
            {#if item.year}
                <span>{item.year}</span>
            {/if}
            {#if item.communityRating !== undefined}
                <span class="flex items-center gap-1">
                    <Icon src={Star} class="h-3.5 w-3.5 text-yellow-400" solid />
                    {item.communityRating.toFixed(1)}
                </span>
            {/if}
        </div>

        {#if genreChips.length > 0}
            <div class="flex flex-wrap gap-1.5">
                {#each genreChips as genre (genre)}
                    <span
                        class="max-w-full truncate rounded-full bg-white/10 px-2 py-0.5 text-xs text-surface-100"
                        >{genre}</span>
                {/each}
            </div>
        {/if}

        {#if item.overview}
            <p class="line-clamp-2 break-words text-sm text-surface-200">{item.overview}</p>
        {/if}
        <button
            type="button"
            class="min-h-11 self-start rounded-full bg-white/15 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            onclick={handleDetails}>
            {m.rate_view_details()}
        </button>
    </div>
</div>
