<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    // Module-scoped counter → unique per-instance heading ids. Build-safe:
    // $props.id() passes svelte-check but fails the production rolldown build.
    let modalHeaderIdSeq = 0;
</script>

<script lang="ts">
    /**
     * ModalHeader - Title and metadata section for media modals
     *
     * Handles the display of:
     * - Title (movie/series name or episode name)
     * - Series name (for episodes)
     * - Season/Episode info
     * - Episode description (for Sonarr episodes)
     *
     * Overview uses a responsive line budget and an explicit expansion button.
     */
    import * as m from '$lib/paraglide/messages';
    import {
        formatSeriesCounts,
        formatSeriesProgress,
        type SeriesCountSummary,
    } from '$lib/utils/series-episode-counts';
    import LanguageBadges from '$lib/components/media/LanguageBadges.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import AudiobookProgress from './AudiobookProgress.svelte';
    import ModalOverview from './ModalOverview.svelte';
    import type { ComponentProps } from 'svelte';
    import { Icon, ChevronRight, BookOpen } from 'svelte-hero-icons';
    import type { MediaQualitySummary } from '$lib/schemas/media-detail';
    import { convertSecondsToHoursAndMinutes } from '../../../utility';
    import { buildQualityChips, type QualityChipTone } from '$lib/utils/quality-chips';

    import { secondaryTitle, normalizeTitle } from '$lib/utils/search/matched-title';

    interface Props {
        seriesCounts?: SeriesCountSummary;
        title: string;
        matchedTitle?: string;
        tagline?: string | undefined;
        year?: string | number | undefined;
        duration?: number | undefined;
        certification?: string | undefined;
        genres?: string[] | undefined;
        libraryNames?: string[] | undefined;
        audiobook?: boolean;
        coverImage?: string | undefined;
        creator?: string | undefined;
        /** The listener's place in this audiobook; shown under the author. */
        audiobookProgress?: ComponentProps<typeof AudiobookProgress> | undefined;
        /** Original production language title (shown when different from display title) */
        originalTitle?: string | undefined;
        /** English title (shown when different from both display and original title) */
        englishTitle?: string | undefined;
        seriesName?: string | undefined;
        overview?: string | undefined;
        mediaType?: string | undefined;
        episode?: number | undefined;
        episodeNumberEnd?: number | undefined;
        episodeTitle?: string | undefined;
        originalLanguage?: string | undefined;
        audioLanguages?: string[] | undefined;
        subtitleLanguages?: string[] | undefined;
        /** Best-available version quality summary (4K / HDR / Dolby Vision / Atmos chips). */
        quality?: MediaQualitySummary | undefined;
        /** When true, title/seriesName are rendered in the backdrop strip on mobile */
        hideTitleOnMobile?: boolean;
        /**
         * When provided (episode view), the series-name subtitle becomes the
         * "go to the parent series" affordance — clicking it swaps this episode
         * card for the series overview. Keeps navigation out of the bottom
         * action bar and reads as "this episode belongs to <series> → tap".
         */
        ongoToSeries?: () => void;
        /** Spinner + disabled state while the series modal is resolving. */
        seriesLoading?: boolean;
    }

    let {
        seriesCounts = {},
        title,
        matchedTitle = undefined,
        tagline = undefined,
        year = undefined,
        duration = undefined,
        certification = undefined,
        genres = [],
        libraryNames = [],
        audiobook = false,
        coverImage = undefined,
        creator = undefined,
        audiobookProgress = undefined,
        originalTitle = undefined,
        englishTitle = undefined,
        seriesName = undefined,
        overview = undefined,
        mediaType = undefined,
        episode = undefined,
        episodeNumberEnd = undefined,
        episodeTitle = undefined,
        originalLanguage = undefined,
        audioLanguages = undefined,
        subtitleLanguages = undefined,
        quality = undefined,
        hideTitleOnMobile = false,
        ongoToSeries = undefined,
        seriesLoading = false,
    }: Props = $props();

    // Premium-format badges (4K / HDR / Dolby Vision / Atmos) for the
    // best-available version. Derivation lives in a tested helper; the tone →
    // class map is kept here (full literal strings so Tailwind can detect them).
    const qualityChips = $derived(buildQualityChips(quality));
    const TONE_CLASSES: Record<QualityChipTone, string> = {
        amber: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
        orange: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        purple: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
        cyan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
    };

    // Unique per-instance id for the title heading. A hard-coded `modal-title`
    // collides when two modals stack, so `aria-labelledby` (auto-wired by
    // ModalContainer) would resolve to the background modal's title. A module-
    // scoped counter gives an instance-unique value (modals are client-mounted,
    // so there's no SSR/hydration id mismatch).
    modalHeaderIdSeq += 1;
    const titleId = `modal-title-${modalHeaderIdSeq}`;

    // Build alternate title line: show titles that differ from the display title
    let alternateTitles = $derived.by(() => {
        const matched = secondaryTitle(matchedTitle, title);
        if (matched) return matched;
        const parts: string[] = [];
        for (const candidate of [englishTitle, originalTitle]) {
            const alternative = secondaryTitle(candidate, title);
            if (
                alternative &&
                !parts.some((part) => normalizeTitle(part) === normalizeTitle(alternative))
            ) {
                parts.push(alternative);
            }
        }
        return parts.length > 0 ? parts.join(' · ') : null;
    });

    let failedCover = $state<string>();
    const mediaLabel = $derived(
        audiobook
            ? m.media_audiobook()
            : mediaType === 'movie'
              ? m.media_movie()
              : mediaType === 'tv' || mediaType === 'series'
                ? m.media_series()
                : undefined,
    );

    /** For combined episodes (e.g. "Der Einbruch / Der Neue"), split and label overview parts */
    let overviewParts = $derived.by(() => {
        if (episodeNumberEnd == null || episode == null || !overview) return null;
        const expectedSegments = episodeNumberEnd - episode + 1;
        if (expectedSegments < 2) return null;

        // Split on " / " followed by an uppercase letter — the separator pattern
        // in combined Jellyfin episode overviews
        const parts = overview.split(/ \/ (?=[A-Z])/);
        // Only split if part count matches expected segment count
        if (parts.length !== expectedSegments) return null;

        // Extract segment names from title (e.g., "Der Einbruch / Der Neue")
        const titleParts = episodeTitle?.split(' / ') ?? [];

        return parts.map((part, i) => ({
            label: titleParts[i] || `Part ${i + 1}`,
            text: part.trim(),
        }));
    });
