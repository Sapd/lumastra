<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ModalBody - Metadata, ratings, cast, and social activity for media modals
     *
     * Handles:
     * - Metadata row (year, ratings, duration, genres, studio, etc.)
     * - Actors/Cast section with hover previews and click-to-filmography
     * - Similar content section (via SectionRenderer)
     * - Social activity (other instance users who watched)
     */
    import { Icon, Check } from 'svelte-hero-icons';
    import { SectionRenderer } from '$lib/components/sections';
    import PluginDetailSlots from '$lib/components/plugins/PluginDetailSlots.svelte';
    import { ActorChip } from '$lib/components/modal';
    import SocialReviewSection from './SocialReviewSection.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import Skeleton from '$lib/components/ui/Skeleton.svelte';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import type { SocialActivity } from '$lib/utils/modal-data';
    import { openActorModal } from '$lib/utils/modal-utils';
    import { convertSecondsToHoursAndMinutes } from '../../../utility';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        // Props - Episode metadata
        season?: number | undefined;
        episode?: number | undefined;
        absoluteEpisode?: number | undefined;
        seriesChildCount?: number | undefined;
        isSeries?: boolean;
        // Props - Basic metadata
        year?: string | undefined;
        /** Facts already shown beside the title in the parent detail header. */
        hidePrimaryMetadata?: boolean;
        rating?: number | undefined;
        criticRating?: number | undefined;
        rtAudience?: number | undefined;
        letterboxdRating?: number | undefined;
        letterboxdVotes?: number | undefined;
        traktScore?: number | undefined;
        metacriticScore?: number | undefined;
        mdblistScore?: number | undefined;
        duration?: number | undefined;
        genres?: string[] | undefined;
        studio?: string | undefined;
        author?: string | undefined;
        // Props - Sonarr metadata
        sonarrNetwork?: string | undefined;
        sonarrQuality?: string | undefined;
        sonarrHasFile?: boolean;
        // Props - Cast (can be strings or objects with name/character)
        actors?:
            | Array<
                  | string
                  | {
                        name: string;
                        character?: string;
                        personId?: string | null;
                        profileUrl?: string;
                    }
              >
            | undefined;
        // Props - Similar content
        similarSection?: PageSection | null;
        showSimilar?: boolean;
        // Props - Social activity
        socialActivities?: SocialActivity[];
        showSocialActivity?: boolean;
        // Props - Reviews
        showReviews?: boolean;
        isEpisode?: boolean;
        /** Books are listened to, not watched. */
        isAudiobook?: boolean;
        mediaDbId?: string;
        currentUserId?: string;
        currentUserRating?: number | null;
        isAdmin?: boolean;
        onreviewchange?: () => void;
        onrated?: (rating: number) => void;
        // Props - Layout
        episodeLayout?: 'single' | 'split';
        // Callbacks
        onsimilarItemClick?: (detail: { section: PageSection; item: UniversalMediaItem }) => void;
        onsimilarItemMore?: (detail: { section: PageSection; item: UniversalMediaItem }) => void;
        /**
         * Identity of the item on screen, for plugin detail widgets. Null
         * disables the plugin section entirely (nothing to key a mount on).
         */
        pluginItem?: {
            id: string;
            mediaType: string;
            title: string;
            year: number | null;
            externalIds: { tmdb?: string; imdb?: string; tvdb?: string };
        } | null;
    }

    let {
        season = undefined,
        episode = undefined,
        absoluteEpisode = undefined,
        seriesChildCount = undefined,
        isSeries = false,
        year = undefined,
        hidePrimaryMetadata = false,
        rating = undefined,
        criticRating = undefined,
        rtAudience = undefined,
        letterboxdRating = undefined,
        letterboxdVotes = undefined,
        traktScore = undefined,
        metacriticScore = undefined,
        mdblistScore = undefined,
        duration = undefined,
        genres = undefined,
        studio = undefined,
        author = undefined,
        sonarrNetwork = undefined,
        sonarrQuality = undefined,
        sonarrHasFile = false,
        actors = undefined,
        similarSection = null,
        showSimilar = false,
        socialActivities = [],
        showSocialActivity = true,
        showReviews = true,
        isEpisode = false,
        isAudiobook = false,
        mediaDbId = undefined,
        currentUserId = undefined,
        currentUserRating = undefined,
        isAdmin = false,
        onreviewchange = undefined,
        onrated = undefined,
        episodeLayout = 'single',
        onsimilarItemClick,
        onsimilarItemMore,
        pluginItem = null,
    }: Props = $props();

    // Handle similar item click
    function handleSimilarItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        onsimilarItemClick?.(data);
    }

    // Handle similar item "more" button click
    function handleSimilarItemMore(data: { section: PageSection; item: UniversalMediaItem }) {
        onsimilarItemMore?.(data);
    }

    // Handle actor click - open actor modal
    function handleActorClick(detail: { id: number | string; name: string }) {
        const { id, name } = detail;

        // Validate we have a valid actor ID before doing anything
        if (!id || (typeof id === 'number' && id <= 0)) {
            console.warn('[ModalBody] Invalid actor ID:', id, 'for actor:', name);
            return;
        }

        // Open actor modal (will auto-close current modal)
        openActorModal(id, name);
    }
    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // Operator-supplied rating logos (IMDb/Rotten Tomatoes restrict their marks; we
    // ship text labels by default and only render a logo when the operator has
    // mounted one and pointed RATING_LOGO_* at it — see src/lib/server/config.ts).
    let ratingLogoImdb = $derived($page.data?.branding?.ratingLogoImdb || '');
    let ratingLogoRottenTomatoes = $derived($page.data?.branding?.ratingLogoRottenTomatoes || '');
    // Normalize actors to always be objects with name/character
    let normalizedActors = $derived(
        Array.isArray(actors)
            ? actors.map((actor) => {
                  if (typeof actor === 'string') {
                      return {
                          name: actor,
                          character: undefined,
                          personId: undefined,
                          profileUrl: undefined,
                      };
                  }
                  return actor;
              })
            : undefined,
    );
    // Check if any ratings are available
    let hasAnyRatings = $derived(
        rating ||
            criticRating ||
            rtAudience ||
            letterboxdRating ||
            traktScore ||
            metacriticScore ||
            mdblistScore,
    );
    let hasAnyMetadata = $derived(
        episode ||
            seriesChildCount ||
            (!hidePrimaryMetadata && year) ||
            hasAnyRatings ||
            (!hidePrimaryMetadata && duration) ||
            (!hidePrimaryMetadata && genres && genres.length > 0) ||
            studio ||
            author ||
            sonarrNetwork ||
            sonarrQuality ||
            sonarrHasFile,
    );
