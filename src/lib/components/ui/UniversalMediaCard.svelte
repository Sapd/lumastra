<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	UniversalMediaCard.svelte

	A unified media card component for Server-Driven UI architecture.
	Supports three variants: poster, backdrop, and list layouts.

	Slots:
	- footer: Content below the image (e.g., user avatars)
	- actions: Action buttons for list variant
	- overlay: Custom hover overlay content for backdrop variant (replaces default play button)

	@example Poster Card (default)
	<UniversalMediaCard {item} onclick={handleClick} onplay={handlePlay} />

	@example Backdrop Card (for Continue Watching/Next Up)
	<UniversalMediaCard {item} variant="backdrop" onclick={handleClick} />

	@example Backdrop with Custom Overlay (for Live Sessions)
	<UniversalMediaCard {item} variant="backdrop">
		<svelte:fragment slot="overlay">
			<div class="text-xs text-white">Technical info here</div>
		</svelte:fragment>
		<svelte:fragment slot="footer">
			<div class="user-avatar">...</div>
		</svelte:fragment>
	</UniversalMediaCard>

	@example List View (for Search Results/Watchlist)
	<UniversalMediaCard {item} variant="list">
		<svelte:fragment slot="actions">
			<button>Remove</button>
		</svelte:fragment>
	</UniversalMediaCard>
-->
<script module lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    import { safeHighlightedSnippet } from '$lib/utils/highlighted-snippet';
    import { MediaQuery } from 'svelte/reactivity';

    // Singleton tracker so opening one card's context menu closes any other
    // card's open menu. Keeps multi-card stacking from happening when a user
    // opens a second card's actions without dismissing the first.
    let activeContextMenuClose: (() => void) | null = null;

    // Shared hover-capability query, reused by every card instance instead of
    // each card creating its own `matchMedia('(hover: hover)')` listener.
    // `MediaQuery` resolves to an SSR-safe stub server-side (fallback `true`,
    // matching this component's previous default) and to the real
    // browser-backed reactive value on the client. Its `change` listener is
    // itself ref-counted across every subscriber (see svelte/reactivity's
    // `createSubscriber`), so N cards reading `.current` still add exactly one
    // listener — not N.
    //
    // Constructed LAZILY (on first use, not at module-evaluation time): the
    // `MediaQuery` constructor calls `window.matchMedia` immediately, and a
    // module-top-level `new MediaQuery(...)` would run that at import time —
    // before a test's `beforeEach` gets a chance to stub `window.matchMedia`
    // (see UniversalMediaCard.context-menu-touch.test.ts). Memoizing on first
    // access still yields exactly one instance shared by every card.
    let hoverQuery: MediaQuery | undefined;
    function getHoverQuery(): MediaQuery {
        return (hoverQuery ??= new MediaQuery('hover: hover', true));
    }
</script>

