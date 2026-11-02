<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    KeywordChipsSection.svelte

    Horizontal scrollable chip list for genre/theme exploration.
    Supports multi-select: selecting multiple chips fetches their movies in
    parallel and shows the combined results. A single-chip selection
    supports load-more pagination.

    Uses ChipScrollRow for progressive reveal and no-clip scrolling.
-->
<script lang="ts">
    import { Icon, Hashtag, ArrowPath, XMark, Check } from 'svelte-hero-icons';
    import { page } from '$app/stores';
    import { z } from 'zod';
    import { PageBlockSchema } from '$lib/schemas/pagination';
    import { apiGet } from '$lib/api/client';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import StandardSection from './StandardSection.svelte';
    import ChipScrollRow from '$lib/components/ui/ChipScrollRow.svelte';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import { MOVIE_OR_TV_TO_CARD } from '$lib/utils/media-types';
    import * as m from '$lib/paraglide/messages';

    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);

    // =========================================================================
    // Types
    // =========================================================================

    interface ExploreKeyword {
        keyword: string;
        displayName: string;
        count: number;
    }

    type KeywordMovieRow = {
        externalIds: Record<string, string>;
        /** Canonical wire type — 'series' for TV (maps to 'tv' for imageFromIds / mediaCompositeKey). */
        type: 'movie' | 'series';
        title: string;
        year?: number | null;
        overview?: string | null;
        imdbRating?: number | null;
        mdblistScore?: number | null;
        qualityScore: number;
        aiSimilarity: number | null;
        isAvailable: boolean;
        canRequest: boolean;
    };

    // =========================================================================
    // Typed schema for /api/keyword-movies — matches server KeywordMoviesResponseSchema.
    // Wire shape: { keyword, personalized, items: [...], page }
    // Canonical: 'type' ∈ 'movie' | 'series'; mapRow converts 'series' → 'tv'
    // for imageFromIds / mediaCompositeKey (which use TMDB binary type).
    // =========================================================================

    const KeywordMovieItemClientSchema = z.object({
        externalIds: z.record(z.string(), z.string()),
        type: z.enum(['movie', 'series']),
        title: z.string(),
        overview: z.string().nullable().optional(),
        year: z.number().int().nullable().optional(),
        imdbRating: z.number().nullable().optional(),
        rtRating: z.number().nullable().optional(),
        rtAudienceRating: z.number().nullable().optional(),
        letterboxdRating: z.number().nullable().optional(),
        mdblistScore: z.number().nullable().optional(),
        qualityScore: z.number().int(),
        aiSimilarity: z.number().int().nullable(),
        popularity: z.number().nullable().optional(),
        isAvailable: z.boolean(),
        canRequest: z.boolean(),
    });

    const KeywordMoviesResponseClientSchema = z.object({
        keyword: z.string(),
        personalized: z.boolean(),
        page: PageBlockSchema,
        items: z.array(KeywordMovieItemClientSchema),
    });

    interface Props {
        section: PageSection;
        onitemClick?: (detail: UniversalMediaItem) => void;
        onitemPlay?: (detail: UniversalMediaItem) => void;
        onitemRequest?: (detail: UniversalMediaItem) => void;
        onitemMore?: (detail: UniversalMediaItem) => void;
    }

    let { section, onitemClick, onitemPlay, onitemRequest, onitemMore }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    let selectedKeywords: ExploreKeyword[] = $state([]);
    let keywordMovies: UniversalMediaItem[] = $state([]);
    let loadingMovies = $state(false);
    let loadingMore = $state(false);
    let hasMore = $state(false);
    let offset = 0;
    const ITEMS_PER_PAGE = 20;

    let keywords = $derived((section.meta?.keywords || []) as ExploreKeyword[]);
    let isMultiSelect = $derived(selectedKeywords.length > 1);

    // Build the movies section from current results
    let moviesSection = $derived.by(() => {
        if (selectedKeywords.length === 0 || keywordMovies.length === 0) return null;
        const title = selectedKeywords.map((k) => k.displayName).join(' + ');
        const id = `keyword-movies-${selectedKeywords.map((k) => k.keyword).join('-')}`;
        return {
            id,
            type: 'carousel' as const,
            title,
            items: keywordMovies,
            meta: {
                accentColor: 'cyan',
                subtitle:
                    hasMore && !isMultiSelect
                        ? `${keywordMovies.length}+ ${m.calendar_matches()}`
                        : `${keywordMovies.length} ${m.calendar_matches()}`,
            },
        };
    });

    // =========================================================================
    // Helpers
    // =========================================================================

    function mapRow(row: KeywordMovieRow): UniversalMediaItem {
        // imageFromIds / mediaCompositeKey use TMDB binary type ('movie' | 'tv');
        // canonical wire type 'series' maps to 'tv' at those call sites ONLY —
        // the emitted card mediaType maps back through MOVIE_OR_TV_TO_CARD.
        const tmdbType = row.type === 'series' ? 'tv' : 'movie';
        const compositeKey = mediaCompositeKey(row.externalIds, tmdbType);
        return {
            id: `kw-${compositeKey}`,
            externalIds: row.externalIds,
            mediaType: MOVIE_OR_TV_TO_CARD[tmdbType],
            title: row.title,
            subtitle: row.year ? String(row.year) : undefined,
            image: imageFromIds(row.externalIds, 'poster', tmdbType, { size: 'card' }) || '',
            overview: row.overview ?? undefined,
            rating: row.imdbRating ?? undefined,
            mdblistScore: row.mdblistScore ?? undefined,
            isAvailable: row.isAvailable,
            canRequest: row.canRequest,
        };
    }

    function dedupeById(items: UniversalMediaItem[]): UniversalMediaItem[] {
        const seen: Record<string, boolean> = {};
        return items.filter((item) => {
            if (seen[item.id]) return false;
            seen[item.id] = true;
            return true;
        });
    }

    // =========================================================================
    // Data loading
    // A generation counter discards responses from superseded calls so rapid
    // toggling never shows stale data.
    // =========================================================================

    let kwFetchGen = 0;

    async function loadSingleKeyword(keyword: string, reset: boolean): Promise<void> {
        if (reset) {
            loadingMovies = true;
            keywordMovies = [];
            offset = 0;
        } else {
            loadingMore = true;
        }
        const gen = kwFetchGen;

        try {
            const { data, error: fetchError } = await apiGet(
                '/api/keyword-movies',
                KeywordMoviesResponseClientSchema,
                { params: { keyword, limit: ITEMS_PER_PAGE, offset } },
            );
            if (gen !== kwFetchGen) return;

            if (fetchError || !data) {
                console.error('[KeywordChips] Failed to load movies:', fetchError);
                return;
            }

            const newItems = dedupeById([
                ...(reset ? [] : keywordMovies),
                ...data.items.map(mapRow),
            ]);
            keywordMovies = newItems;
            hasMore = data.page.hasMore;
            offset = (data.page.offset ?? offset) + data.page.limit;
        } catch (e) {
            console.error('[KeywordChips] Failed to load movies:', e);
        } finally {
            if (gen === kwFetchGen) {
                loadingMovies = false;
                loadingMore = false;
            }
        }
    }

    async function loadMultipleKeywords(kwList: ExploreKeyword[]): Promise<void> {
        loadingMovies = true;
        hasMore = false;
        offset = 0;
        keywordMovies = [];
        const gen = kwFetchGen;

        try {
            // allSettled so one failing genre doesn't discard the others
            const settled = await Promise.allSettled(
                kwList.map((kw) =>
                    apiGet('/api/keyword-movies', KeywordMoviesResponseClientSchema, {
                        params: { keyword: kw.keyword, limit: ITEMS_PER_PAGE, offset: 0 },
                    }),
                ),
            );
            if (gen !== kwFetchGen) return;

            const combined: UniversalMediaItem[] = [];
            for (const result of settled) {
                if (result.status === 'fulfilled' && result.value?.data?.items) {
                    combined.push(...result.value.data.items.map(mapRow));
                }
            }
            keywordMovies = dedupeById(combined);
        } catch (e) {
            console.error('[KeywordChips] Failed to load movies:', e);
        } finally {
            if (gen === kwFetchGen) loadingMovies = false;
        }
    }

    async function toggleKeyword(
        kw: ExploreKeyword,
        event: MouseEvent | KeyboardEvent,
    ): Promise<void> {
        const alreadySelected = selectedKeywords.some((k) => k.keyword === kw.keyword);
        let next: ExploreKeyword[];
        if (event.shiftKey) {
            next = alreadySelected
                ? selectedKeywords.filter((k) => k.keyword !== kw.keyword)
                : [...selectedKeywords, kw];
        } else {
            next = alreadySelected && selectedKeywords.length === 1 ? [] : [kw];
        }

        selectedKeywords = next;
        kwFetchGen++;
        loadingMore = false; // cancel any in-flight load-more immediately

        if (next.length === 0) {
            keywordMovies = [];
            hasMore = false;
            offset = 0;
            loadingMovies = false;
        } else if (next.length === 1) {
            await loadSingleKeyword(next[0].keyword, true);
        } else {
            await loadMultipleKeywords(next);
        }
    }

    function handleLoadMore(): void {
        if (selectedKeywords.length === 1 && hasMore && !loadingMore && !loadingMovies) {
            void loadSingleKeyword(selectedKeywords[0].keyword, false);
        }
    }

    function clearAll(): void {
        selectedKeywords = [];
        keywordMovies = [];
        hasMore = false;
        offset = 0;
        loadingMovies = false;
        loadingMore = false;
    }

    function handleClearKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            clearAll();
        }
    }

    // =========================================================================
    // Event bubbling
    // =========================================================================

    function handleItemClick(item: UniversalMediaItem): void {
        onitemClick?.(item);
    }
    function handleItemPlay(item: UniversalMediaItem): void {
        onitemPlay?.(item);
    }
    function handleItemRequest(item: UniversalMediaItem): void {
        onitemRequest?.(item);
    }
    function handleItemMore(item: UniversalMediaItem): void {
        onitemMore?.(item);
    }
