<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * MediaCarousel - Stats carousel with timeframe selector
     * Uses Server-Driven UI architecture with SectionRenderer
     */
    import { page } from '$app/stores';
    import { openMediaModal } from '$lib/utils/modal-utils';
    import { imageFromIds } from '$lib/utils/image-utils';
    import {
        createExternalIdsFromTmdb,
        hasValidExternalId,
        mediaCompositeKey,
    } from '$lib/utils/media-id-helpers';
    import { SectionRenderer } from '$lib/components/sections';
    import type { PageSection, UniversalMediaItem, Badge } from '$lib/types/server-driven-ui';
    import type { ExternalIds } from '$lib/types/api-common';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
    import { MOVIE_OR_TV_TO_CARD } from '$lib/utils/media-types';
    import { resolveMediaAvailability } from '$lib/shared/media-availability.js';

    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);

    type CarouselItem = {
        id?: string;
        externalIds?: ExternalIds;
        title?: string;
        overview?: string;
        year?: number;
        rating?: number;
        avgCompletionRate?: number;
        uniqueViewers?: number;
        isAvailable?: boolean;
        is_available?: boolean;
        hasFile?: boolean;
        hasFiles?: boolean;
        has_files?: boolean;
    };

    interface Props {
        title?: string;
        items?: CarouselItem[];
        type?: 'movies' | 'tvshows' | 'completion';
        showTimeframeSelector?: boolean;
        selectedTimeframe?: 'AllTime' | 'LastWeek' | 'LastMonth' | 'LastYear';
        onTimeframeChange?: ((timeframe: string) => void) | null;
        isLoading?: boolean;
    }

    let {
        title = 'Media',
        items = [],
        type = 'movies',
        showTimeframeSelector = false,
        selectedTimeframe = 'AllTime',
        onTimeframeChange = null,
        isLoading = false,
    }: Props = $props();

    /**
     * A carousel KIND is not a media type.
     *
     * `type` is `'movies' | 'tvshows' | 'completion'` — the kind of statistics
     * carousel being rendered. It used to be passed straight into `toTmdbType()`,
     * which produced the right answer only by accident: `'tvshows'` happened to be
     * in that function's alias list, while `'movies'` and `'completion'` were not
     * recognised at all and fell through its `default: return 'movie'` arm.
     *
     * Now that the narrowing is honest, the two vocabularies are mapped
     * explicitly. `'completion'` mixes both kinds; it keeps its historic
     * movie-shaped composite keys and TMDB image paths.
     */
    // `| undefined` in the value type is deliberate: `noUncheckedIndexedAccess` is
    // off, so without it TypeScript would treat every string as a valid key and the
    // fallback below would read as dead code.
    const CAROUSEL_MEDIA_TYPE: Readonly<Record<string, 'movie' | 'tv' | undefined>> = {
        movies: 'movie',
        tvshows: 'tv',
        completion: 'movie',
    };

    function carouselMediaType(kind: string): 'movie' | 'tv' {
        // Accept a media type directly too — `clickData.carouselType` is an
        // untyped string that some callers populate with a real media type.
        return CAROUSEL_MEDIA_TYPE[kind] ?? toTmdbType(kind) ?? 'movie';
    }

    // =========================================================================
    // Transform item to UniversalMediaItem
    // =========================================================================

    function transformItem(item: CarouselItem): UniversalMediaItem {
        const badges: Badge[] = [];

        // Add rating badge if exists
        if (item.rating) {
            badges.push({
                text: item.rating.toFixed(1),
                color: 'warning',
                icon: 'star',
            });
        }

        // Build subtitle based on type
        let subtitle = '';
        if (type === 'completion' && item.avgCompletionRate) {
            subtitle = `${Math.round(item.avgCompletionRate)}% completed`;
        } else if (item.uniqueViewers) {
            subtitle = `${item.uniqueViewers} ${item.uniqueViewers === 1 ? 'viewer' : 'viewers'}`;
        }

        // Get image URL via provider-agnostic external ID lookup
        const mediaType = carouselMediaType(type);
        const externalIds = item.externalIds || {};
        let imageUrl: string;
        if (hasValidExternalId(externalIds)) {
            imageUrl =
                imageFromIds(externalIds, 'poster', mediaType, {
                    size: 'thumb',
                }) || FALLBACK_IMAGE;
        } else {
            imageUrl = FALLBACK_IMAGE;
        }

        return {
            id: `stats-${type}-${mediaCompositeKey(externalIds, mediaType, item.id || item.title)}`,
            externalIds,
            // `mediaType` above is the TMDB token the key + poster URL need; the
            // card contract emits 'series' for it.
            mediaType: MOVIE_OR_TV_TO_CARD[mediaType],
            title: item.title || 'Unknown',
            subtitle,
            image: imageUrl,
            overview: item.overview,
            rating: item.rating,
            year: item.year,
            isAvailable: resolveMediaAvailability(item),
            canRequest: false,
            badges,
            clickData: {
                item,
                carouselType: type,
            },
        };
    }

    // Build reactive section from items
    let section: PageSection = $derived({
        id: `carousel-${type}`,
        type: 'carousel',
        title: '', // Empty - we use custom header with dropdown
        items: items.map(transformItem),
        meta: {
            loading: isLoading,
        },
    });

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        const originalItem = item.clickData?.item;
        const carouselType = (item.clickData?.carouselType as string) || type;

        // Determine media type based on carousel type (or, when `clickData`
        // carried a real media type, on that).
        const mediaType = carouselMediaType(carouselType);

        // Open modal with the item data
        openMediaModal(
            {
                title: item.title,
                overview: item.overview,
                mediaType,
                rating:
                    typeof item.rating === 'string' ? Number.parseFloat(item.rating) : item.rating,
                year: item.year,
                genres: (originalItem as { genres?: number[] })?.genres || [],
                externalIds: item.externalIds,
                isAvailable: item.isAvailable,
                customMetadata: item.customMetadata,
            },
            item.image,
        );
    }

    const handleTimeframeChange = (event: Event) => {
        const target = event.target as HTMLSelectElement;
        if (onTimeframeChange) {
            onTimeframeChange(target.value);
        }
    };
</script>

<div class="relative">
    <!-- Custom Header with Title and Timeframe Selector -->
    <div class="between mb-4">
        <div class="flex items-center gap-4">
            <h2 class="text-2xl font-bold text-white">{title}</h2>
            {#if showTimeframeSelector}
                <div class="flex items-center gap-2">
                    <select
                        value={selectedTimeframe}
                        onchange={handleTimeframeChange}
                        disabled={isLoading}
                        class="bg-gray-800 border border-gray-600 text-white text-sm rounded-lg px-3 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
                        <option value="AllTime">All Time</option>
                        <option value="LastMonth">Last Month</option>
                        <option value="LastWeek">Last Week</option>
                    </select>
                    {#if isLoading}
                        <span class="loading-spinner loading-spinner-white w-4 h-4"></span>
                    {/if}
                </div>
            {/if}
        </div>
    </div>

    <!-- SectionRenderer handles the carousel -->
    <SectionRenderer {section} {hasRequestPermission} onitemClick={handleItemClick} />
</div>