<script lang="ts">
    import { SvelteSet, SvelteDate } from 'svelte/reactivity';
    import { tick } from 'svelte';

    import {
        Icon,
        Sparkles,
        DocumentPlus,
        XMark,
        Check,
        CheckCircle,
        Bookmark,
        PlayCircle,
        QueueList,
        ChevronDoubleRight,
        UserCircle,
        Radio,
        MusicalNote,
        BookOpen,
        HandThumbDown,
        EllipsisVertical,
        ExclamationTriangle,
        ListBullet,
        ClipboardDocument,
        ArrowUturnLeft,
        InformationCircle,
        Star,
        DocumentMagnifyingGlass,
        ArrowPath,
        HandThumbUp,
        Heart,
        WrenchScrewdriver,
        ArrowRight,
        Beaker,
        NoSymbol,
        EyeSlash,
        Tv,
        Film,
    } from 'svelte-hero-icons';
    import { addToPlaylistEntry } from '$lib/components/playlist/add-to-playlist-menu';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from './context-menu-types';
    import SetSeriesProgressModal from '$lib/components/modal/SetSeriesProgressModal.svelte';
    import RatingPickerModal from '$lib/components/modal/RatingPickerModal.svelte';
    import MediaFileInfoModal from '$lib/components/modal/MediaFileInfoModal.svelte';
    import WhyHereModal from '$lib/components/modal/WhyHereModal.svelte';
    import {
        isPageAdmin,
        setEpisodeWatchState,
        markMediaUnwatched as markMediaUnwatchedShared,
        refreshMediaMetadata as refreshMediaMetadataShared,
        copyMediaLink as copyMediaLinkShared,
        toggleWatchlistMedia,
        canWatchlistMedia,
        canRateMedia,
        quickRateMedia,
        buildMediaShareId,
    } from '$lib/utils/media-context-actions';
    import { watchlistItems } from '$lib/stores/watchlist';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import type { UniversalMediaItem, CardVariant, Badge } from '$lib/types/server-driven-ui';
    import { getBadgeVariant } from '$lib/types/server-driven-ui';
    import { getIcon } from '$lib/utils/icon-map';
    import { getEpisodeKey } from '$lib/utils/media-types';
    import BrandedPlayIcon from '$lib/icons/BrandedPlayIcon.svelte';
    import BrandedRequestIcon from '$lib/icons/BrandedRequestIcon.svelte';
    import TrackTitleLine from '$lib/components/music/TrackTitleLine.svelte';
    import MalIcon from '$lib/icons/MalIcon.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import Skeleton from '$lib/components/ui/Skeleton.svelte';
    import * as m from '$lib/paraglide/messages';
    import { isSeason } from '$lib/shared/media-types';
    import { formatSeriesCounts, seriesCountBadge } from '$lib/utils/series-episode-counts';
    import { getCwDismissDisplayName } from '$lib/utils/cw-dismiss-helper';
    import {
        isSeries,
        isEpisode,
        isMovie,
        isAudiobook,
        isAudio,
        isTrack,
        isMusicType,
        isNonEntertainment,
        isTvChannel,
        isBookMediaType,
    } from '$lib/shared/media-types';
    import { toMovieOrSeries } from '$lib/shared/media-type-domain';
    import { prefetchSimilar } from '$lib/utils/similar-prefetch';
    import {
        getLibraryTypeTemplate,
        renderSubtitleTemplate,
    } from '$lib/shared/library-type-templates';
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import { resolve } from '$lib/paths';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import { blurhashToDataUrl } from '$lib/utils/blurhash-css';
    import {
        getCatalogBackdropSrcSet,
        getCatalogPosterSrcSet,
        getCatalogThumbSrcSet,
    } from '$lib/utils/image-utils';
    import { requireValue } from '$lib/utils/runtime-validation';
    import { UUID_RE_LOOSE } from '$lib/utils/id-patterns';
    import { posterSizesFor, backdropSizesFor } from './media-card-sizes';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The media item data */
        item: UniversalMediaItem;
        /** Card layout variant */
        variant?: CardVariant;
        /**
         * Which layout this card is rendered in. Distinct from `variant`, which is
         * the content-type axis (poster / backdrop / list). Only `sizes` depends on
         * this: a carousel card is far narrower than a grid card, so sharing one
         * `sizes` string made the browser pick a srcset candidate about twice the
         * width it would ever display.
         *
         * Defaults to 'grid' deliberately: 'grid' declares the LARGER width, so a
         * call site that does not pass this keeps exactly today's behaviour and can
         * never under-declare. Under-declaring is the dangerous direction — it makes
         * images blurry; over-declaring only wastes bytes.
         */
        layout?: 'carousel' | 'grid';
        /** Priority loading for LCP optimization */
        priority?: boolean;
        /** Custom width class (overrides default) */
        widthClass?: string;
        /** Show the "More/Similar" button on hover */
        showMoreButton?: boolean;
        /**
         * Show the "show less like this" (taste-damper) context-menu action.
         * Off by default — only the surfaces whose ranking actually consumes the
         * damper set it true (For-You anime/short/you-like/mood rows), so the
         * action never appears where it would have no local effect.
         */
        showDamperAction?: boolean;
        /** Accent color for hover effects (Tailwind color name without prefix) */
        accentColor?: string;
        /** Show dismiss/remove button (for continue watching cards) */
        showDismiss?: boolean;
        /** Always show dismiss button, even without progress (for fulfilled requests) */
        alwaysShowDismiss?: boolean;
        /** The card sits in the Continue Watching row, so dismiss means
         *  "hide from Continue Watching" and is labelled that way. */
        continueWatching?: boolean;
        /** Show "Add to Playlist" button (for playlist mode in search) */
        showSeriesCountBadge?: boolean;
        showAddButton?: boolean;
        /** Show "Add to Watchlist" bookmark button */
        showWatchlistButton?: boolean;
        /** Set of composite keys for items currently in the watchlist (for toggle state) */
        watchlistItemKeys?: Set<string>;
        /** Set of composite keys for items currently being saved/removed (for loading state) */
        watchlistLoadingKeys?: Set<string>;
        /** Set of item keys that are already in the playlist (for "Added" state) */
        playlistItemKeys?: Set<string>;
        /** Whether the user has permission to make requests (hides request button if false) */
        hasRequestPermission?: boolean;
        footer?: import('svelte').Snippet;
        overlay?: import('svelte').Snippet<[{ isHovered: boolean }]>;
        actions?: import('svelte').Snippet;
        /** Callback when card is clicked */
        onclick?: (item: UniversalMediaItem) => void;
        /** Callback when play button is clicked */
        onplay?: (item: UniversalMediaItem) => void;
        /** Callback when request button is clicked */
        onrequest?: (item: UniversalMediaItem) => void;
        /** Callback when more/similar button is clicked */
        onmore?: (item: UniversalMediaItem) => void;
        /** Callback when remove/dismiss button is clicked */
        onremove?: (item: UniversalMediaItem) => void;
        /**
         * Callback when the "Mark as watched" menu action is selected.
         * Distinct from `onremove` — remove/dismiss hides the card without
         * asserting the user finished the content, while mark-watched
         * records a deliberate "I watched this" intent.
         */
        onmarkWatched?: (item: UniversalMediaItem) => void;
        /** Callback when add to playlist button is clicked */
        onaddToPlaylist?: (item: UniversalMediaItem) => void;
        /** Callback when watchlist bookmark button is clicked */
        onwatchlist?: (item: UniversalMediaItem) => void;
    }

    let {
        item,
        variant = 'poster',
        layout = 'grid',
        priority = false,
        widthClass = '',
        showMoreButton = true,
        showDamperAction = false,
        accentColor = 'primary',
        showDismiss = false,
        alwaysShowDismiss = false,
        continueWatching = false,
        showSeriesCountBadge = false,
        showAddButton = false,
        showWatchlistButton = false,
        watchlistItemKeys = new SvelteSet(),
        watchlistLoadingKeys = new SvelteSet(),
        playlistItemKeys = new SvelteSet(),
        hasRequestPermission = true,
        footer,
        overlay,
        actions,
        onclick,
        onplay,
        onrequest,
        onmore,
        onremove,
        onmarkWatched,
        onaddToPlaylist,
        onwatchlist,
    }: Props = $props();

    // =========================================================================
    // Internal State
    // =========================================================================

    let isPointerHovered = $state(false);
    let hasFocusWithin = $state(false);
    let isHovered = $derived(isPointerHovered || hasFocusWithin);
    /** Pointer dwell on a card before its Similar row is prefetched. */
    const SIMILAR_PREFETCH_DWELL_MS = 250;
    let imageError = $state(false);
    // Fade the poster in once it decodes. Until then a shimmer placeholder
    // occupies the (aspect-ratio-reserved) image box, so cards without a
    // blurhash — e.g. every music track / album / artist cover — don't flash
    // a wall of empty rectangles while lazy images stream in. Items that carry
    // a blurhash already show that as the placeholder, so they skip the fade.
    let imageLoaded = $state(false);
    let posterImgEl: HTMLImageElement | undefined = $state();

    // Touch vs mouse: only paint hover overlay on devices with a real hover
    // capability. On touch screens the first tap synthesizes mouseenter, which
    // would otherwise trigger a sticky hover state and force a second tap to
    // reach the play button.
    // Read from the shared module-level hover query (declared above) instead
    // of creating a per-card `matchMedia('(hover: hover)')` listener. Kept as
    // an `$effect` (rather than a `$derived`) so the sync happens post-mount,
    // matching the previous timing exactly: SSR and the first client render
    // both use the `true` fallback, and the real value is applied only after
    // hydration. `showTouchContextButton` below branches an `{#if}` on
    // `hasHover`; deriving it eagerly would let that branch flip mid-hydration
    // instead of after mount, same as before this change.
    // eslint-disable-next-line svelte/prefer-writable-derived -- deliberate: see comment above.
    let hasHover = $state(true);
    $effect(() => {
        hasHover = getHoverQuery().current;
    });

    // A cached poster can already be `complete` before `onload` binds, so the
    // event never fires and the shimmer would linger forever. Flip the flag on
    // bind when the image is already decoded.
    $effect(() => {
        if (posterImgEl?.complete && posterImgEl.naturalWidth > 0) imageLoaded = true;
    });

    const CONTEXT_BUTTON_MOVE_THRESHOLD = 14;

    // Context menu state: opened by right-click (desktop) or the ⋯ button (touch)
    let contextMenuPos = $state<{ x: number; y: number } | null>(null);
    let contextMenuTrigger = $state<HTMLButtonElement | undefined>();
    const contextMenuId = $props.id();

    // Context-menu entries, built lazily on open (see buildMenuItems below).
    // Stays empty until the first open so idle cards pay no construction cost;
    // rebuilt on every open so entries always reflect current reactive state.
    let menuItemsCache = $state<ContextMenuEntry[]>([]);

    // "Set my progress" picker — opened from the context menu for series/
    // episode cards in CW. Self-contained so the host page doesn't need to
    // plumb a callback through StandardSection / SectionRenderer just to
    // render a modal it doesn't otherwise care about.
    let setProgressOpen = $state(false);

    // Inline rating picker — opened from the context menu, mounted only
    // while open so 30+ idle cards on a page don't each pay for an
    // unmounted modal scaffold.
    let ratingModalOpen = $state(false);
    let fileInfoModalOpen = $state(false);
    let whyHereOpen = $state(false);

    let isCardAdmin = $derived(isPageAdmin($page.data));
    let sonicEnabled = $derived($page.data?.features?.sonicEmbeddings === true);
    let alchemyEnabled = $derived($page.data?.features?.musicAlchemy === true);
    // Track cards are HTML5-draggable so they can be dropped into the queue or
    // any visible Music Alchemy pad. The drag payload is ignored by non-music
    // drop targets, so this can stay enabled even when the Alchemy dock is
    // collapsed.
    let trackDragEnabled = $derived(isTrack(item.mediaType));
    let trackDragInProgress = $state(false);
    let suppressContextMenuUntil = $state(0);
    let suppressContextButtonClickUntil = $state(0);
    let contextButtonTouchStart = $state<{ x: number; y: number } | null>(null);
    let contextButtonTouchMoved = $state(false);
    // Episode cards point at their parent series via item.seriesId; bare
    // series cards (rare in CW, but possible) target their own internal id.
    let setProgressSeriesId = $derived(
        isEpisode(item.mediaType)
            ? item.seriesId
            : isSeries(item.mediaType)
              ? item.externalIds?.internal
              : undefined,
    );
    let setProgressSeriesTitle = $derived(item.seriesName ?? item.title ?? '');

    function openContextMenu(x: number, y: number, prebuilt?: ContextMenuEntry[]): void {
        // Build the menu lazily — only when it's actually about to open — so
        // idle cards never pay for the (~400-line) construction. Callers that
        // already built the array (native context menu) pass it via `prebuilt`
        // to avoid a second build.
        const items = prebuilt ?? buildMenuItems();
        if (items.length === 0) return;
        menuItemsCache = items;
        // Close any other card's open menu first, then claim the singleton.
        if (activeContextMenuClose && activeContextMenuClose !== closeContextMenu) {
            activeContextMenuClose();
        }
        activeContextMenuClose = closeContextMenu;
        contextMenuPos = { x, y };
    }

    function closeContextMenu(): void {
        // A portaled menu can own keyboard focus. Return it before removing
        // the menu so closing with Escape doesn't lose the user's place.
        const restoreFocus =
            document.getElementById(contextMenuId)?.contains(document.activeElement) ||
            document.getElementById(`${contextMenuId}-submenu`)?.contains(document.activeElement);
        if (restoreFocus) contextMenuTrigger?.focus();
        contextMenuPos = null;
        if (activeContextMenuClose === closeContextMenu) {
            activeContextMenuClose = null;
        }
    }

    function suppressContextMenuBriefly(): void {
        suppressContextMenuUntil = Date.now() + 500;
    }

    // If the card unmounts while still holding the singleton, release it so
    // future cards can open menus.
    $effect(() => {
        return () => {
            if (activeContextMenuClose === closeContextMenu) {
                activeContextMenuClose = null;
            }
        };
    });

    function handleNativeContextMenu(e: MouseEvent): void {
        // Touch browsers synthesize `contextmenu` after a stationary press.
        // The touch UI has an explicit ⋯ button, so never let a press on the
        // poster body open either our menu or the browser's native menu.
        if (!hasHover) {
            e.preventDefault();
            return;
        }
        if (trackDragInProgress || Date.now() < suppressContextMenuUntil) {
            e.preventDefault();
            return;
        }
        // Right-click on an inner button (dismiss / play / queue) should
        // surface the browser's native menu for that control rather than
        // hijacking it for the card's context menu.
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, a, input, select, textarea')) {
            return;
        }
        // Build once here so we can decide whether to suppress the native
        // menu: an empty card menu must let the browser's own menu through
        // (so we must not preventDefault before we know it's non-empty).
        const items = buildMenuItems();
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, items);
    }

    function handleContextMenuButton(e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < suppressContextButtonClickUntil) return;
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        openContextMenu(rect.left + rect.width / 2, rect.bottom + 4);
        if (e.detail === 0) {
            // Enter/Space activation should land directly in the menu.
            void tick().then(() => {
                document
                    .getElementById(contextMenuId)
                    ?.querySelector<HTMLElement>('[role="menuitem"]')
                    ?.focus();
            });
        }
    }

    /**
     * Click handler for the "auto-marked?" warning indicator. Opens the same
     * context menu the ⋯ / right-click flow uses so the user can confirm
     * (mark watched) or reject (hide) without an admin-level repudiation.
     * Anchors the menu below the indicator so it doesn't cover the card.
     */
    function handleSuspicionIndicator(e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        openContextMenu(rect.left + rect.width / 2, rect.bottom + 4);
    }

    function handleContextMenuButtonTouchEnd(e: TouchEvent): void {
        e.preventDefault();
        e.stopPropagation();
        if (contextButtonTouchMoved) {
            suppressContextMenuBriefly();
            suppressContextButtonClickUntil = Date.now() + 500;
            contextButtonTouchStart = null;
            contextButtonTouchMoved = false;
            return;
        }
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        contextButtonTouchStart = null;
        contextButtonTouchMoved = false;
        openContextMenu(rect.left + rect.width / 2, rect.bottom + 4);
    }

    function handleContextMenuButtonTouchStart(e: TouchEvent): void {
        e.stopPropagation();
        const touch = e.touches[0];
        contextButtonTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
        contextButtonTouchMoved = false;
    }

    function handleContextMenuButtonTouchMove(e: TouchEvent): void {
        e.stopPropagation();
        const start = contextButtonTouchStart;
        const touch = e.touches[0];
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dx * dx + dy * dy > CONTEXT_BUTTON_MOVE_THRESHOLD * CONTEXT_BUTTON_MOVE_THRESHOLD) {
            contextButtonTouchMoved = true;
        }
    }

    function stopContextButtonPropagation(e: Event): void {
        e.stopPropagation();
    }

    // Track previous progress to detect program changes (progress drops = new program)
    let prevProgress: number | undefined = undefined;
    let skipTransition = $state(false);

    // Detect when progress decreases (indicates program change, e.g., ~100% to ~0%)
    // For live TV, progress should only ever increase during a program - any decrease means new program
    $effect(() => {
        const currentProgress = item.progress;
        let cleanup: (() => void) | undefined;
        if (
            prevProgress !== undefined &&
            currentProgress !== undefined &&
            currentProgress < prevProgress
        ) {
            skipTransition = true;
            const t = setTimeout(() => {
                skipTransition = false;
            }, 100);
            cleanup = () => clearTimeout(t);
        }
        prevProgress = currentProgress;
        return cleanup;
    });

    // =========================================================================
    // Computed Values
    // =========================================================================

    // Default width classes per variant
    let defaultWidth = $derived(
        variant === 'list' ? 'w-full' : variant === 'backdrop' ? 'w-44' : 'w-32',
    );
    let cardWidth = $derived(widthClass || defaultWidth);

    // Quick Picks provenance: items in the /music quick-picks carousel are
    // built with itemKey = "qp:<bucket>:<uuid>" so we can surface *why* this card
    // showed up. The label is shown as a subtitle in the right-click /
    // long-press context menu.
    let quickPickBucket = $derived.by((): string | null => {
        const match = item.itemKey?.match(/^qp:([^:]+):/);
        return match ? match[1] : null;
    });

    const QUICK_PICK_LABELS: Record<string, string> = {
        'heavy-rotation': 'Your top plays',
        'recently-heard': 'Recently played',
        'hot-this-week': 'Hot this week',
        'taste-similar': 'Similar to your taste',
        'highly-rated': 'Highly rated by you',
        'unplayed-from-loved-albums': 'From an album you love',
        'co-album': 'From the same album as your favorites',
        'new-discovery': "New for you — matches your taste, you've never played it",
        'deep-cuts': 'Deep cut from your library',
        random: 'Surprise pick',
    };

    let quickPickLabel = $derived.by((): string | undefined => {
        if (!quickPickBucket) return undefined;
        return QUICK_PICK_LABELS[quickPickBucket];
    });

    // Aspect ratio classes
    let aspectClass = $derived(
        variant === 'backdrop'
            ? 'aspect-video'
            : variant === 'list'
              ? ''
              : item.aspectRatio === 'video'
                ? 'aspect-video'
                : item.aspectRatio === 'square'
                  ? 'aspect-square'
                  : 'aspect-[2/3]',
    );

    // Intrinsic width/height attributes for the <img> tag. These don't
    // determine the rendered size (CSS does, via w-full + aspect-*), but
    // modern browsers read them as an aspect-ratio hint and reserve layout
    // space *before* the image bytes arrive. Without them, the page reflows
    // when each image loads — a measurable CLS hit and the perceived
    // "page jumping" you can feel on a slow connection.
    let intrinsicSize = $derived.by(() => {
        if (variant === 'backdrop') return { width: 320, height: 180 };
        if (variant === 'list') return { width: 80, height: 120 };
        if (item.aspectRatio === 'video') return { width: 320, height: 180 };
        if (item.aspectRatio === 'square') return { width: 200, height: 200 };
        return { width: 200, height: 300 }; // default 2:3 poster
    });

    // Internal UUID for catalog image srcset (item.id may be a composite key like tmdb:123:movie).
    // Guarded by shape: external rows smuggle non-catalog ids through the internal
    // slot (Kavita rows carry `kavita-series-<n>`), and a srcset built from one
    // resolves to the placeholder — which the browser then prefers over the
    // working `src`. Only a UUID-shaped id may build catalog srcset URLs.
    let internalUuid = $derived.by(() => {
        const id = isMusicItem ? item.id : item.externalIds?.internal;
        return id && UUID_RE_LOOSE.test(id) ? id : undefined;
    });

    // BlurHash placeholder backgrounds (decoded once and cached)
    let posterBlurDataUrl = $derived(
        item.posterBlurHash ? blurhashToDataUrl(item.posterBlurHash) : '',
    );
    let backdropBlurDataUrl = $derived(
        item.backdropBlurHash ? blurhashToDataUrl(item.backdropBlurHash) : '',
    );

    // Image dimensions for list variant
    let listImageClass = $derived(
        isAudiobook(item.mediaType) || isMusicType(item.mediaType)
            ? 'list-artwork square-artwork'
            : 'list-artwork',
    );

    // Hover text color
    let hoverTextColor = $derived(`text-${accentColor}-300`);

    // Generate item key for playlist checking using new provider-agnostic format
    function getItemKeyFromItem(mediaItem: UniversalMediaItem): string {
        return getEpisodeKey({
            externalIds: mediaItem.externalIds,
            mediaType: mediaItem.mediaType,
            seasonNumber: mediaItem.seasonNumber,
            episodeNumber: mediaItem.episodeNumber,
        });
    }

    // Check if this item is already in the playlist
    let isInPlaylist = $derived(playlistItemKeys.has(getItemKeyFromItem(item)));

    // Watchlist state — prefer the parent-supplied set when present
    // (Watchlist widget threads its own optimistic snapshot), otherwise
    // fall back to the global watchlist store so menu entries on cards
    // anywhere on the home page reflect the right add/remove label.
    let watchlistKey = $derived(item.externalIds && item.mediaType ? getItemKeyFromItem(item) : '');
    let watchlistKeyForStore = $derived(
        item.externalIds && (isMovie(item.mediaType) || isSeries(item.mediaType))
            ? mediaCompositeKey(item.externalIds, isSeries(item.mediaType) ? 'tv' : 'movie')
            : '',
    );
    // Resting the pointer on a movie/series card warms its "Similar" row (see
    // similar-prefetch.ts). The dwell keeps a pointer sweeping across a row from
    // firing searches. Cards wrapped in MediaHoverCard lose :hover to the popup
    // that covers them, so the popup warms it too when it opens.
    $effect(() => {
        if (!isHovered || !watchlistKeyForStore) return;
        const target = item;
        const timer = setTimeout(() => prefetchSimilar(target), SIMILAR_PREFETCH_DWELL_MS);
        return () => clearTimeout(timer);
    });
    let isInWatchlistFromStore = $derived(
        watchlistKeyForStore
            ? $watchlistItems.some(
                  (w) => mediaCompositeKey(w.externalIds, w.mediaType) === watchlistKeyForStore,
              )
            : false,
    );
    let isInWatchlist = $derived(
        watchlistKey && watchlistItemKeys.size > 0
            ? watchlistItemKeys.has(watchlistKey)
            : isInWatchlistFromStore,
    );
    let isWatchlistLoading = $derived(
        watchlistKey ? watchlistLoadingKeys.has(watchlistKey) : false,
    );

    // Check if this is a music-type item (no request/similar, always show play)
    let isMusicItem = $derived(
        isMusicType(item.mediaType) || isAudio(item.mediaType) || item.mediaType === 'playlist',
    );

    let isRadioItem = $derived(item.clickData?.isRadio === true && isMusicItem);

    // TV channels don't support "similar" recommendations
    let isTvChannelItem = $derived(isTvChannel(item.mediaType));

    // AudiobookShelf books have exactly one cover image, served only under the
    // 'poster' role — ImageProxyService.getImageByCatalogId returns null for
    // any other role (see service.ts's `isAudiobook(...) && type !== 'poster'`
    // short-circuit), and the media image route turns that null into a 302 to
    // the FALLBACK_IMAGE placeholder. The backdrop-variant card below always
    // populates `item.backdrop` with a (for audiobooks, doomed) backdrop URL,
    // so preferring it over `cardImage` silently swaps a real cover for the
    // generic placeholder. Route audiobooks straight to the poster URL the
    // server already resolved instead of recomputing anything.
    let isAudiobookItem = $derived(isAudiobook(item.mediaType));

    /**
     * The image the backdrop-variant card (CW / Next Up rows) actually paints.
     *
     * `item.backdrop` is now OMITTED server-side for audiobooks
     * (MediaTransformerService.getBackdropUrl), so `item.backdrop || cardImage`
     * would already fall through to the poster. The explicit audiobook arm stays
     * as a client-side belt: this card is also fed by client-built items
     * (browse-transformers, hero-builder) and by cached SSR payloads produced
     * before that server fix shipped, either of which can still hand us a
     * backdrop href for a book.
     */
    let cardImage = $derived(
        item.mediaType === 'audiobook' && item.images && !Array.isArray(item.images)
            ? pickVariant(item.images.primary, 'card')
            : item.image,
    );
    let backdropSlotSrc = $derived(isAudiobookItem ? cardImage : item.backdrop || cardImage);

    // Check if this is a book-type item (for showing "Read" instead of "Play").
    // The comparator is case-insensitive: v1 search rows carry lowercase
    // 'book'/'manga'/'comic', legacy callers upper-cased them.
    let originalMediaType = $derived((item.clickData?.mediaType as string) || '');
    let isBookType = $derived(
        isBookMediaType(originalMediaType) || isBookMediaType(item.mediaType),
    );

    // Neither the request modal nor an external Jellyseerr URL is configured —
    // the request/+ button must stay hidden regardless of item.canRequest.
    let requestsConfigured = $derived(
        $page.data?.features?.requests === true || !!env.PUBLIC_REQUESTURL,
    );

    // =========================================================================
    // Handlers
    // =========================================================================

    function playRadio(): void {
        const track = buildTrackPayload();
        if (track) musicPlayerStore.play(track);
    }

    function handleClick() {
        if (isRadioItem) {
            playRadio();
            return;
        }
        // Touch devices deliberately have NO hover play button, so the
        // background-click-opens-album split only applies where the ▶ exists:
        // on hover-capable devices. A track card tap on touch keeps playing
        // directly; the album stays reachable via long-press → "Go to album".
        // List rows are exempt — they render an always-visible Play button, so
        // the row tap keeps its open-the-album meaning there.
        if (
            !hasHover &&
            variant !== 'list' &&
            (item.mediaType === 'track' || item.mediaType === 'music') &&
            onplay
        ) {
            onplay(item);
            return;
        }
        onclick?.(item);
    }

    function handlePlay(e: Event) {
        e.stopPropagation();
        if (isRadioItem) {
            playRadio();
            return;
        }
        if (isMusicItem || item.isAvailable) {
            onplay?.(item);
        } else if (item.canRequest && hasRequestPermission && requestsConfigured) {
            onrequest?.(item);
        }
    }

    function handleMore(e: Event) {
        e.stopPropagation();
        onmore?.(item);
    }

    // Episodes hide their whole series, so the label names what disappears.
    let dismissLabel = $derived(
        continueWatching
            ? m.card_hide_title_from_continue_watching({ title: getCwDismissDisplayName(item) })
            : m.card_hide(),
    );

    function handleRemove(e: Event): void {
        e.stopPropagation();
        onremove?.(item);
    }

    function handleAddToPlaylist(e: Event) {
        e.stopPropagation();
        onaddToPlaylist?.(item);
    }

    function handleWatchlist(e: Event) {
        e.stopPropagation();
        onwatchlist?.(item);
    }

    function buildTrackPayload(): MusicTrack | null {
        return musicTrackFromCard({
            id: item.id,
            title: item.title,
            remixerArtists: item.remixerArtists?.map((a) => ({ ...a, id: a.id ?? null })),
            artists: item.artists?.map((a) => ({ ...a, id: a.id ?? null })) ?? [
                { id: null, title: item.subtitle ?? 'Unknown Artist' },
            ],
            isRadio: item.clickData?.isRadio === true,
        });
    }

    function goToMusicPath(path: string): void {
        void import('$app/navigation').then(({ goto }) => goto(resolve(path)));
    }

    function handleTrackDragStart(e: DragEvent): void {
        if (!trackDragEnabled || !e.dataTransfer) {
            e.preventDefault();
            return;
        }
        const track = buildTrackPayload();
        if (!track) {
            e.preventDefault();
            return;
        }
        trackDragInProgress = true;
        suppressContextMenuBriefly();
        closeContextMenu();
        e.dataTransfer.setData('application/lumastra-music-track', JSON.stringify(track));
        e.dataTransfer.effectAllowed = 'copy';
    }

    function handleTrackDragEnd(): void {
        trackDragInProgress = false;
        suppressContextMenuBriefly();
    }

    function addToQueueEnd(): void {
        if (!isMusicItem) return;
        const track = buildTrackPayload();
        if (track) musicPlayerStore.addToQueue(track);
    }

    function addToQueueFront(): void {
        if (!isMusicItem) return;
        const track = buildTrackPayload();
        if (track) musicPlayerStore.addToQueueFront(track);
    }

    function handleAddToQueueEnd(e: Event): void {
        e.stopPropagation();
        addToQueueEnd();
    }

    function handleAddToQueueFront(e: Event): void {
        e.stopPropagation();
        addToQueueFront();
    }

    function openArtistFromContextMenu(): void {
        const artistId = item.clickData?.artistId;
        if (typeof artistId !== 'string' || !artistId) return;
        import('$lib/utils/modal-utils')
            .then(({ openArtistModal }) => openArtistModal(artistId))
            .catch(() => {
                // Chunk load failure — silently ignore; user can tap subtitle.
            });
    }

    function openAlbumFromContextMenu(): void {
        const albumId = item.clickData?.albumId;
        if (typeof albumId !== 'string' || !albumId) return;
        import('$lib/utils/modal-utils')
            .then(({ openAlbumModal }) => openAlbumModal(albumId))
            .catch(() => {
                // Chunk load failure — silently ignore.
            });
    }

    function startArtistRadioFromContextMenu(): void {
        const artistId = item.clickData?.artistId;
        if (typeof artistId !== 'string' || !artistId) return;
        const artistName = item.subtitle?.trim() || 'Unknown Artist';
        void musicPlayerStore.seedAutoplay({
            type: 'artist',
            artistId,
            artistName,
        });
    }

    async function dislikeTrackFromContextMenu(): Promise<void> {
        const internalId = isMusicItem ? item.id : item.externalIds?.internal;
        if (!internalId) return;
        try {
            const [{ setTrackFeedback }, { toasts }] = await Promise.all([
                import('$lib/api/music'),
                import('$lib/stores/toast.store'),
            ]);
            const { error } = await setTrackFeedback(internalId, 'disliked');
            if (error) {
                toasts.error(`Couldn't hide this track: ${error}`);
                return;
            }
            toasts.info(m.toast_track_disliked());
            // Best-effort optimistic removal from the visible carousel —
            // the page-level handler decides what to do (Quick Picks
            // benefits from this; other sections may ignore it).
            onremove?.(item);
        } catch {
            /* network / chunk load — leave UI as is */
        }
    }

    // === Generic (video) context-menu helpers ============================

    function openDetailsFromContextMenu(): void {
        import('$lib/utils/modal-utils')
            .then(({ openMediaModal }) => {
                openMediaModal(
                    {
                        externalIds: item.externalIds,
                        mediaType: item.mediaType,
                        title: item.title,
                        overview: item.overview ?? '',
                        rating: typeof item.rating === 'number' ? item.rating : undefined,
                        isAvailable: item.isAvailable,
                        canRequest: item.canRequest,
                        seriesInternalId: item.seriesId,
                        seriesName: item.seriesName,
                        seasonNumber: item.seasonNumber,
                        episodeNumber: item.episodeNumber,
                    },
                    cardImage,
                );
            })
            .catch(() => {
                /* chunk load failure — silently ignore */
            });
    }

    function copyLinkFromContextMenu(): void {
        void copyMediaLinkShared(item);
    }

    function refreshMetadataFromContextMenu(): void {
        void refreshMediaMetadataShared(item);
    }

    async function quickRateAndMaybeRemove(kind: 'dislike' | 'liked' | 'loved'): Promise<void> {
        const ok = await quickRateMedia(item, kind);
        // Only the strong negative path optimistically drops the card;
        // liked/loved should leave the section as-is. Whether the
        // section listens to onremove is up to the caller (for-you
        // does; library / search ignores it).
        if (ok && kind === 'dislike') {
            onremove?.(item);
        }
    }

    async function handleLessLikeThis(): Promise<void> {
        if (!item.externalIds) return;
        const [{ lessLikeThis }, { toasts }] = await Promise.all([
            import('$lib/api/for-you'),
            import('$lib/stores/toast.store'),
        ]);
        const mediaType = toMovieOrSeries(item.mediaType);
        // `lessLikeThis` writes a taste damper against a RECOMMENDER entity,
        // and the recommender only models movies and series. The old
        // `toPublicMovieOrSeries` answered 'movie' here, so "Less like this"
        // on an audiobook or a track recorded a damper against a MOVIE
        // carrying that item's external ids: it damped an unrelated title and
        // left the actual item unaffected. Bail instead of guessing.
        if (mediaType === null) return;
        const { error } = await lessLikeThis({
            externalIds: item.externalIds,
            mediaType,
            title: item.title,
        });
        if (!error) {
            toasts.info(m.card_less_like_this_done());
            // On for-you surfaces drop the card; library/search ignore onremove.
            onremove?.(item);
        }
    }

    function markUnwatchedFromContextMenu(): void {
        void markMediaUnwatchedShared(item);
    }

    function handleImageError() {
        imageError = true;
    }

    function handleImageLoad() {
        imageLoaded = true;
    }

    function handleKeypress(e: KeyboardEvent) {
        // Nested artist-link buttons (TrackTitleLine) handle their own activation;
        // preventDefault here would cancel their native click synthesis on Enter/Space.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
        }
    }

    function handleArtistClick(e: Event): void {
        e.stopPropagation();
        const artistId = item.clickData?.artistId;
        if (typeof artistId === 'string' && artistId) {
            import('$lib/utils/modal-utils')
                .then(({ openArtistModal }) => {
                    openArtistModal(artistId);
                })
                .catch(() => {
                    // Chunk load failure — fall through to card click
                });
        }
    }

    /** Whether the subtitle should be clickable to open an artist modal */
    let hasClickableArtist = $derived(
        isMusicType(item.mediaType) && typeof item.clickData?.artistId === 'string',
    );

    /**
     * Subtitle to render, suppressed when it's identical to the title (e.g.
     * a series card whose subtitle got set to the same series name) so we
     * never show "Harper's Island" / "Harper's Island" stacked on two lines.
     */
    let displaySubtitle = $derived(
        item.subtitle && item.subtitle !== item.title ? item.subtitle : undefined,
    );

    /** Whether a "Go to album" entry can be added to the context menu */
    let hasClickableAlbum = $derived(
        isMusicType(item.mediaType) && typeof item.clickData?.albumId === 'string',
    );

    // Items shown in the desktop right-click / touch ⋯ context menu. Empty array
    // means no menu — handlers will skip opening it in that case.
    //
    // A plain function (NOT a $derived), invoked only when the menu is about
    // to open (openContextMenu / handleNativeContextMenu) or when a touch
    // device needs to know whether to show the ⋯ affordance
    // (showTouchContextButton). Building this ~400-line array eagerly for
    // every idle card across many carousels was a real hydration cost for a
    // menu that's rarely opened. It reads live reactive state (watchlist
    // status, admin, item fields), so rebuilding on each open guarantees
    // fresh, non-stale entries.
    function buildMenuItems(): ContextMenuEntry[] {
        const out: ContextMenuEntry[] = [];
        const inCwLikeContext =
            showDismiss && (alwaysShowDismiss || (item.progress && item.progress > 0));
        const isCwEpisode =
            continueWatching &&
            isEpisode(item.mediaType) &&
            !!item.externalIds?.internal &&
            inCwLikeContext;
        if (isRadioItem) {
            out.push({
                label: m.card_play(),
                icon: PlayCircle,
                onSelect: () => playRadio(),
            });
        } else if (isMusicItem) {
            out.push({
                label: m.card_play(),
                icon: PlayCircle,
                onSelect: () => onplay?.(item),
            });
            out.push({
                label: m.card_music_play_next(),
                icon: ChevronDoubleRight,
                onSelect: () => addToQueueFront(),
            });
            out.push({
                label: m.card_music_add_to_queue(),
                icon: QueueList,
                onSelect: () => addToQueueEnd(),
            });
            if (onmore && isTrack(item.mediaType)) {
                out.push({
                    label: m.card_music_more_like_this(),
                    icon: Sparkles,
                    onSelect: () => onmore?.(item),
                });
            }
            if (isTrack(item.mediaType) && sonicEnabled) {
                out.push({
                    label: m.card_music_song_paths(),
                    icon: ArrowRight,
                    onSelect: () => {
                        const internalId = isMusicItem ? item.id : item.id;
                        goToMusicPath(
                            internalId ? `/music/path?from=${internalId}` : '/music/path',
                        );
                    },
                });
            }
            if (isTrack(item.mediaType) && alchemyEnabled) {
                out.push({
                    label: m.music_alchemy_context_add_seed(),
                    icon: Beaker,
                    onSelect: () => {
                        const t = buildTrackPayload();
                        if (t) musicAlchemyStore.addSeed(t);
                    },
                });
                out.push({
                    label: m.music_alchemy_context_add_avoid(),
                    icon: NoSymbol,
                    onSelect: () => {
                        const t = buildTrackPayload();
                        if (t) musicAlchemyStore.addAvoid(t);
                    },
                });
            }
            if (isMusicItem && alchemyEnabled) {
                out.push({
                    label: m.card_music_open_mixing_desk(),
                    icon: Beaker,
                    onSelect: () => goToMusicPath('/music/alchemy'),
                });
            }
            if (hasClickableArtist) {
                out.push({
                    label: m.card_music_start_artist_radio(),
                    icon: Radio,
                    onSelect: () => startArtistRadioFromContextMenu(),
                });
                out.push({
                    label: m.card_music_go_to_artist(),
                    icon: UserCircle,
                    onSelect: () => openArtistFromContextMenu(),
                });
            }
            if (hasClickableAlbum) {
                out.push({
                    label: m.card_music_go_to_album(),
                    icon: MusicalNote,
                    onSelect: () => openAlbumFromContextMenu(),
                });
            }
            if (item.id) {
                out.push(
                    addToPlaylistEntry({
                        externalIds: { internal: item.id },
                        title: item.title,
                        subtitle: item.subtitle ?? undefined,
                        posterPath: cardImage ?? undefined,
                    }),
                );
                out.push({
                    label: m.card_music_dont_recommend(),
                    icon: HandThumbDown,
                    destructive: true,
                    onSelect: () => {
                        void dislikeTrackFromContextMenu();
                    },
                });
            }
            if (isCardAdmin && item.id) {
                out.push({
                    label: m.card_open_in_admin(),
                    icon: WrenchScrewdriver,
                    hideOnMobile: true,
                    onSelect: () => {
                        if (typeof window === 'undefined') return;
                        const internalId = requireValue(
                            item.id,
                            'item.id must exist for admin link',
                        );
                        window.open(
                            `/admin/library/media/${encodeURIComponent(internalId)}`,
                            '_blank',
                            'noopener,noreferrer',
                        );
                    },
                });
            }
        } else if (item.isAvailable && onplay) {
            out.push({
                label: m.card_play(),
                icon: PlayCircle,
                onSelect: () => onplay?.(item),
            });
        } else if (item.canRequest && hasRequestPermission && requestsConfigured && onrequest) {
            out.push({
                label: m.request(),
                icon: DocumentPlus,
                onSelect: () => onrequest?.(item),
            });
        }
        // "Open details" — useful in two cases:
        //  - sections whose primary click does not open the modal
        //    (Featured Pick, music plays directly)
        //  - users who want to read overview/metadata without leaving
        //    the card via the play action.
        // Skipped for music/radio (the dedicated artist/album entries
        // already cover what the user needs there).
        if (!isMusicItem && !isRadioItem && !isTvChannelItem) {
            out.push({
                label: m.card_open_details(),
                icon: InformationCircle,
                onSelect: () => openDetailsFromContextMenu(),
            });
        }
        // "Why is this here?" — surfaces the AI-generated reason field
        // for items that have one (currently only AI-suggestion items).
        // Other for-you sections imply their reason via the section
        // title ("Trending", "Because you watched X") and don't carry
        // a per-item reason yet, so the entry stays hidden there.
        if (
            !isMusicItem &&
            !isRadioItem &&
            typeof item.reason === 'string' &&
            item.reason.trim().length > 0
        ) {
            out.push({
                label: m.card_why_here(),
                icon: Sparkles,
                onSelect: () => {
                    whyHereOpen = true;
                },
            });
        }
        if (showMoreButton && !isMusicItem && !isTvChannelItem && onmore) {
            out.push({
                label: m.card_similar_titles(),
                icon: Sparkles,
                onSelect: () => onmore?.(item),
            });
        }
        if (canWatchlistMedia(item)) {
            out.push({
                label: isInWatchlist ? m.watchlist_remove() : m.watchlist_add(),
                icon: Bookmark,
                onSelect: () => {
                    if (onwatchlist) {
                        onwatchlist(item);
                    } else {
                        void toggleWatchlistMedia(item, { isInWatchlist });
                    }
                },
            });
        }
        // Quick rate row — three taps for the user who just wants to
        // stamp a taste signal (dislike / liked / loved) without
        // walking through the picker. The picker entry below is for
        // the granular 1–10 case. The dislike button additionally
        // calls onremove so for-you sections drop the card; this is
        // the visual replacement for the previous "Don't recommend
        // this title" entry.
        if (canRateMedia(item)) {
            out.push({
                kind: 'actions',
                actions: [
                    {
                        icon: HandThumbDown,
                        label: m.card_dislike(),
                        accent: 'negative',
                        onSelect: () => {
                            void quickRateAndMaybeRemove('dislike');
                        },
                    },
                    {
                        icon: HandThumbUp,
                        label: m.card_liked(),
                        accent: 'positive',
                        onSelect: () => {
                            void quickRateAndMaybeRemove('liked');
                        },
                    },
                    {
                        icon: Heart,
                        label: m.card_loved(),
                        accent: 'love',
                        onSelect: () => {
                            void quickRateAndMaybeRemove('loved');
                        },
                    },
                ],
            });
        }
        // "Rate this" — for movies/series only. Episodes share the
        // parent series rating (the API accepts movie/tv only), and
        // music has its own dedicated like/dislike surface inside the
        // player.
        if (
            !isMusicItem &&
            !isRadioItem &&
            (isMovie(item.mediaType) || isSeries(item.mediaType)) &&
            (item.externalIds?.tmdb || item.externalIds?.imdb || item.externalIds?.internal)
        ) {
            out.push({
                label: m.card_rate_this(),
                icon: Star,
                onSelect: () => {
                    ratingModalOpen = true;
                },
            });
        }
        // "Show less like this" — soft, decaying, non-judgmental steering away
        // from similar content. Distinct from Dislike (a permanent 1★ rating):
        // it records no rating and never touches the durable taste vector.
        // Gated on `showDamperAction` so it only appears on surfaces whose
        // ranking actually consumes the damper (For-You anime/short/you-like/mood
        // rows) — not on trending/search/browse/watchlist where it'd seem inert.
        if (
            showDamperAction &&
            !isMusicItem &&
            !isRadioItem &&
            (isMovie(item.mediaType) || isSeries(item.mediaType)) &&
            (item.externalIds?.tmdb || item.externalIds?.imdb || item.externalIds?.internal)
        ) {
            out.push({
                label: m.card_less_like_this(),
                icon: EyeSlash,
                onSelect: () => {
                    void handleLessLikeThis();
                },
            });
        }
        // "Set progress…" — manual correction for series whose CW/NextUp
        // row shows the wrong episode (Lumastra's view diverging from the
        // user's mental model in ways no Jellyfin re-pull can fix). Lives
        // OUTSIDE the showDismiss + progress>0 gate below because the drift
        // problem manifests on NextUp cards (no progress at all) just as
        // much as on paused CW cards — a NextUp suggestion can point to
        // an earlier episode instead of the user's intended season.
        // Gated only on having a series UUID to operate on (episodes carry
        // it via item.seriesId; movies and music never qualify).
        if (setProgressSeriesId && !isMusicItem) {
            out.push({
                label: m.card_set_progress(),
                icon: ListBullet,
                onSelect: () => {
                    setProgressOpen = true;
                },
            });
        }
        if (showDismiss && (alwaysShowDismiss || (item.progress && item.progress > 0))) {
            // "Mark as watched" — the deliberate "I finished this"
            // action. Appears above "Hide" so the more-assertive action
            // is on top, matching the priority order used elsewhere.
            // Only show for video-like media (movies / episodes /
            // series); marking a music track watched has no semantic
            // and Lumastra already routes music through a different
            // state machine.
            if (
                onmarkWatched &&
                !isCwEpisode &&
                !isMusicItem &&
                (isMovie(item.mediaType) || isEpisode(item.mediaType) || isSeries(item.mediaType))
            ) {
                out.push({
                    label: m.card_mark_watched(),
                    icon: CheckCircle,
                    onSelect: () => onmarkWatched?.(item),
                });
            }
        }
        // "Mark unwatched" — inverse of Mark as watched. Only useful
        // when an explicit "watched" state already exists, so we gate
        // on item.isPlayed (the deliberate flag) rather than on progress
        // alone. Lives OUTSIDE the showDismiss gate so a user who notices
        // a wrongly-marked-watched title in any section (Trending,
        // Because-you-watched, etc.) can correct it without first
        // navigating into Continue Watching.
        if (
            !isMusicItem &&
            item.isPlayed &&
            !isCwEpisode &&
            item.externalIds?.internal &&
            (isMovie(item.mediaType) || isEpisode(item.mediaType) || isSeries(item.mediaType))
        ) {
            out.push({
                label: m.card_mark_unwatched(),
                icon: ArrowUturnLeft,
                onSelect: () => {
                    void markUnwatchedFromContextMenu();
                },
            });
        }
        // "Copy link" — produces a shareable /?modal=<id> URL. Hidden
        // when no usable id exists, and for live TV channels (their
        // UUID resolves to a non-modal-shaped media type).
        if (!isRadioItem && !isTvChannelItem && buildMediaShareId(item) !== null) {
            out.push({
                label: m.card_copy_link(),
                icon: ClipboardDocument,
                onSelect: () => {
                    void copyLinkFromContextMenu();
                },
            });
        }
        // The previous "Don't recommend this title" menu entry is now
        // covered by the quick-rate row's Dislike button above (same
        // signal, plus onremove for for-you sections).
        if (inCwLikeContext) {
            out.push({
                // In the CW row this names the title and the row, so users
                // see the hide is scoped to the row and covers the whole
                // series. Other dismiss sections get the generic "Hide".
                label: dismissLabel,
                icon: XMark,
                destructive: true,
                onSelect: () => onremove?.(item),
            });
            if (isCwEpisode && item.externalIds?.internal) {
                out.push(
                    {
                        label: m.card_mark_episode_complete(),
                        icon: CheckCircle,
                        onSelect: () => {
                            void setEpisodeWatchState(item, true);
                        },
                    },
                    {
                        label: m.card_mark_episode_not_watched(),
                        icon: ArrowUturnLeft,
                        onSelect: () => {
                            void setEpisodeWatchState(item, false);
                        },
                    },
                );
            }
        }
        // Admin-only entries — gated on cluster admin group membership
        // and on the item carrying an internal UUID we can target.
        if (
            isCardAdmin &&
            item.externalIds?.internal &&
            !isMusicItem &&
            !isRadioItem &&
            (isMovie(item.mediaType) || isEpisode(item.mediaType) || isSeries(item.mediaType))
        ) {
            // "Show file info" — surfaces codec / runtime / file path /
            // stream layout for triaging "why won't this play right" or
            // "which version is this" without leaving the card.
            // Episodes, movies only — series-as-aggregate has no single
            // file. We still let series through because the inline
            // modal calls /files which returns the children.
            out.push({
                label: m.card_file_info(),
                icon: DocumentMagnifyingGlass,
                hideOnMobile: true,
                onSelect: () => {
                    fileInfoModalOpen = true;
                },
            });
            out.push({
                label: m.card_refresh_metadata(),
                icon: ArrowPath,
                hideOnMobile: true,
                onSelect: () => {
                    void refreshMetadataFromContextMenu();
                },
            });
            // Series episodes carry their own episode UUID, but admins
            // typically want to land on the parent series record. Use
            // the series UUID when present so the admin page opens at
            // the right level.
            const adminTargetId =
                isEpisode(item.mediaType) && item.seriesId
                    ? item.seriesId
                    : item.externalIds.internal;
            out.push({
                label: m.card_open_in_admin(),
                icon: WrenchScrewdriver,
                hideOnMobile: true,
                onSelect: () => {
                    if (typeof window === 'undefined') return;
                    window.open(
                        `/admin/library/media/${encodeURIComponent(adminTargetId)}`,
                        '_blank',
                        'noopener,noreferrer',
                    );
                },
            });
        }
        return out;
    }

    // Touch-only affordance: on devices without hover we surface a ⋯ button,
    // but only when the menu would actually have entries. `hasHover` short-
    // circuits first so hover-capable (desktop) devices never build the menu
    // here. On touch this rebuilds when its reactive inputs change — identical
    // to the previous $derived behavior.
    let showTouchContextButton = $derived.by((): boolean =>
        hasHover ? false : buildMenuItems().length > 0,
    );

    // One predictable action entry point for video cards: pointer hover and
    // keyboard focus reveal the same menu that touch users already have.
    // Keep the menu trigger mounted while its menu owns focus outside the card.
    let showCardContextButton = $derived(
        showTouchContextButton ||
            (hasHover && !isMusicItem && !isTvChannelItem && (isHovered || !!contextMenuPos)),
    );

    // =========================================================================
    // Rating Formatting Helper
    // =========================================================================

    function formatRating(rating: string | number | undefined): string {
        if (rating === undefined || rating === null) return '';
        const num = typeof rating === 'number' ? rating : Number.parseFloat(rating);
        if (isNaN(num) || num <= 0) return '';
        return num.toFixed(1);
    }

    // =========================================================================
    // Badge Rendering Helper
    // =========================================================================

    type BadgeIcon = typeof Icon;

    function renderBadgeIcon(badge: Badge): BadgeIcon | null {
        if (!badge.icon) return null;
        const icon = getIcon(badge.icon) as BadgeIcon | undefined;
        return icon ? (icon as BadgeIcon) : null;
    }

    // =========================================================================
    // Date Formatting Helper
    // =========================================================================

    function formatReleaseDate(dateString: string): string {
        const date = new SvelteDate(dateString);
        // If not a valid date, return as-is (already formatted string like "Morgen")
        if (Number.isNaN(date.getTime())) return dateString;
        return date.toLocaleDateString();
    }
