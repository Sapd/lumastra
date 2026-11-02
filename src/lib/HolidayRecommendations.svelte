<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * HolidayRecommendations - Seasonal themed recommendations banner
     * Uses UniversalMediaCard for consistent media rendering
     */
    import { onMount } from 'svelte';
    import { apiGet, apiPost } from '$lib/api/client';
    import { Icon, Sparkles, ArrowPath, ChevronDown, ChevronUp } from 'svelte-hero-icons';
    import { openMediaModal, handleRequestAction } from '$lib/utils/modal-utils';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { buildMediaKey, getPlayableId } from '$lib/utils/media-id-helpers';
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { createCollapseHandler } from '$lib/utils/ui-state';
    import { dragScroll } from '$lib/utils/drag-scroll';
    import UniversalMediaCard from '$lib/components/ui/UniversalMediaCard.svelte';
    import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { mediaCompositeKey, createRenderableMediaKeys } from '$lib/utils/media-id-helpers';
    import { MOVIE_OR_TV_TO_CARD } from '$lib/utils/media-types';
    import type { ExternalIds } from '$lib/types/api-common';
    import { z } from 'zod';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        // Callbacks
        onvisibilityChange?: (detail: { visible: boolean }) => void;
    }

    let { onvisibilityChange }: Props = $props();

    // Get holiday name based on current locale
    function getHolidayName(h: Holiday): string {
        const locale = getLocale();
        return h.localizedNames?.[locale] ?? h.name;
    }

    // =========================================================================
    // Constants
    // =========================================================================

    const collapseHandler = createCollapseHandler('holiday-collapsed');

    // Feature flags from layout data
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    const requestUrl = env.PUBLIC_REQUESTURL || '';

    interface Holiday {
        id: string;
        name: string;
        localizedNames?: Record<string, string>;
        emoji: string;
        backgroundColor: string;
        textColor: string;
        backgroundImage?: string;
    }

    /**
     * Derived from `HolidayItemClientSchema` below rather than hand-written.
     * The old interface disagreed with both that schema and the server
     * (`/api/recommendations/holiday`): it marked ~10 fields required that the
     * wire sends optionally, and typed `rating` as `string` when the endpoint
     * emits `z.number()` — so `Number.parseFloat(rec.rating)` only worked by
     * runtime coercion, and the `as HolidayRecommendation[]` below was a lie.
     */
    type HolidayRecommendation = z.infer<typeof HolidayItemClientSchema>;

    let active = $state(false);
    let holiday = $state<Holiday | null>(null);
    let recommendations: HolidayRecommendation[] = $state([]);
    // Dedup-safe render keys — duplicate items / shared title fallbacks would otherwise
    // collide and throw `each_key_duplicate`.
    let recommendationKeys = $derived(createRenderableMediaKeys(recommendations));
    let loading = $state(true);
    let isCollapsed = $state(false);
    let wasVisible = false;

    /**
     * Client-side schema for /api/recommendations/holiday.
     * Matches the server's HolidayResponseSchema — bare object, no success wrapper,
     * items typed to the fields the component actually consumes.
     */
    const HolidayItemClientSchema = z.object({
        mediaType: z.enum(['movie', 'tv']).optional(),
        title: z.string().optional(),
        externalIds: z.record(z.string(), z.string()).optional(),
        images: z.record(z.string(), z.object({ href: z.string() })).optional(),
        isAvailable: z.boolean().optional(),
        canRequest: z.boolean().optional(),
        overview: z.string().optional(),
        rating: z.number().optional(),
        genres: z.array(z.number()).optional(),
        criticRating: z.number().optional(),
        aiSuggestion: z.boolean().optional(),
        holidayThemed: z.boolean().optional(),
        holidayId: z.string().optional(),
        holidayName: z.string().optional(),
        availabilitySource: z.string().optional(),
        userRating: z.number().optional(),
    });

    const HolidayHolidayClientSchema = z
        .object({
            id: z.string().optional(),
            name: z.string().optional(),
            localizedNames: z.record(z.string(), z.string()).optional(),
            emoji: z.string().optional(),
            backgroundColor: z.string().optional(),
            textColor: z.string().optional(),
            backgroundImage: z.string().optional(),
        })
        .catchall(z.unknown());

    const HolidayResponseSchema = z.object({
        active: z.boolean(),
        holiday: HolidayHolidayClientSchema.optional(),
        items: z.array(HolidayItemClientSchema).optional(),
        cached: z.boolean().optional(),
        message: z.string().optional(),
    });

    async function loadHolidayRecommendations(refresh = false) {
        loading = true;
        try {
            const limit = $page.data.homepage?.holidayLimit ?? 20;
            const url = refresh
                ? '/api/recommendations/holiday/refresh'
                : `/api/recommendations/holiday?limit=${limit}`;
            const { data: payload, error: fetchError } = await (refresh
                ? apiPost(url, HolidayResponseSchema, { limit })
                : apiGet(url, HolidayResponseSchema));

            if (fetchError || !payload) {
                // Keep a previously loaded shelf and its Refresh control usable.
                toasts.error(m.error_generic());
                return;
            }

            active = payload.active;
            holiday = payload.holiday ? (payload.holiday as unknown as Holiday) : null;
            recommendations = payload.items ?? [];
        } catch {
            toasts.error(m.error_generic());
        } finally {
            loading = false;
            // Dispatch visibility change when data loads
            const isVisible = active && holiday !== null;
            if (isVisible !== wasVisible) {
                wasVisible = isVisible;
                onvisibilityChange?.({ visible: isVisible });
            }
        }
    }

    function toggleCollapse() {
        isCollapsed = collapseHandler.toggle(isCollapsed);
    }

    onMount(() => {
        isCollapsed = collapseHandler.loadState();
        loadHolidayRecommendations();
    });

    function getPosterUrl(externalIds: ExternalIds, mediaType: 'movie' | 'tv' = 'movie'): string {
        return (
            imageFromIds(externalIds, 'poster', mediaType, {
                size: 'thumb',
            }) || ''
        );
    }

    /**
     * Transform a HolidayRecommendation to UniversalMediaItem for the card component
     */
    function transformHolidayItem(rec: HolidayRecommendation): UniversalMediaItem {
        // Every field below is optional on the wire, so defaults are applied here
        // rather than being assumed. `mediaType` falls back to 'movie', matching
        // the endpoint's own default for untyped rows.
        const externalIds = rec.externalIds ?? {};
        const mediaType = rec.mediaType ?? 'movie';
        const title = rec.title ?? '';
        const key = mediaCompositeKey(externalIds, mediaType, title);
        return {
            id: `holiday-${key}`,
            externalIds,
            // `mediaType` stays TMDB-shaped for the key + poster URL below; the
            // emitted card type is the 'series' vocabulary.
            mediaType: MOVIE_OR_TV_TO_CARD[mediaType],
            title,
            image: getPosterUrl(externalIds, mediaType),
            overview: rec.overview,
            isAvailable: rec.isAvailable === true,
            canRequest: rec.canRequest === true,
            rating: rec.rating,
            criticRating: rec.criticRating,
            // Store original data for click handler
            clickData: rec as unknown as Record<string, unknown>,
        };
    }

    function openMovieModal(movie: HolidayRecommendation) {
        const imageUrl = getPosterUrl(movie.externalIds ?? {}, movie.mediaType ?? 'movie');
        openMediaModal(
            {
                ...movie,
                rating: movie.rating,
                criticRating: movie.criticRating,
                genres: movie.genres,
            },
            imageUrl,
        );
    }

    function handleRefresh() {
        loadHolidayRecommendations(true);
    }

    function handleRequest(item: UniversalMediaItem) {
        handleRequestAction(
            {
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                posterPath: item.image,
                year: String(item.year ?? ''),
            },
            requestsEnabled,
            requestUrl,
            hasRequestPermission,
        );
    }

    function handlePlay(item: UniversalMediaItem) {
        const playableId = getPlayableId(item);
        if (playableId) {
            const key = buildMediaKey(item.externalIds, item.mediaType) ?? playableId;
            void navigateToWatch(key);
        }
    }