</script>

<!-- Metadata Row -->
{#if hasAnyMetadata}
    <small class="detail-secondary-metadata mb-2 pt-2 shrink">
        <!-- Episode info (only show if both season AND episode are defined) -->
        {#if season !== undefined && episode !== undefined}
            <span class="mr-4">
                S{season} E{episode}
                {#if absoluteEpisode}
                    <span>({absoluteEpisode})</span>
                {/if}
            </span>
        {/if}

        <!-- Season count for non-series views -->
        {#if seriesChildCount && !isSeries}
            <span class="mr-4">
                {seriesChildCount === 1
                    ? m.modal_one_season()
                    : m.modal_seasons({ count: String(seriesChildCount) })}
            </span>
        {/if}

        <!-- Year. Suppressed for a book: with ratings, genres and studio all
             absent, the year and the length were the ONLY things left in this
             row, so they read as two orphaned numbers. ModalAudiobookDetails
             carries them as labelled rows with the rest of the book's facts. -->
        {#if year && !isAudiobook && !hidePrimaryMetadata}
            <span class="mr-4">{year}</span>
        {/if}

        <!-- IMDb Rating -->
        {#if rating}
            <span class="mr-4">
                {#if ratingLogoImdb}
                    <img
                        class="criticlogo inline h-4 -mt-1"
                        src={ratingLogoImdb}
                        alt="IMDb Rating" />
                {:else}
                    <span class="text-yellow-400 font-bold text-xs">IMDb</span>
                {/if}
                {Math.floor(rating)}<small>/10</small>
            </span>
        {/if}

        <!-- Rotten Tomatoes Critics -->
        {#if criticRating}
            <Tooltip text="Rotten Tomatoes Critics" position="top" fixed>
                <span class="mr-4">
                    {#if ratingLogoRottenTomatoes}
                        <img
                            class="criticlogo inline h-4 -mt-2 ml-2"
                            src={ratingLogoRottenTomatoes}
                            alt="RT Critics" />
                    {:else}
                        <span class="text-red-500 font-bold text-xs">RT</span>
                    {/if}
                    {criticRating}%
                </span>
            </Tooltip>
        {/if}

        <!-- Rotten Tomatoes Audience -->
        {#if rtAudience}
            <Tooltip text="Rotten Tomatoes Audience" position="top" fixed>
                <span class="mr-4 inline-flex items-center gap-1">
                    {#if ratingLogoRottenTomatoes}
                        <img
                            class="criticlogo inline h-4 w-4 -mt-0.5"
                            src={ratingLogoRottenTomatoes}
                            alt="Rotten Tomatoes Audience" />
                    {:else}
                        <span class="text-red-500 font-bold text-xs">RT</span>
                    {/if}
                    {rtAudience}%
                </span>
            </Tooltip>
        {/if}

        <!-- Letterboxd Rating -->
        {#if letterboxdRating}
            <Tooltip
                text="Letterboxd Rating{letterboxdVotes
                    ? ` (${letterboxdVotes.toLocaleString()} votes)`
                    : ''}"
                position="top"
                fixed>
                <span class="mr-4">
                    <span class="text-orange-500 font-bold text-xs">LB</span>
                    {Number(letterboxdRating).toFixed(1)}
                </span>
            </Tooltip>
        {/if}

        <!-- Trakt Score -->
        {#if traktScore}
            <Tooltip text="Trakt Score" position="top" fixed>
                <span class="mr-4">
                    <span class="text-red-500 text-xs">T</span>
                    {traktScore}%
                </span>
            </Tooltip>
        {/if}

        <!-- Metacritic Score -->
        {#if metacriticScore}
            <Tooltip text="Metacritic Score" position="top" fixed>
                <span class="mr-4">
                    <span class="text-yellow-400 text-xs">MC</span>
                    {metacriticScore}
                </span>
            </Tooltip>
        {/if}

        <!-- MDBList Score -->
        {#if mdblistScore}
            <Tooltip text="MDBList Aggregated Score" position="top" fixed>
                <span class="mr-4">
                    <span class="text-teal-400 text-xs">MDB</span>
                    {mdblistScore}%
                </span>
            </Tooltip>
        {/if}

        <!-- Studio -->
        {#if studio}
            <span class="mr-4">{studio}</span>
        {/if}

        <!-- Author (for audiobooks) -->
        {#if author}
            <span class="mr-4">{author}</span>
        {/if}

        <!-- Duration -->
        {#if duration && !isAudiobook && !hidePrimaryMetadata}
            <span class="mb-2 mr-4">{convertSecondsToHoursAndMinutes(duration)}</span>
        {/if}

        <!-- Genres -->
        {#if genres && genres.length > 0 && !hidePrimaryMetadata}
            <span class="block sm:inline">
                {#each genres as genre, i (`${genre}-${i}`)}
                    <span class="mr-2">{genre}</span>
                {/each}
            </span>
        {/if}

        <!-- Sonarr Network -->
        {#if sonarrNetwork}
            <span class="mb-2 mr-4">{sonarrNetwork}</span>
        {/if}

        <!-- Sonarr Quality -->
        {#if sonarrQuality}
            <span class="mb-2 mr-4">{sonarrQuality}</span>
        {/if}

        <!-- Sonarr Has File Indicator (only show for episodes, not movies) -->
        {#if sonarrHasFile && episode}
            <Tooltip text={m.modal_episode_downloaded()} position="top" fixed>
                <span class="mb-2 mr-4">
                    <Icon class="inline text-green-500" src={Check} solid size="20" />
                </span>
            </Tooltip>
        {/if}
    </small>
{/if}

<!-- Actors Section -->
{#if normalizedActors && normalizedActors.length > 0}
    <div class="actors-section mt-4">
        <h4 class="text-sm font-semibold text-surface-300 mb-2">
            {m.modal_cast()}
        </h4>
        <div class="flex flex-wrap gap-1">
            {#each normalizedActors.slice(0, episodeLayout === 'split' ? 5 : 8) as actor, actorIdx (actor.name + '__' + actorIdx)}
                <ActorChip
                    id={actor.personId ?? undefined}
                    profileUrl={actor.profileUrl}
                    name={actor.name}
                    character={actor.character}
                    onclick={handleActorClick} />
            {/each}
            {#if normalizedActors.length > (episodeLayout === 'split' ? 5 : 8)}
                <span class="text-xs text-surface-400 px-2 py-1">
                    {m.modal_more_actors({
                        count: String(
                            normalizedActors.length - (episodeLayout === 'split' ? 5 : 8),
                        ),
                    })}
                </span>
            {/if}
        </div>
    </div>
{/if}

<!-- Similar Content Section -->
{#if showSimilar && similarSection}
    {#if similarSection.meta?.loading && similarSection.items.length === 0}
        <!-- Loading: reserve the rail with poster-shaped shimmer boxes so
             content doesn't pop in. Resolved-empty returns a null section
             (outer #if false), so no gap is reserved once loading settles. -->
        <div class="similar-section mt-4" aria-hidden="true">
            <div class="mb-2">
                <Skeleton width="w-28" height="h-4" />
            </div>
            <div class="flex gap-2 overflow-hidden">
                {#each Array.from({ length: 6 }) as _, i (i)}
                    <Skeleton
                        class="shrink-0"
                        width="w-[5.5rem]"
                        height="h-[8.25rem]"
                        rounded="md" />
                {/each}
            </div>
        </div>
    {:else}
        <div class="similar-section mt-4 modal-similar-carousel">
            <SectionRenderer
                section={similarSection}
                {hasRequestPermission}
                onitemClick={handleSimilarItemClick}
                onitemPlay={handleSimilarItemClick}
                onitemRequest={handleSimilarItemClick}
                onitemMore={handleSimilarItemMore} />
        </div>
    {/if}
{/if}

<!-- Social Activity + Reviews Section -->
<SocialReviewSection
    {socialActivities}
    {showSocialActivity}
    {showReviews}
    {isSeries}
    {isEpisode}
    {isAudiobook}
    {mediaDbId}
    {currentUserId}
    {currentUserRating}
    {isAdmin}
    {onreviewchange}
    {onrated} />

<!-- Plugin-contributed detail sections. Last in the stack: a plugin adds to
     the page rather than competing with the built-in metadata for the top. -->
<PluginDetailSlots
    widgets={$page.data?.pluginWidgets ?? []}
    item={pluginItem}
    user={$page.data?.pluginUser ?? null} />

<style lang="postcss">
    /* Make similar movies/shows posters smaller in modals */
    .modal-similar-carousel :global(.w-32) {
        width: 5.5rem; /* w-22 equivalent, down from w-32 (8rem) */
    }

    /* Also reduce the gap between items */
    .modal-similar-carousel :global(.gap-3) {
        gap: 0.5rem;
    }

    /* Smaller section title */
    .modal-similar-carousel :global(.text-lg) {
        font-size: 0.875rem;
        line-height: 1.25rem;
    }

    /* Hide all badges/overlays on posters - just show clean posters */
    .modal-similar-carousel :global(.absolute) {
        display: none !important;
    }

    .detail-secondary-metadata {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.625rem 1rem;
        padding-top: 0.875rem;
        border-top: 1px solid rgb(var(--color-surface-600-rgb) / 0.4);
        color: var(--color-surface-300);
        font-size: 0.75rem;
        line-height: 1.6;
    }
    .detail-secondary-metadata :global(.mr-4) {
        margin-right: 0;
        margin-bottom: 0;
        overflow-wrap: anywhere;
    }
</style>
