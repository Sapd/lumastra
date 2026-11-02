<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	StandardSection.svelte

	Renders carousel or grid layouts for media items.
	Supports collapsible headers, refresh buttons, and filter dropdowns.
	Supports grouped filters with IconDropdown for streaming service selection.

	@example Carousel
	<StandardSection section={{ type: 'carousel', items: [...] }} />

	@example Grid
	<StandardSection section={{ type: 'grid', items: [...] }} />

	@example With Grouped Filters (Streaming)
	<StandardSection section={{
		type: 'carousel',
		items: [...],
		meta: { filterGroups: [...], activeFilter: 'netflix-movies' }
	}} />
-->
<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';

    import { onMount, type Snippet } from 'svelte';
    import { debounce } from '$lib/utils/debounce';
    import { resolve } from '$lib/paths';
    import { Icon, ArrowPath, ChevronDown, ChevronUp, Trash } from 'svelte-hero-icons';
    import type {
        PageSection,
        UniversalMediaItem,
        CardVariant,
        SectionMeta,
    } from '$lib/types/server-driven-ui';
    import { createRenderableMediaKeys, mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import { getIcon } from '$lib/utils/icon-map';
    import { dragScroll } from '$lib/utils/drag-scroll';
    import { createCollapseHandler } from '$lib/utils/ui-state';
    import { UniversalMediaCard, IconDropdown, MediaHoverCard } from '$lib/components/ui';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import RatingPickerModal from '$lib/components/modal/RatingPickerModal.svelte';
    import MediaFileInfoModal from '$lib/components/modal/MediaFileInfoModal.svelte';
    import {
        InformationCircle,
        Bookmark,
        Star,
        ClipboardDocument,
        DocumentMagnifyingGlass,
        ArrowPath as RefreshIcon,
        HandThumbDown,
        HandThumbUp,
        Heart,
        WrenchScrewdriver,
    } from 'svelte-hero-icons';
    import {
        copyMediaLink,
        refreshMediaMetadata,
        toggleWatchlistMedia,
        canWatchlistMedia,
        canRateMedia,
        quickRateMedia,
        buildMediaShareId,
        isPageAdmin,
    } from '$lib/utils/media-context-actions';
    import { watchlistItems } from '$lib/stores/watchlist';
    import { isMovie, isSeries, isEpisode } from '$lib/shared/media-types';
    import { canWrapMediaHoverCard } from './standard-section-hover';
    import { sectionConsumesDamper } from '$lib/shared/feed-section-kinds';
    import { page } from '$app/stores';
    import { posterHoverPreview } from '$lib/stores/uiPreferences';
    import * as m from '$lib/paraglide/messages';
    import { browser } from '$app/environment';
    import DOMPurify from 'dompurify';
    import type { TitlePart } from '$lib/schemas/api-responses';
    import {
        decodeEscapedText,
        titleChunksFromHtml,
        titleChunksFromParts,
        type TitleChunk,
    } from './section-title';
    import { isRecord } from '$lib/utils/data-extraction';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import { fallbackImage } from '$lib/utils/image-utils';
    import {
        NetflixIcon,
        DisneyIcon,
        PrimeIcon,
        HboIcon,
        AppleTvIcon,
        TrendingIcon,
        PopularIcon,
        CertifiedFreshIcon,
        BoxOfficeIcon,
        AnimeIcon,
    } from '$lib/icons/streaming';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The section data to render */
        section: PageSection;
        /** Caller-owned controls, rendered beside the title and wrapped on small screens. */
        headerControls?: Snippet;
        /** Override card variant (defaults based on section type) */
        cardVariant?: CardVariant | undefined;
        /** Override card width class */
        cardWidthClass?: string;
        /** Whether the user has permission to make requests (hides request buttons if false) */
        hasRequestPermission?: boolean;
        /** Show "Add to Playlist" button on cards */
        showAddButton?: boolean;
        /** Show watchlist bookmark button on cards */
        showWatchlistButton?: boolean;
        /** Set of composite keys for items in the watchlist */
        watchlistItemKeys?: Set<string>;
        /** Set of composite keys for items being saved/removed from watchlist */
        watchlistLoadingKeys?: Set<string>;
        /** Set of item keys that are already in the playlist (for "Added" state) */
        playlistItemKeys?: Set<string>;
        /** Callback when item is clicked */
        onitemClick?: (item: UniversalMediaItem) => void;
        /** Callback when play button is clicked */
        onitemPlay?: (item: UniversalMediaItem) => void;
        /** Callback when request button is clicked */
        onitemRequest?: (item: UniversalMediaItem) => void;
        /** Callback when more/similar button is clicked */
        onitemMore?: (item: UniversalMediaItem) => void;
        /** Callback when remove button is clicked */
        onitemRemove?: (item: UniversalMediaItem) => void;
        /** Callback when "Mark as watched" menu action is selected */
        onitemMarkWatched?: (item: UniversalMediaItem) => void;
        /** Callback when item is added to playlist */
        onitemAddToPlaylist?: (item: UniversalMediaItem) => void;
        /** Callback when item watchlist button is clicked */
        onitemWatchlist?: (item: UniversalMediaItem) => void;
        /** Callback when clear all button is clicked */
        onclearAll?: () => void;
        /** Callback when refresh button is clicked */
        onrefresh?: () => void;
        /** Callback when filter is changed */
        onfilterChange?: (value: string) => void;
        /** Callback when section is collapsed/expanded */
        oncollapse?: (collapsed: boolean) => void;
        /** Callback when a horizontal carousel nears its right edge */
        onreachEnd?: () => void;
        /**
         * When true, render a "Load more" affordance in the header (used by
         * lazily-expandable carousels like music genres). Clicking it — or
         * scrolling to the carousel's right edge — fires `onreachEnd`.
         */
        canLoadMore?: boolean;
        /** When true, the next "load more" batch is in flight (button shows a spinner). */
        loadingMore?: boolean;
        /**
         * How many of the first cards should render with `priority=true`
         * (loading=eager + fetchpriority=high). Set to a small positive
         * number for the first/above-the-fold section on a page so the
         * browser fetches those images ahead of off-screen lazy ones.
         * Default 0 = preserve previous lazy-everything behavior; only
         * sections explicitly told they're above the fold opt in.
         */
        priorityCount?: number;
    }

    let {
        section,
        headerControls,
        cardVariant = undefined,
        cardWidthClass = '',
        hasRequestPermission = true,
        showAddButton = false,
        showWatchlistButton = false,
        watchlistItemKeys = new SvelteSet(),
        watchlistLoadingKeys = new SvelteSet(),
        playlistItemKeys = new SvelteSet(),
        onitemClick,
        onitemPlay,
        onitemRequest,
        onitemMore,
        onitemRemove,
        onitemMarkWatched,
        onitemAddToPlaylist,
        onitemWatchlist,
        onclearAll,
        onrefresh,
        onfilterChange,
        oncollapse,
        onreachEnd,
        canLoadMore = false,
        loadingMore = false,
        priorityCount = 0,
    }: Props = $props();

    // =========================================================================
    // Internal State
    // =========================================================================

    const getLiveTvHoverDelayMs = (hoverData: unknown, fallback: number): number => {
        if (isRecord(hoverData) && typeof hoverData.liveTvDelayMs === 'number') {
            return hoverData.liveTvDelayMs;
        }
        return fallback;
    };

    const getVideoHoverDelayMs = (hoverData: unknown, fallback: number): number => {
        if (isRecord(hoverData) && typeof hoverData.videoDelayMs === 'number') {
            return hoverData.videoDelayMs;
        }
        return fallback;
    };

    let isCollapsed = $state(false);
    let isRefreshing = $state(false);
    let lastReachEndAt = 0;
    let renderItemKeys = $derived(createRenderableMediaKeys(section.items));
    // Only show the "show less like this" action when THIS section's ranking
    // consumes the damper (anime / short-movies / you-like / mood rows).
    let damperAware = $derived(sectionConsumesDamper(section.id));

    // Stable id for the section heading so the scroll container can reference it
    // via aria-labelledby. Sanitised to a valid id token.
    let sectionHeadingId = $derived(
        `section-h-${(section.id || 'section').replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    );

    // Keyboard scrolling for the carousel: a focused (tabindex=0, role="group")
    // scroller responds to Arrow/Home/End so keyboard-only users can traverse a
    // horizontal row that is otherwise only reachable by mouse drag/wheel.
    const KEYBOARD_SCROLL_STEP_PX = 240;
    function handleCarouselKeydown(event: KeyboardEvent): void {
        const node = event.currentTarget as HTMLElement | null;
        if (!node) return;
        switch (event.key) {
            case 'ArrowRight':
                node.scrollBy({ left: KEYBOARD_SCROLL_STEP_PX, behavior: 'smooth' });
                event.preventDefault();
                break;
            case 'ArrowLeft':
                node.scrollBy({ left: -KEYBOARD_SCROLL_STEP_PX, behavior: 'smooth' });
                event.preventDefault();
                break;
            case 'Home':
                node.scrollTo({ left: 0, behavior: 'smooth' });
                event.preventDefault();
                break;
            case 'End':
                node.scrollTo({ left: node.scrollWidth, behavior: 'smooth' });
                event.preventDefault();
                break;
        }
    }

    // Mobile detection - disable hover popups on small screens
    const MOBILE_BREAKPOINT = 768;
    const CAROUSEL_LOAD_MORE_THRESHOLD_PX = 480;
    let isMobile = $state(browser ? window.innerWidth < MOBILE_BREAKPOINT : true);

    let meta = $derived(section.meta || {}) as SectionMeta;
    let iconName = $derived(meta.icon);
    type SectionIcon = typeof Icon;
    let iconComponent = $derived(iconName ? (getIcon(iconName) as SectionIcon) || null : null);

    // =========================================================================
    // Streaming Icon Map
    // =========================================================================

    const streamingIconMap: Record<string, typeof NetflixIcon> = {
        'netflix-movies': NetflixIcon,
        'netflix-shows': NetflixIcon,
        'disney-movies': DisneyIcon,
        'disney-shows': DisneyIcon,
        'amazon-prime-movies': PrimeIcon,
        'amazon-prime-shows': PrimeIcon,
        'hbo-shows': HboIcon,
        'apple-tv-movies': AppleTvIcon,
        'apple-tv-all': AppleTvIcon,
        'trending-movies': TrendingIcon,
        'trending-shows': TrendingIcon,
        'popular-movies': PopularIcon,
        'popular-shows': PopularIcon,
        'certified-fresh': CertifiedFreshIcon,
        'box-office': BoxOfficeIcon,
        'latest-anime': AnimeIcon,
        'latest-anime-movies': AnimeIcon,
    };

    const titlePurifyConfig = {
        ALLOWED_TAGS: ['span', 'strong', 'em'],
        ALLOWED_ATTR: ['class'],
    };

    function stripTags(html: string): string {
        return html.replace(/<[^>]*>/g, '');
    }

    function sanitizeTitle(html: string): string {
        if (!browser) {
            return stripTags(html);
        }
        return DOMPurify.sanitize(html, titlePurifyConfig);
    }

    function computeTitleChunks(rawTitle: string, parts: TitlePart[] | undefined): TitleChunk[] {
        // Structured parts (text only) win over parsing the HTML title, unless a
        // filter replaced the title with its own text.
        if (parts && parts.length > 0 && rawTitle === section.title) {
            return titleChunksFromParts(parts);
        }
        const sanitized = sanitizeTitle(rawTitle);
        if (!browser) {
            return [{ text: decodeEscapedText(sanitized.replace(/<[^>]+>/g, '')) }];
        }
        return titleChunksFromHtml(sanitized);
    }

    // Single-entry memo: sanitizing + DOM-parsing a title is pure in its
    // input string, but the call sits in a `$derived` whose upstream deps
    // (filter selection, etc.) can change without the resolved title
    // changing. Caching the last (title -> chunks) result means the heavy
    // DOMParser/DOMPurify work only runs when the title text actually
    // changes, and the stable output reference lets Svelte skip the
    // downstream `{#each titleChunks}` render on unrelated ticks.
    let lastTitleInput: string | undefined;
    let lastTitleParts: TitlePart[] | undefined;
    let lastTitleChunks: TitleChunk[] = [];

    function parseTitleChunks(rawTitle: string, parts: TitlePart[] | undefined): TitleChunk[] {
        if (rawTitle === lastTitleInput && parts === lastTitleParts) {
            return lastTitleChunks;
        }
        lastTitleInput = rawTitle;
        lastTitleParts = parts;
        lastTitleChunks = computeTitleChunks(rawTitle, parts);
        return lastTitleChunks;
    }

    function getDisplayTitle(
        _activeFilter: string,
        _filterGroups: typeof filterGroups,
        _sectionTitle: string | undefined,
    ): string {
        // If we have a grouped filter selected, show the selected filter name
        if (_filterGroups.length > 0 && _activeFilter) {
            for (const group of _filterGroups) {
                const option = group.options.find((o) => o.value === _activeFilter);
                if (option) {
                    // Remove emoji from label if present
                    return option.label.replace(
                        /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u,
                        '',
                    );
                }
            }
        }
        return _sectionTitle || '';
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    onMount(() => {
        // Load saved collapse state
        if (collapseHandler) {
            isCollapsed = collapseHandler.loadState();
        } else if (meta.defaultCollapsed) {
            isCollapsed = meta.defaultCollapsed;
        }

        // Handle window resize for mobile detection
        const handleResize = () => {
            isMobile = window.innerWidth < MOBILE_BREAKPOINT;
        };
        const debouncedResize = debounce(handleResize, 150);
        window.addEventListener('resize', debouncedResize);
        return () => window.removeEventListener('resize', debouncedResize);
    });

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function isCustomEvent(
        value: UniversalMediaItem | CustomEvent<UniversalMediaItem>,
    ): value is CustomEvent<UniversalMediaItem> {
        return typeof value === 'object' && value !== null && 'detail' in value;
    }

    function getItem(
        value: UniversalMediaItem | CustomEvent<UniversalMediaItem>,
    ): UniversalMediaItem {
        return isCustomEvent(value) ? value.detail : value;
    }

    function toggleCollapse() {
        if (!isCollapsible) return;

        if (collapseHandler) {
            isCollapsed = collapseHandler.toggle(isCollapsed);
        } else {
            isCollapsed = !isCollapsed;
        }

        oncollapse?.(isCollapsed);
    }

    function handleRefresh() {
        if (isRefreshing) return;
        isRefreshing = true;
        onrefresh?.();

        // Reset refreshing state after animation
        setTimeout(() => {
            isRefreshing = false;
        }, 1000);
    }

    function handleItemClick(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemClick?.(getItem(value));
    }

    function handleItemPlay(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemPlay?.(getItem(value));
    }

    function handleItemRequest(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemRequest?.(getItem(value));
    }

    function handleItemMore(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemMore?.(getItem(value));
    }

    function handleItemRemove(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemRemove?.(getItem(value));
    }

    function handleItemMarkWatched(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemMarkWatched?.(getItem(value));
    }

    function handleItemAddToPlaylist(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemAddToPlaylist?.(getItem(value));
    }

    function handleItemWatchlist(value: UniversalMediaItem | CustomEvent<UniversalMediaItem>) {
        onitemWatchlist?.(getItem(value));
    }

    function handleClearAll() {
        onclearAll?.();
    }

    function handleFilterChange(e: Event) {
        const select = e.target as HTMLSelectElement;
        onfilterChange?.(select.value);
    }

    function handleIconDropdownChange(value: string) {
        onfilterChange?.(value);
    }

    /** Build a UniversalMediaItem from the section's source metadata,
     * or null when any required field is missing. Shared by the source
     * card's click and right-click handlers. */
    function buildSourceItem(): UniversalMediaItem | null {
        if (!meta.sourceExternalIds || !meta.sourceMediaType || !meta.sourceTitle) {
            return null;
        }
        return {
            id: mediaCompositeKey(meta.sourceExternalIds, meta.sourceMediaType, 'source'),
            externalIds: meta.sourceExternalIds,
            // Card vocabulary emits 'series'; the composite key above keeps the
            // raw sourceMediaType because it interpolates the token verbatim.
            mediaType: isSeries(meta.sourceMediaType) ? 'series' : 'movie',
            title: meta.sourceTitle,
            image: meta.sourceImage || FALLBACK_IMAGE,
            isAvailable: false, // We don't know availability, modal will fetch it
            canRequest: false,
        };
    }

    function handleSourceClick() {
        const sourceItem = buildSourceItem();
        if (!sourceItem) return;
        onitemClick?.(sourceItem);
    }

    // =========================================================================
    // Source-card right-click context menu
    // =========================================================================

    let sourceContextMenuPos = $state<{ x: number; y: number } | null>(null);
    let sourceContextMenuItem = $state<UniversalMediaItem | null>(null);
    let sourceRatingModalOpen = $state(false);
    let sourceFileInfoOpen = $state(false);
    let sourceModalTargetItem = $state<UniversalMediaItem | null>(null);

    let isSourceAdmin = $derived(isPageAdmin($page.data));

    let sourceMenuItems: ContextMenuEntry[] = $derived.by(() => {
        const target = sourceContextMenuItem;
        if (!target) return [];
        const out: ContextMenuEntry[] = [];
        out.push({
            label: m.card_open_details(),
            icon: InformationCircle,
            onSelect: () => onitemClick?.(target),
        });
        if (canWatchlistMedia(target)) {
            const targetKey = mediaCompositeKey(
                target.externalIds,
                isSeries(target.mediaType) ? 'tv' : 'movie',
            );
            const inWatchlist = $watchlistItems.some(
                (w) => mediaCompositeKey(w.externalIds, w.mediaType) === targetKey,
            );
            out.push({
                label: inWatchlist ? m.watchlist_remove() : m.watchlist_add(),
                icon: Bookmark,
                onSelect: () => {
                    void toggleWatchlistMedia(target, {
                        isInWatchlist: inWatchlist,
                    });
                },
            });
        }
        if (canRateMedia(target)) {
            out.push({
                kind: 'actions',
                actions: [
                    {
                        icon: HandThumbDown,
                        label: m.card_dislike(),
                        accent: 'negative',
                        onSelect: () => {
                            void quickRateMedia(target, 'dislike');
                        },
                    },
                    {
                        icon: HandThumbUp,
                        label: m.card_liked(),
                        accent: 'positive',
                        onSelect: () => {
                            void quickRateMedia(target, 'liked');
                        },
                    },
                    {
                        icon: Heart,
                        label: m.card_loved(),
                        accent: 'love',
                        onSelect: () => {
                            void quickRateMedia(target, 'loved');
                        },
                    },
                ],
            });
            out.push({
                label: m.card_rate_this(),
                icon: Star,
                onSelect: () => {
                    sourceModalTargetItem = target;
                    sourceRatingModalOpen = true;
                },
            });
        }
        if (buildMediaShareId(target) !== null) {
            out.push({
                label: m.card_copy_link(),
                icon: ClipboardDocument,
                onSelect: () => {
                    void copyMediaLink(target);
                },
            });
        }
        const isVideo =
            isMovie(target.mediaType) || isSeries(target.mediaType) || isEpisode(target.mediaType);
        if (isSourceAdmin && target.externalIds?.internal && isVideo) {
            out.push({
                label: m.card_file_info(),
                icon: DocumentMagnifyingGlass,
                hideOnMobile: true,
                onSelect: () => {
                    sourceModalTargetItem = target;
                    sourceFileInfoOpen = true;
                },
            });
            out.push({
                label: m.card_refresh_metadata(),
                icon: RefreshIcon,
                hideOnMobile: true,
                onSelect: () => {
                    void refreshMediaMetadata(target);
                },
            });
            out.push({
                label: m.card_open_in_admin(),
                icon: WrenchScrewdriver,
                hideOnMobile: true,
                onSelect: () => {
                    if (typeof window === 'undefined') return;
                    if (!target.externalIds?.internal) return;
                    window.open(
                        `/admin/library/media/${encodeURIComponent(target.externalIds.internal)}`,
                        '_blank',
                        'noopener,noreferrer',
                    );
                },
            });
        }
        return out;
    });

    function handleSourceContextMenu(e: MouseEvent): void {
        const sourceItem = buildSourceItem();
        if (!sourceItem) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, select, textarea')) return;
        e.preventDefault();
        e.stopPropagation();
        sourceContextMenuItem = sourceItem;
        sourceContextMenuPos = { x: e.clientX, y: e.clientY };
    }

    function closeSourceContextMenu(): void {
        sourceContextMenuPos = null;
        sourceContextMenuItem = null;
    }
    // =========================================================================
    // Computed Values
    // =========================================================================

    // Debug: Check for duplicate IDs
    $effect(() => {
        const ids = section.items.map((item) => item.itemKey ?? item.id);
        const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
        if (duplicates.length > 0) {
            console.error(`[StandardSection] Duplicate IDs in section "${section.id}":`, {
                duplicateIds: [...new SvelteSet(duplicates)],
                itemCount: section.items.length,
                sampleItems: section.items.slice(0, 3).map((i) => ({
                    id: i.id,
                    title: i.title,
                    key:
                        i.externalIds && i.mediaType
                            ? mediaCompositeKey(i.externalIds, i.mediaType)
                            : 'no-key',
                })),
            });
        }
    });
    let isCollapsible = $derived(meta.collapsible ?? false);
    let showRefresh = $derived(meta.showRefresh ?? false);
    let iconColor = $derived(meta.iconColor || 'text-primary-400');
    let accentColor = $derived(meta.accentColor || 'primary');
    let subtitle = $derived(meta.subtitle);
    let isLoading = $derived(meta.loading ?? false);
    let loadingFilters = $derived(meta.loadingFilters ?? false);
    let isSyncing = $derived(meta.syncing ?? false);
    let errorMessage = $derived(meta.error);
    let itemCount = $derived(meta.count ?? section.items.length);
    let filterGroups = $derived(meta.filterGroups || []);
    let filterPlaceholder = $derived(meta.filterPlaceholder || m.section_select());
    let activeFilter = $derived(meta.activeFilter || '');
    // Check if we have grouped filters (use IconDropdown)
    let hasGroupedFilters = $derived(filterGroups.length > 0);
    // Check if we have simple filters (use select)
    let hasSimpleFilters = $derived(meta.filters && meta.filters.length > 0 && !hasGroupedFilters);
    // Determine layout type
    let isCarousel = $derived(
        section.type === 'carousel' ||
            section.type === 'continue-watching' ||
            section.type === 'next-up',
    );
    let isGrid = $derived(section.type === 'grid');
    let rowCount = $derived(meta.rows ?? 1);
    let isMultiRowCarousel = $derived(isCarousel && rowCount > 1);
    // Determine card variant based on section type or meta override
    let resolvedCardVariant = $derived(
        cardVariant ||
            section.meta?.cardVariant ||
            (section.type === 'continue-watching' || section.type === 'next-up'
                ? 'backdrop'
                : 'poster'),
    );
    // Determine card width based on variant and aspect ratio
    let hasSquareItems = $derived(
        section.items.length > 0 && section.items[0].aspectRatio === 'square',
    );
    let resolvedCardWidth = $derived(
        cardWidthClass ||
            meta.cardWidthOverride ||
            (resolvedCardVariant === 'backdrop' ? 'w-44' : hasSquareItems ? 'w-36' : 'w-32'),
    );
    // Multi-row carousel uses `grid-auto-flow: column` with `grid-auto-columns: auto`,
    // which sizes each column to its widest content — i.e. the (often long) title text,
    // not the fixed-width cover. That strands the cover on the left with a big gap.
    // Pin the column width to the card width so columns match the cover; the title then
    // truncates within. Empty when the width class is unknown → falls back to `auto`.
    let multiRowColumnWidth = $derived(
        (
            {
                'w-20': '5rem',
                'w-24': '6rem',
                'w-28': '7rem',
                'w-32': '8rem',
                'w-36': '9rem',
                'w-40': '10rem',
                'w-44': '11rem',
                'w-48': '12rem',
            } as Record<string, string>
        )[resolvedCardWidth] ?? '',
    );
    // Show dismiss button for continue-watching, fulfilled-requests, and "because-*" sections
    let showDismiss = $derived(
        section.type === 'continue-watching' ||
            section.id === 'fulfilled-requests' ||
            section.id.startsWith('because-'),
    );
    // Always show dismiss in any of these sections — including CW. The
    // strip mixes paused items (progress > 0) with NextUp suggestions
    // (no progress), and the wrong NextUp episode is exactly the case
    // the user wants to dismiss. The
    // old progress-gate hid Hide on NextUp items, leaving the user no
    // way to drop them from the strip.
    let alwaysShowDismiss = $derived(
        section.type === 'continue-watching' ||
            section.id === 'fulfilled-requests' ||
            section.id.startsWith('because-'),
    );
    let isContinueWatching = $derived(section.type === 'continue-watching');
    // Show clear all button for continue-watching sections with items that have progress
    let showClearAll = $derived(
        section.type === 'continue-watching' &&
            section.items.some((item) => item.progress && item.progress > 0),
    );
    // Get icon component from icon-map
    // Get streaming icon component if activeFilter matches
    let streamingIconComponent = $derived(
        activeFilter && streamingIconMap[activeFilter] ? streamingIconMap[activeFilter] : null,
    );
    // Collapse handler with localStorage persistence
    let collapseHandler = $derived(
        meta.collapseKey ? createCollapseHandler(meta.collapseKey) : null,
    );
    // Get title - may be dynamic based on filter selection
    // Pass dependencies explicitly for Svelte reactivity
    let displayTitle = $derived(getDisplayTitle(activeFilter, filterGroups, section.title));
    let titleChunks = $derived(parseTitleChunks(displayTitle, meta.titleParts));
    // Media hover popup feature - enabled for poster and backdrop cards
    // Media hover popup - disabled on mobile (no hover on touch devices)
    let hoverPopupEnabled = $derived(
        !isMobile &&
            $page.data?.features?.mediaHoverPopup === true &&
            meta.hoverPopupEnabled !== false &&
            (resolvedCardVariant === 'poster' || resolvedCardVariant === 'backdrop'),
    );
    // Audio-only cards have no trailer or video preview, so they must never be
    // wrapped in MediaHoverCard — that would arm an irrelevant video hover surface.
    // Trailers in hover popup
    let hoverPopupTrailersEnabled = $derived(
        $page.data?.features?.mediaHoverPopupTrailers === true,
    );
    // Video preview in hover popup (admin feature AND the per-user opt-out toggle)
    let hoverPopupVideoPreviewEnabled = $derived(
        $page.data?.features?.mediaHoverVideoPreview === true && $posterHoverPreview,
    );
    // Live TV hover delay (longer delay to reduce accidental triggers)
    let liveTvHoverDelayMs = $derived(getLiveTvHoverDelayMs($page.data?.hover, 2500));
    // Hover delay before loading the trailer/preview video inside the popup
    let hoverVideoDelayMs = $derived(getVideoHoverDelayMs($page.data?.hover, 500));
    // Backdrop accent (for "Because you watched" sections)
    let hasBackdrop = $derived(!!meta.backdropUrl);
    // Optional "View all" / "More" link passed via meta.data.viewAllHref.
    // Genre carousels use this to link to the full genre browse page.
    let viewAllHref = $derived(
        typeof meta.data?.viewAllHref === 'string' ? (meta.data.viewAllHref as string) : null,
    );

    function handleCarouselScroll(event: Event): void {
        if (!onreachEnd) return;

        const node = event.currentTarget as HTMLElement | null;
        if (!node || node.scrollWidth <= node.clientWidth) return;

        const distanceFromEnd = node.scrollWidth - node.scrollLeft - node.clientWidth;
        if (distanceFromEnd > CAROUSEL_LOAD_MORE_THRESHOLD_PX) return;

        const now = Date.now();
        if (now - lastReachEndAt < 600) return;
        lastReachEndAt = now;
        onreachEnd();
    }
</script>

<section
    class="space-y-4 {hasBackdrop ? 'backdrop-accent-section' : ''}"
    class:has-backdrop={hasBackdrop}>
    <!-- Backdrop Accent (for "Because you watched" sections) -->
    {#if hasBackdrop && meta.backdropUrl}
        <div class="backdrop-accent-container">
            <div class="backdrop-image" style="background-image: url('{meta.backdropUrl}');"></div>
            <div class="backdrop-overlay"></div>
        </div>
    {/if}

    <!-- Section Header -->
    {#if section.title || hasGroupedFilters || headerControls}
        <div class="section-header-content">
            <div class="between group/section-header {headerControls ? 'flex-wrap gap-3' : ''}">
                <div class="flex items-center gap-3">
                    <!-- Icon: Streaming icon takes precedence when filter is selected -->
                    {#if streamingIconComponent}
                        {@const SvelteComponent = streamingIconComponent}
                        <SvelteComponent size="w-5 h-5" />
                    {:else if iconComponent}
                        <Icon src={iconComponent} class="h-5 w-5 {iconColor}" />
                    {/if}

                    <!-- Title (supports HTML for colored text spans). Rendered as
                         an <h2> so each carousel/grid is a labelled landmark in the
                         accessibility tree and screen-reader heading navigation can
                         jump between sections. -->
                    <h2
                        id={sectionHeadingId}
                        class="tracking-tight text-lg font-semibold text-gray-200 m-0">
                        {#each titleChunks as chunk, i (i)}
                            {#if chunk.tag === 'strong'}
                                <strong class={chunk.className}>{chunk.text}</strong>
                            {:else if chunk.tag === 'em'}
                                <em class={chunk.className}>{chunk.text}</em>
                            {:else if chunk.className}
                                <span class={chunk.className}>{chunk.text}</span>
                            {:else}
                                {chunk.text}
                            {/if}
                        {/each}
                        {#if subtitle && !hasGroupedFilters}
                            <span class="text-sm text-surface-400 ml-2">({subtitle})</span>
                        {/if}
                    </h2>

                    <!-- Item count badge -->
                    {#if itemCount > 0 && meta.count !== undefined}
                        <span
                            class="text-xs bg-{accentColor}-600 text-{accentColor}-100 px-2 py-0.5 rounded">
                            {itemCount}
                        </span>
                    {/if}
                </div>
                {#if headerControls}
                    <div class="order-3 w-full min-w-0 sm:order-none sm:w-auto">
                        {@render headerControls()}
                    </div>
                {/if}

                <!-- Header Actions -->
                <div class="flex items-center gap-2 {headerControls ? 'ml-auto' : ''}">
                    <!-- Grouped Filter Dropdown (IconDropdown) -->
                    {#if hasGroupedFilters}
                        <IconDropdown
                            value={activeFilter}
                            groups={filterGroups}
                            placeholder={filterPlaceholder}
                            disabled={loadingFilters}
                            onchange={handleIconDropdownChange} />
                    {/if}

                    <!-- Simple Filter Dropdown -->
                    {#if hasSimpleFilters && meta.filters}
                        <select
                            class="select select-sm bg-surface-700 border-surface-600 text-sm"
                            value={activeFilter}
                            onchange={handleFilterChange}>
                            {#each meta.filters as filter (filter.value)}
                                <option value={filter.value}>{filter.label}</option>
                            {/each}
                        </select>
                    {/if}

                    <!-- Clear All Button (for continue-watching) -->
                    {#if showClearAll}
                        <button
                            class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                            onclick={handleClearAll}
                            title={m.section_reset_progress()}
                            aria-label={m.section_reset_progress()}>
                            <Icon src={Trash} class="w-4 h-4 text-gray-400 hover:text-red-400" />
                        </button>
                    {/if}

                    <!-- Syncing indicator -->
                    {#if isSyncing}
                        <span class="text-xs text-surface-400 animate-pulse"
                            >{m.section_syncing()}</span>
                    {/if}

                    <!-- Refresh Button -->
                    {#if showRefresh}
                        <button
                            class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                            onclick={handleRefresh}
                            disabled={isRefreshing || isLoading}
                            title={m.section_refresh()}
                            aria-label={m.section_refresh()}>
                            <Icon
                                src={ArrowPath}
                                class="w-4 h-4 text-gray-400 hover:text-white {isRefreshing ||
                                isLoading
                                    ? 'animate-spin'
                                    : ''}" />
                        </button>
                    {/if}

                    <!-- Collapse Toggle -->
                    {#if isCollapsible}
                        <button
                            class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                            onclick={toggleCollapse}
                            title={isCollapsed ? m.section_expand() : m.section_collapse()}
                            aria-label={isCollapsed ? m.section_expand() : m.section_collapse()}>
                            <Icon
                                src={isCollapsed ? ChevronDown : ChevronUp}
                                class="w-4 h-4 text-gray-400 hover:text-white" />
                        </button>
                    {/if}

                    <!-- "More →" link when meta.data.viewAllHref is set (e.g. genre
                         carousels link to their full genre page). Always visible,
                         not hover-revealed: touch devices have no hover, and a
                         row's only way to its full grid must not depend on one. -->
                    {#if viewAllHref}
                        <a
                            href={resolve(viewAllHref)}
                            class="text-xs font-medium text-primary-400 hover:text-primary-300 whitespace-nowrap">
                            {m.section_show_more()} →
                        </a>
                    {/if}

                    <!-- "Load more" button: appends another batch of items inline
                         (in addition to the carousel's auto-load on reach-end). -->
                    {#if canLoadMore}
                        <button
                            class="flex items-center gap-1 text-xs font-medium text-primary-400 hover:text-primary-300 whitespace-nowrap disabled:cursor-default"
                            disabled={loadingMore}
                            onclick={() => onreachEnd?.()}>
                            {#if loadingMore}
                                <Icon src={ArrowPath} class="w-3.5 h-3.5 animate-spin" />
                                {m.section_loading_more()}
                            {:else}
                                {m.section_load_more()} →
                            {/if}
                        </button>
                    {/if}
                </div>
            </div>

            <!-- Optional "Inspired by" label for backdrop sections -->
            {#if hasBackdrop && meta.sourceTitle && meta.showSourceLabel}
                <div class="mt-2 ml-1">
                    <span class="text-xs text-surface-400">
                        Inspired by <span class="text-surface-300">{meta.sourceTitle}</span>
                    </span>
                </div>
            {/if}
        </div>
    {/if}

    <!-- Content -->
    {#if !isCollapsed}
        <!-- Loading State -->
        {#if isLoading && section.items.length === 0}
            {#if isMultiRowCarousel}
                <div
                    class="multi-row-carousel"
                    style="grid-template-rows: repeat({rowCount}, auto);">
                    {#each Array(rowCount * 6) as _, i (i)}
                        <div class="{resolvedCardWidth} shrink-0 animate-pulse">
                            <div class="aspect-square rounded-lg bg-surface-700"></div>
                            <div class="mt-2 space-y-1">
                                <div class="h-3 bg-surface-600 rounded w-3/4"></div>
                                <div class="h-2 bg-surface-600 rounded w-1/2"></div>
                            </div>
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="flex gap-3 overflow-hidden">
                    {#each Array(5) as _, i (i)}
                        <div class="{resolvedCardWidth} shrink-0 animate-pulse">
                            <div
                                class="{resolvedCardVariant === 'backdrop'
                                    ? 'aspect-video'
                                    : 'aspect-[2/3]'} rounded-lg bg-surface-700">
                            </div>
                            <div class="mt-2 px-1 space-y-2">
                                <div class="h-4 bg-surface-600 rounded w-3/4"></div>
                                <div class="h-3 bg-surface-600 rounded w-1/2"></div>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}

            <!-- Error State -->
        {:else if errorMessage}
            <div class="bg-error-500/20 border border-error-500 rounded-lg p-4">
                <p class="text-error-300 text-sm">{errorMessage}</p>
            </div>

            <!-- Empty State -->
        {:else if section.items.length === 0}
            {#if meta.emptyState}
                <div
                    class="flex flex-col sm:flex-row items-start sm:items-center gap-3 py-6 px-4 bg-surface-800/60 border border-surface-700 rounded-lg">
                    <p class="text-surface-300 text-sm flex-1">
                        {meta.emptyState.message}
                    </p>
                    {#if meta.emptyState.linkHref && meta.emptyState.linkLabel}
                        <a
                            href={meta.emptyState.linkHref}
                            class="btn btn-sm variant-ghost-primary hover:variant-filled-primary transition-colors whitespace-nowrap">
                            {meta.emptyState.linkLabel} →
                        </a>
                    {/if}
                </div>
            {:else}
                <div class="text-center py-8 text-gray-500">
                    <p>{m.section_no_content_available()}</p>
                </div>
            {/if}

            <!-- Multi-Row Carousel Layout -->
        {:else if isMultiRowCarousel}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
            <div
                class="multi-row-carousel pb-4 smooth-scroll carousel-scroll"
                style="grid-template-rows: repeat({rowCount}, auto);{multiRowColumnWidth
                    ? ` grid-auto-columns: ${multiRowColumnWidth};`
                    : ''}"
                role="region"
                aria-labelledby={section.title ? sectionHeadingId : undefined}
                aria-label={section.title ? undefined : m.section_media_carousel()}
                tabindex="0"
                onkeydown={handleCarouselKeydown}
                onscroll={handleCarouselScroll}
                use:dragScroll>
                {#each section.items as item, index (renderItemKeys[index])}
                    <UniversalMediaCard
                        {item}
                        variant={resolvedCardVariant}
                        widthClass={resolvedCardWidth}
                        {accentColor}
                        {showDismiss}
                        {alwaysShowDismiss}
                        continueWatching={isContinueWatching}
                        {hasRequestPermission}
                        showDamperAction={damperAware}
                        {showAddButton}
                        {showWatchlistButton}
                        {watchlistItemKeys}
                        {watchlistLoadingKeys}
                        {playlistItemKeys}
                        priority={index < priorityCount}
                        onclick={handleItemClick}
                        onplay={handleItemPlay}
                        onrequest={handleItemRequest}
                        onmore={handleItemMore}
                        onremove={handleItemRemove}
                        onmarkWatched={handleItemMarkWatched}
                        onaddToPlaylist={handleItemAddToPlaylist}
                        onwatchlist={handleItemWatchlist} />
                {/each}
            </div>

            <!-- Carousel Layout -->
        {:else if isCarousel}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
            <div
                class="flex gap-3 overflow-x-auto pb-4 smooth-scroll carousel-scroll"
                role="region"
                aria-labelledby={section.title ? sectionHeadingId : undefined}
                aria-label={section.title ? undefined : m.section_media_carousel()}
                tabindex="0"
                onkeydown={handleCarouselKeydown}
                onscroll={handleCarouselScroll}
                use:dragScroll>
                <!-- Source Poster Card (for "Because you watched" sections) -->
                {#if hasBackdrop && meta.sourceImage}
                    <div
                        class="source-card-container w-32 shrink-0 cursor-pointer"
                        onclick={() => handleSourceClick()}
                        onkeydown={(e) =>
                            (e.key === 'Enter' || e.key === ' ') && handleSourceClick()}
                        oncontextmenu={handleSourceContextMenu}
                        role="button"
                        tabindex="0">
                        <img
                            src={meta.sourceImage}
                            alt={meta.sourceTitle || ''}
                            class="source-poster-card w-32 h-48"
                            title={meta.sourceTitle || ''}
                            loading="lazy"
                            decoding="async"
                            use:fallbackImage={FALLBACK_IMAGE} />
                        <div class="source-card-label">
                            <span class="source-label-text">{m.section_based_on_this()}</span>
                        </div>
                        {#if meta.sourceTitle}
                            <p class="font-heading text-sm text-white truncate mt-1">
                                {meta.sourceTitle}
                            </p>
                        {/if}
                    </div>
                {/if}

                {#each section.items as item, index (renderItemKeys[index])}
                    {#if hoverPopupEnabled && canWrapMediaHoverCard(item)}
                        <MediaHoverCard
                            {item}
                            {hasRequestPermission}
                            showDamperAction={damperAware}
                            trailersEnabled={hoverPopupTrailersEnabled}
                            videoPreviewEnabled={hoverPopupVideoPreviewEnabled}
                            videoLoadDelay={hoverVideoDelayMs}
                            delay={item.id.startsWith('channel-') ? liveTvHoverDelayMs : undefined}
                            onplay={handleItemPlay}
                            onrequest={handleItemRequest}
                            onmore={handleItemMore}
                            onclick={handleItemClick}
                            onhide={isContinueWatching ? handleItemRemove : undefined}>
                            <UniversalMediaCard
                                {item}
                                variant={resolvedCardVariant}
                                layout="carousel"
                                widthClass={resolvedCardWidth}
                                {accentColor}
                                {showDismiss}
                                {alwaysShowDismiss}
                                continueWatching={isContinueWatching}
                                {hasRequestPermission}
                                showDamperAction={damperAware}
                                {showAddButton}
                                {showWatchlistButton}
                                {watchlistItemKeys}
                                {watchlistLoadingKeys}
                                {playlistItemKeys}
                                priority={index < priorityCount}
                                onclick={handleItemClick}
                                onplay={handleItemPlay}
                                onrequest={handleItemRequest}
                                onmore={handleItemMore}
                                onremove={handleItemRemove}
                                onmarkWatched={handleItemMarkWatched}
                                onaddToPlaylist={handleItemAddToPlaylist}
                                onwatchlist={handleItemWatchlist} />
                        </MediaHoverCard>
                    {:else}
                        <UniversalMediaCard
                            {item}
                            variant={resolvedCardVariant}
                            layout="carousel"
                            widthClass={resolvedCardWidth}
                            {accentColor}
                            {showDismiss}
                            {alwaysShowDismiss}
                            continueWatching={isContinueWatching}
                            {hasRequestPermission}
                            showDamperAction={damperAware}
                            {showAddButton}
                            {showWatchlistButton}
                            {watchlistItemKeys}
                            {watchlistLoadingKeys}
                            {playlistItemKeys}
                            priority={index < priorityCount}
                            onclick={handleItemClick}
                            onplay={handleItemPlay}
                            onrequest={handleItemRequest}
                            onmore={handleItemMore}
                            onremove={handleItemRemove}
                            onmarkWatched={handleItemMarkWatched}
                            onaddToPlaylist={handleItemAddToPlaylist}
                            onwatchlist={handleItemWatchlist} />
                    {/if}
                {/each}
            </div>

            <!-- Grid Layout -->
        {:else if isGrid}
            <div
                class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {#each section.items as item, index (renderItemKeys[index])}
                    {#if hoverPopupEnabled && canWrapMediaHoverCard(item)}
                        <MediaHoverCard
                            {item}
                            {hasRequestPermission}
                            showDamperAction={damperAware}
                            trailersEnabled={hoverPopupTrailersEnabled}
                            videoPreviewEnabled={hoverPopupVideoPreviewEnabled}
                            videoLoadDelay={hoverVideoDelayMs}
                            delay={item.id.startsWith('channel-') ? liveTvHoverDelayMs : undefined}
                            onplay={handleItemPlay}
                            onrequest={handleItemRequest}
                            onmore={handleItemMore}
                            onclick={handleItemClick}
                            onhide={isContinueWatching ? handleItemRemove : undefined}>
                            <UniversalMediaCard
                                {item}
                                variant={resolvedCardVariant}
                                layout="grid"
                                widthClass="w-full"
                                {accentColor}
                                {showDismiss}
                                {alwaysShowDismiss}
                                continueWatching={isContinueWatching}
                                {hasRequestPermission}
                                showDamperAction={damperAware}
                                {showAddButton}
                                {showWatchlistButton}
                                {watchlistItemKeys}
                                {watchlistLoadingKeys}
                                {playlistItemKeys}
                                priority={index < priorityCount}
                                onclick={handleItemClick}
                                onplay={handleItemPlay}
                                onrequest={handleItemRequest}
                                onmore={handleItemMore}
                                onremove={handleItemRemove}
                                onmarkWatched={handleItemMarkWatched}
                                onaddToPlaylist={handleItemAddToPlaylist}
                                onwatchlist={handleItemWatchlist} />
                        </MediaHoverCard>
                    {:else}
                        <UniversalMediaCard
                            {item}
                            variant={resolvedCardVariant}
                            layout="grid"
                            widthClass="w-full"
                            {accentColor}
                            {showDismiss}
                            {alwaysShowDismiss}
                            continueWatching={isContinueWatching}
                            {hasRequestPermission}
                            showDamperAction={damperAware}
                            {showAddButton}
                            {showWatchlistButton}
                            {watchlistItemKeys}
                            {watchlistLoadingKeys}
                            {playlistItemKeys}
                            priority={index < priorityCount}
                            onclick={handleItemClick}
                            onplay={handleItemPlay}
                            onrequest={handleItemRequest}
                            onmore={handleItemMore}
                            onremove={handleItemRemove}
                            onmarkWatched={handleItemMarkWatched}
                            onaddToPlaylist={handleItemAddToPlaylist}
                            onwatchlist={handleItemWatchlist} />
                    {/if}
                {/each}
            </div>
        {/if}
    {/if}
</section>

{#if sourceContextMenuPos && sourceContextMenuItem}
    <ContextMenu
        x={sourceContextMenuPos.x}
        y={sourceContextMenuPos.y}
        title={sourceContextMenuItem.title}
        items={sourceMenuItems}
        onClose={closeSourceContextMenu} />
{/if}

{#if sourceRatingModalOpen && sourceModalTargetItem}
    <RatingPickerModal
        open={sourceRatingModalOpen}
        title={sourceModalTargetItem.title}
        externalIds={sourceModalTargetItem.externalIds}
        mediaType={isSeries(sourceModalTargetItem.mediaType) ? 'tv' : 'movie'}
        onClose={() => (sourceRatingModalOpen = false)} />
{/if}

{#if sourceFileInfoOpen && sourceModalTargetItem?.externalIds?.internal}
    <MediaFileInfoModal
        open={sourceFileInfoOpen}
        mediaId={sourceModalTargetItem.externalIds.internal}
        includeChildren={isSeries(sourceModalTargetItem.mediaType)}
        title={sourceModalTargetItem.title}
        onClose={() => (sourceFileInfoOpen = false)} />
{/if}

<style lang="postcss">
    /* Override global scrollbar for subtle appearance in carousels */
    .smooth-scroll {
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }

    .smooth-scroll::-webkit-scrollbar {
        height: 6px;
    }

    .smooth-scroll::-webkit-scrollbar-track {
        background: transparent;
    }

    .smooth-scroll::-webkit-scrollbar-thumb {
        background-color: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
    }

    .smooth-scroll::-webkit-scrollbar-thumb:hover {
        background-color: rgba(255, 255, 255, 0.3);
    }

    .multi-row-carousel {
        display: grid;
        grid-auto-flow: column;
        gap: 0.75rem;
        overflow-x: auto;
    }

    /* Horizontal scroll-snap for carousels: cards settle on a clean left edge
       when scrolled (mouse, touch, or keyboard Arrow/Home/End). proximity (not
       mandatory) keeps free-scroll/drag from feeling sticky. A visible focus
       ring marks the scroller as a focusable group for keyboard users. */
    .carousel-scroll {
        scroll-snap-type: x proximity;
        scroll-padding-left: 0.25rem;
        /* The home page stacks ~20 of these rows (~6k nodes, 16 screens tall).
           Offscreen tracks skip style/layout/paint — and their loading
           shimmers stop animating. Set on the track, not the <section>: the
           containment clips overflow, which the track (an overflow-x scroller)
           already does, while the section's backdrop overhangs its box.
           `auto` remembers the last rendered height, so nothing jumps. */
        content-visibility: auto;
        contain-intrinsic-block-size: auto 280px;
    }

    .carousel-scroll > :global(*) {
        scroll-snap-align: start;
    }

    .carousel-scroll:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
        border-radius: 0.5rem;
    }

    /* Backdrop Accent for "Because you watched" sections */
    .backdrop-accent-section {
        position: relative;
        isolation: isolate;
    }

    .backdrop-accent-section.has-backdrop {
        padding: 1.5rem 0; /* Extra vertical padding for emphasis */
    }

    .backdrop-accent-container {
        position: absolute;
        top: 0;
        left: -2rem; /* Extend to edges of container */
        right: -2rem;
        bottom: 0;
        z-index: -1;
        overflow: hidden;
        border-radius: 0.75rem;
        pointer-events: none;
    }

    .backdrop-image {
        position: absolute;
        inset: 0;
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        /* Minimal blur for clarity, slight desaturation for subtlety */
        filter: blur(2px) saturate(0.8);
        transform: scale(1.01);
        opacity: 0.35; /* More visible */
        /* Horizontal fade - visible on left, fades to transparent on right */
        mask-image: linear-gradient(
            to right,
            rgba(0, 0, 0, 1) 0%,
            rgba(0, 0, 0, 1) 30%,
            rgba(0, 0, 0, 0.8) 50%,
            rgba(0, 0, 0, 0.5) 70%,
            rgba(0, 0, 0, 0.2) 85%,
            rgba(0, 0, 0, 0) 100%
        );
        -webkit-mask-image: linear-gradient(
            to right,
            rgba(0, 0, 0, 1) 0%,
            rgba(0, 0, 0, 1) 30%,
            rgba(0, 0, 0, 0.8) 50%,
            rgba(0, 0, 0, 0.5) 70%,
            rgba(0, 0, 0, 0.2) 85%,
            rgba(0, 0, 0, 0) 100%
        );
    }

    .backdrop-overlay {
        /* Left-side gradient for text readability, fades completely on right */
        position: absolute;
        inset: 0;
        background: linear-gradient(
            to right,
            rgba(0, 0, 0, 0.7) 0%,
            rgba(0, 0, 0, 0.5) 15%,
            rgba(0, 0, 0, 0.3) 30%,
            rgba(0, 0, 0, 0.15) 50%,
            rgba(0, 0, 0, 0.05) 70%,
            rgba(0, 0, 0, 0) 85%
        );
        pointer-events: none;
    }

    /* Fix 3: Stronger header with more contrast and padding */
    .section-header-content {
        position: relative;
        z-index: 1;
    }

    /* The draggable mobile nav toggle (Sidebar.svelte's `.mobile-toggle`) rests
       `fixed` in the top-right corner (top/right: 1rem, 40px circle) and floats
       over scrolled content by design — but a section header's OWN action
       icons (filter dropdown, "load more", etc.) sitting in that exact corner
       become unreachable behind it. Reserve that corner on narrow viewports
       (where the toggle exists) so header actions never land under it. */
    @media (max-width: 767px) {
        .section-header-content {
            padding-right: 3rem;
        }
    }

    /* Enhanced header for backdrop sections - fades left to right quickly */
    .has-backdrop .section-header-content {
        padding: 0.75rem 1rem;
        margin: -0.75rem -1rem 0.5rem;
        background: linear-gradient(
            to right,
            rgba(0, 0, 0, 0.6) 0%,
            rgba(0, 0, 0, 0.4) 15%,
            rgba(0, 0, 0, 0.2) 25%,
            rgba(0, 0, 0, 0.05) 35%,
            rgba(0, 0, 0, 0) 45%
        );
        border-radius: 0.5rem 0.5rem 0 0;
    }

    /* Source poster card in carousel - matches carousel card size */
    .source-card-container {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .source-poster-card {
        object-fit: cover;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.7);
        opacity: 1;
        border: 2px solid rgba(255, 255, 255, 0.3);
        transition:
            transform 0.2s ease,
            box-shadow 0.2s ease,
            border-color 0.2s ease;
    }

    .source-poster-card:hover {
        transform: scale(1.03);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.9);
        border-color: rgba(255, 255, 255, 0.5);
    }

    .source-card-label {
        text-align: center;
        margin-top: 0.25rem;
    }

    .source-label-text {
        font-size: 0.625rem; /* text-xs */
        color: rgb(148 163 184); /* text-slate-400 */
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
</style>