</script>

{#if active && holiday}
    <section class="space-y-4">
        <!-- Holiday Banner with themed background -->
        <div
            class="rounded-xl p-6 border-2 relative overflow-hidden"
            style="
				background: {holiday.backgroundImage
                ? `linear-gradient(135deg, ${holiday.backgroundColor}dd, ${holiday.backgroundColor}aa), url('${holiday.backgroundImage}') center/cover`
                : `linear-gradient(135deg, ${holiday.backgroundColor}dd, ${holiday.backgroundColor}aa)`};
				border-color: {holiday.backgroundColor};
				color: {holiday.textColor};
			">
            <div class="relative z-10">
                <div class="between mb-2">
                    <div class="flex items-center gap-3">
                        <span class="text-5xl">{holiday.emoji}</span>
                        <div>
                            <h2 class="text-2xl font-bold">
                                {getHolidayName(holiday)}
                            </h2>
                            <p class="text-sm opacity-90">
                                {recommendations.length}
                                {recommendations.length === 1
                                    ? m.holiday_recommendation()
                                    : m.holiday_recommendations()}
                                {m.holiday_for_holidays()}
                            </p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button
                            class="p-2 hover:bg-black/20 rounded-full transition-colors"
                            onclick={handleRefresh}
                            disabled={loading}
                            title={m.btn_refresh()}>
                            <Icon src={ArrowPath} class="w-5 h-5 {loading ? 'animate-spin' : ''}" />
                        </button>

                        <button
                            class="p-2 hover:bg-black/20 rounded-full transition-colors"
                            onclick={toggleCollapse}
                            title={isCollapsed ? m.btn_expand() : m.btn_collapse()}>
                            <Icon src={isCollapsed ? ChevronDown : ChevronUp} class="w-5 h-5" />
                        </button>
                    </div>
                </div>
                {#if recommendations.some((rec) => rec.aiSuggestion)}
                    <p class="text-xs opacity-75 mt-2">
                        <Icon src={Sparkles} class="w-3 h-3 inline" />
                        {m.holiday_ai_personalized()}
                    </p>
                {/if}
            </div>

            <!-- Decorative background pattern -->
            <div class="absolute inset-0 opacity-10 pointer-events-none">
                <div
                    class="text-9xl absolute top-0 right-0 transform translate-x-1/4 -translate-y-1/4">
                    {holiday.emoji}
                </div>
                <div
                    class="text-7xl absolute bottom-0 left-0 transform -translate-x-1/4 translate-y-1/4">
                    {holiday.emoji}
                </div>
            </div>
        </div>

        {#if !isCollapsed}
            {#if loading}
                <div class="card variant-soft p-8 text-center">
                    <p class="text-gray-400">
                        {m.holiday_loading({
                            holiday: getHolidayName(holiday),
                        })}
                    </p>
                </div>
            {:else if recommendations.length === 0}
                <div class="card variant-soft p-8 text-center">
                    <p class="text-gray-400">
                        {m.holiday_none_found({
                            holiday: getHolidayName(holiday),
                        })}
                    </p>
                </div>
            {:else}
                <!-- Horizontal scrolling carousel -->
                <div
                    class="flex gap-3 overflow-x-auto pb-4 smooth-scroll"
                    style="--holiday-color: {holiday.backgroundColor};"
                    use:dragScroll>
                    {#each recommendations as rec, recIdx (recommendationKeys[recIdx])}
                        <div class="w-32 shrink-0">
                            <UniversalMediaCard
                                item={transformHolidayItem(rec)}
                                variant="poster"
                                showMoreButton={false}
                                {hasRequestPermission}
                                onclick={() => openMovieModal(rec)}
                                onplay={handlePlay}
                                onrequest={handleRequest} />
                        </div>
                    {/each}
                </div>
            {/if}
        {/if}
    </section>
{/if}

<style lang="postcss">
    /* Override scrollbar with holiday-themed colors */
    .smooth-scroll {
        scrollbar-width: thin;
        scrollbar-color: var(--holiday-color, rgba(255, 255, 255, 0.2)) transparent;
    }

    .smooth-scroll::-webkit-scrollbar {
        height: 6px;
    }

    .smooth-scroll::-webkit-scrollbar-track {
        background: transparent;
    }

    .smooth-scroll::-webkit-scrollbar-thumb {
        background-color: var(--holiday-color, rgba(255, 255, 255, 0.2));
        border-radius: 3px;
    }

    .smooth-scroll::-webkit-scrollbar-thumb:hover {
        filter: brightness(1.2);
    }
</style>