</script>

{#snippet legacyDismiss()}
    {#if hasHover && (isMusicItem || isTvChannelItem) && showDismiss && (alwaysShowDismiss || (item.progress && item.progress > 0))}
        <div class="absolute top-1 left-1 z-20 cw-dismiss" data-preview-suppress>
            <Tooltip text={dismissLabel} position="top" fixed wrap delay={100}>
                <button
                    data-preview-suppress
                    class="p-1.5 rounded-full bg-black/80 hover:bg-red-600 transition-all shadow-lg focus-visible:outline-2 focus-visible:outline-white"
                    onclick={handleRemove}
                    aria-label={dismissLabel}>
                    <Icon src={XMark} class="w-4 h-4 text-white" />
                </button>
            </Tooltip>
        </div>
    {/if}
{/snippet}

<!-- ======================================================================= -->
<!-- POSTER VARIANT -->
<!-- ======================================================================= -->
{#if variant === 'poster'}
    <div
        class="{cardWidth} shrink-0 cursor-pointer card-touch-root"
        data-drag-scroll-allow
        data-quick-pick-bucket={quickPickBucket ?? undefined}
        draggable={trackDragEnabled}
        ondragstart={handleTrackDragStart}
        ondragend={handleTrackDragEnd}
        oncontextmenu={handleNativeContextMenu}
        onmouseenter={() => {
            if (hasHover) isPointerHovered = true;
        }}
        onmouseleave={() => (isPointerHovered = false)}
        onfocusin={() => (hasFocusWithin = true)}
        onfocusout={(event) => {
            if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
            ) {
                hasFocusWithin = false;
            }
        }}
        onclick={handleClick}
        onkeydown={handleKeypress}
        role="button"
        tabindex="0">
        <div class="relative overflow-hidden rounded-lg">
            {#if Array.isArray(item.images) && item.images.length >= 4 && !cardImage}
                <!-- Mosaic grid (e.g. playlist covers) -->
                <div
                    class="w-full {aspectClass} grid grid-cols-2 grid-rows-2 transition-transform duration-300 {isHovered
                        ? 'scale-110'
                        : ''}">
                    {#each item.images.slice(0, 4) as src, i (i)}
                        <img
                            {src}
                            alt="{item.title} cover {i + 1}"
                            class="w-full h-full object-cover"
                            loading={priority ? 'eager' : 'lazy'}
                            decoding="async"
                            fetchpriority={priority ? 'high' : undefined} />
                    {/each}
                </div>
            {:else if cardImage && !imageError}
                <img
                    bind:this={posterImgEl}
                    src={cardImage}
                    srcset={!isAudiobookItem && internalUuid
                        ? isEpisode(item.mediaType)
                            ? getCatalogThumbSrcSet(internalUuid)
                            : getCatalogPosterSrcSet(internalUuid)
                        : undefined}
                    sizes={posterSizesFor(layout, cardWidth)}
                    width={intrinsicSize.width}
                    height={intrinsicSize.height}
                    alt="{item.title} poster"
                    class="w-full {aspectClass} object-cover transition-[opacity,transform] duration-300 {isHovered
                        ? 'scale-110'
                        : ''} {imageLoaded || posterBlurDataUrl ? 'opacity-100' : 'opacity-0'}"
                    style:background-image={posterBlurDataUrl
                        ? `url(${posterBlurDataUrl})`
                        : undefined}
                    style:background-size={posterBlurDataUrl ? 'cover' : undefined}
                    loading={priority ? 'eager' : 'lazy'}
                    decoding="async"
                    fetchpriority={priority ? 'high' : undefined}
                    onload={handleImageLoad}
                    onerror={handleImageError} />
                {#if !imageLoaded && !posterBlurDataUrl}
                    <!-- Shimmer placeholder while the cover streams in. Occupies
                         the exact image box (the sibling <img> reserves the box
                         via width/height + aspect class) so nothing reflows. -->
                    <div class="absolute inset-0 pointer-events-none" aria-hidden="true">
                        <Skeleton width="w-full" height="h-full" rounded="none" />
                    </div>
                {/if}
            {:else}
                <!-- No artwork: a card-colored tile with the title, NOT the same
                     muted treatment as a disabled/unavailable card — raised from
                     flat bg-surface-800 + text-white/70 (read as inert at a
                     glance across a grid of real posters) to a lighter surface,
                     a border for definition, and full-contrast text. -->
                <div
                    class="w-full {aspectClass} bg-surface-700 border border-surface-600/60 flex items-center justify-center p-3 transition-transform duration-300 {isHovered
                        ? 'scale-110'
                        : ''}">
                    <span
                        class="text-white font-medium text-sm text-center leading-snug break-words line-clamp-3">
                        {item.title}
                    </span>
                </div>
            {/if}

            <!-- Hover Overlay with Play Button -->
            {#if isHovered}
                <div class="absolute inset-0 bg-black/40 center pointer-events-none">
                    <!-- Music cards: solid primary fill — the card background
                         OPENS the album while only this button PLAYS, so the
                         play control must read as a distinct button, not as a
                         decoration on a uniformly clickable poster. -->
                    <button
                        data-play-button
                        class="{isMusicItem
                            ? 'bg-primary-600/95 border-primary-300/50 hover:bg-primary-500'
                            : 'bg-gray-900/70 border-white/20 hover:bg-gray-800/80'} backdrop-blur-sm rounded-full p-2 shadow-lg hover:scale-110 transition-all border pointer-events-auto"
                        onclick={handlePlay}
                        title={isMusicItem || item.isAvailable
                            ? m.card_play()
                            : item.canRequest && hasRequestPermission && requestsConfigured
                              ? m.request()
                              : m.card_details()}>
                        {#if isMusicItem || item.isAvailable}
                            <BrandedPlayIcon size="w-5 h-5" />
                        {:else}
                            <BrandedRequestIcon class="w-5 h-5" />
                        {/if}
                    </button>
                </div>

                <!-- Queue Buttons (top-right on hover) - Music items only -->
                {#if isHovered && isMusicItem && !isRadioItem}
                    <div
                        class="absolute {showSeriesCountBadge &&
                        seriesCountBadge(item, item.mediaType)
                            ? 'top-8'
                            : 'top-1'} right-1 z-10 flex flex-col gap-1 pointer-events-auto">
                        <button
                            class="rounded bg-black/70 p-1 text-white/80 backdrop-blur-sm transition-all hover:bg-black/90 hover:text-white"
                            title={m.card_add_to_queue_end()}
                            onclick={handleAddToQueueEnd}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                class="h-3 w-3"
                                viewBox="0 0 20 20"
                                fill="currentColor">
                                <path
                                    d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h7a1 1 0 110 2H4a1 1 0 01-1-1zm10 1a1 1 0 100 2 1 1 0 000-2z" />
                            </svg>
                        </button>
                        <button
                            class="rounded bg-black/70 p-1 text-white/80 backdrop-blur-sm transition-all hover:bg-black/90 hover:text-white"
                            title={m.card_play_next_queue()}
                            onclick={handleAddToQueueFront}>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                class="h-3 w-3"
                                viewBox="0 0 20 20"
                                fill="currentColor">
                                <path
                                    fill-rule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                                    clip-rule="evenodd" />
                            </svg>
                        </button>
                    </div>
                {/if}
            {/if}

            {@render legacyDismiss()}

            <!-- Progress Bar -->
            {#if !item.isPlayed && item.progress && item.progress > 0}
                <div class="absolute bottom-0 left-0 right-0 h-1 bg-gray-800/80">
                    <div
                        class="h-full bg-red-600 {skipTransition
                            ? ''
                            : 'transition-[width] duration-[5s] ease-linear'}"
                        style="width: {item.progress}%">
                    </div>
                </div>
            {/if}

            <!-- Static Badges (always visible) -->
            {#if showCardContextButton}
                <button
                    bind:this={contextMenuTrigger}
                    type="button"
                    data-preview-suppress
                    aria-haspopup="menu"
                    aria-expanded={!!contextMenuPos}
                    aria-controls={contextMenuPos ? contextMenuId : undefined}
                    class="absolute {showSeriesCountBadge && seriesCountBadge(item, item.mediaType)
                        ? 'top-8'
                        : 'top-1'} right-1 z-30 flex h-8 w-8 items-center justify-center rounded bg-black/55 text-white/75 transition-colors hover:bg-black/80 hover:text-white focus-visible:outline-2 focus-visible:outline-white active:bg-black/70 active:text-white"
                    aria-label={m.card_actions_aria()}
                    onpointerdown={stopContextButtonPropagation}
                    ontouchstart={handleContextMenuButtonTouchStart}
                    ontouchmove={handleContextMenuButtonTouchMove}
                    ontouchend={handleContextMenuButtonTouchEnd}
                    onclick={handleContextMenuButton}>
                    <Icon src={EllipsisVertical} class="h-4 w-4" />
                </button>
            {/if}

            <!-- Top-right: Request indicator (yellow dot with tooltip) - only show if user can request, never for music -->
            {#if !showCardContextButton && !isMusicItem && !item.isAvailable && item.canRequest && hasRequestPermission && requestsConfigured}
                <div
                    class="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-yellow-500 rounded-full shadow-md border border-yellow-400 cursor-help"
                    title={m.card_needs_request()}>
                </div>
            {/if}

            <!-- Top-left: Match/Rank badge (when not hovered). Solid tint, no
                 backdrop-blur: the home page shows ~90 of these at once and each
                 blur re-samples the poster under it on every scroll frame. -->
            {#if !isHovered}
                {#if item.similarityScore}
                    {@const matchPercent = Math.min(Math.round(item.similarityScore * 100), 100)}
                    <div class="absolute top-1 left-1">
                        <span
                            class="flex items-center gap-0.5 rounded-full border border-white/10 bg-black/65 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white/90"
                            title={m.card_match_tooltip({ percent: matchPercent })}>
                            <Icon src={Sparkles} class="w-3 h-3 text-primary-300" mini />
                            {matchPercent}%
                        </span>
                    </div>
                {:else if item.rank}
                    <div class="absolute top-1 left-1">
                        <span class="badge variant-filled-surface text-xs px-1">#{item.rank}</span>
                    </div>
                {/if}
            {/if}

            <!-- Bottom-right: Rating badge (MAL for anime, otherwise standard rating) — hidden for non-entertainment -->
            {#if !isNonEntertainment(item.mediaType)}
                {#if item.malScore && !item.rating && !item.progress}
                    <div class="absolute bottom-1 right-1">
                        <span
                            class="badge variant-filled-surface text-xs px-1 flex items-center gap-1">
                            <MalIcon size="12" />
                            {formatRating(item.malScore)}
                        </span>
                    </div>
                {:else if item.rating && !item.progress && formatRating(item.rating)}
                    <div class="absolute bottom-1 right-1">
                        <span class="badge variant-filled-surface text-xs px-1">
                            ⭐ {formatRating(item.rating)}
                        </span>
                    </div>
                {/if}
            {/if}

            <!-- Episode badge — offset below the Match/Rank badge (top-1 left-1)
                 when both would render at once, so the two never overlap. -->
            {#if isEpisode(item.mediaType) && item.seasonNumber && item.episodeNumber}
                <div
                    class="absolute left-1 {!isHovered && (item.similarityScore || item.rank)
                        ? 'top-7'
                        : 'top-1'}">
                    <span class="badge variant-filled-primary text-xs">
                        S{item.seasonNumber}:E{item.episodeNumber}
                    </span>
                </div>
            {/if}

            {#if showSeriesCountBadge && seriesCountBadge(item, item.mediaType)}
                {@const countBadge = seriesCountBadge(item, item.mediaType)!}
                <div class="absolute top-1 right-1">
                    <span
                        class="badge {countBadge.complete
                            ? 'variant-filled-success'
                            : 'variant-filled-primary'} text-xs px-1"
                        title={countBadge.label}
                        aria-label={countBadge.label}>{countBadge.text}</span>
                </div>
            {/if}

            <!-- Played/Watched badge -->
            {#if item.isPlayed && !(showSeriesCountBadge && (isSeries(item.mediaType) || isSeason(item.mediaType)))}
                <div class="absolute bottom-1 right-1">
                    <span class="badge variant-filled-success text-xs px-1">✓</span>
                </div>
            {/if}

            <!-- Custom badges from server -->
            {#if item.badges && item.badges.length > 0}
                {#each item.badges as badge, i (i)}
                    {@const badgeIcon = renderBadgeIcon(badge)}
                    <div class="absolute" style="top: {(i + 1) * 1.5}rem; right: 0.25rem;">
                        <span
                            class="{getBadgeVariant(
                                badge.color,
                            )} badge text-xs px-1 flex items-center gap-0.5"
                            title={badge.title}>
                            {#if badgeIcon}
                                <Icon src={badgeIcon} class="w-3 h-3" mini />
                            {/if}
                            {badge.text}
                        </span>
                    </div>
                {/each}
            {/if}

            <!-- Footer Slot (e.g., for user avatars in sessions) -->
            {@render footer?.()}
        </div>

        <!-- Title -->
        <p
            data-media-card-title
            title={item.title}
            class="text-sm text-white truncate mt-1 transition-colors {isHovered
                ? hoverTextColor
                : ''}">
            {#if item.mediaType === 'track' && ((item.artists?.length ?? 0) > 0 || (item.remixerArtists?.length ?? 0) > 0)}
                <TrackTitleLine
                    title={item.title}
                    artists={item.artists}
                    remixerArtists={item.remixerArtists} />
            {:else}
                {item.title}
            {/if}
        </p>

        {#if formatSeriesCounts(item, item.mediaType)}
            <p class="text-hint truncate" title={formatSeriesCounts(item, item.mediaType)}>
                {formatSeriesCounts(item, item.mediaType, !showSeriesCountBadge)}
            </p>
        {/if}

        <!-- Subtitle: non-entertainment uses custom metadata template -->
        {#if isNonEntertainment(item.mediaType) && item.customMetadata}
            {@const tpl = getLibraryTypeTemplate(item.mediaType)}
            {#if tpl}
                <p class="text-hint truncate">
                    {renderSubtitleTemplate(tpl.cardConfig.subtitleTemplate, item.customMetadata)}
                </p>
            {:else if item.subtitle}
                <p class="text-hint truncate">{item.subtitle}</p>
            {/if}
        {:else if item.year && item.genres && item.genres.length > 0}
            <p class="text-hint truncate">
                {item.year} • {item.genres[0]}
            </p>
        {:else if item.year && displaySubtitle}
            {#if hasClickableArtist}
                <p
                    data-media-card-subtitle
                    class="text-hint truncate"
                    title="{item.year} · {displaySubtitle}">
                    {item.year} ·
                    <button
                        class="hover:text-primary-400 hover:underline transition-colors {isHovered
                            ? 'text-primary-400/70'
                            : ''}"
                        onclick={handleArtistClick}
                        title={displaySubtitle}>{displaySubtitle}</button>
                </p>
            {:else}
                <p
                    data-media-card-subtitle
                    class="text-hint truncate"
                    title="{item.year} · {displaySubtitle}">
                    {item.year} · {displaySubtitle}
                </p>
            {/if}
        {:else if item.year}
            <p class="text-hint truncate">{item.year}</p>
        {:else if displaySubtitle}
            {#if hasClickableArtist}
                <button
                    data-media-card-subtitle
                    class="text-hint truncate block max-w-full text-left hover:text-primary-400 hover:underline transition-colors {isHovered
                        ? 'text-primary-400/70'
                        : ''}"
                    onclick={handleArtistClick}
                    title={displaySubtitle}>
                    {displaySubtitle}
                </button>
            {:else}
                <p data-media-card-subtitle class="text-hint truncate" title={displaySubtitle}>
                    {displaySubtitle}
                </p>
            {/if}
        {:else if item.reason}
            <!-- Recommendation reasons are full sentences ("Matches your taste in
                 Action films") — a single-line truncate cut every card off at the
                 same useless prefix, so allow two lines before clamping. -->
            <p class="text-hint line-clamp-2" title={item.reason}>
                {item.reason}
            </p>
        {/if}
    </div>

    <!-- ======================================================================= -->
    <!-- BACKDROP VARIANT (for Continue Watching / Next Up) -->
    <!-- ======================================================================= -->
{:else if variant === 'backdrop'}
    <div
        class="relative {cardWidth} shrink-0 group cursor-pointer card-touch-root"
        data-drag-scroll-allow
        draggable={trackDragEnabled}
        ondragstart={handleTrackDragStart}
        ondragend={handleTrackDragEnd}
        oncontextmenu={handleNativeContextMenu}
        onmouseenter={() => {
            if (hasHover) isPointerHovered = true;
        }}
        onmouseleave={() => (isPointerHovered = false)}
        onfocusin={() => (hasFocusWithin = true)}
        onfocusout={(event) => {
            if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
            ) {
                hasFocusWithin = false;
            }
        }}
        onclick={handleClick}
        onkeydown={handleKeypress}
        role="button"
        tabindex="0">
        <div class="relative {aspectClass} rounded-lg overflow-hidden bg-surface-700">
            {#if backdropSlotSrc && !imageError}
                {#if isAudiobookItem}
                    <!-- Pillarbox. An audiobook cover is a 2:3 PORTRAIT image and
                         this slot is 16:9 LANDSCAPE (the CW/Next-Up rail is a
                         backdrop-variant row). `object-cover` would crop the cover
                         to a horizontal band through its middle — title and author
                         art sliced off — and `object-fit: fill` would stretch it.
                         So: show the whole cover with `object-contain`, and fill the
                         two side gutters with a blurred, over-scaled, darkened copy
                         of the cover itself. Reads as a deliberate treatment rather
                         than letterbox bars, keeps the row's height rhythm (the box
                         stays 16:9, so audiobooks and episodes line up), and is the
                         same pattern LiveSessionSection already uses for square
                         album art in a video-shaped slot. -->
                    <img
                        src={backdropSlotSrc}
                        alt=""
                        aria-hidden="true"
                        class="absolute inset-0 w-full h-full object-cover scale-150 blur-2xl brightness-50"
                        loading={priority ? 'eager' : 'lazy'}
                        decoding="async" />
                    <img
                        src={backdropSlotSrc}
                        srcset={!isAudiobookItem && internalUuid
                            ? getCatalogPosterSrcSet(internalUuid)
                            : undefined}
                        sizes="(max-width: 640px) 110px, (max-width: 1024px) 150px, 215px"
                        width={200}
                        height={300}
                        alt={item.title}
                        class="absolute inset-0 h-full mx-auto object-contain drop-shadow-lg transition-transform duration-300 {isHovered
                            ? 'scale-105'
                            : ''}"
                        loading={priority ? 'eager' : 'lazy'}
                        decoding="async"
                        fetchpriority={priority ? 'high' : undefined}
                        onerror={handleImageError} />
                {:else}
                    <img
                        src={backdropSlotSrc}
                        srcset={!isAudiobookItem && internalUuid
                            ? isEpisode(item.mediaType)
                                ? getCatalogThumbSrcSet(internalUuid)
                                : getCatalogBackdropSrcSet(internalUuid)
                            : undefined}
                        sizes={backdropSizesFor(layout, cardWidth)}
                        width={intrinsicSize.width}
                        height={intrinsicSize.height}
                        alt={item.title}
                        class="w-full h-full object-cover transition-transform duration-300 {isHovered
                            ? 'scale-110'
                            : ''}"
                        style:background-image={backdropBlurDataUrl
                            ? `url(${backdropBlurDataUrl})`
                            : posterBlurDataUrl
                              ? `url(${posterBlurDataUrl})`
                              : undefined}
                        style:background-size={backdropBlurDataUrl || posterBlurDataUrl
                            ? 'cover'
                            : undefined}
                        loading={priority ? 'eager' : 'lazy'}
                        decoding="async"
                        fetchpriority={priority ? 'high' : undefined}
                        onerror={handleImageError} />
                {/if}
            {:else}
                <div class="w-full h-full flex items-center justify-center p-4">
                    <span
                        class="text-white/70 font-medium text-base text-center leading-snug break-words line-clamp-3">
                        {item.title}
                    </span>
                </div>
            {/if}

            <!-- Progress Bar -->
            {#if !item.isPlayed && item.progress && item.progress > 0}
                <div class="absolute bottom-0 left-0 right-0 h-1 bg-gray-800/80">
                    <div
                        class="h-full bg-red-600 {skipTransition
                            ? ''
                            : 'transition-[width] duration-[5s] ease-linear'}"
                        style="width: {item.progress}%">
                    </div>
                </div>
            {/if}

            <!-- Hover Overlay -->
            {#if isHovered}
                <div class="absolute inset-0 bg-black/60 center pointer-events-none">
                    <!-- Custom overlay content slot (for technical info, etc.) -->
                    {#if overlay}{@render overlay({ isHovered })}{:else}
                        <!-- Default: Play button -->
                        <button
                            data-play-button
                            class="bg-gray-900/70 backdrop-blur-sm rounded-full p-2 shadow-lg hover:scale-110 hover:bg-gray-800/80 transition-all border border-white/20 pointer-events-auto"
                            onclick={handlePlay}>
                            <BrandedPlayIcon size="w-6 h-6" />
                        </button>
                    {/if}
                </div>
            {/if}

            {@render legacyDismiss()}

            <!-- Suspicion Indicator (top-left). Appears on CW/NU cards whose
                 watch state was recorded inside a bulk-mark sync window.
                 Clicking opens the same context menu that the long-press /
                 ⋯ button uses, so the user can confirm (mark watched) or
                 hide. Actions live in the opposite corner, so the warning
                 remains visible on hover. Also gated on at least one of
                 onmarkWatched/onremove being wired: without a handler the
                 menu would open empty and clicking the indicator becomes
                 a dead action. -->
            {#if item.isSuspicious && (onmarkWatched || onremove)}
                <button
                    type="button"
                    class="absolute top-1 left-1 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/90 text-white shadow-lg transition-all hover:scale-110 hover:bg-amber-400"
                    aria-label={m.ui_suspicious_bulk_watch()}
                    title={m.ui_suspicious_bulk_watch()}
                    onpointerdown={stopContextButtonPropagation}
                    ontouchstart={stopContextButtonPropagation}
                    onclick={handleSuspicionIndicator}>
                    <Icon src={ExclamationTriangle} class="h-3.5 w-3.5" />
                </button>
            {/if}

            <!-- Episode Badge (top-left) - hidden when the suspicion
                 indicator is shown so badges don't stack. The
                 suspicion indicator only renders when at least one of
                 onmarkWatched/onremove is wired, so mirror that check here
                 so the episode badge reappears on cards that have no menu
                 handler wired even though item.isSuspicious is set. -->
            {#if isEpisode(item.mediaType) && item.seasonNumber && item.episodeNumber && !(item.isSuspicious && (onmarkWatched || onremove))}
                <div class="absolute top-2 left-2">
                    <span class="badge variant-filled-primary text-xs">
                        S{item.seasonNumber}:E{item.episodeNumber}
                    </span>
                </div>
            {/if}

            <!-- New Badge (freshly-aired episodes; CW/NU rows never set isNew) -->
            {#if !showTouchContextButton && item.isNew}
                <div class="absolute top-2 right-2">
                    <span class="badge variant-filled-tertiary text-xs">{m.card_new()}</span>
                </div>
            {/if}

            <!-- Next Up indicator: shown on CW-row cards whose contextLabel
                 marks them as the "next episode" anchor (no progress bar, no
                 resume). Gives users a single-glance signal that a tap will
                 start something new rather than resume. -->
            {#if !showTouchContextButton && !item.isNew && !item.progress && item.isNextUp}
                <div class="absolute top-2 right-2">
                    <span
                        class="badge variant-soft-primary text-[10px] flex items-center gap-0.5 px-1.5 py-0.5">
                        ▶ Next
                    </span>
                </div>
            {/if}

            {#if showCardContextButton}
                <button
                    bind:this={contextMenuTrigger}
                    type="button"
                    data-preview-suppress
                    aria-haspopup="menu"
                    aria-expanded={!!contextMenuPos}
                    aria-controls={contextMenuPos ? contextMenuId : undefined}
                    class="absolute {(showSeriesCountBadge &&
                        seriesCountBadge(item, item.mediaType)) ||
                    (hasHover && (item.isNew || (!item.progress && item.isNextUp)))
                        ? 'top-8'
                        : 'top-1'} right-1 z-30 flex h-8 w-8 items-center justify-center rounded bg-black/55 text-white/75 transition-colors hover:bg-black/80 hover:text-white focus-visible:outline-2 focus-visible:outline-white active:bg-black/70 active:text-white"
                    aria-label={m.card_actions_aria()}
                    onpointerdown={stopContextButtonPropagation}
                    ontouchstart={handleContextMenuButtonTouchStart}
                    ontouchmove={handleContextMenuButtonTouchMove}
                    ontouchend={handleContextMenuButtonTouchEnd}
                    onclick={handleContextMenuButton}>
                    <Icon src={EllipsisVertical} class="h-4 w-4" />
                </button>
            {/if}

            <!-- Footer Slot -->
            {@render footer?.()}
        </div>

        <!-- Title & Subtitle -->
        <div class="mt-2 px-1">
            <h3 class="text-sm font-medium text-white truncate">
                {#if item.mediaType === 'track' && ((item.artists?.length ?? 0) > 0 || (item.remixerArtists?.length ?? 0) > 0)}
                    <TrackTitleLine
                        title={item.title}
                        artists={item.artists}
                        remixerArtists={item.remixerArtists} />
                {:else}
                    {item.title}
                {/if}
            </h3>
            {#if displaySubtitle}
                {#if hasClickableArtist}
                    <button
                        class="text-hint truncate block max-w-full text-left hover:text-primary-400 hover:underline transition-colors {isHovered
                            ? 'text-primary-400/70'
                            : ''}"
                        onclick={handleArtistClick}
                        title={displaySubtitle}>
                        {displaySubtitle}
                    </button>
                {:else}
                    <p class="text-hint truncate">{displaySubtitle}</p>
                {/if}
            {:else if item.seriesName}
                <p class="text-hint truncate">{item.seriesName}</p>
            {/if}
            <!-- Context label: short "why is this here" line for CW/NU cards -->
            {#if item.contextLabel}
                <p
                    class="text-[11px] truncate {item.isNextUp
                        ? 'text-primary-300/90'
                        : 'text-surface-400'}"
                    title={item.contextLabel}>
                    {item.contextLabel}
                </p>
            {/if}
        </div>
    </div>

    <!-- ======================================================================= -->
    <!-- LIST VARIANT (for Search Results / Watchlist) -->
    <!-- ======================================================================= -->
{:else if variant === 'list'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="relative media-list-card rounded-lg border border-surface-700 hover:border-surface-600 transition-colors p-3 sm:p-4"
        onmouseenter={() => (isPointerHovered = true)}
        onmouseleave={() => (isPointerHovered = false)}>
        {#if showSeriesCountBadge && seriesCountBadge(item, item.mediaType)}
            {@const countBadge = seriesCountBadge(item, item.mediaType)!}
            <span
                class="absolute top-1 right-1 z-10 rounded-full bg-surface-900/90 px-2 py-0.5 text-xs font-semibold text-white"
                aria-label={countBadge.label}
                title={countBadge.label}>{countBadge.text}</span>
        {/if}
        <div class="flex gap-3 sm:gap-4">
            <!-- Poster Image -->
            <div
                class="{listImageClass} shrink-0 self-start bg-surface-900 relative rounded-lg overflow-hidden cursor-pointer"
                data-drag-scroll-allow
                onclick={handleClick}
                onkeydown={handleKeypress}
                role="button"
                tabindex="0">
                <img
                    src={imageError ? FALLBACK_IMAGE : cardImage || FALLBACK_IMAGE}
                    srcset={!isAudiobookItem && !imageError && internalUuid
                        ? isEpisode(item.mediaType)
                            ? getCatalogThumbSrcSet(internalUuid)
                            : getCatalogPosterSrcSet(internalUuid)
                        : undefined}
                    sizes="(max-width: 639px) 64px, 80px"
                    width={intrinsicSize.width}
                    height={intrinsicSize.height}
                    alt="{item.title} poster"
                    class="w-full h-full object-cover hover:scale-105 transition-transform"
                    style:background-image={posterBlurDataUrl
                        ? `url(${posterBlurDataUrl})`
                        : undefined}
                    style:background-size={posterBlurDataUrl ? 'cover' : undefined}
                    loading={priority ? 'eager' : 'lazy'}
                    decoding="async"
                    fetchpriority={priority ? 'high' : undefined}
                    onerror={handleImageError} />

                <!-- Progress overlay for list items -->
                {#if !item.isPlayed && item.progress && item.progress > 0}
                    <div class="absolute bottom-0 left-0 right-0 h-1 bg-gray-800/80">
                        <div
                            class="h-full bg-red-600 {skipTransition
                                ? ''
                                : 'transition-[width] duration-[5s] ease-linear'}"
                            style="width: {item.progress}%">
                        </div>
                    </div>
                {/if}
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
                <!-- Header Row -->
                <div class="media-list-header flex items-start justify-between gap-3 mb-2">
                    <div class="flex items-center gap-2 flex-wrap">
                        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                        <h3
                            class="list-title tracking-tight font-semibold text-sm sm:text-base cursor-pointer hover:text-primary-300 text-surface-100 flex items-center gap-2"
                            data-drag-scroll-allow
                            onclick={handleClick}
                            onkeydown={handleKeypress}
                            role="button"
                            tabindex="0">
                            <Icon
                                src={isSeries(item.mediaType) || isEpisode(item.mediaType)
                                    ? Tv
                                    : isMusicItem
                                      ? MusicalNote
                                      : isAudiobookItem
                                        ? BookOpen
                                        : Film}
                                class="inline h-4 w-4 shrink-0 opacity-70"
                                aria-hidden="true" />
                            {item.title}
                        </h3>

                        {#if item.year}
                            <span
                                class="media-list-title-year hidden text-xs text-surface-400 font-normal whitespace-nowrap"
                                >{item.year}</span>
                        {/if}

                        <!-- Inline badges (e.g., NEU) -->
                        {#if item.badges && item.badges.length > 0}
                            {#each item.badges as badge, i (i)}
                                {@const badgeIcon = renderBadgeIcon(badge)}
                                <span
                                    class="{getBadgeVariant(
                                        badge.color,
                                    )} badge text-xs px-2 py-0.5 flex items-center gap-1"
                                    title={badge.title}>
                                    {#if badgeIcon}
                                        <Icon src={badgeIcon} class="w-3 h-3" mini />
                                    {/if}
                                    {badge.text}
                                </span>
                            {/each}
                        {/if}
                    </div>

                    <!-- Actions Slot (e.g., remove button) -->
                    {@render actions?.()}
                </div>

                <!-- Subtitle (e.g., episode title) -->
                {#if displaySubtitle}
                    {#if hasClickableArtist}
                        <button
                            class="text-sm text-gray-300 mb-2 hover:text-primary-400 hover:underline transition-colors text-left"
                            onclick={handleArtistClick}>
                            {displaySubtitle}
                        </button>
                    {:else}
                        <p class="text-sm text-gray-300 mb-2">
                            {displaySubtitle}
                        </p>
                    {/if}
                {/if}

                <!-- Fulltext match snippet (for description matches) -->
                {#if item.matchSource === 'overview' && item.matchSnippet}
                    <div
                        class="bg-primary-900/30 border border-primary-700/50 rounded px-2 py-1.5 mb-2">
                        <div class="flex items-center gap-1 text-xs text-primary-400 mb-1">
                            <Icon src={DocumentPlus} class="w-3 h-3" mini />
                            <span>{m.card_match_description()}</span>
                        </div>
                        <p class="text-sm text-gray-300 italic line-clamp-2">
                            {#if item.highlightedMatchSnippet}
                                {@html safeHighlightedSnippet(item.highlightedMatchSnippet)}
                            {:else}
                                {item.matchSnippet}
                            {/if}
                        </p>
                    </div>
                {:else if item.matchSource === 'keyword'}
                    <div class="text-hint text-yellow-400 mb-2">
                        {m.card_match_keyword()}
                    </div>
                {:else if item.matchSource === 'actor'}
                    <div class="text-hint text-green-400 mb-2">
                        {m.card_match_actor()}
                    </div>
                {:else if item.matchSource === 'director'}
                    <div class="text-hint text-purple-400 mb-2">
                        {m.card_match_director()}
                    </div>
                {/if}

                <!-- Overview -->
                {#if item.overview}
                    <p
                        class="text-xs sm:text-sm leading-relaxed text-surface-300 mb-3 line-clamp-2">
                        {item.overview}
                    </p>
                {/if}

                <div class="media-list-footer contents">
                    <!-- Ratings Row -->
                    <div class="media-list-metadata flex items-center gap-3 mb-3 flex-wrap">
                        {#if item.rating && formatRating(item.rating)}
                            <div class="flex items-center gap-1" title={m.card_rating_title()}>
                                <Icon src={Star} class="h-3.5 w-3.5 text-yellow-400 inline" solid />
                                <span class="text-sm text-gray-300">
                                    {formatRating(item.rating)}
                                </span>
                            </div>
                        {/if}

                        {#if item.letterboxdRating}
                            <Tooltip text={m.rating_letterboxd()} position="top" fixed>
                                <div class="flex items-center gap-1">
                                    <span class="text-orange-500 font-bold text-xs">LB</span>
                                    <span class="text-sm text-gray-300"
                                        >{Number(item.letterboxdRating).toFixed(1)}</span>
                                </div>
                            </Tooltip>
                        {/if}

                        {#if item.criticRating}
                            <Tooltip text="Rotten Tomatoes Critics" position="top" fixed>
                                <div class="flex items-center gap-1">
                                    <span class="text-red-400 font-bold text-xs">RT</span>
                                    <span class="text-sm text-gray-300">{item.criticRating}%</span>
                                </div>
                            </Tooltip>
                        {/if}

                        {#if item.audienceRating}
                            <Tooltip text="Rotten Tomatoes Audience" position="top" fixed>
                                <div class="flex items-center gap-1">
                                    <span class="text-red-400 font-bold text-xs">AUD</span>
                                    <span class="text-sm text-gray-300"
                                        >{item.audienceRating}%</span>
                                </div>
                            </Tooltip>
                        {/if}

                        {#if item.malScore}
                            <Tooltip text="MyAnimeList Score" position="top" fixed>
                                <div class="flex items-center gap-1">
                                    <span class="text-blue-500 font-bold text-xs">MAL</span>
                                    <span class="text-sm text-gray-300"
                                        >{Number(item.malScore).toFixed(1)}</span>
                                </div>
                            </Tooltip>
                        {/if}

                        {#if formatSeriesCounts(item, item.mediaType)}
                            <span class="text-caption"
                                >{formatSeriesCounts(item, item.mediaType)}</span>
                        {/if}
                        {#if item.durationMs}
                            <span class="text-caption"
                                >{Math.round(item.durationMs / 60_000)} Min.</span>
                        {/if}

                        {#if item.year}
                            <span class="media-list-footer-year text-caption">{item.year}</span>
                        {/if}

                        {#if item.releaseDate}
                            <span class="text-caption">
                                {formatReleaseDate(item.releaseDate)}
                            </span>
                        {/if}
                    </div>

                    <!-- Action Buttons Row -->
                    <div class="media-list-actions flex items-center gap-3 flex-wrap">
                        {#if isMusicItem}
                            <button
                                data-play-button
                                class="btn btn-sm variant-filled-primary"
                                onclick={handlePlay}>
                                ▶ {m.card_play()}
                            </button>
                        {:else if item.isAvailable && (isBookType || item.externalIds?.internal)}
                            <button
                                data-play-button
                                class="btn btn-sm variant-filled-primary"
                                onclick={handlePlay}>
                                {#if isBookType}
                                    📖 {m.card_read()}
                                {:else}
                                    ▶ {m.card_play()}
                                {/if}
                            </button>
                            <!-- "Available" is meaningless for books: every Kavita row is
                             by definition available, so the badge is pure noise there. -->
                            {#if !isBookType}
                                <span class="text-hint text-green-400 flex items-center gap-1">
                                    ✓ {m.card_available()}
                                </span>
                            {/if}
                        {:else if item.canRequest && hasRequestPermission && requestsConfigured}
                            <button
                                class="btn btn-sm variant-ghost-primary hover:variant-filled-primary transition-colors"
                                onclick={(e) => {
                                    e.stopPropagation();
                                    onrequest?.(item);
                                }}>
                                📝 {m.request()}
                            </button>
                        {/if}

                        {#if showWatchlistButton && (isMovie(item.mediaType) || isSeries(item.mediaType))}
                            <button
                                class="btn btn-sm {isInWatchlist
                                    ? 'variant-filled-warning'
                                    : 'variant-ghost-surface hover:variant-filled-warning'} transition-colors"
                                onclick={handleWatchlist}
                                disabled={isWatchlistLoading}
                                title={isInWatchlist ? m.watchlist_remove() : m.watchlist_add()}>
                                {#if isWatchlistLoading}
                                    <div
                                        class="w-4 h-4 border-2 border-current opacity-50 border-t-transparent rounded-full animate-spin">
                                    </div>
                                {:else}
                                    <Icon
                                        src={Bookmark}
                                        class="w-4 h-4 {isInWatchlist ? 'fill-current' : ''}" />
                                {/if}
                            </button>
                        {/if}

                        <!-- Books are external Kavita rows — not addable to media playlists
                         (Search's handleItemAddToPlaylist skips them), so don't offer
                         a button that would do nothing. -->
                        {#if showAddButton && !isBookType}
                            <button
                                class="btn btn-sm {isInPlaylist
                                    ? 'variant-filled-success'
                                    : 'variant-filled-tertiary'}"
                                onclick={handleAddToPlaylist}
                                disabled={isInPlaylist}
                                title={isInPlaylist
                                    ? m.card_already_in_playlist()
                                    : m.card_add_to_playlist()}>
                                {#if isInPlaylist}
                                    <Icon src={Check} class="w-4 h-4 mr-1" />
                                    {m.card_added()}
                                {:else}
                                    + {m.card_add()}
                                {/if}
                            </button>
                        {/if}

                        <!-- No "Similar" for books either: handleItemMore only acts on
                         movies/series, so the button would be inert on a book row. -->
                        {#if showMoreButton && !isMusicItem && !isTvChannelItem && !isBookType}
                            <button
                                class="btn btn-sm variant-ghost-surface hover:variant-filled-primary transition-colors"
                                onclick={handleMore}
                                title={m.card_similar_titles()}>
                                <Icon src={Sparkles} class="w-4 h-4" />
                                <span class="ml-1">{m.card_similar()}</span>
                            </button>
                        {/if}
                    </div>
                </div>
            </div>
        </div>
    </div>
{/if}

<!-- Desktop right-click / touch ⋯ context menu (rendered at root, fixed-positioned) -->
{#if contextMenuPos}
    <ContextMenu
        id={contextMenuId}
        x={contextMenuPos.x}
        y={contextMenuPos.y}
        title={item.title}
        subtitle={quickPickLabel}
        items={menuItemsCache}
        mobileSheet={showTouchContextButton}
        onClose={closeContextMenu} />
{/if}

<!--
    "Set my progress" picker — rendered inline so the right-click menu can
    open it without the host page wiring a callback through StandardSection /
    SectionRenderer. {#if} keeps the modal markup out of the DOM until first
    open so 30+ idle CW cards don't each pay for unmounted modal scaffolding.
-->
{#if setProgressSeriesId && setProgressOpen}
    <SetSeriesProgressModal
        open={setProgressOpen}
        seriesId={setProgressSeriesId}
        seriesTitle={setProgressSeriesTitle}
        onClose={() => (setProgressOpen = false)}
        onSaved={() => (setProgressOpen = false)} />
{/if}

{#if ratingModalOpen}
    <RatingPickerModal
        open={ratingModalOpen}
        title={item.title}
        externalIds={item.externalIds}
        mediaType={isSeries(item.mediaType) ? 'series' : 'movie'}
        onClose={() => (ratingModalOpen = false)} />
{/if}

{#if fileInfoModalOpen && item.externalIds?.internal}
    <MediaFileInfoModal
        open={fileInfoModalOpen}
        mediaId={item.externalIds.internal}
        includeChildren={isSeries(item.mediaType)}
        title={item.title}
        onClose={() => (fileInfoModalOpen = false)} />
{/if}

{#if whyHereOpen}
    <WhyHereModal
        open={whyHereOpen}
        title={item.title}
        reason={item.reason}
        onClose={() => (whyHereOpen = false)} />
{/if}

<style lang="postcss">
    .cw-dismiss {
        opacity: 0;
        pointer-events: none;
    }

    .card-touch-root:hover .cw-dismiss,
    .card-touch-root:focus-within .cw-dismiss {
        opacity: 1;
        pointer-events: auto;
    }

    .media-list-card {
        background: rgb(var(--color-surface-800-rgb) / 0.45);
    }
    .media-list-card:hover {
        background: rgb(var(--color-surface-800-rgb) / 0.8);
    }
    .list-artwork {
        width: 80px;
        height: 112px;
    }
    .list-artwork.square-artwork {
        height: 80px;
    }
    .list-title {
        overflow-wrap: anywhere;
    }
    .media-list-card :global([role='button']:focus-visible),
    .media-list-card :global(button:focus-visible) {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 3px;
    }
    @media (max-width: 639px) {
        .list-artwork {
            width: 64px;
            height: 90px;
        }
        .list-artwork.square-artwork {
            height: 64px;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .media-list-card,
        .media-list-card img {
            transition: none;
        }
    }
    .line-clamp-2 {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    /* Touch-input behavior for cards:
       - touch-action: manipulation removes the 300ms double-tap-zoom delay
       - suppress iOS callout/selection on the actual touched descendant
       Mouse behavior is unaffected. */
    .card-touch-root {
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
    }

    .card-touch-root,
    .card-touch-root * {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        user-select: none;
    }

    .card-touch-root img {
        -webkit-user-drag: none;
    }

    /* When the card itself is draggable (music track cards), allow the
       browser to initiate the drag from the image element so that
       ondragstart fires on the wrapper div. Without this override,
       -webkit-user-drag:none on img suppresses the drag event entirely
       on WebKit/Blink — the dragstart never reaches the outer div. */
    [draggable='true'].card-touch-root img {
        -webkit-user-drag: auto;
    }
</style>
