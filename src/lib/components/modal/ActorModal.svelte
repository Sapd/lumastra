<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { deriveIsAdmin } from '$lib/utils/permissions';
    import ImageCandidates from '$lib/components/admin/media/ImageCandidates.svelte';
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
    import { pickVariant } from '$lib/utils/image-utils';
    /**
     * ActorModal - Shows actor details and filmography
     *
     * Uses Server-Driven UI pattern:
     * - Fetches person data from /api/person/{id}
     * - Transforms to PageSection format
     * - Renders with SectionRenderer for consistent UI
     */
    import { onMount } from 'svelte';
    import { SectionRenderer } from '$lib/components/sections';
    import { modals, modalCount } from '$lib/stores/modal.store';
    import SimilarMoviesModal from '$lib/components/SimilarMoviesModal.svelte';
    import { openMediaModal } from '$lib/utils/modal-utils';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import type {
        PersonCredit,
        PersonDetailResponse as ActorDetails,
    } from '$lib/schemas/api-person-responses';
    import { hasValidExternalId } from '$lib/utils/media-id-helpers';
    import { isSeries } from '$lib/shared/media-types';
    import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
    import * as adminApi from '$lib/api/admin';

    interface Props {
        // Props
        actorId: string;
        actorName: string;
        // Injected by ModalContainer - used as id attribute for accessibility
        modalId: string;
    }

    let { actorId, actorName, modalId }: Props = $props();

    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);

    let isAdmin = $derived(deriveIsAdmin($page.data));

    async function refreshImages(): Promise<void> {
        const result = await adminApi.getPerson(actorId);
        if (result.data) actorDetails = result.data;
    }

    // Check if we have history to go back to (more than 1 modal in stack)
    let hasHistory = $derived($modalCount > 1);

    // State
    let loading = $state(true);
    let error = $state<string | null>(null);
    let actorDetails = $state<ActorDetails | null>(null);

    // Sections for server-driven UI
    let movieSection = $state<PageSection | null>(null);
    let tvSection = $state<PageSection | null>(null);

    onMount(async () => {
        if (!actorId) {
            error = m.actor_no_id();
            loading = false;
            return;
        }

        try {
            const { data, error: apiError } = await adminApi.getPerson(actorId);
            if (apiError || !data) {
                throw new Error(apiError || 'Failed to fetch person');
            }

            actorDetails = data;
            if (!actorDetails) {
                error = m.actor_invalid_data();
                return;
            }

            if (!actorDetails.name) {
                error = m.actor_not_found();
                return;
            }

            // Build sections
            movieSection = buildMovieSection(actorDetails.movieCredits || []);
            tvSection = buildTvSection(actorDetails.tvCredits || []);
        } catch (err) {
            console.error('Failed to load actor details:', err);
            error = m.actor_load_error();
        } finally {
            loading = false;
        }
    });

    function transformCredit(credit: PersonCredit): UniversalMediaItem {
        // Build subtitle: character name + episode count for TV
        let subtitle = credit.character || '';
        if (isSeries(credit.type) && credit.episodeCount) {
            const epText =
                credit.episodeCount === 1
                    ? m.actor_one_episode()
                    : m.actor_episodes({ count: String(credit.episodeCount) });
            subtitle = subtitle ? `${subtitle} (${epText})` : epText;
        } else if (!subtitle && credit.year) {
            subtitle = String(credit.year);
        }

        return {
            id: credit.id,
            externalIds: mediaPreviewToUniversal(credit).externalIds,
            mediaType: credit.type === 'season' ? 'series' : credit.type,
            title: credit.title,
            subtitle,
            image: pickVariant(credit.images.poster, 'thumb') ?? '/placeholder-poster.jpg',
            rating: credit.rating,
            year: credit.year,
            isAvailable: credit.availability?.isAvailable ?? false,
            canRequest: credit.availability?.canRequest ?? false,
            hasFiles: credit.availability?.hasFile ?? credit.availability?.isAvailable ?? false,
            clickData: { credit },
        };
    }

    function buildMovieSection(credits: PersonCredit[]): PageSection | null {
        if (!credits || credits.length === 0) return null;

        return {
            id: 'actor-movies',
            type: 'carousel',
            title: m.actor_movies(),
            items: credits.map((c) => transformCredit(c)),
            meta: {
                icon: 'film',
                collapsible: false,
                showRefresh: false,
            },
        };
    }

    function buildTvSection(credits: PersonCredit[]): PageSection | null {
        if (!credits || credits.length === 0) return null;

        return {
            id: 'actor-tv',
            type: 'carousel',
            title: m.actor_series(),
            items: credits.map((c) => transformCredit(c)),
            meta: {
                icon: 'tv',
                collapsible: false,
                showRefresh: false,
            },
        };
    }

    async function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const credit = item.clickData?.credit as PersonCredit | undefined;
        if (!credit) return;

        // Open media modal (stacking on top of actor modal)
        openMediaModal(
            {
                externalIds: mediaPreviewToUniversal(credit).externalIds,
                // A TMDB person credit is always a movie or a tv entity — those are
                // the only two credit namespaces TMDB has — so the narrowing cannot
                // fail here. Kept checked rather than asserted.
                // eslint-disable-next-line callback-safety/no-inline-media-type-default -- TMDB credits are movie/series only.
                mediaType: toTmdbType(credit.type) ?? 'movie',
                title: credit.title,
                overview: '',
                isAvailable: credit.availability?.isAvailable ?? false,
                canRequest: credit.availability?.canRequest ?? false,
            },
            item.image,
        );
    }

    // Handle "more/similar" button click on filmography items
    async function handleItemMore(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const credit = item.clickData?.credit as PersonCredit | undefined;

        // Build externalIds from credit or item
        const externalIds = credit?.ids || item.externalIds || {};
        const name = credit?.title || item.title;
        const mediaType = credit?.type || item.mediaType;

        if (!hasValidExternalId(externalIds)) return;

        // Open similar movies modal (stacking on top of actor modal)
        await modals.open(SimilarMoviesModal, {
            sourceMedia: {
                externalIds,
                name,
                type: mediaType,
            },
            similar: [],
            loading: true,
        });
    }

    async function handleBack() {
        await modals.close();
    }

    async function handleClose() {
        // X = "Done": leave the whole trail. Back (handleBack) still pops one.
        await modals.closeAll();
    }

    function formatDate(dateStr: string | undefined): string {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleDateString(getLocale(), {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    }

    function calculateAge(
        birthday: string | undefined,
        deathday: string | undefined,
    ): number | null {
        if (!birthday) return null;
        const birth = new Date(birthday);
        const end = deathday ? new Date(deathday) : new Date();
        const age = Math.floor((end.getTime() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        return age;
    }

    let age = $derived.by(() => {
        const details = actorDetails;
        if (!details) return null;
        return calculateAge(details.birthday, details.deathday);
    });
    let profileImageUrl = $derived.by(() => {
        const details = actorDetails;
        const profile = details?.images.primary;
        return pickVariant(profile, 'full') ?? null;
    });
</script>

<div
    id={modalId}
    class="card p-4 sm:p-6 shadow-xl max-w-[900px] w-screen sm:w-[90vw] max-h-[90vh] overflow-y-auto relative">
    <!-- Navigation buttons row -->
    <div class="flex justify-between items-center mb-4">
        <!-- Back button (when navigated from another modal) -->
        {#if hasHistory}
            <button
                class="p-2 rounded-full hover:bg-surface-600 transition-colors flex items-center gap-1 text-sm text-surface-300 hover:text-surface-100"
                onclick={handleBack}
                aria-label={m.back()}>
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M15 19l-7-7 7-7" />
                </svg>
                <span class="hidden sm:inline">{m.back()}</span>
            </button>
        {:else}
            <div></div>
        {/if}

        <!-- Close button -->
        <button
            class="p-2 rounded-full hover:bg-surface-600 transition-colors"
            onclick={handleClose}
            aria-label={m.close()}>
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    </div>

    {#if loading}
        <div class="center-col py-12">
            <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
            {#if actorName}
                <p class="mt-4 text-surface-400">{actorName}</p>
            {/if}
        </div>
    {:else if error || !actorDetails}
        <div class="text-center py-12">
            <p class="text-error-500">{error || m.actor_not_found()}</p>
            {#if actorName}
                <p class="text-surface-400 mt-2">{actorName}</p>
            {/if}
            <button class="btn variant-ghost-surface mt-4" onclick={handleClose}>
                {m.close()}
            </button>
        </div>
    {:else if actorDetails}
        {#if isAdmin}
            <div class="mb-4">
                <ImageCandidates mediaId={actorDetails.id} onsaved={() => void refreshImages()} />
            </div>
        {/if}
        <!-- Header with profile image and bio -->
        <div class="flex flex-col sm:flex-row gap-6 mb-6">
            <!-- Profile image -->
            {#if profileImageUrl}
                <div class="shrink-0">
                    <img
                        src={profileImageUrl}
                        alt={actorDetails.name}
                        class="w-32 h-48 sm:w-40 sm:h-60 object-cover rounded-lg shadow-lg mx-auto sm:mx-0" />
                </div>
            {/if}

            <!-- Info -->
            <div class="flex-1 min-w-0">
                <h2 class="text-2xl sm:text-3xl font-bold mb-2">
                    {actorDetails.name}
                </h2>

                <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-surface-400 mb-4">
                    {#if actorDetails.knownForDepartment}
                        <span>{actorDetails.knownForDepartment}</span>
                    {/if}
                    {#if actorDetails.birthday}
                        <span>
                            {formatDate(actorDetails.birthday)}
                            {#if age !== null}
                                ({actorDetails.deathday
                                    ? m.actor_years_old_deceased({
                                          age: String(age),
                                      })
                                    : m.actor_years_old({
                                          age: String(age),
                                      })})
                            {/if}
                        </span>
                    {/if}
                    {#if actorDetails.deathday}
                        <span class="text-surface-500">
                            {m.actor_deceased({
                                date: formatDate(actorDetails.deathday),
                            })}
                        </span>
                    {/if}
                    {#if actorDetails.placeOfBirth}
                        <span>{actorDetails.placeOfBirth}</span>
                    {/if}
                </div>

                {#if actorDetails.biography}
                    <div class="max-h-[150px] overflow-y-auto text-sm text-surface-300 pr-2">
                        <p class="whitespace-pre-line">
                            {actorDetails.biography}
                        </p>
                    </div>
                {/if}
            </div>
        </div>

        <!-- Filmography sections -->
        <div class="space-y-4 actor-filmography">
            {#if movieSection}
                <SectionRenderer
                    section={movieSection}
                    {hasRequestPermission}
                    onitemClick={handleItemClick}
                    onitemMore={handleItemMore} />
            {/if}

            {#if tvSection}
                <SectionRenderer
                    section={tvSection}
                    {hasRequestPermission}
                    onitemClick={handleItemClick}
                    onitemMore={handleItemMore} />
            {/if}

            {#if !movieSection && !tvSection}
                <p class="text-center text-surface-400 py-8">
                    {m.actor_no_filmography()}
                </p>
            {/if}
        </div>

        <!-- Close button -->
        <footer class="mt-6 flex justify-end">
            <button class="btn variant-ghost-surface" onclick={handleClose}>
                {m.close()}
            </button>
        </footer>
    {/if}
</div>

<style>
    /* Smaller cards in actor filmography */
    :global(.actor-filmography .media-card) {
        max-width: 120px;
    }

    :global(.actor-filmography .media-card img) {
        height: 180px;
    }

    /* Make carousel scroll edge-to-edge within modal */
    :global(.actor-filmography .smooth-scroll) {
        /* Extend scroll area to edges */
        margin-left: -1rem;
        margin-right: -1rem;
        padding-left: 1rem;
        padding-right: 1rem;
    }

    @media (min-width: 640px) {
        :global(.actor-filmography .smooth-scroll) {
            margin-left: -1.5rem;
            margin-right: -1.5rem;
            padding-left: 1.5rem;
            padding-right: 1.5rem;
        }
    }
</style>