</script>

{#if keywords.length > 0}
    <section class="space-y-4">
        <!-- Section Header -->
        <h3 class="flex items-center gap-2 text-lg font-semibold text-gray-200">
            <Icon src={Hashtag} class="w-5 h-5 text-cyan-400" />
            {section.title}
        </h3>

        <!-- Keyword Chips -->
        <ChipScrollRow totalCount={keywords.length}>
            {#snippet children(visibleCount)}
                <!-- Clear all — visible only when keywords are selected -->
                {#if selectedKeywords.length > 0}
                    <button
                        data-drag-scroll-allow
                        class="genre-chip shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all bg-surface-600 text-surface-300 hover:bg-red-500/20 hover:text-red-300"
                        onclick={clearAll}
                        onkeydown={handleClearKeydown}>
                        <Icon src={XMark} class="w-4 h-4" />
                    </button>
                {/if}

                {#each keywords.slice(0, visibleCount) as kw (kw.keyword)}
                    {@const isSelected = selectedKeywords.some((k) => k.keyword === kw.keyword)}
                    <button
                        data-drag-scroll-allow
                        class="genre-chip shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all
                            {isSelected
                            ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/50'
                            : 'bg-surface-700 text-gray-300 hover:bg-cyan-600/30 hover:text-cyan-300'}"
                        onclick={(e) => toggleKeyword(kw, e)}>
                        {#if isSelected}
                            <Icon src={Check} class="w-4 h-4" />
                        {/if}
                        <span>{kw.displayName}</span>
                        <span class="text-xs opacity-70">({kw.count})</span>
                    </button>
                {/each}
            {/snippet}
        </ChipScrollRow>

        <!-- Selected Keyword Movies -->
        {#if selectedKeywords.length > 0}
            <div class="mt-4">
                {#if loadingMovies}
                    <div class="flex items-center gap-2 py-4 text-gray-400">
                        <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                        <span
                            >{m.loading_title({
                                title: selectedKeywords.map((k) => k.displayName).join(', '),
                            })}</span>
                    </div>
                {:else if moviesSection}
                    <StandardSection
                        section={moviesSection}
                        {hasRequestPermission}
                        onitemClick={handleItemClick}
                        onitemPlay={handleItemPlay}
                        onitemRequest={handleItemRequest}
                        onitemMore={handleItemMore} />

                    <!-- Load more — only in single-keyword mode -->
                    {#if !isMultiSelect && hasMore}
                        <div class="mt-4 flex justify-center">
                            <button
                                class="flex items-center gap-2 rounded-lg bg-surface-700 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-surface-600"
                                onclick={handleLoadMore}
                                disabled={loadingMore}>
                                {#if loadingMore}
                                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                    {m.section_loading_more()}
                                {:else}
                                    {m.section_load_more()}
                                {/if}
                            </button>
                        </div>
                    {/if}
                {:else}
                    <p class="py-4 text-muted">
                        {m.keyword_no_movies_found({
                            keyword: selectedKeywords.map((k) => k.displayName).join(', '),
                        })}
                    </p>
                {/if}
            </div>
        {/if}
    </section>
{/if}

<style lang="postcss">
    .genre-chip {
        cursor: pointer;
        white-space: nowrap;
        -webkit-user-select: none;
        user-select: none;
    }

    .genre-chip:hover {
        transform: translateY(-1px);
    }

    .genre-chip:active {
        transform: translateY(0);
    }

    .genre-chip:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
    }
</style>
