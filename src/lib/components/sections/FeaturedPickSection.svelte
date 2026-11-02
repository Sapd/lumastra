<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	FeaturedPickSection.svelte

	Hero-style featured pick section that displays ONE prominently recommended item.
	Shows WHY it's featured with a criteria badge (Hidden Gem, Perfect Match, etc.)
	Supports hover preview with YouTube trailers/video streams via MediaHoverCard.

	@example
	<FeaturedPickSection {section} onitemClick={handleClick} />
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { debounce } from '$lib/utils/debounce';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import {
        Icon,
        Plus,
        Sparkles,
        InformationCircle,
        VideoCameraSlash,
        VideoCamera,
        SpeakerWave,
        SpeakerXMark,
        PlayCircle,
        DocumentPlus,
        Star,
        ClipboardDocument,
        ArrowUturnLeft,
        ArrowPath,
        DocumentMagnifyingGlass,
        HandThumbDown,
        HandThumbUp,
        Heart,
        Bookmark,
        WrenchScrewdriver,
        EyeSlash,
    } from 'svelte-hero-icons';
    import type {
        PageSection,
        UniversalMediaItem,
        FeaturedPickCriteria,
    } from '$lib/types/server-driven-ui';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { buildMediaKey, getPlayableId } from '$lib/utils/media-id-helpers';
    import { isMovie, isSeries, isEpisode } from '$lib/shared/media-types';
    import { toMovieOrSeries } from '$lib/shared/media-type-domain';
    import * as m from '$lib/paraglide/messages';
    import HeroVideoPlayer from '$lib/components/ui/HeroVideoPlayer.svelte';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import RatingPickerModal from '$lib/components/modal/RatingPickerModal.svelte';
    import MediaFileInfoModal from '$lib/components/modal/MediaFileInfoModal.svelte';
    import { lessLikeThis } from '$lib/api/for-you';
    import { toasts } from '$lib/stores/toast.store';
    import {
        copyMediaLink,
        markMediaUnwatched,
        refreshMediaMetadata,
        toggleWatchlistMedia,
        canWatchlistMedia,
        canRateMedia,
        quickRateMedia,
        isVideoItem,
        isPageAdmin,
        buildMediaShareId,
    } from '$lib/utils/media-context-actions';
    import { watchlistItems } from '$lib/stores/watchlist';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import {
        getSavedVideoDisabledState,
        saveVideoDisabledState,
    } from '$lib/utils/video-player-utils';
    import { firstFeaturedPickVideoItem } from './featured-pick-eligibility';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The section data to render */
        section: PageSection;
        /** Whether the user has permission to make requests */
        hasRequestPermission?: boolean;
        /** Callback when item is clicked */
        onitemClick?: (item: UniversalMediaItem) => void;
        /** Callback when play button is clicked */
        onitemPlay?: (item: UniversalMediaItem) => void;
        /** Callback when request button is clicked */
        onitemRequest?: (item: UniversalMediaItem) => void;
        /** Callback when more/similar button is clicked */
        onitemMore?: (item: UniversalMediaItem) => void;
    }

    let {
        section,
        hasRequestPermission = true,
        onitemClick,
        onitemPlay,
        onitemRequest,
        onitemMore,
    }: Props = $props();

    // =========================================================================
    // Mobile Detection (disable video on small screens)
    // =========================================================================

    const MOBILE_BREAKPOINT = 768;
    let isMobile = $state(browser ? window.innerWidth < MOBILE_BREAKPOINT : true);

    onMount(() => {
        const handleResize = () => {
            isMobile = window.innerWidth < MOBILE_BREAKPOINT;
        };
        const debouncedResize = debounce(handleResize, 150);
        window.addEventListener('resize', debouncedResize);
        return () => window.removeEventListener('resize', debouncedResize);
    });

    // =========================================================================
    // Video Control State
    // =========================================================================

    let videoDisabled = $state(getSavedVideoDisabledState());
    // Starts muted; kept in sync with the HeroVideoPlayer's exclusive-audio state
    // via its onMuteChange callback (handleMuteChange). Only drives the mute icon.
    let isMuted = $state(true);
    let heroPlayer: ReturnType<typeof HeroVideoPlayer> | undefined = $state();

    function handleToggleVideo() {
        videoDisabled = !videoDisabled;
        saveVideoDisabledState(videoDisabled);
    }

    function handleToggleMute() {
        if (heroPlayer) {
            heroPlayer.toggleMute();
        } else {
            // Fallback: toggle locally if the player ref isn't available yet.
            isMuted = !isMuted;
        }
    }

    function handleMuteChange(muted: boolean) {
        isMuted = muted;
    }

    // =========================================================================
    // Derived State
    // =========================================================================

    let item = $derived(firstFeaturedPickVideoItem(section.items));
    let meta = $derived(section.meta || {});
    let criteria = $derived(meta.featuredCriteria as FeaturedPickCriteria | undefined);
    let featuredReason = $derived(meta.featuredReason || getCriteriaLabel(criteria));

    // Feature flag - single toggle controls both trailers and video preview for featured pick
    // Disabled on mobile to save bandwidth and improve performance
    let featuredPickVideoEnabled = $derived(
        !isMobile && $page.data?.features?.featuredPickVideo === true,
    );

    // Image URLs - use pre-computed values from transformer, with fallbacks
    let backdropUrl = $derived(item?.backdrop || null);
    let logoUrl = $derived(item?.logo || null);

    // Track logo load failures by item id so the title reappears when no logo exists.
    const failedLogoIds = new SvelteSet<string>();
    let showLogo = $derived(!!logoUrl && !(item?.id != null && failedLogoIds.has(item.id)));

    // =========================================================================
    // Helpers
    // =========================================================================

    function getCriteriaLabel(criteria: FeaturedPickCriteria | undefined): string {
        switch (criteria) {
            case 'hidden-gem':
                return m.featured_hidden_gem?.() || 'Hidden Gem for You';
            case 'fresh-for-you':
                return m.featured_fresh_for_you?.() || 'Fresh for You';
            case 'perfect-match':
                return m.featured_perfect_match?.() || 'Perfect Match';
            case 'overlooked-classic':
                return m.featured_overlooked_classic?.() || 'Overlooked Classic';
            case 'buzzing-now':
                return m.featured_buzzing_now?.() || 'Buzzing Now';
            default:
                return m.featured_pick?.() || 'Featured Pick';
        }
    }

    function getCriteriaIcon(criteria: FeaturedPickCriteria | undefined): string {
        switch (criteria) {
            case 'hidden-gem':
                return '💎';
            case 'fresh-for-you':
                return '✨';
            case 'perfect-match':
                return '🎯';
            case 'overlooked-classic':
                return '🎬';
            case 'buzzing-now':
                return '🔥';
            default:
                return '⭐';
        }
    }

    function formatMetadata(): string {
        const parts: string[] = [];
        if (item?.year) parts.push(String(item.year));
        if (item?.durationMs) {
            const totalMinutes = Math.round(item.durationMs / 60_000);
            const hours = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;
            if (hours > 0 && mins > 0) parts.push(`${hours}h ${mins}m`);
            else if (hours > 0) parts.push(`${hours}h`);
            else parts.push(`${mins}m`);
        }
        if (item?.rating) {
            const rating =
                typeof item.rating === 'number' ? item.rating : parseFloat(String(item.rating));
            if (!isNaN(rating) && rating > 0) parts.push(`⭐ ${rating.toFixed(1)}`);
        }
        if (item?.genres && item.genres.length > 0) {
            parts.push(item.genres.slice(0, 2).join(', '));
        }
        return parts.join(' • ');
    }

    // Check if any ratings are available
    let hasRatings = $derived(
        (item?.criticRating && item.criticRating > 0) ||
            (item?.audienceRating && item.audienceRating > 0) ||
            (item?.mdblistScore && item.mdblistScore > 0),
    );

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function handlePlay(override?: UniversalMediaItem | null) {
        const target = override ?? item;
        if (!target) return;
        const playableId = getPlayableId(target);
        if (playableId) {
            if (onitemPlay) {
                onitemPlay(target);
            } else {
                const key = buildMediaKey(target.externalIds, target.mediaType) ?? playableId;
                void navigateToWatch(key);
            }
        } else if (target.canRequest && hasRequestPermission) {
            onitemRequest?.(target);
        }
    }

    function handleDetails(override?: UniversalMediaItem | null) {
        const target = override ?? item;
        if (!target) return;
        onitemClick?.(target);
    }

    function handleSimilar(override?: UniversalMediaItem | null) {
        const target = override ?? item;
        if (!target) return;
        onitemMore?.(target);
    }

    function handleLogoError() {
        if (item?.id != null) {
            failedLogoIds.add(item.id);
        }
    }

    // =========================================================================
    // Right-click context menu
    // =========================================================================

    let contextMenuPos = $state<{ x: number; y: number } | null>(null);
    let ratingModalOpen = $state(false);
    let fileInfoModalOpen = $state(false);
    /** Snapshot of `item` taken when the user picks a modal-opening
     * action. Without this snapshot the modal's externalIds / mediaId
     * props would track the live `section.items[0]` derive — and a
     * mid-modal section refresh (Quick Picks rotation, AI re-roll)
     * would silently retarget the modal to a different item, causing
     * a rating to land on the wrong title. */
    let modalTargetItem = $state<UniversalMediaItem | null>(null);
    /** Snapshot of the item the user right-clicked on. Pinned for the
     * lifetime of the open menu so a section rotate / re-roll while the
     * menu is open doesn't silently retarget the menu's actions to a
     * different featured item. */
    let contextMenuItem = $state<UniversalMediaItem | null>(null);

    let isFeaturedAdmin = $derived(isPageAdmin($page.data));

    let featuredMenuItems: ContextMenuEntry[] = $derived.by(() => {
        const target = contextMenuItem;
        if (!target) return [];
        const out: ContextMenuEntry[] = [];
        if (target.isAvailable && getPlayableId(target)) {
            out.push({
                label: m.card_play(),
                icon: PlayCircle,
                onSelect: () => handlePlay(target),
            });
        } else if (target.canRequest && hasRequestPermission) {
            out.push({
                label: m.request(),
                icon: DocumentPlus,
                onSelect: () => onitemRequest?.(target),
            });
        }
        out.push({
            label: m.card_open_details(),
            icon: InformationCircle,
            onSelect: () => handleDetails(target),
        });
        // "Why is this here?" is intentionally omitted on the featured pick:
        // the reason is already on the card face (criteria badge + inline
        // "💫 reason"), so a menu item opening the same text is redundant.
        if (onitemMore) {
            out.push({
                label: m.card_similar_titles(),
                icon: Sparkles,
                onSelect: () => handleSimilar(target),
            });
        }
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
                    modalTargetItem = target;
                    ratingModalOpen = true;
                },
            });
        }
        // "Show less like this" — soft, decaying, non-judgmental steering away
        // from similar content. Distinct from Dislike (a permanent 1★ rating).
        if (isMovie(target.mediaType) || isSeries(target.mediaType)) {
            out.push({
                label: m.card_less_like_this(),
                icon: EyeSlash,
                onSelect: () => {
                    void handleFeaturedLessLikeThis(target);
                },
            });
        }
        if (target.isPlayed && target.externalIds?.internal && isVideoItem(target)) {
            out.push({
                label: m.card_mark_unwatched(),
                icon: ArrowUturnLeft,
                onSelect: () => {
                    void markMediaUnwatched(target);
                },
            });
        }
        // The previous "Don't recommend this title" entry is now
        // covered by the quick-rate row's Dislike button above.
        if (buildMediaShareId(target) !== null) {
            out.push({
                label: m.card_copy_link(),
                icon: ClipboardDocument,
                onSelect: () => {
                    void copyMediaLink(target);
                },
            });
        }
        if (isFeaturedAdmin && target.externalIds?.internal && isVideoItem(target)) {
            out.push({
                label: m.card_file_info(),
                icon: DocumentMagnifyingGlass,
                hideOnMobile: true,
                onSelect: () => {
                    modalTargetItem = target;
                    fileInfoModalOpen = true;
                },
            });
            out.push({
                label: m.card_refresh_metadata(),
                icon: ArrowPath,
                hideOnMobile: true,
                onSelect: () => {
                    void refreshMediaMetadata(target);
                },
            });
            const adminTargetId =
                isEpisode(target.mediaType) && target.seriesId
                    ? target.seriesId
                    : target.externalIds.internal;
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
    });

    async function handleFeaturedLessLikeThis(target: UniversalMediaItem): Promise<void> {
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

    function handleFeaturedContextMenu(e: MouseEvent): void {
        if (!item) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, select, textarea')) return;
        e.preventDefault();
        e.stopPropagation();
        // Pin the item so a section refresh mid-menu doesn't retarget
        // the actions to a different featured pick.
        contextMenuItem = item;
        contextMenuPos = { x: e.clientX, y: e.clientY };
    }

    function closeFeaturedContextMenu(): void {
        contextMenuPos = null;
        contextMenuItem = null;
    }
</script>

{#if item}
    <section class="featured-pick-section mb-8 w-full">
        <div
            class="featured-card relative aspect-[21/9] rounded-xl overflow-hidden cursor-pointer group/hero w-full"
            role="button"
            tabindex="0"
            onclick={() => handleDetails()}
            onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleDetails();
            }}
            oncontextmenu={handleFeaturedContextMenu}>
            <!-- Video/Backdrop. `isolate` is load-bearing: the player's inner
                 layers carry z-indexes (backdrop cover z-10/20). Without a
                 stacking context here they escape and paint ABOVE the sibling
                 gradient scrims below — but only AT REST, because the
                 group-hover scale transform creates the context while
                 hovered. That's why the scrim used to appear on hover only. -->
            <div
                class="absolute inset-0 isolate transition-transform duration-500 group-hover/hero:scale-105">
                <HeroVideoPlayer
                    bind:this={heroPlayer}
                    {item}
                    trailersEnabled={!videoDisabled && featuredPickVideoEnabled}
                    videoPreviewEnabled={!videoDisabled && featuredPickVideoEnabled}
                    {backdropUrl}
                    aspectRatio="21/9"
                    startOffset={10}
                    videoScale={100}
                    showMuteButton={false}
                    onMuteChange={handleMuteChange} />
            </div>

            <!-- Gradient Overlay -->
            <div
                class="absolute inset-0 bg-gradient-to-r from-black/90 via-black/60 to-transparent">
            </div>
            <div
                class="absolute inset-0 bg-gradient-to-t from-black/95 from-0% via-black/55 via-40% to-transparent to-80%">
            </div>

            <!-- Badge + Content share one flex column so a long title can never
                 overlap the badge — they're stacked in document order instead of
                 independently top/bottom-anchored absolute boxes. -->
            <div class="absolute inset-0 z-10 flex flex-col">
                <!-- Featured Badge -->
                <div class="featured-badge p-4 hidden md:block">
                    <div
                        class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-sm text-white text-sm font-medium shadow-lg {criteria ===
                        'perfect-match'
                            ? 'bg-black/40 border border-white/30'
                            : 'bg-primary-500/90'}">
                        <span class="text-base">{getCriteriaIcon(criteria)}</span>
                        <span>{featuredReason}</span>
                    </div>
                </div>

                <!-- Content Overlay -->
                <div class="mt-auto p-6 md:p-8">
                    <div class="max-w-2xl">
                        <!-- Logo or Title -->
                        {#if showLogo}
                            <img
                                src={logoUrl}
                                alt={item.title}
                                class="h-16 md:h-20 max-w-[60%] object-contain mb-4"
                                onerror={handleLogoError} />
                        {/if}
                        <h2
                            class="featured-title text-2xl md:text-4xl font-bold text-white mb-2 line-clamp-2 drop-shadow-lg {showLogo
                                ? 'sr-only'
                                : ''}">
                            {item.title}
                        </h2>

                        <!-- Metadata Row -->
                        <p class="text-sm md:text-base text-gray-300 mb-2 subhero-scrim-text">
                            {formatMetadata()}
                        </p>

                        <!-- Ratings Row -->
                        {#if hasRatings}
                            <div
                                class="featured-ratings flex items-center gap-4 mb-3 text-sm subhero-scrim-text">
                                {#if item.criticRating && item.criticRating > 0}
                                    <span
                                        class="inline-flex items-center gap-1"
                                        title="Rotten Tomatoes Critics">
                                        <span>RT</span>
                                        <span class="text-gray-300">{item.criticRating}%</span>
                                    </span>
                                {/if}
                                {#if item.audienceRating && item.audienceRating > 0}
                                    <span
                                        class="inline-flex items-center gap-1"
                                        title="Rotten Tomatoes Audience">
                                        <span>AUD</span>
                                        <span class="text-gray-300">{item.audienceRating}%</span>
                                    </span>
                                {/if}
                                {#if item.mdblistScore && item.mdblistScore > 0}
                                    <span
                                        class="inline-flex items-center gap-1"
                                        title="MDBList Score">
                                        <span class="text-gray-400 font-medium">MDB</span>
                                        <span class="text-gray-300">{item.mdblistScore}</span>
                                    </span>
                                {/if}
                            </div>
                        {/if}

                        <!-- Overview -->
                        {#if item.overview}
                            <p
                                class="featured-overview text-sm md:text-base text-gray-200 line-clamp-3 mb-4 max-w-xl subhero-scrim-text">
                                {item.overview}
                            </p>
                        {/if}

                        <!-- AI Reason (if available) -->
                        {#if item.reason}
                            <p class="featured-reason text-sm text-primary-300 italic mb-4">
                                💫 {item.reason}
                            </p>
                        {/if}

                        <!-- Action Buttons -->
                        <div class="flex items-center gap-3">
                            {#if item.isAvailable}
                                <button
                                    class="featured-play-btn"
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        handlePlay();
                                    }}>
                                    <svg
                                        class="featured-play-icon"
                                        viewBox="0 0 24 24"
                                        fill="currentColor"
                                        aria-hidden="true">
                                        <path
                                            d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6Z" />
                                    </svg>
                                    {item.progress && item.progress > 0
                                        ? m.device_continue()
                                        : m.play()}
                                </button>
                            {:else if item.canRequest && hasRequestPermission}
                                <button
                                    class="btn variant-filled-secondary flex items-center gap-2 px-6 py-2.5 font-semibold"
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        onitemRequest?.(item);
                                    }}>
                                    <Icon src={Plus} class="w-5 h-5" />
                                    {m.request()}
                                </button>
                            {/if}

                            <button
                                class="btn variant-ghost-surface flex items-center gap-2 px-4 py-2.5"
                                onclick={(e) => {
                                    e.stopPropagation();
                                    handleDetails();
                                }}
                                title={m.card_details?.() || 'Details'}>
                                <Icon src={InformationCircle} class="w-5 h-5" />
                                <span class="hidden sm:inline">{m.moreInfo()}</span>
                            </button>

                            <button
                                class="btn variant-ghost-surface flex items-center gap-2 px-4 py-2.5"
                                onclick={(e) => {
                                    e.stopPropagation();
                                    handleSimilar();
                                }}
                                title={m.card_similar_titles?.() || 'Similar'}>
                                <Icon src={Sparkles} class="w-5 h-5" />
                                <span class="hidden sm:inline">{m.similar()}</span>
                            </button>

                            <!-- Video Controls (only when video feature is enabled) -->
                            {#if featuredPickVideoEnabled}
                                <div class="flex items-center gap-1 ml-2">
                                    <button
                                        class="btn-icon variant-ghost-surface w-10 h-10 rounded-full"
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            handleToggleVideo();
                                        }}
                                        title={videoDisabled ? 'Enable video' : 'Disable video'}>
                                        <Icon
                                            src={videoDisabled ? VideoCameraSlash : VideoCamera}
                                            class="w-5 h-5" />
                                    </button>
                                    {#if !videoDisabled}
                                        <button
                                            class="btn-icon variant-ghost-surface w-10 h-10 rounded-full"
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                handleToggleMute();
                                            }}
                                            title={isMuted ? 'Unmute' : 'Mute'}>
                                            <Icon
                                                src={isMuted ? SpeakerXMark : SpeakerWave}
                                                class="w-5 h-5" />
                                        </button>
                                    {/if}
                                </div>
                            {/if}
                        </div>

                        <!-- Progress Bar (if applicable) -->
                        {#if item.progress && item.progress > 0}
                            <div class="featured-progress mt-4 max-w-md">
                                <div class="flex items-center gap-2 mb-1">
                                    <div
                                        class="flex-1 h-1 bg-gray-700/50 rounded-full overflow-hidden">
                                        <div
                                            class="h-full bg-primary-500 rounded-full transition-all"
                                            style="width: {Math.min(item.progress, 100)}%">
                                        </div>
                                    </div>
                                    <span class="text-xs text-gray-400"
                                        >{Math.round(item.progress)}%</span>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>
        </div>
    </section>
{/if}

{#if contextMenuPos && contextMenuItem}
    <ContextMenu
        x={contextMenuPos.x}
        y={contextMenuPos.y}
        title={contextMenuItem.title}
        items={featuredMenuItems}
        onClose={closeFeaturedContextMenu} />
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

<style>
    /* Ensure section and children fill container width */
    .featured-pick-section :global(> *) {
        width: 100%;
    }

    .featured-card {
        min-height: 260px;
        max-height: 400px;
    }

    @media (min-width: 768px) {
        .featured-card {
            min-height: 300px;
        }
    }

    @media (min-width: 1024px) {
        .featured-card {
            min-height: 340px;
        }
    }

    /* Mobile Landscape — at this width the persistent sidebar (shown from
       md: up) eats most of the horizontal space, so the card's actual
       rendered width — and therefore its aspect-[21/9] height — is far
       narrower than the raw viewport width that triggered the md:
       typography/padding above. The full content stack (badge, title,
       metadata, overview, AI reason, buttons) then overflows the card's
       min-height floor, and overflow-hidden clips the action buttons.
       Drop everything but title/metadata/buttons so the primary CTAs are
       never clipped on a short landscape phone. */
    @media (max-width: 920px) and (orientation: landscape) {
        .featured-badge,
        .featured-ratings,
        .featured-overview,
        .featured-reason,
        .featured-progress {
            display: none;
        }

        .featured-title {
            -webkit-line-clamp: 1;
            line-clamp: 1;
        }
    }

    /* Subtle hover effect */
    .featured-card:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
    }

    /* Primary play action — mirrors HeroSection's .lumastra-hero-play so the
       two hero-style surfaces (top hero + Featured Pick) present the same
       "solid white pill" primary action instead of a generic Skeleton
       variant-filled-primary button. */
    .featured-play-btn {
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
        background: #fff;
        color: #0b1120;
        border: 1px solid transparent;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
        transition:
            background 0.15s ease,
            transform 0.12s ease,
            box-shadow 0.15s ease;
    }

    .featured-play-btn:hover {
        background: #f1f3f7;
        transform: translateY(-1px);
        box-shadow: 0 7px 24px rgba(0, 0, 0, 0.5);
    }

    .featured-play-btn:active {
        transform: translateY(0);
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45);
    }

    .featured-play-btn:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
    }

    .featured-play-icon {
        width: 18px;
        height: 18px;
        flex: none;
    }

    /* Text over the backdrop has no per-element background, only the gradient
       scrims above it — a bright backdrop (light hair, snow, daylight sky) can
       still wash out gray-300/200 text where the scrim has already faded.
       A soft shadow keeps it legible without darkening/blurring the artwork. */
    .subhero-scrim-text {
        text-shadow:
            0 1px 3px rgba(0, 0, 0, 0.9),
            0 1px 8px rgba(0, 0, 0, 0.7);
    }

    @media (prefers-reduced-motion: reduce) {
        .featured-play-btn {
            transition: none;
            transform: none;
        }
    }
</style>