</script>

<header class="detail-header shrink-0 min-w-0 max-w-full" class:audiobook-header={audiobook}>
    <div class="detail-heading" class:mobile-hidden={hideTitleOnMobile}>
        {#if audiobook}
            <div class="book-cover">
                {#if coverImage && failedCover !== coverImage}
                    <img
                        src={coverImage}
                        alt=""
                        width="220"
                        height="220"
                        onerror={() => (failedCover = coverImage)} />
                {:else}
                    <Icon src={BookOpen} class="w-12 h-12 text-surface-400" />
                {/if}
            </div>
        {/if}
        <div class="heading-copy">
            {#if mediaLabel || libraryNames?.length}
                <p class="detail-context text-surface-400">
                    {#if mediaLabel}<span>{mediaLabel}</span>{/if}
                    {#if libraryNames?.length}<span class="library-context"
                            >{libraryNames.join(' · ')}</span
                        >{/if}
                </p>
            {/if}
            <h1
                id={titleId}
                class="detail-title text-2xl sm:text-4xl font-bold mb-1 h1 leading-tight pt-1">
                {title ?? m.modal_title_missing()}
            </h1>
            {#if creator}<p class="detail-creator text-surface-200">{creator}</p>{/if}
            {#if audiobook && audiobookProgress}<AudiobookProgress {...audiobookProgress} />{/if}

            {#if alternateTitles}
                <p
                    class="text-sm text-surface-400 truncate mb-2 max-w-[calc(100vw-3rem)] sm:max-w-[400px] md:max-w-[600px] lg:max-w-[800px]">
                    {alternateTitles}
                </p>
            {:else}
                <div class="mb-1"></div>
            {/if}

            {#if seriesName}
                {#if ongoToSeries}
                    <button
                        type="button"
                        class="series-link text-lg text-surface-300 mb-1 inline-flex items-center gap-0.5 max-w-full"
                        onclick={ongoToSeries}
                        disabled={seriesLoading}
                        aria-busy={seriesLoading}
                        aria-label={m.modal_go_to_series()}>
                        <span class="truncate">{seriesName}</span>
                        {#if seriesLoading}
                            <span
                                class="loading-spinner loading-spinner-primary shrink-0"
                                role="status"
                                aria-label={m.loading()}></span>
                        {:else}
                            <Icon src={ChevronRight} class="w-4 h-4 shrink-0 series-link-chevron" />
                        {/if}
                    </button>
                {:else}
                    <h2 class="text-lg text-surface-300 mb-1">{seriesName}</h2>
                {/if}
            {/if}
        </div>
    </div>

    {#if formatSeriesCounts(seriesCounts, mediaType)}
        <p class="text-sm text-surface-300" data-series-counts>
            {formatSeriesCounts(seriesCounts, mediaType)}
        </p>
    {/if}
    {#if formatSeriesProgress(seriesCounts, mediaType)}
        <p class="text-sm text-surface-400" data-series-progress>
            {formatSeriesProgress(seriesCounts, mediaType)}
        </p>
    {/if}

    {#if !audiobook && (year || duration || certification?.trim() || genres.length)}
        <div class="detail-facts text-surface-300">
            {#if year}<span>{year}</span>{/if}
            {#if duration && duration > 0}<span>{convertSecondsToHoursAndMinutes(duration)}</span
                >{/if}
            {#if certification?.trim()}<span class="content-rating">{certification.trim()}</span
                >{/if}
            {#if genres.length}
                <span class="detail-genres"
                    >{#each genres as genre, i (`${genre}-${i}`)}<span>{genre}</span>{/each}</span>
            {/if}
        </div>
    {/if}

    {#if tagline?.trim()}
        <p class="detail-tagline text-surface-300">{tagline.trim()}</p>
    {/if}

    {#if overview}
        <ModalOverview {overview} parts={overviewParts} id={`${titleId}-overview`} />
    {/if}
    {#if qualityChips.length || audioLanguages?.length || subtitleLanguages?.length}
        <div class="mt-2 flex flex-wrap items-center gap-1">
            {#each qualityChips as chip (chip.label)}
                <Tooltip text={chip.tooltip} position="top" fixed>
                    <span
                        class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold tracking-wide border {TONE_CLASSES[
                            chip.tone
                        ]}"
                        aria-label={chip.tooltip}
                        title={chip.tooltip}>{chip.label}</span>
                </Tooltip>
            {/each}
            <LanguageBadges {originalLanguage} {audioLanguages} {subtitleLanguages} />
        </div>
    {/if}
</header>

<style>
    .detail-heading {
        min-width: 0;
    }
    .heading-copy {
        min-width: 0;
    }
    .detail-title {
        font-size: clamp(1.5rem, 2.8vw, 2.375rem);
        font-weight: 700;
        overflow-wrap: anywhere;
        text-wrap: balance;
        letter-spacing: -0.025em;
    }
    .detail-context {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem 0.75rem;
        font-size: 0.75rem;
        margin-bottom: 0.5rem;
        padding-right: 2rem;
    }
    .library-context {
        overflow-wrap: anywhere;
    }
    .detail-context > span + span {
        border-left: 1px solid var(--color-surface-600);
        padding-left: 0.75rem;
    }
    .detail-tagline {
        margin: 0.5rem 0 0.875rem;
        font-size: 0.875rem;
        font-style: italic;
        line-height: 1.5;
    }
    .detail-facts {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 0.875rem;
        margin: 0.75rem 0;
        font-size: 0.75rem;
        line-height: 1.5;
    }
    .content-rating {
        padding: 0.05rem 0.375rem;
        border: 1px solid var(--color-surface-500);
        border-radius: 0.25rem;
    }
    .detail-genres {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 0.25rem 0.625rem;
        color: var(--color-surface-400);
    }
    .detail-creator {
        margin-top: 0.875rem;
        font-size: 1rem;
    }
    .audiobook-header .detail-heading {
        display: flex;
        align-items: center;
        gap: 1.75rem;
        padding: 1.5rem;
        margin-bottom: 1.5rem;
        border-radius: 0.75rem;
        background: linear-gradient(
            135deg,
            rgb(var(--color-primary-500-rgb) / 0.14),
            rgb(var(--color-surface-800-rgb) / 0.3)
        );
    }
    .book-cover {
        display: grid;
        place-items: center;
        width: 220px;
        aspect-ratio: 1;
        flex-shrink: 0;
        border-radius: 0.5rem;
        background: var(--color-surface-800);
        overflow: hidden;
        box-shadow: 0 12px 30px #0004;
    }
    .book-cover img {
        width: 100%;
        height: 100%;
        object-fit: contain;
    }
    @media (max-width: 639px) {
        .audiobook-header .detail-heading {
            padding: 1.25rem;
            gap: 1rem;
        }
        .book-cover {
            width: 130px;
        }
    }
    @media (max-width: 419px) {
        .audiobook-header .detail-heading {
            flex-direction: column;
            text-align: center;
        }
        .book-cover {
            width: 170px;
        }
        .audiobook-header .detail-context {
            justify-content: center;
            padding-right: 0;
        }
    }
    /* Episode view: the series name doubles as the "go to series" link. Styled
       as plain subtitle text until hover/focus so it doesn't compete with the
       episode title, then reveals its affordance. */
    .series-link {
        background: transparent;
        border: 0;
        padding: 0;
        cursor: pointer;
        text-align: left;
        transition:
            color 0.12s ease,
            opacity 0.12s ease;
    }
    .series-link:disabled {
        cursor: default;
        opacity: 0.7;
    }
    .series-link :global(.series-link-chevron) {
        opacity: 0.5;
        transition:
            transform 0.12s ease,
            opacity 0.12s ease;
    }
    .series-link:hover:not(:disabled),
    .series-link:focus-visible {
        color: var(--color-primary-400, #818cf8);
    }
    .series-link:hover:not(:disabled) :global(.series-link-chevron),
    .series-link:focus-visible :global(.series-link-chevron) {
        opacity: 1;
        transform: translateX(2px);
    }
    .series-link:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
        border-radius: 4px;
    }

    /* Hide title on mobile when it's rendered in the backdrop strip */
    @media (max-width: 639px) {
        .mobile-hidden {
            display: none;
        }
    }
</style>
