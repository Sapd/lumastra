<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	HeroSection.svelte

	Full-featured hero/featured content section with a custom crossfade carousel.
	Each slide plays video via <HeroVideoPlayer> — which decides per item between a
	self-hosted preview (ffmpeg HLS snippet of the real library file), a YouTube
	trailer, or a static backdrop, in that fallback order. Takes section.items as
	UniversalMediaItem[] — data fetching is handled externally.

	Features:
	- Custom crossfade carousel (absolutely-stacked slides, opacity transition)
	- Per-slide <HeroVideoPlayer> mounted ONLY for the active slide (+ one
	  preloaded neighbor) so concurrent ffmpeg transcode sessions stay bounded;
	  rotating away UNMOUNTS the outgoing player → its preview-session is DELETEd
	  and ffmpeg stops.
	- Single shared mute state across slides (proxied to the active player)
	- Logo/title display with fallback
	- Ratings display (IMDB, RT, Letterboxd, etc.)
	- AI suggestion badges and reasoning

	@example
	<HeroSection {section} {muteStore} {storeLoaded} onitemClick={handleClick} />
-->
<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { goto } from '$app/navigation';
    import { AudiobookKindSchema, type AudiobookPersonRef } from '$lib/schemas/api-audiobook';
    import { resolve } from '$lib/paths';
    import { env } from '$env/dynamic/public';
    import { saveReturnPath } from '$lib/stores/playerNavigation';
    import { openMediaModal } from '$lib/utils/modal-utils';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import HeroVideoPlayer from '$lib/components/ui/HeroVideoPlayer.svelte';
    import {
        PlayCircle,
        InformationCircle,
        DocumentPlus,
        Bookmark,
        Star,
        ClipboardDocument,
        ArrowUturnLeft,
        ArrowPath,
        DocumentMagnifyingGlass,
        HandThumbDown,
        HandThumbUp,
        Heart,
        Sparkles,
        WrenchScrewdriver,
        EyeSlash,
    } from 'svelte-hero-icons';
    import RatingPickerModal from '$lib/components/modal/RatingPickerModal.svelte';
    import MediaFileInfoModal from '$lib/components/modal/MediaFileInfoModal.svelte';
    import WhyHereModal from '$lib/components/modal/WhyHereModal.svelte';
    import {
        copyMediaLink,
        markMediaUnwatched,
        refreshMediaMetadata,
        toggleWatchlistMedia,
        canWatchlistMedia,
        canRateMedia,
        quickRateMedia,
        buildMediaShareId,
        isPageAdmin,
    } from '$lib/utils/media-context-actions';
    import { watchlistItems } from '$lib/stores/watchlist';
    import { lessLikeThis } from '$lib/api/for-you';
    import { toasts } from '$lib/stores/toast.store';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import { buildQualityChips, qualitySummaryFromTiers } from '$lib/utils/quality-chips';
    import type { Writable } from 'svelte/store';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import type { HeroFirstSlide } from '$lib/schemas/hero';
    import { page } from '$app/stores';
    import { convertSecondsToHoursAndMinutes } from '../../../utility';
    import {
        imageFromIds,
        getCatalogPosterUrl,
        getCatalogBackdropSrcSet,
        getCatalogBackdropUrl,
    } from '$lib/utils/image-utils';
    import { createRenderableMediaKeys } from '$lib/utils/media-id-helpers';
    import { getPreferredExternalId, getExternalIdFor } from '$lib/utils/external-ids';
    import * as m from '$lib/paraglide/messages';
    import { formatSeriesCounts } from '$lib/utils/series-episode-counts';
    import { isMovie, isSeries, isEpisode, isAudiobook } from '$lib/shared/media-types';
    import { toMovieOrSeries } from '$lib/shared/media-type-domain';
    import { FALLBACK_IMAGE } from '$lib/constants/images';

    import {
        nextIndex,
        prevIndex,
        clampIndex,
        shouldAutoplay,
        resumeLabel,
        slideKeysEqual,
        heroImageSlots,
    } from '$lib/utils/hero-carousel';
    import { blurhashToCssBackground } from '$lib/utils/blurhash-client';
    import { heroAutoplayVideo } from '$lib/stores/uiPreferences';
    import { watchUserIdle } from '$lib/utils/user-idle';
    import { audiobookStartFailureMessage, playAudiobook } from '$lib/services/audiobook-playback';
    import { continueTargetFor, resolveMediaPlayTarget } from '$lib/utils/media-play-target';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The section data to render */
        section: PageSection;
        /**
         * SSR first slide from +page.server.ts. When provided and the component
         * mounts with no items yet (client-side build still in-flight), a single
         * minimal UniversalMediaItem is seeded so the hero is visible immediately.
         */
        firstSlide?: HeroFirstSlide;
        /**
         * Live "is this playing right now" map, keyed by internal id AND
         * seriesId, sourced from the same watchingSections the CW carousel
         * consumes (kept fresh over SSE). When it KNOWS an item (key present),
         * it is authoritative — letting the hero flip both ways (→ Playing now,
         * and back → Continue Watching) in lock-step with the carousel. When it
         * doesn't know an item, the hero falls back to the item's own snapshot
         * flag (from the /continue overlay).
         */
        cwLiveState?: Record<string, boolean>;
        /** Mute store for trailer audio control */
        muteStore?: Writable<boolean> | undefined;
        /** Bindable: whether the active slide currently has playable video */
        videoHasAudio?: boolean;
        /**
         * Bindable carousel state exposed so the lifted <HeroControls> row (rendered
         * by the parent page, outside this hero box) can read it. These are written
         * by this component only — the parent binds to observe, never to mutate.
         */
        currentIndex?: number;
        slideCount?: number;
        slideTitles?: string[];
        userPaused?: boolean;
        autoplayActive?: boolean;
        muted?: boolean;
        onitemClick?: (detail: UniversalMediaItem) => void;
        onitemPlay?: (detail: UniversalMediaItem) => void;
        onitemRequest?: (detail: UniversalMediaItem) => void;
    }

    let {
        section,
        firstSlide = undefined,
        cwLiveState = undefined,
        muteStore = undefined,

        videoHasAudio = $bindable(false),
        currentIndex = $bindable(0),
        slideCount = $bindable(0),
        slideTitles = $bindable([]),
        userPaused = $bindable(false),
        autoplayActive = $bindable(false),
        muted = $bindable(true),
        onitemClick,
        onitemPlay,
        onitemRequest,
    }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    // Seed the first slide at init so SSR renders one slide in the HTML.
    // Top-level script runs during SSR; $effect does NOT — so seeding here
    // is the only way to get the slide into server-rendered HTML.
    function mapFirstSlideToItem(slide: HeroFirstSlide): UniversalMediaItem {
        const internalId = slide.externalIds.internal;
        // For episodes internalId is the episode's own media_id (per HeroFirstSlide
        // schema); the backdrop is series-level, so resolve it via seriesId — an
        // episode id returns null → popcorn placeholder on the first SSR paint.
        const backdropId =
            isEpisode(slide.mediaType) && slide.seriesId ? slide.seriesId : internalId;
        // Must match the `size` hero-builder.ts's transformNextUpItem requests for
        // the same slide (also 'full') — hero-builder.ts is what replaces this SSR
        // seed once the client-side rebuild resolves. A mismatched size changes the
        // <img> src on that swap, forcing a reload. For Jellyfin/TMDB-backed
        // backdrops that's a harmless no-op (both sizes collapse to "unconstrained"
        // server-side and hit the same warm cache), but AudiobookShelf covers snap
        // named presets to distinct disk-cache keys (`wide`→960px, `full`→original)
        // — a mismatch there is a guaranteed cache MISS, forcing a live fetch to the
        // AudiobookShelf server + a Sharp resize on every hydration, which visibly
        // blanks the poster (see HeroSection.svelte's poster-flash bug).
        const artworkUrl = isAudiobook(slide.mediaType)
            ? getCatalogPosterUrl(internalId, { size: 'full' })
            : getCatalogBackdropUrl(backdropId, { size: 'full' });
        return {
            id: `hero-ssr-seed-${internalId}`,
            externalIds: slide.externalIds,
            mediaType: slide.mediaType as UniversalMediaItem['mediaType'],
            title: slide.title,
            overview: slide.overview,
            customMetadata: slide.customMetadata,
            seriesId: slide.seriesId,
            backdropBlurHash: slide.backdropBlurhash,
            progress: slide.progress !== undefined ? Math.round(slide.progress * 100) : undefined,
            durationMs:
                slide.runtimeMinutes == null ? undefined : Math.round(slide.runtimeMinutes * 60_000),
            seasonCount: slide.seasonCount,
            episodeCount: slide.episodeCount,
            availableEpisodeCount: slide.availableEpisodeCount,
            watchedEpisodeCount: slide.watchedEpisodeCount,
            unwatchedEpisodeCount: slide.unwatchedEpisodeCount,

            isPlaying: slide.isPlaying,
            image: artworkUrl || FALLBACK_IMAGE,
            backdrop: isAudiobook(slide.mediaType) ? undefined : artworkUrl || FALLBACK_IMAGE,
            isAvailable: true,
            canRequest: false,
        };
    }

    function initialItems(): UniversalMediaItem[] {
        return firstSlide ? [mapFirstSlideToItem(firstSlide)] : [];
    }

    /**
     * Effective "is this slide playing right now". The live CW map (mirrored
     * from the carousel's watchingSections over SSE) is authoritative when it
     * knows the item — so the badge flips BOTH ways in lock-step with the
     * carousel. When the map doesn't know the item (not a CW row, or CW data
     * absent), fall back to the item's own snapshot flag from the /continue
     * overlay. Reading `cwLiveState` here keeps the treatment reactive: when
     * the SSE-driven invalidation refreshes it, the hero re-renders.
     */
    function livePlayingFor(item: UniversalMediaItem): boolean {
        if (cwLiveState) {
            const internal = getExternalIdFor(item.externalIds, 'internal');
            if (internal && Object.hasOwn(cwLiveState, internal))
                return cwLiveState[internal] === true;
            if (item.seriesId && Object.hasOwn(cwLiveState, item.seriesId))
                return cwLiveState[item.seriesId] === true;
        }
        return item.isPlaying === true;
    }

    let items: UniversalMediaItem[] = $state(initialItems());
    let renderItemKeys = $derived(createRenderableMediaKeys(items));

    // =========================================================================
    // Custom crossfade carousel state
    // =========================================================================

    interface HeroCarouselConfig {
        autoplayEnabled: boolean;
        autoplayIntervalMs: number;
        transitionMs: number;
        maxSlides: number;
    }
    const HERO_DEFAULTS: HeroCarouselConfig = {
        autoplayEnabled: true,
        autoplayIntervalMs: 10000,
        transitionMs: 500,
        maxSlides: 5,
    };
    let heroCfg = $derived<HeroCarouselConfig>(
        ($page.data?.hero as HeroCarouselConfig | undefined) ?? HERO_DEFAULTS,
    );

    // currentIndex & userPaused are now $bindable() props (declared above) so the
    // lifted <HeroControls> row in the parent page can read/observe them. They are
    // still written exclusively by this component.
    // Three independent pause sources — combined into a single derived gate so
    // they can't overwrite each other (e.g. focusout while hovering, or
    // hover-leave undoing a manual pause).
    let isHovering = $state(false); // pointer over carousel
    let isFocused = $state(false); // keyboard focus within carousel
    let tabHidden = $state(false); // tab hidden (transient) — must NOT clobber userPaused
    // No input for HERO_IDLE_MS (transient, like tabHidden). A VISIBLE window
    // nobody is looking at never sets tabHidden: prod 2026-09-25 had one such
    // tab rotate for 30h — 5,995 preview-session POSTs and ~25k segment fetches.
    // Idle both stops the rotation AND unmounts the preview players (see
    // heroVideoEnabled), which DELETEs their sessions and ends the heartbeats.
    let userIdle = $state(false);
    const HERO_IDLE_MS = 5 * 60_000;
    const paused = $derived(userPaused || isHovering || isFocused || tabHidden || userIdle);
    let reducedMotion = $state(false);
    let autoplayTimer: ReturnType<typeof setInterval> | null = null;
    let logoExists: boolean[] = $state([]);

    // =========================================================================
    // Hero video orchestration (active-slide-only mount + one preloaded neighbor)
    // =========================================================================

    // Mobile detection — mirror FeaturedPickSection: video is desktop-only.
    const MOBILE_BREAKPOINT = 768;
    let isMobile = $state(browser ? window.innerWidth < MOBILE_BREAKPOINT : true);

    // Single feature flag drives BOTH the self-hosted preview and the YouTube
    // trailer fallback inside HeroVideoPlayer (mirrors FeaturedPickSection's
    // single-flag pattern). Desktop-only.
    // Read the feature flag directly from root-layout SSR page data.
    let heroVideoEnabled = $derived(
        !isMobile && !userIdle && $page.data?.features?.youtubeHero === true && $heroAutoplayVideo,
    );

    // Indices that may mount a <HeroVideoPlayer>: the active slide plus ONE
    // neighbor (the next slide). Bounding this to two entries caps the number of
    // concurrent ffmpeg transcode sessions the hero can spawn. Every other slide
    // shows only its (cheap) backdrop image. When a slide leaves this set on
    // rotation its player is UNMOUNTED — HeroVideoPlayer.onDestroy → cleanup()
    // → unmount(MediaPreviewPlayer) → DELETE /preview-session stops ffmpeg.
    let playerSlots = $derived.by<number[]>(() => {
        const len = items.length;
        if (len === 0) return [];
        const active = clampIndex(currentIndex, len);
        if (len === 1) return [active];
        return [active, nextIndex(active, len)];
    });
    function isPlayerSlot(index: number): boolean {
        return playerSlots.includes(index);
    }

    // Indices whose backdrop <img> is allowed to render: the active slide
    // plus its two neighbours. Every slide sits in the DOM at once
    // (cross-faded via opacity), so without this gate `loading="lazy"`
    // defers nothing — the browser eagerly fetches the 1920w srcset
    // candidate for every off-screen slide on first paint, on the LCP path,
    // for slides nobody has seen. Deliberately WIDER than `playerSlots`:
    // that bounds concurrent transcode sessions, this bounds image bytes.
    let imageSlots = $derived.by<number[]>(() => heroImageSlots(currentIndex, items.length));
    function isImageSlot(index: number): boolean {
        return imageSlots.includes(index);
    }

    // The mounted HeroVideoPlayer instance for the active slide (used to proxy
    // the shared mute state). Bound per-index via the {#each} so it always points
    // at the currently-active slide's player.
    let activePlayer: ReturnType<typeof HeroVideoPlayer> | undefined = $state();

    // Whether the active slide is actually showing video (controls the mute
    // button + the bound `videoHasAudio` the homepage reads). A slide shows video
    // only when the feature is on, the slot is mounted, and the active item is
    // either in-library (preview) or has a trailer URL.
    let activeItemHasVideo = $derived.by<boolean>(() => {
        if (!heroVideoEnabled) return false;
        const item = items[clampIndex(currentIndex, items.length)];
        if (!item) return false;
        if (isAudiobook(item.mediaType)) return false;
        const inLibrary = !!item.externalIds?.internal && item.isAvailable !== false;
        return inLibrary || !!item.trailerUrl;
    });

    // Keep the homepage-bound `videoHasAudio` in lock-step with the active slide.
    // Only write on a real change so the `$bindable(false)` default isn't treated
    // as a provably-dead assignment.
    $effect(() => {
        if (videoHasAudio !== activeItemHasVideo) {
            videoHasAudio = activeItemHasVideo;
        }
    });

    // Right-click context menu state — anchored at the click point and
    // bound to the slide currently underneath the user's cursor.
    let contextMenuPos = $state<{ x: number; y: number } | null>(null);
    let contextMenuItem = $state<UniversalMediaItem | null>(null);
    let ratingModalOpen = $state(false);
    let fileInfoModalOpen = $state(false);
    let whyHereOpen = $state(false);
    let modalTargetItem = $state<UniversalMediaItem | null>(null);

    let isHeroAdmin = $derived(isPageAdmin($page.data));

    // LQIP: decoded reactively per slide (see $effect tracking `items`), hidden
    // via opacity once THAT slide's own backdrop <img> loads. Deliberately
    // per-slide rather than index-0-only: `imageSlots` (active ± 1) matches
    // autoplay/arrows, but the hero's dots jump to an ARBITRARY index
    // (HeroControls.svelte -> `goTo`), which is outside that window. A slide
    // reached that way mounts its <img> for the first time exactly when it
    // becomes visible, and with no placeholder the cross-fade ran against an
    // empty box until the 1920w fetch landed. The blurhash is an inline data:
    // URI (no network request), so decoding it for every slide costs nothing
    // per slide — only a handful of tiny (32x18) canvas decodes.
    let lqipBackgrounds = $state<(string | null)[]>([]);
    let imageLoaded = $state<boolean[]>([]);
    // Bound to each slide's <img> so a cached image (.complete already true
    // before our onload handler attaches) is detected immediately, per slide.
    let slideImgEls = $state<(HTMLImageElement | null)[]>([]);

    /** Whether autoplay was running when the menu was opened. We only
     * restart autoplay on close if it was running before — the user may
     * have already stopped rotation deliberately (e.g. by opening the
     * detail modal first), and a context menu shouldn't second-guess
     * that. */
    let autoplayWasRunning = false;
    /** Set inside any menu onSelect that consumes the user's action so
     * the close handler knows not to resume autoplay underneath. */
    let menuSelectionConsumed = false;

    /** Wrap an onSelect so it flags the close handler not to resume
     * autoplay. Used for every action that has any side effect. */
    function consumed(fn: () => void): () => void {
        return () => {
            menuSelectionConsumed = true;
            fn();
        };
    }

    let heroMenuItems: ContextMenuEntry[] = $derived.by(() => {
        const target = contextMenuItem;
        if (!target) return [];
        const out: ContextMenuEntry[] = [];
        const playable = resolveMediaPlayTarget(target).kind !== 'delegate';
        if (target.isAvailable && playable) {
            out.push({
                label: m.card_play(),
                icon: PlayCircle,
                onSelect: consumed(() => handlePlay(target)),
            });
        } else if (target.canRequest && $page.data?.user?.hasRequestPermission !== false) {
            out.push({
                label: m.request(),
                icon: DocumentPlus,
                onSelect: consumed(() => onitemRequest?.(target)),
            });
        }
        out.push({
            label: m.card_open_details(),
            icon: InformationCircle,
            onSelect: consumed(() => openDescription(target)),
        });
        if (typeof target.reason === 'string' && target.reason.trim().length > 0) {
            out.push({
                label: m.card_why_here(),
                icon: Sparkles,
                onSelect: consumed(() => {
                    modalTargetItem = target;
                    whyHereOpen = true;
                }),
            });
        }
        const isVideo =
            isMovie(target.mediaType) || isSeries(target.mediaType) || isEpisode(target.mediaType);
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
                onSelect: consumed(() => {
                    void toggleWatchlistMedia(target, {
                        isInWatchlist: inWatchlist,
                    });
                }),
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
                        onSelect: consumed(() => {
                            void quickRateMedia(target, 'dislike');
                        }),
                    },
                    {
                        icon: HandThumbUp,
                        label: m.card_liked(),
                        accent: 'positive',
                        onSelect: consumed(() => {
                            void quickRateMedia(target, 'liked');
                        }),
                    },
                    {
                        icon: Heart,
                        label: m.card_loved(),
                        accent: 'love',
                        onSelect: consumed(() => {
                            void quickRateMedia(target, 'loved');
                        }),
                    },
                ],
            });
            out.push({
                label: m.card_rate_this(),
                icon: Star,
                onSelect: consumed(() => {
                    modalTargetItem = target;
                    ratingModalOpen = true;
                }),
            });
        }
        // "Show less like this" — soft, decaying neighborhood steering (not a
        // rating). Movies/series only.
        if (isMovie(target.mediaType) || isSeries(target.mediaType)) {
            out.push({
                label: m.card_less_like_this(),
                icon: EyeSlash,
                onSelect: consumed(() => {
                    void handleHeroLessLikeThis(target);
                }),
            });
        }
        if (target.isPlayed && target.externalIds?.internal && isVideo) {
            out.push({
                label: m.card_mark_unwatched(),
                icon: ArrowUturnLeft,
                onSelect: consumed(() => {
                    void markMediaUnwatched(target);
                }),
            });
        }
        if (buildMediaShareId(target) !== null) {
            out.push({
                label: m.card_copy_link(),
                icon: ClipboardDocument,
                onSelect: consumed(() => {
                    void copyMediaLink(target);
                }),
            });
        }
        if (isHeroAdmin && target.externalIds?.internal && isVideo) {
            out.push({
                label: m.card_file_info(),
                icon: DocumentMagnifyingGlass,
                hideOnMobile: true,
                onSelect: consumed(() => {
                    modalTargetItem = target;
                    fileInfoModalOpen = true;
                }),
            });
            out.push({
                label: m.card_refresh_metadata(),
                icon: ArrowPath,
                hideOnMobile: true,
                onSelect: consumed(() => {
                    void refreshMediaMetadata(target);
                }),
            });
            const adminTargetId =
                isEpisode(target.mediaType) && target.seriesId
                    ? target.seriesId
                    : target.externalIds.internal;
            out.push({
                label: m.card_open_in_admin(),
                icon: WrenchScrewdriver,
                hideOnMobile: true,
                onSelect: consumed(() => {
                    if (typeof window === 'undefined') return;
                    window.open(
                        `/admin/library/media/${encodeURIComponent(adminTargetId)}`,
                        '_blank',
                        'noopener,noreferrer',
                    );
                }),
            });
        }
        return out;
    });

    async function handleHeroLessLikeThis(target: UniversalMediaItem): Promise<void> {
        if (!target.externalIds) return;
        const mediaType = toMovieOrSeries(target.mediaType);
        // `lessLikeThis` writes a taste damper against a RECOMMENDER entity,
        // and the recommender only models movies and series. The old
        // `toPublicMovieOrSeries` answered 'movie' here, so "Less like this"
        // on an audiobook or a track recorded a damper against a MOVIE
        // carrying that item's external ids: it damped an unrelated title and
        // left the actual item unaffected. Bail instead of guessing.
        if (mediaType === null) return;
        const { error } = await lessLikeThis({
            externalIds: target.externalIds,
            mediaType,
            title: target.title,
        });
        if (!error) {
            toasts.info(m.card_less_like_this_done());
        }
    }

    function openHeroContextMenu(e: MouseEvent, item: UniversalMediaItem): void {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, select, textarea')) return;
        e.preventDefault();
        e.stopPropagation();
        autoplayWasRunning = autoplayTimer !== null;
        menuSelectionConsumed = false;
        // Pause rotation while the menu is open.
        userPaused = true;
        startAutoplay();
        contextMenuItem = item;
        contextMenuPos = { x: e.clientX, y: e.clientY };
    }

    function closeHeroContextMenu(): void {
        contextMenuPos = null;
        contextMenuItem = null;
        // Resume only when the menu was dismissed without a pick.
        if (autoplayWasRunning && !menuSelectionConsumed) {
            userPaused = false;
            startAutoplay();
        }
        autoplayWasRunning = false;
        menuSelectionConsumed = false;
    }

    // `muted` is a $bindable() prop (declared above) — single shared mute state,
    // proxied to the active player and mirrored back from its own toggle.

    // Track touch/mouse to differentiate swipe from tap
    let touchStartX = 0;
    let touchStartY = 0;
    let isSwiping = false;
    // Horizontal travel (px) needed to commit a swipe to the next/prev slide.
    const SWIPE_THRESHOLD = 50;

    function onSwipePointerDown(e: PointerEvent): void {
        // Ignore non-primary buttons (e.g. right-click opens the context menu).
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        // NEVER setPointerCapture() here. An active capture makes the browser
        // retarget the compatibility mouse events, so the follow-up `click` is
        // dispatched on the CAPTURE ELEMENT (this carousel) instead of on the
        // element under the cursor — which silently kills every click inside
        // the hero: the Play/Resume <a>, the request <a>, the audiobook
        // <button> and the "open details" wrapper are all descendants, and the
        // <a>'s own default navigation is suppressed too. The native image drag
        // that capture was added to defeat is already handled the right way, by
        // making the artwork undraggable (`draggable="false"` on the backdrop
        // <img> plus `-webkit-user-drag: none` on hero imagery in the styles
        // below), so no dragstart ever fires to steal the pointerup.
        touchStartX = e.clientX;
        touchStartY = e.clientY;
        isSwiping = false;
    }

    function onSwipePointerUp(e: PointerEvent): void {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        const dx = e.clientX - touchStartX;
        const dy = e.clientY - touchStartY;
        // Only treat predominantly-horizontal drags past the commit threshold
        // as a swipe; vertical/short movement falls through to click/tap.
        if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            isSwiping = true;
            if (dx < 0) {
                next();
            } else {
                prev();
            }
        }
    }

    function onSwipePointerCancel(): void {
        isSwiping = false;
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    // Captured handler refs so onDestroy can detach them.
    let reducedMotionMq: MediaQueryList | null = null;
    let onReducedMotionChange: ((e: MediaQueryListEvent) => void) | null = null;
    let onVisibilityChange: (() => void) | null = null;
    let onResize: (() => void) | null = null;
    let stopIdleWatch: (() => void) | null = null;

    onMount(() => {
        stopIdleWatch = watchUserIdle(HERO_IDLE_MS, (idle) => {
            userIdle = idle;
            startAutoplay();
        });

        // LQIP decode + reset is handled reactively in an $effect that tracks
        // items[0]?.backdropBlurHash (covers SSR-seed → client reconciliation).

        // Track viewport for the desktop-only video gate.
        onResize = () => {
            isMobile = window.innerWidth < MOBILE_BREAKPOINT;
        };
        window.addEventListener('resize', onResize);

        // Detect reduced-motion preference (suppresses autoplay) and react to changes.
        reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion = reducedMotionMq.matches;
        onReducedMotionChange = (e: MediaQueryListEvent) => {
            reducedMotion = e.matches;
            startAutoplay();
        };
        reducedMotionMq.addEventListener('change', onReducedMotionChange);

        // Pause autoplay when the tab is hidden, resume when visible again.
        // Uses the transient `tabHidden` flag (NOT userPaused) so returning to
        // the tab can't silently undo an explicit user pause.
        onVisibilityChange = () => {
            tabHidden = document.hidden;
            startAutoplay();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Subscribe to mute store if provided. The store is the single source of
        // truth across slides; on change we proxy it to the active slide's player.
        if (muteStore) {
            let isFirstSubscription = true;
            const unsubMute = muteStore.subscribe((value: boolean) => {
                const wasMuted = muted;
                muted = value;

                // Only stop autoplay when the user actively unmutes to watch a
                // video (not on initial subscription or when muting).
                if (!isFirstSubscription && wasMuted && !value) {
                    userPaused = true;
                    startAutoplay();
                }
                isFirstSubscription = false;

                // Proxy the shared mute state to the active player. HeroVideoPlayer
                // reflects the global exclusive-audio owner and exposes
                // toggleMute()/getMuted(); only toggle when they diverge so we
                // don't fight its own onMuteChange callback.
                try {
                    if (activePlayer && activePlayer.getMuted() !== value) {
                        activePlayer.toggleMute();
                    }
                } catch {
                    /* expected: player may not be ready yet */
                }
            });
            return () => unsubMute();
        }
    });

    // Cleanup carousel timers and listeners on component destroy
    onDestroy(() => {
        stopAutoplay();
        stopIdleWatch?.();
        if (reducedMotionMq && onReducedMotionChange) {
            reducedMotionMq.removeEventListener('change', onReducedMotionChange);
        }
        if (onVisibilityChange) {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (onResize) {
            window.removeEventListener('resize', onResize);
        }
    });

    // When the active player's own mute UI changes (e.g. its internal toggle),
    // mirror it back into the shared store so all slides agree.
    function handleActiveMuteChange(nextMuted: boolean): void {
        muted = nextMuted;
        if (muteStore) muteStore.set(nextMuted);
    }

    // Reconcile a freshly-mounted active player (carousel rotation / manual nav)
    // to the shared mute state. Each HeroVideoPlayer starts muted (exclusive-audio
    // default), so without this a slide change while the hero is unmuted would
    // leave the new slide silent yet still show an "unmuted" icon.
    //
    // The ONLY dependency is `activePlayer` identity — the getMuted()/muted reads
    // are untracked. getMuted() transitively reads the GLOBAL audio owner, so
    // tracking it would re-run this effect whenever ANY other player claims audio
    // and — racing the local `muted` update — re-claim audio back to the hero,
    // silencing the player the user just unmuted. Ongoing muted changes are
    // already proxied to the active player by the muteStore subscription above.
    $effect(() => {
        const player = activePlayer;
        if (!player) return;
        untrack(() => {
            try {
                if (player.getMuted() !== muted) {
                    player.toggleMute();
                }
            } catch {
                /* expected: player may not be ready yet */
            }
        });
    });

    export function toggleMute(): void {
        if (!muteStore) {
            // No shared store — toggle the active player directly.
            try {
                activePlayer?.toggleMute();
            } catch {
                /* expected: player may not be ready */
            }
            return;
        }
        muteStore.set(!muted);
    }

    // =========================================================================
    // Autoplay control (interval-driven slide rotation)
    // =========================================================================

    function startAutoplay() {
        stopAutoplay();
        if (!browser) return;
        if (!shouldAutoplay(items.length, heroCfg.autoplayEnabled, reducedMotion) || paused) {
            return;
        }
        autoplayTimer = setInterval(() => {
            goTo(nextIndex(currentIndex, items.length));
        }, heroCfg.autoplayIntervalMs);
    }

    function stopAutoplay() {
        if (autoplayTimer) {
            clearInterval(autoplayTimer);
            autoplayTimer = null;
        }
    }

    export function next(): void {
        goTo(nextIndex(currentIndex, items.length));
    }
    export function prev(): void {
        goTo(prevIndex(currentIndex, items.length));
    }
    export function goTo(i: number): void {
        currentIndex = clampIndex(i, items.length);
        // Reset the autoplay timer on every manual/auto change. The player-slot
        // set is derived from currentIndex, so changing it here remounts the
        // active player and unmounts the slide that just rotated out.
        startAutoplay();
    }

    // Exposed for the lifted <HeroControls> WCAG pause/play button.
    export function togglePause(): void {
        userPaused = !userPaused;
        startAutoplay();
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function openDescription(item: UniversalMediaItem) {
        // Opening the detail modal stops rotation underneath it.
        userPaused = true;
        startAutoplay();

        // Get original item data for modal
        const originalItem = item.clickData?.originalItem || {};

        const originalTrailers = (originalItem as { remoteTrailers?: string | string[] })
            .remoteTrailers;
        const remoteTrailers = item.trailerUrl
            ? [item.trailerUrl]
            : typeof originalTrailers === 'string'
              ? [originalTrailers]
              : originalTrailers;

        // Use openMediaModal for consistent data mapping (ensures externalIds, similar movies, social features work)
        openMediaModal(
            {
                ...originalItem,
                title: item.title,
                overview: item.overview,
                // eslint-disable-next-line callback-safety/no-inline-media-type-default -- the hero modal accepts only its video vocabulary.
                mediaType: isAudiobook(item.mediaType)
                    ? 'AUDIOBOOK'
                    : isSeries(item.mediaType)
                      ? 'SERIES'
                      : isEpisode(item.mediaType)
                        ? 'EPISODE'
                        : 'MOVIE',
                externalIds: item.externalIds,
                seriesInternalId: item.seriesId,
                rating:
                    typeof item.rating === 'number'
                        ? item.rating
                        : Number.parseFloat(String(item.rating || '0')),
                year: item.year?.toString(),
                genres: item.genres,
                duration: item.durationMs == null ? undefined : item.durationMs / 60_000,
                remoteTrailers: Array.isArray(remoteTrailers) ? remoteTrailers[0] : remoteTrailers,
                canRequest: item.canRequest,
                isAvailable: item.isAvailable,
                // Episode-specific fields
                seriesName: item.seriesName,
                seasonNumber: item.seasonNumber,
                episodeNumber: item.episodeNumber,
                // Additional ratings
                rt_critic: item.criticRating,
                rt_audience: item.audienceRating,
                letterboxd_rating: item.letterboxdRating,
                mdblist_score: item.mdblistScore,
                metacritic_score: item.metacriticScore,
            },
            item.image || item.backdrop || FALLBACK_IMAGE,
        );

        onitemClick?.(item);
    }

    async function handlePlay(item: UniversalMediaItem): Promise<void> {
        const target = resolveMediaPlayTarget(item);
        if (target.kind === 'audiobook') {
            const started = await playAudiobook(target.mediaId);
            if (!started) toasts.error(audiobookStartFailureMessage());
            return;
        }
        if (target.kind === 'watch') {
            saveReturnPath();
            await goto(resolve(`/watch/${continueTargetFor(item) ?? target.playbackId}`));
            return;
        }
        if (item.canRequest) onitemRequest?.(item);
    }

    function handleLogoError(index: number) {
        logoExists[index] = false;
        logoExists = [...logoExists];
    }

    function handleBackdropError(e: Event, item: UniversalMediaItem) {
        const target = e.target as HTMLImageElement;
        if (!target) return;
        // Try the poster once as a fallback for AI suggestions (also with
        // fallback=none so a missing poster 404s instead of redirecting to the
        // popcorn placeholder).
        if (item.isAISuggestion && item.externalIds && !target.dataset.triedPoster) {
            target.dataset.triedPoster = '1';
            // isSeries() accepts BOTH 'tv' and 'series', so the old guard let a
            // 'series' through wearing the 'movie' | 'tv' type and put
            // `tmdb:{id}:series` in the poster composite key. Collapse instead;
            // every non-series token keeps landing on 'movie' as before.
            const mediaType: 'movie' | 'tv' = isSeries(item.mediaType) ? 'tv' : 'movie';
            const posterUrl = imageFromIds(item.externalIds, 'poster', mediaType, {
                size: 'thumb',
            });
            if (posterUrl) {
                target.src = posterUrl + (posterUrl.includes('?') ? '&' : '?') + 'fallback=none';
                return;
            }
        }
        // No real artwork — hide the backdrop so the hero gradient shows through
        // instead of the popcorn placeholder.
        target.style.visibility = 'hidden';
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Whether the item has real backdrop/poster art, as opposed to the
     * generic `popcorn.jpg` placeholder. Hero builders (hero-builder.ts,
     * the SSR seed above) deliberately fill `backdrop`/`image` with
     * FALLBACK_IMAGE when no real art resolves — a fine default for a small
     * grid card, but blown up full-bleed on the hero it reads as a giant
     * stock photo. `isImageSlot` renders nothing (letting the page's own
     * background show through, exactly like the `onerror` 404 path already
     * does) rather than requesting this image at all.
     */
    function hasRealBackdropArt(item: UniversalMediaItem): boolean {
        const url = isAudiobook(item.mediaType) ? item.image : item.backdrop || item.image;
        return !!url && url !== FALLBACK_IMAGE;
    }

    function getBackdropUrl(item: UniversalMediaItem): string {
        // AudiobookShelf provides a cover, not landscape artwork. The poster is
        // the only valid image role, so use it as the static hero artwork rather
        // than requesting the catalog backdrop route (which redirects to the
        // popcorn placeholder).
        const url = isAudiobook(item.mediaType) ? item.image : item.backdrop || item.image;
        if (!url) return '';
        // For video art, fallback=none makes a missing backdrop 404 instead of
        // redirecting to the popcorn placeholder. Audiobooks use their valid
        // poster URL above; their companion `srcset` stays suppressed because
        // those candidates are always backdrop URLs and would 302 to the
        // placeholder. Same trap exists in `+page.svelte`'s preload.
        return url.includes('fallback=')
            ? url
            : url + (url.includes('?') ? '&' : '?') + 'fallback=none';
    }

    function getLogoUrl(item: UniversalMediaItem): string {
        const url = item.logo;
        if (!url) return '';
        // The hero logo is optional decoration. Request it with fallback=none so
        // the image endpoint returns 404 (instead of redirecting to the popcorn
        // placeholder) when no logo artwork exists — that 404 fires onerror →
        // handleLogoError, which swaps in the title text instead of a placeholder.
        if (url.includes('fallback=')) return url;
        return url.includes('?') ? `${url}&fallback=none` : `${url}?fallback=none`;
    }

    function getMediaTypeLabel(item: UniversalMediaItem): string {
        if (isMovie(item.mediaType)) {
            return m.hero_media_type_movie();
        }
        if (isSeries(item.mediaType)) {
            return m.hero_media_type_series();
        }
        if (isEpisode(item.mediaType)) {
            // A partly-watched episode is a RESUME, not the "next" one up — show the
            // continue-watching kicker so it doesn't read as "NÄCHSTE EPISODE" at 58%.
            if (item.progress && item.progress > 0) {
                return m.hero_continue_watching();
            }
            return m.hero_media_type_next_episode();
        }
        if (isAudiobook(item.mediaType)) {
            return m.hero_media_type_audiobook();
        }
        return '';
    }

    // Editorial eyebrow line: the media-type label, plus any cheaply-available
    // context already rendered elsewhere in the slide (e.g. season/episode for
    // an episode slide) — composed with a ' · ' separator. Never fetches new
    // data, only reads fields already used by the meta row below.
    function getEyebrowLine(item: UniversalMediaItem): string {
        const parts: string[] = [];
        const label = getMediaTypeLabel(item);
        if (label) parts.push(label);
        if (isEpisode(item.mediaType) && item.seasonNumber && item.episodeNumber) {
            parts.push(`S${item.seasonNumber} E${item.episodeNumber}`);
        }
        return parts.join(' · ');
    }

    function getDisplayTitle(item: UniversalMediaItem): string {
        if (isEpisode(item.mediaType) && item.seriesName) {
            return item.seriesName;
        }
        return item.title;
    }

    function getAudiobookPeople(
        item: UniversalMediaItem,
        field: 'authors' | 'narrators',
    ): AudiobookPersonRef[] {
        if (!isAudiobook(item.mediaType)) return [];
        const parsed = AudiobookKindSchema.safeParse(item.clickData?.audiobook);
        return parsed.success ? parsed.data[field] : [];
    }

    function getRequestUrl(item: UniversalMediaItem): string {
        // Use provider-agnostic redirect endpoint that resolves to TMDB server-side
        const type = isSeries(item.mediaType) ? 'tv' : 'movie';

        // Use provider-agnostic helper to get preferred external ID
        const preferred = getPreferredExternalId(item.externalIds);
        if (!preferred) {
            // No external IDs available - return base URL (will show search page)
            return env.PUBLIC_REQUESTURL || '';
        }

        const { provider, id: externalId } = preferred;

        // Use redirect endpoint with composite key
        const compositeKey = `${provider}:${externalId}:${type}`;
        return `/api/request/redirect?id=${encodeURIComponent(compositeKey)}`;
    }

    function getPlayUrl(item: UniversalMediaItem): string | undefined {
        const target = resolveMediaPlayTarget(item);
        return target.kind === 'watch'
            ? resolve(`/watch/${continueTargetFor(item) ?? target.playbackId}`)
            : undefined;
    }
    // Progress ring: visible only when autoplay is running and not paused
    const progressRingEnabled = $derived(
        shouldAutoplay(items.length, heroCfg.autoplayEnabled, reducedMotion) && !paused,
    );

    // ---- Sync bindable observation state out to the parent (lifted controls) ----
    // The parent renders <HeroControls> outside this hero box; these $effects push
    // the carousel's derived view-state into the bindable props it reads. Writing
    // only on change keeps the $bindable() defaults from being treated as
    // provably-dead assignments and avoids needless churn.
    $effect(() => {
        if (slideCount !== items.length) slideCount = items.length;
    });
    $effect(() => {
        const titles = items.map((it) => getDisplayTitle(it));
        // Re-point only when content-different to avoid an unstable array identity
        // re-triggering parent reactivity every tick.
        if (titles.length !== slideTitles.length || titles.some((t, i) => t !== slideTitles[i])) {
            slideTitles = titles;
        }
    });
    $effect(() => {
        if (autoplayActive !== progressRingEnabled) autoplayActive = progressRingEnabled;
    });

    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // Operator-supplied rating logos (IMDb/Rotten Tomatoes restrict their marks; we
    // ship text labels by default and only render a logo when the operator has
    // mounted one and pointed RATING_LOGO_* at it — see src/lib/server/config.ts).
    let ratingLogoImdb = $derived($page.data?.branding?.ratingLogoImdb || '');
    let ratingLogoRottenTomatoes = $derived($page.data?.branding?.ratingLogoRottenTomatoes || '');
    // Track items from section prop
    let sectionItems = $derived(section.items);
    // React to section.items changes. The list arrives in stages: SSR seed (0–1
    // items) → full client list (≤5) when the parent's buildHeroSection()
    // resolves → later refreshes (SWR / afterNavigate). On the FIRST non-empty
    // list we initialize; on subsequent changes we re-point `items` only when the
    // incoming list is content-different (same length + per-index render keys ⇒
    // no-op, so we don't churn the keyed {#each} and remount the active player's
    // ffmpeg session on every SWR refresh).
    let carouselInitialized = $state(false);
    $effect(() => {
        if (!browser) return;
        const incoming = sectionItems;
        if (incoming.length === 0) return;
        if (!carouselInitialized) {
            items = incoming;
            carouselInitialized = true;
            return;
        }
        const nextKeys = createRenderableMediaKeys(incoming);
        if (incoming !== items && !slideKeysEqual(renderItemKeys, nextKeys)) {
            items = incoming;
        }
    });

    // Drive autoplay. Re-runs when the slide count changes (e.g. the single SSR
    // seed reconciles into the full client list) AND when any input to the pause
    // gate / autoplay config changes — reading `paused`, `reducedMotion` and
    // `heroCfg.autoplayEnabled` here makes start/stop fully reactive (startAutoplay
    // already re-checks these). When the list grows past the single seed, reset to
    // slide 0 so the rotation starts cleanly; clamp first so a shrinking list can't
    // leave currentIndex pointing past the array.
    $effect(() => {
        const len = items.length;
        // Read pause/config so the effect re-runs (and re-evaluates start/stop)
        // when they change.
        void paused;
        void reducedMotion;
        void heroCfg.autoplayEnabled;
        currentIndex = clampIndex(currentIndex, len);
        if (len <= 1) {
            currentIndex = 0;
        }
        startAutoplay();
        return () => stopAutoplay();
    });

    // LQIP for every slide: re-decode whenever `items` changes reference (a
    // genuine change — the reconcile effect above filters out same-content
    // refreshes via slideKeysEqual, so this doesn't thrash on a no-op
    // stale-while-revalidate). Resets `imageLoaded` so each slide's fresh LQIP
    // shows again until its own backdrop loads. $effect is browser-only, so
    // canvas decoding is safe here.
    $effect(() => {
        lqipBackgrounds = items.map((item) => blurhashToCssBackground(item.backdropBlurHash));
        imageLoaded = new Array(items.length).fill(false);
        slideImgEls = new Array(items.length).fill(null);
    });

    // Cached-image guard: if a slide's backdrop was already in cache, its
    // onload may fire before the handler attaches, so `imageLoaded[index]`
    // would never flip. The attachment binds the element and checks
    // `.complete` immediately on attach (and the $effect below re-checks
    // reactively for every slide, e.g. after the reset above).
    function captureSlideImg(index: number) {
        // Returns a cleanup function, so the attachment's return type has to
        // admit one — `void` alone made svelte-check reject the return below.
        return (node: Element): void | (() => void) => {
            slideImgEls[index] = node as HTMLImageElement;
            if ((node as HTMLImageElement).complete) {
                imageLoaded[index] = true;
            }
            // Cleanup: heroImageSlots (active ± 1) can evict this slide's
            // <img> from the DOM (currentIndex moves away) without its key
            // ever changing. Without this, `slideImgEls[index]` keeps
            // pointing at the detached node — which still reports
            // `.complete === true` per real DOM semantics — so the guard
            // effect above leaves `imageLoaded[index]` true forever and the
            // LQIP never comes back for a slide that has no image mounted at
            // all. Only clear if we're still the current occupant of this
            // slot (a fresh attach for the SAME index may already have run
            // first).
            return () => {
                if (slideImgEls[index] === node) {
                    slideImgEls[index] = null;
                    imageLoaded[index] = false;
                }
            };
        };
    }
    $effect(() => {
        for (let i = 0; i < slideImgEls.length; i++) {
            if (slideImgEls[i]?.complete && !imageLoaded[i]) {
                imageLoaded[i] = true;
            }
        }
    });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
    class="hero-carousel"
    class:loading={items.length === 0}
    role="group"
    aria-roledescription="carousel"
    aria-label={m.hero_featured_content()}
    tabindex="0"
    style={`--hero-transition:${heroCfg.transitionMs}ms`}
    onmouseenter={() => {
        isHovering = true;
        startAutoplay();
    }}
    onmouseleave={() => {
        isHovering = false;
        startAutoplay();
    }}
    onfocusin={() => {
        isFocused = true;
        startAutoplay();
    }}
    onfocusout={() => {
        isFocused = false;
        startAutoplay();
    }}
    onkeydown={(e) => {
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            next();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            prev();
        }
    }}
    onpointerdown={onSwipePointerDown}
    onpointerup={onSwipePointerUp}
    onpointercancel={onSwipePointerCancel}>
    <!-- Polite live region: announces current slide to screen readers on change -->
    <div class="sr-only" aria-live="polite" aria-atomic="true">
        {items.length
            ? m.hero_slide_position({
                  current: currentIndex + 1,
                  total: items.length,
                  title: getDisplayTitle(items[currentIndex]),
              })
            : ''}
    </div>

    <!-- Quiet accent pill: transparent bg, small dot, subtle border — used for
         every status/progress chip inside the hero text block (AI suggestion,
         match %, continue-watching) instead of a filled/gradient badge. -->
    {#snippet accentPill(label: string)}
        <span
            class="inline-flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-2.5 py-0.5 text-xs font-semibold text-primary-300">
            <span class="h-1.5 w-1.5 rounded-full bg-primary-400" aria-hidden="true"></span>
            {label}
        </span>
    {/snippet}

    {#if items.length > 0}
        {#each items as item, index (renderItemKeys[index])}
            <div
                class="hero-slide min-h-[400px]"
                class:is-active={index === currentIndex}
                aria-hidden={index !== currentIndex}
                inert={index !== currentIndex}
                aria-label={m.hero_slide_position({
                    current: index + 1,
                    total: items.length,
                    title: getDisplayTitle(item),
                })}>
                <div
                    class="slide-backdrop"
                    class:slide-backdrop--audiobook={isAudiobook(item.mediaType)}>
                    {#if item.backdropBlurHash}
                        <div
                            class="hero-lqip"
                            class:hidden={imageLoaded[index]}
                            style={lqipBackgrounds[index]
                                ? `background-image:url(${lqipBackgrounds[index]})`
                                : undefined}
                            aria-hidden="true">
                        </div>
                    {/if}
                    {#if heroVideoEnabled && !isAudiobook(item.mediaType) && isPlayerSlot(index)}
                        <!-- Active slide (or the single preloaded neighbour) plays
                             video via HeroVideoPlayer: self-hosted preview →
                             youtube → backdrop, decided per item. Leaving the
                             player-slot set unmounts this, stopping ffmpeg. -->
                        <div class="hero-video slide-image">
                            {#if index === currentIndex}
                                <HeroVideoPlayer
                                    bind:this={activePlayer}
                                    {item}
                                    trailersEnabled
                                    videoPreviewEnabled
                                    backdropUrl={getBackdropUrl(item)}
                                    aspectRatio="16/9"
                                    videoScale={116}
                                    youtubeScale={135}
                                    loop
                                    heroSafeCodec
                                    showMuteButton={false}
                                    onMuteChange={handleActiveMuteChange} />
                            {:else}
                                <HeroVideoPlayer
                                    {item}
                                    trailersEnabled
                                    videoPreviewEnabled
                                    backdropUrl={getBackdropUrl(item)}
                                    aspectRatio="16/9"
                                    videoScale={116}
                                    youtubeScale={135}
                                    loop
                                    heroSafeCodec
                                    showMuteButton={false} />
                            {/if}
                        </div>
                    {:else if isImageSlot(index) && hasRealBackdropArt(item)}
                        <img
                            class="slide-image"
                            alt=""
                            draggable="false"
                            width="1280"
                            height="720"
                            src={getBackdropUrl(item)}
                            srcset={item.externalIds?.internal && !isAudiobook(item.mediaType)
                                ? getCatalogBackdropSrcSet(item.externalIds.internal)
                                : undefined}
                            sizes="100vw"
                            loading={index === 0 ? 'eager' : 'lazy'}
                            decoding="async"
                            fetchpriority={index === 0 ? 'high' : undefined}
                            {@attach captureSlideImg(index)}
                            onerror={(e) => handleBackdropError(e, item)}
                            onload={() => {
                                imageLoaded[index] = true;
                            }} />
                    {:else if isImageSlot(index)}
                        <!-- No real art: a soft gradient instead of the
                             popcorn placeholder blown up full-bleed. -->
                        <div class="slide-backdrop-fallback" aria-hidden="true"></div>
                    {/if}
                </div>

                <div class="container mx-auto px-4 sm:px-8 mt-24 md:mt-24 slide-content">
                    <!-- Clickable content wrapper -->
                    <!-- currentIndex is the active slide for click/keyboard/menu actions -->
                    <!-- aria-label names the wrapper so it doesn't duplicate the title text
                         already present in child headings; inner <a> buttons remain independently
                         focusable and are NOT swallowed by this role="button". -->
                    <div
                        class="slide-content-inner"
                        role="button"
                        tabindex="0"
                        aria-label={m.hero_open_details({ title: getDisplayTitle(item) })}
                        onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                openDescription(items[currentIndex] || item);
                            }
                        }}
                        onclick={() => {
                            // Suppress the click that ends a swipe gesture.
                            if (isSwiping) {
                                isSwiping = false;
                                return;
                            }
                            openDescription(items[currentIndex] || item);
                        }}
                        oncontextmenu={(e) => {
                            openHeroContextMenu(e, items[currentIndex] || item);
                        }}>
                        <div class="hero-copy">
                            <!-- Eyebrow: editorial kicker line (media type + cheap
                             context) plus the AI-suggestion accent pill. -->
                            <div class="mb-2 flex flex-wrap items-center gap-2">
                                {#if item.isAISuggestion}
                                    {@render accentPill(m.hero_ai_suggestion())}
                                {/if}
                                <h4
                                    class="m-0 text-xs font-semibold uppercase leading-none tracking-[0.15em] text-primary-400 sm:text-sm">
                                    {getEyebrowLine(item)}
                                </h4>
                            </div>

                            <!-- Let the title use its actual height; short logos and one-line
                                 titles should not leave an empty second line. -->
                            <div class="hero-title-slot">
                                {#if logoExists[index] !== false && getLogoUrl(item)}
                                    <img
                                        class="hero-title-logo"
                                        alt="Logo"
                                        width="320"
                                        height="80"
                                        src={getLogoUrl(item)}
                                        loading={index === 0 ? 'eager' : 'lazy'}
                                        decoding="async"
                                        fetchpriority={index === 0 ? 'high' : undefined}
                                        onerror={() => handleLogoError(index)} />
                                {:else}
                                    <h1
                                        class="h1 text-2xl font-bold leading-[1.1] tracking-tight line-clamp-2 md:text-6xl md:leading-[1.05] lg:text-6xl">
                                        {getDisplayTitle(item)}
                                    </h1>
                                {/if}
                            </div>

                            <!-- Only reserve subtitle space when there is text. -->
                            {#if item.subtitle?.trim() && item.subtitle !== item.title}
                                <small class="block title italic mb-2 truncate">
                                    {item.subtitle}
                                </small>
                            {:else if isEpisode(item.mediaType) && logoExists[index] !== false && getLogoUrl(item)}
                                <small class="block title italic mb-2 truncate">
                                    {item.title}
                                </small>
                            {/if}

                            <!-- Metadata Row: muted facts, consistent ' · ' separators
                             (via .hero-meta-item + .hero-meta-item, see the style
                             block below — NEVER write a literal style tag here,
                             it breaks svelte preprocessing). RT/Letterboxd/Trakt/
                             Metacritic badges keep their own accent colors — only
                             the row's base tone is muted. -->
                            <p
                                class="hero-meta flex flex-wrap items-center text-xs text-surface-300 sm:text-sm">
                                {#if isEpisode(item.mediaType) && item.seasonNumber && item.episodeNumber}
                                    <span class="hero-meta-item"
                                        >S{item.seasonNumber} E{item.episodeNumber}</span>
                                {/if}
                                {#if formatSeriesCounts(item, item.mediaType)}
                                    <span class="hero-meta-item"
                                        >{formatSeriesCounts(item, item.mediaType)}</span>
                                {/if}
                                {#if item.year}
                                    <span class="hero-meta-item">{item.year}</span>
                                {/if}
                                {#if item.rating}
                                    <span class="hero-meta-item inline-flex items-center gap-1">
                                        {#if ratingLogoImdb}
                                            <img
                                                class="criticlogo inline h-4 w-auto"
                                                width="16"
                                                height="16"
                                                src={ratingLogoImdb}
                                                alt="IMDb Rating"
                                                loading="lazy"
                                                decoding="async" />
                                        {:else}
                                            <span class="font-bold text-yellow-400">IMDb</span>
                                        {/if}
                                        {Math.floor(Number(item.rating))}<small>/10</small>
                                    </span>
                                {/if}
                                {#if item.criticRating}
                                    <span class="hero-meta-item inline-flex items-center gap-1">
                                        {#if ratingLogoRottenTomatoes}
                                            <img
                                                class="criticlogo inline h-4 w-auto"
                                                width="16"
                                                height="16"
                                                src={ratingLogoRottenTomatoes}
                                                alt="RT Critics"
                                                loading="lazy"
                                                decoding="async" />
                                        {:else}
                                            <span class="font-bold text-red-500">RT</span>
                                        {/if}
                                        {item.criticRating}
                                    </span>
                                {/if}
                                {#if item.audienceRating}
                                    <span class="hero-meta-item inline-flex items-center gap-1">
                                        <span class="font-bold text-red-500">RT</span>
                                        {item.audienceRating}%
                                    </span>
                                {/if}
                                {#if item.letterboxdRating}
                                    <span class="hero-meta-item inline-flex items-center gap-1">
                                        <span class="font-bold text-orange-500">LB</span>
                                        {Number(item.letterboxdRating).toFixed(1)}
                                    </span>
                                {/if}
                                {#if item.traktScore}
                                    <span class="hero-meta-item inline-flex items-center gap-1">
                                        <span class="text-red-500">T</span>
                                        {item.traktScore}%
                                    </span>
                                {/if}
                                {#if item.metacriticScore}
                                    <span class="hero-meta-item inline-flex items-center gap-1">
                                        <span class="text-yellow-400">MC</span>
                                        {item.metacriticScore}
                                    </span>
                                {/if}
                                {#if item.durationMs}
                                    <span class="hero-meta-item"
                                        >{convertSecondsToHoursAndMinutes(
                                            item.durationMs / 1000,
                                        )}</span>
                                {/if}
                                {#if item.certification}
                                    <span class="hero-meta-item">
                                        <span
                                            class="rounded border border-surface-400/60 px-1.5 py-px text-[0.65rem] font-semibold leading-tight text-surface-200"
                                            >{item.certification}</span>
                                    </span>
                                {/if}
                                {#each buildQualityChips(qualitySummaryFromTiers( item.resolutionTier, item.hdrTier, { hasAtmos: item.hasAtmos, hasCc: item.hasCc, hasSdh: item.hasSdh, hasAd: item.hasAd } )) as chip (chip.label)}
                                    <span class="hero-meta-item">
                                        <span
                                            class="rounded bg-surface-200/90 px-1.5 py-px text-[0.65rem] font-bold uppercase leading-tight tracking-wide text-surface-900"
                                            title={chip.tooltip}>{chip.label}</span>
                                    </span>
                                {/each}
                                {#if item.genres && item.genres.length > 0}
                                    <span class="hero-meta-item">
                                        {#each item.genres as genre, genreIdx (genre + '-' + genreIdx)}
                                            <span class="mr-2 last:mr-0">{genre}</span>
                                        {/each}
                                    </span>
                                {/if}
                                {#if item.isAISuggestion && item.similarityScore}
                                    <span class="hero-meta-item">
                                        {@render accentPill(
                                            m.hero_match_percent({
                                                percent: Math.min(
                                                    Math.round(item.similarityScore * 100),
                                                    100,
                                                ),
                                            }),
                                        )}
                                    </span>
                                {/if}
                                {#if isAudiobook(item.mediaType)}
                                    {@const authors = getAudiobookPeople(item, 'authors')}
                                    {@const narrators = getAudiobookPeople(item, 'narrators')}
                                    {#if authors.length > 0}
                                        <span class="hero-meta-item"
                                            >{m.modal_audiobook_authors()}: {#each authors as person, index (person.id)}{#if index > 0},
                                                {/if}<a
                                                    href={resolve(
                                                        `/audiobooks/authors/${person.id}`,
                                                    )}
                                                    class="hover:underline">{person.name}</a
                                                >{/each}</span>
                                    {/if}
                                    {#if narrators.length > 0}
                                        <span class="hero-meta-item"
                                            >{m.modal_audiobook_narrators()}: {#each narrators as person, index (person.id)}{#if index > 0},
                                                {/if}<a
                                                    href={resolve(
                                                        `/audiobooks/narrators/${person.id}`,
                                                    )}
                                                    class="hover:underline">{person.name}</a
                                                >{/each}</span>
                                    {/if}
                                {/if}
                            </p>

                            <!-- AI Reason -->
                            {#if item.isAISuggestion && item.reason}
                                <p
                                    class="mb-2 max-w-prose text-sm italic text-primary-300 line-clamp-2">
                                    {item.reason}
                                </p>
                            {/if}

                            <!-- Description -->
                            <div
                                class="max-w-prose text-surface-200/80 leading-relaxed line-clamp-3">
                                {#if item.overview}
                                    {item.overview}
                                {/if}
                            </div>
                        </div>
                        <div class="hero-playback">
                            <!-- Progress / now-playing bar. Shown for partly-watched
                             items, and also for anything with a live session even
                             at ~0% progress so "Playing now" surfaces immediately. -->
                            {#if (item.progress && item.progress > 0) || livePlayingFor(item)}
                                {@const progressPct = Math.round(item.progress ?? 0)}
                                {@const playingLive = livePlayingFor(item)}
                                <div class="max-w-md">
                                    <div class="mb-1.5">
                                        {#if playingLive}
                                            <!-- Live "Playing now" pill — pulsing dot signals an
                                             active session (see section_playing_now, reused
                                             from the Continue Watching cards; a book is
                                             listened to, so it takes the listening verb the
                                             CW label uses for the same state). -->
                                            <span
                                                class="inline-flex items-center gap-1.5 rounded-full border border-primary-500/40 bg-primary-500/15 px-2.5 py-0.5 text-xs font-semibold text-primary-200">
                                                <span
                                                    class="hero-live-dot h-1.5 w-1.5 rounded-full bg-primary-400"
                                                    aria-hidden="true"></span>
                                                {isAudiobook(item.mediaType)
                                                    ? m.section_listening_now()
                                                    : m.section_playing_now()}
                                            </span>
                                        {:else}
                                            {@render accentPill(
                                                `${m.hero_continue_watching()} · ${progressPct}%`,
                                            )}
                                        {/if}
                                    </div>
                                    <div
                                        class="w-full rounded-full bg-surface-400/20 h-1 overflow-hidden">
                                        <div
                                            class="h-1 rounded-full bg-primary-400 transition-all"
                                            class:hero-progress-live={playingLive}
                                            style="width: {progressPct}%">
                                        </div>
                                    </div>
                                </div>
                            {/if}

                            <!-- Action Buttons -->
                            <div class="hero-actions">
                                {#if isAudiobook(item.mediaType) && resolveMediaPlayTarget(item).kind === 'audiobook'}
                                    <button
                                        type="button"
                                        class="lumastra-hero-play"
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            void handlePlay(item);
                                        }}>
                                        <svg
                                            class="lumastra-hero-icon"
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            aria-hidden="true">
                                            <path
                                                d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6Z" />
                                        </svg>
                                        <span>{m.play()}</span>
                                    </button>
                                {:else if !isAudiobook(item.mediaType) && item.isAISuggestion && !item.isAvailable && hasRequestPermission}
                                    <a
                                        href={resolve(getRequestUrl(item))}
                                        class="lumastra-hero-request"
                                        target="_blank"
                                        onclick={(e) => e.stopPropagation()}>
                                        <svg
                                            class="lumastra-hero-icon"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            aria-hidden="true">
                                            <path
                                                d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
                                            <path d="m6.2 5.3 3.1 3.9" />
                                            <path d="m12.4 3.4 3.1 4" />
                                            <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                                            <path d="M12 13.9v4.2" />
                                            <path d="M9.9 16h4.2" />
                                        </svg>
                                        <span>{m.request()}</span>
                                    </a>
                                {:else if !isAudiobook(item.mediaType) && resolveMediaPlayTarget(item).kind === 'watch'}
                                    {@const minsLeft = resumeLabel(
                                        item.progress != null ? item.progress / 100 : undefined,
                                        item.durationMs == null
                                            ? undefined
                                            : item.durationMs / 60_000,
                                    )}
                                    <a
                                        href={getPlayUrl(item)}
                                        class="lumastra-hero-play"
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            e.preventDefault();
                                            void handlePlay(item);
                                        }}>
                                        <svg
                                            class="lumastra-hero-icon"
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            aria-hidden="true">
                                            <path
                                                d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6Z" />
                                        </svg>
                                        <span>{minsLeft ? m.hero_resume() : m.play()}</span>
                                    </a>
                                    {#if minsLeft}
                                        <span class="hero-time-left opacity-80">{minsLeft}</span>
                                    {/if}
                                {/if}
                            </div>
                        </div>
                    </div>
                    <!-- end slide-content-inner -->
                </div>
            </div>
        {/each}
    {:else}
        <!-- Loading Placeholder -->
        <div class="hero-slide is-active min-h-[420px] max-h-[420px] relative">
            <div class="slide-backdrop animate-pulse">
                <div class="slide-image bg-gray-700"></div>
            </div>
            <div class="container mx-auto px-4 sm:px-8 mt-24 md:mt-24 slide-content">
                <div class="h-4 bg-gray-600 rounded w-24 mb-4 animate-pulse"></div>
                <div class="h-20 bg-gray-600 rounded w-64 max-w-full mb-3 animate-pulse"></div>
                <div class="h-4 bg-gray-600 rounded w-96 max-w-full mb-4 animate-pulse"></div>
                <div class="h-16 bg-gray-600 rounded w-full mb-4 animate-pulse"></div>
                <div class="h-10 bg-gray-600 rounded w-32 animate-pulse"></div>
            </div>
        </div>
    {/if}

    <!-- The carousel controls (dots + progress ring + pause/play + mute) are no
         longer rendered here — they're lifted into a dedicated <HeroControls> row
         in +page.svelte (between the nav buttons and the footer), driven via the
         bindable state + exported goTo/togglePause/toggleMute on this component. -->
</div>

{#if contextMenuPos && contextMenuItem}
    <ContextMenu
        x={contextMenuPos.x}
        y={contextMenuPos.y}
        title={contextMenuItem.title}
        items={heroMenuItems}
        onClose={closeHeroContextMenu} />
{/if}

{#if ratingModalOpen && modalTargetItem}
    <RatingPickerModal
        open={ratingModalOpen}
        title={modalTargetItem.title}
        externalIds={modalTargetItem.externalIds}
        mediaType={isSeries(modalTargetItem.mediaType) ? 'tv' : 'movie'}
        onClose={() => (ratingModalOpen = false)} />
{/if}

{#if fileInfoModalOpen && modalTargetItem?.externalIds?.internal}
    <MediaFileInfoModal
        open={fileInfoModalOpen}
        mediaId={modalTargetItem.externalIds.internal}
        includeChildren={isSeries(modalTargetItem.mediaType)}
        title={modalTargetItem.title}
        onClose={() => (fileInfoModalOpen = false)} />
{/if}

{#if whyHereOpen && modalTargetItem}
    <WhyHereModal
        open={whyHereOpen}
        title={modalTargetItem.title}
        reason={modalTargetItem.reason}
        onClose={() => (whyHereOpen = false)} />
{/if}

<!-- svelte-ignore css_unused_selector -->
<style global lang="postcss">
    /* Custom crossfade carousel root */
    .hero-carousel {
        min-height: 500px;
        /* Stack slides in one grid cell so the longest copy sets a safe,
           stable height across carousel changes, including on mobile. */
        overflow: visible;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        width: 100%;
        position: relative;
        /* Let vertical scroll/zoom pass through; horizontal is a swipe */
        touch-action: pan-y pinch-zoom;
    }

    /* Grid-stacked slides crossfade via opacity without leaving document flow. */
    .hero-slide {
        position: relative;
        grid-area: 1 / 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        width: 100%;
        opacity: 0;
        pointer-events: none;
        overflow: visible;
        transition: opacity var(--hero-transition, 500ms) ease;
    }

    .hero-slide.is-active {
        opacity: 1;
        pointer-events: auto;
    }

    /* Reduced motion: snap between slides instead of fading. */
    @media (prefers-reduced-motion: reduce) {
        .hero-slide {
            transition: none;
        }
    }

    /* Mobile-only readability scrim. On desktop (min-width:600px) the
       left/bottom backdrop mask below gives text its contrast, but on the
       narrow mobile column the backdrop sits directly behind the whole text
       block with no scrim — bright / low-contrast key art washes out the
       muted eyebrow, meta, description and progress text. Paint a soft
       vertical scrim between the backdrop (z-index:1) and the text
       (.slide-content, z-index:2). The scrim is also z-index:2 but a DOM
       sibling BEFORE .slide-content, so text paints on top of it. */
    @media (max-width: 599px) {
        .hero-slide::before {
            content: '';
            position: absolute;
            inset: 0;
            z-index: 2;
            pointer-events: none;
            background: linear-gradient(
                180deg,
                rgba(8, 11, 22, 0) 0%,
                rgba(8, 11, 22, 0.45) 14%,
                rgba(8, 11, 22, 0.68) 40%,
                rgba(8, 11, 22, 0.68) 62%,
                rgba(8, 11, 22, 0.42) 85%,
                rgba(8, 11, 22, 0) 100%
            );
        }
    }

    .slide-backdrop {
        position: absolute;
        width: 100%;
        margin-left: 0;
        margin-right: 0;
        top: 0;
        right: 0;
        pointer-events: none;
        padding-bottom: 56.25%; /* 16:9 aspect ratio */
        background-position: center top;
        background-size: contain;
        background-repeat: no-repeat;
        box-sizing: border-box;
        z-index: 1;
        /* Edge-fade mask applied at the CONTAINER level so EVERY backdrop layer
           (LQIP blurhash, slide image, video/iframe, and the HeroVideoPlayer
           buffering cover / fallback image) fades uniformly. Masking per-element
           left gaps: whichever layer briefly showed during load/buffering and
           wasn't individually masked produced a hard edge. */
        mask-image: linear-gradient(180deg, rgba(37, 18, 18, 0.75) 0%, rgba(0, 0, 0, 0) 100%);
    }

    /* LQIP placeholder: absolutely stacked behind the real backdrop image.
       Hidden via opacity (never removed from DOM) to avoid CLS. */
    .hero-lqip {
        position: absolute;
        inset: 0;
        z-index: 0;
        background-size: cover;
        background-position: center;
        transition: opacity 300ms ease;
    }

    .hero-lqip.hidden {
        opacity: 0;
    }

    /* Subtle stand-in for a missing backdrop — fills the same box the real
       backdrop image would, but as a quiet tint rather than a photo, so the
       page's own background/gradient behind the hero reads through it. */
    .slide-backdrop-fallback {
        position: absolute;
        inset: 0;
        z-index: 1;
        background: linear-gradient(
            160deg,
            rgb(var(--color-surface-800-rgb) / 0.55) 0%,
            rgb(var(--color-surface-900-rgb) / 0.35) 55%,
            rgb(var(--color-surface-900-rgb) / 0) 100%
        );
    }

    .slide-backdrop .slide-image {
        height: 800px;
        /* width:auto neutralizes the intrinsic width="1280" presentational hint on
           the <img> (added to satisfy the unsized-images audit / reserve CLS space)
           so the backdrop keeps rendering at its natural aspect ratio, not 1280px. */
        width: auto;
        object-fit: cover;
        margin-left: auto;
        margin-right: 0;
        /* Edge-fade now lives on .slide-backdrop (container) — see above. */
        position: relative;
        z-index: 1;
        user-select: none;
        -webkit-user-drag: none;
    }

    /* Every image in the hero, not just the backdrop. A native HTML image drag
       fires `pointercancel` and swallows the pointerup, so a swipe started on
       the title logo or a rating badge would never commit. This is the whole
       reason the pointerdown handler must not reach for setPointerCapture()
       (see onSwipePointerDown) — killing dragstart at the source fixes the
       gesture without retargeting clicks away from the play button. */
    .hero-carousel img {
        -webkit-user-drag: none;
    }

    /* Preview video/YouTube frames are decoration. Let gestures reach the
       carousel across the entire backdrop instead of entering an iframe. */
    .hero-carousel .slide-backdrop * {
        pointer-events: none;
    }

    /* Audiobooks only have portrait-ish cover art, not a cinematic landscape
       backdrop. Treat it as an oversized editorial crop on the right instead
       of letting its intrinsic aspect ratio create an arbitrary, towering slab.
       The deliberate crop makes the cover feel present without competing with
       the title and controls on the left. */
    .slide-backdrop--audiobook {
        overflow: hidden;
    }

    .slide-backdrop--audiobook .slide-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
    }

    /* HeroVideoPlayer media must FILL the slide (which is taller than 16:9), NOT
       the stale fixed 800px that left a hard bottom edge / black bar. <video>
       covers via object-fit; the YouTube <iframe> can't object-fit, so it's
       sized as a 16:9 box that covers the container (see HeroVideoPlayer) to
       avoid YT's internal letterbox. */
    .slide-backdrop :global(video) {
        width: 100%;
        height: 100%;
        object-fit: cover;
        position: relative;
        z-index: 1;
    }

    /* The HeroVideoPlayer mounts inside this wrapper; size it like a backdrop
       image so its internal absolutely-positioned video/iframe fills the slide. */
    .slide-backdrop .hero-video {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 1;
    }

    .slide-backdrop .hero-video :global(.hero-video-player) {
        width: 100%;
        height: 100%;
    }

    @media (min-width: 600px) {
        .slide-backdrop {
            width: 80%;
            /* Cap the backdrop/video on extreme-widescreen so it doesn't span the
               whole page — stays right-aligned (margin-left:auto, margin-right:0),
               so it just starts later from the left. */
            max-width: 1600px;
            margin-left: auto;
            margin-right: 0;
            padding-bottom: calc(9 / 16) * 80%;
            background-position: right center;
        }

        .slide-backdrop--audiobook {
            /* A little larger than a normal cover, with a controlled crop. */
            width: min(58vw, 920px);
            height: 620px;
            padding-bottom: 0;
            margin-left: auto;
            margin-right: 0;
        }

        /* Desktop edge-fade at the CONTAINER level (covers every backdrop layer). */
        .slide-backdrop {
            /* Left fade extended to ~45% (was ~37%) so the backdrop blends
               further into the page on its left. */
            mask-image:
                linear-gradient(
                    to right,
                    hsla(0, 0%, 0%, 0) 0%,
                    hsla(0, 0%, 0%, 0.12) 22%,
                    hsla(0, 0%, 0%, 0.35) 36%,
                    hsla(0, 0%, 0%, 0.62) 48%,
                    hsla(0, 0%, 0%, 0.86) 57%,
                    hsl(0, 0%, 0%) 66%
                ),
                linear-gradient(
                    to top,
                    hsla(0, 0%, 0%, 0) 0%,
                    hsla(0, 0%, 0%, 0.182) 5.6%,
                    hsla(0, 0%, 0%, 0.34) 9.9%,
                    hsla(0, 0%, 0%, 0.476) 13.1%,
                    hsla(0, 0%, 0%, 0.593) 15.7%,
                    hsla(0, 0%, 0%, 0.69) 17.9%,
                    hsla(0, 0%, 0%, 0.771) 20.2%,
                    hsla(0, 0%, 0%, 0.836) 22.9%,
                    hsla(0, 0%, 0%, 0.888) 26.3%,
                    hsla(0, 0%, 0%, 0.927) 30.8%,
                    hsla(0, 0%, 0%, 0.956) 36.7%,
                    hsla(0, 0%, 0%, 0.976) 44.4%,
                    hsla(0, 0%, 0%, 0.989) 54.3%,
                    hsla(0, 0%, 0%, 0.996) 66.6%,
                    hsla(0, 0%, 0%, 0.999) 81.7%,
                    hsl(0, 0%, 0%) 100%
                );
            mask-composite: intersect;
        }

        /* Video slides get a STRONGER bottom fade than static backdrops — moving
           footage right at the slide's bottom edge reads as a hard line, so fade
           a larger bottom band into the page. Left fade ~matches the backdrop
           mask; only the bottom (to-top) gradient is extended. `:has(.hero-video)`
           scopes this to video slides; image backdrops keep the lighter mask. */
        .slide-backdrop:has(.hero-video) {
            mask-image:
                linear-gradient(
                    to right,
                    hsla(0, 0%, 0%, 0) 0%,
                    hsla(0, 0%, 0%, 0.12) 22%,
                    hsla(0, 0%, 0%, 0.35) 36%,
                    hsla(0, 0%, 0%, 0.62) 48%,
                    hsla(0, 0%, 0%, 0.86) 57%,
                    hsl(0, 0%, 0%) 66%
                ),
                linear-gradient(
                    to top,
                    hsla(0, 0%, 0%, 0) 0%,
                    hsla(0, 0%, 0%, 0.6) 30%,
                    hsl(0, 0%, 0%) 58%
                );
            mask-composite: intersect;
        }
    }

    /* On desktop give the backdrop/video a wide CINEMATIC aspect (21:9) instead
       of the tall parent-relative padding-bottom — wider + much less height, so
       it reads like a film strip rather than a near-square block. */
    @media (min-width: 1280px) {
        .slide-backdrop {
            padding-bottom: 0;
            aspect-ratio: 21 / 9;
        }
    }

    .slide-content {
        position: relative;
        display: flex;
        flex: 1;
        margin-bottom: 40px;
        box-sizing: border-box;
        z-index: 2;
        font-family: inherit;
        pointer-events: none;
    }

    .hero-carousel.loading .slide-content {
        display: block;
    }

    .slide-content-inner {
        pointer-events: auto;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        width: 100%;

        @media (min-width: 640px) {
            width: 70%;
        }
    }

    /* All slides stretch to the tallest slide. Reserve the same playback
       block below each copy so Play/Request stays put when swiping. */
    .hero-copy {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .hero-title-slot {
        margin-bottom: 20px;
    }

    .hero-title-logo {
        display: block;
        width: auto;
        max-width: min(320px, 100%);
        height: 80px;
        object-fit: contain;
        object-position: left center;
    }

    .hero-meta-item {
        flex-wrap: wrap;
        max-width: 100%;
    }

    .hero-playback {
        flex: none;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        min-height: 96px;
        margin-top: 24px;

        @media (min-width: 640px) {
            margin-top: 28px;
        }
    }

    .hero-actions:empty {
        visibility: hidden;
    }

    .hero-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        height: 52px;
        min-height: 52px;
        margin-top: 12px;
    }

    .hero-actions > a,
    .hero-actions > button {
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.2;
    }

    .hero-time-left {
        min-width: 0;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        overflow: hidden;
        line-height: 1.5;
    }

    /* Metadata row facts: each fact is a `.hero-meta-item`; a ' · ' separator
       is inserted via the adjacent-sibling combinator so it only appears
       between two facts that actually rendered (conditional #if blocks decide
       what's present — CSS just reacts to DOM adjacency instead of the
       template tracking "is this the first visible item"). */
    .hero-meta-item {
        display: inline-flex;
        align-items: center;
    }

    .hero-meta-item + .hero-meta-item::before {
        content: '·';
        margin: 0 0.5rem;
        opacity: 0.6;
    }

    /* ---- Lumastra hero action buttons (see lumastra-branding/buttons) ----
       PLAY is the solid white primary (btn-play.svg); REQUEST is a dark-glass
       secondary. Shared base, two variants. */
    .lumastra-hero-play,
    .lumastra-hero-request {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        height: 52px;
        padding: 0 26px;
        border-radius: 16px;
        font-weight: 700;
        letter-spacing: 0.2px;
        white-space: nowrap;
        cursor: pointer;
        transition:
            background 0.15s ease,
            border-color 0.15s ease,
            transform 0.12s ease,
            box-shadow 0.15s ease;
    }

    .lumastra-hero-icon {
        width: 18px;
        height: 18px;
        flex: none;
    }

    /* Primary — solid white, lifted */
    .lumastra-hero-play {
        background: #fff;
        color: #0b1120;
        border: 1px solid transparent;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
    }

    .lumastra-hero-play:hover {
        background: #f1f3f7;
        transform: translateY(-1px);
        box-shadow: 0 7px 24px rgba(0, 0, 0, 0.5);
    }

    .lumastra-hero-play:active {
        transform: translateY(0);
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45);
    }

    /* Secondary — dark glass */
    .lumastra-hero-request {
        padding: 0 22px;
        font-weight: 600;
        background: rgba(24, 33, 58, 0.82);
        color: #e7eaf1;
        border: 1px solid rgba(255, 255, 255, 0.12);
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
    }

    .lumastra-hero-request:hover {
        background: rgba(34, 46, 76, 0.92);
        border-color: rgba(255, 255, 255, 0.24);
    }

    .lumastra-hero-request:active {
        transform: translateY(1px);
    }

    .lumastra-hero-play:focus-visible,
    .lumastra-hero-request:focus-visible {
        outline: 2px solid #7c86ff;
        outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
        .lumastra-hero-play,
        .lumastra-hero-request {
            transition: none;
            transform: none;
        }
    }

    /* ── "Playing now" live treatment ────────────────────────────────────
       Shown when the hero item has a fresh active session (item.isPlaying).
       Primary #7c86ff matches the hero focus-outline accent above. */

    /* Pulsing dot on the "Playing now" pill. */
    .hero-live-dot {
        animation: hero-live-pulse 1.8s ease-in-out infinite;
    }
    @keyframes hero-live-pulse {
        0%,
        100% {
            opacity: 1;
            box-shadow: 0 0 0 0 rgb(124 134 255 / 45%);
        }
        50% {
            opacity: 0.6;
            box-shadow: 0 0 0 4px rgb(124 134 255 / 0%);
        }
    }

    /* Live progress fill: the primary bar gains a soft glow and a highlight
       that sweeps across the filled portion. overflow:hidden clips the sweep
       to the fill width (box-shadow is unaffected by overflow). */
    .hero-progress-live {
        position: relative;
        overflow: hidden;
        box-shadow: 0 0 8px 0 rgb(124 134 255 / 45%);
    }
    .hero-progress-live::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: linear-gradient(
            90deg,
            transparent 0%,
            rgb(255 255 255 / 55%) 50%,
            transparent 100%
        );
        transform: translateX(-100%);
        animation: hero-progress-shimmer 2s ease-in-out infinite;
    }
    @keyframes hero-progress-shimmer {
        0% {
            transform: translateX(-100%);
        }
        60%,
        100% {
            transform: translateX(100%);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .hero-live-dot,
        .hero-progress-live::after {
            animation: none;
        }
    }

    /* Carousel control styles (.hero-controls/.hero-mute/.hero-pause/.hero-dots/
       .hero-dot/.hero-dot-progress + @keyframes hero-fill) moved to
       HeroControls.svelte along with the markup. */
</style>
