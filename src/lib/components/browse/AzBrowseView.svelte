<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * A-Z Browse View Component
     * Handles alphabetical browsing of media with library filtering and infinite scroll
     */
    import { onMount, untrack } from 'svelte';
    import { Icon, Squares2x2, ListBullet } from 'svelte-hero-icons';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages';
    import * as browseApi from '$lib/api/browse';
    import { watchStateVersion } from '$lib/stores/watch-state-version';
    import UniversalMediaCard from '$lib/components/ui/UniversalMediaCard.svelte';
    import CatalogFilterPanel from '$lib/components/browse/CatalogFilterPanel.svelte';
    import BrowseFilterSearch from '$lib/components/browse/BrowseFilterSearch.svelte';
    import { LANGUAGE_LABELS } from '$lib/shared/track-language';
    import { HDR_LABELS, CODEC_LABELS } from '$lib/shared/quality-filter';
    import { keywordDisplayName } from '$lib/shared/keyword-vocabulary';
    import AzSortDropdown from '$lib/components/browse/AzSortDropdown.svelte';
    import { LoadingState } from '$lib/components/ui';
    import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
    import type { AudioFilterLang, SubtitleFilterLang } from '$lib/shared/track-language';
    import type { ResolutionTier, HdrTier, CodecTier } from '$lib/shared/quality-filter';
    import type { BrowseSort } from '$lib/stores/azBrowse';
    import { createRenderableMediaKeys } from '$lib/utils/media-id-helpers';
    import type { GenreCount, KeywordCount } from '$lib/schemas/api-browse-responses';

    interface Props {
        restoreCount?: number;
        onRestored?: () => void;
        query?: string;
        onClearSearch?: () => void;
        onContentChange?: (next: { genre?: string; tag?: string }) => void;
        initialView?: 'grid' | 'list';
        onViewChange?: (view: 'grid' | 'list') => void;
        mediaType?: 'all' | 'movie' | 'tv';
        selectedGroupId?: string | null;
        /** Letter to pre-select on mount (restored from the URL). */
        initialLetter?: string | null;
        hasRequestPermission?: boolean;
        pageSize?: number;
        scrollMargin?: string;
        onitemClick?: (item: UniversalMediaItem) => void;
        onitemPlay?: (item: UniversalMediaItem) => void;
        onitemMore?: (item: UniversalMediaItem) => void;
        /** Notify the parent that the library selection changed (drives the URL). */
        onSelectLibrary?: (libraryGroupId: string | null) => void;
        /** Notify the parent that the letter selection changed (drives the URL). */
        onSelectLetter?: (letter: string | null) => void;
        /** Initial audio-language filter (restored from the URL/localStorage). */
        audioLangs?: AudioFilterLang[];
        /** Initial subtitle-language filter (restored from the URL/localStorage). */
        subLangs?: SubtitleFilterLang[];
        /** Initial "include untagged" toggle (restored from the URL/localStorage). */
        includeUnknown?: boolean;
        qualityIncludeUnknown?: boolean;
        /** Initial sort order (restored from the URL/localStorage). */
        sort?: BrowseSort;
        /** Initial resolution-tier filter (restored from the URL/localStorage). */
        resolutions?: ResolutionTier[];
        /** Initial HDR-tier filter (restored from the URL/localStorage). */
        hdr?: HdrTier[];
        /** Initial codec-tier filter (restored from the URL/localStorage). */
        codecs?: CodecTier[];
        /** Genre filter — exact match, case-sensitive (restored from the URL). */
        genre?: string;
        /** Tag/keyword filter — normalized server-side (restored from the URL). */
        tag?: string;
        /** Notify the parent that the audio/subtitle/quality filter changed (drives the URL + persistence). */
        onFilterChange?: (next: {
            audioLangs: AudioFilterLang[];
            subLangs: SubtitleFilterLang[];
            includeUnknown: boolean;
            resolutions: ResolutionTier[];
            hdr: HdrTier[];
            codecs: CodecTier[];
        }) => void;
        /** Notify the parent that the sort order changed (drives the URL + persistence). */
        onSortChange?: (sort: BrowseSort) => void;
        /**
         * Whether to offer the A-Z letter rail.
         *
         * `'always'` — /browse/az, where the rail is the entire point.
         * `'auto'`   — /browse/filter, where it appears only once the scope is
         *              large enough to be worth jumping around in. The rail is
         *              the strongest visual signal that says "you are in A-Z
         *              mode", so hiding it on an ordinary filtered set is what
         *              keeps the results view from impersonating A-Z.
         */
        showLetterRail?: 'always' | 'auto';
    }

    let {
        restoreCount = 0,
        onRestored,
        query = '',
        onClearSearch,
        onContentChange,
        initialView = 'grid',
        onViewChange,
        mediaType = 'all',
        selectedGroupId = $bindable(null),
        initialLetter = null,
        hasRequestPermission = false,
        pageSize = 50,
        scrollMargin = '400px',
        onitemClick,
        onitemPlay,
        onitemMore,
        onSelectLibrary,
        onSelectLetter,
        audioLangs = [],
        subLangs = [],
        includeUnknown = false,
        qualityIncludeUnknown = includeUnknown,
        sort = 'title_asc',
        resolutions = [],
        hdr = [],
        codecs = [],
        genre,
        tag,
        onFilterChange,
        onSortChange,
        showLetterRail = 'always',
    }: Props = $props();
    export function getLoadedCount(): number {
        return items.length;
    }

    let view = $state(untrack(() => initialView));
    let loadError = $state(false);
    let requestController: AbortController | undefined;
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    let queryPending = $state(false);
    function clearContent(): void {
        selectedGroupId = null;
        selectedLetter = null;
        onSelectLibrary?.(null);
        onSelectLetter?.(null);
        onContentChange?.({});
    }
    function clearFilters(): void {
        audioLangsState = [];
        subLangsState = [];
        resolutionsState = [];
        hdrState = [];
        codecsState = [];
        includeUnknownState = false;
        clearContent();
        handleFilterChange();
    }
    function selectContent(choice: { kind: 'genre' | 'tag'; value: string }): void {
        onContentChange?.(
            choice.kind === 'genre' ? { genre: choice.value, tag } : { genre, tag: choice.value },
        );
    }
    function changeView(next: 'grid' | 'list'): void {
        view = next;
        onViewChange?.(next);
    }

    /**
     * Minimum scope size before `showLetterRail: 'auto'` offers the rail.
     * Jumping to 'Q' inside a few dozen results buys nothing.
     */
    const LETTER_RAIL_MIN_ITEMS = 100;

    // Local mirrors of the filter/sort state for two-way binding into
    // <AzFilterPanel> / <AzSortDropdown>. Seeded once from the props via
    // untrack() (same "capture initial value only" intent as
    // selectedLetter/initialLetter): after mount this component owns the values
    // and reports changes upward through onFilterChange/onSortChange. Refetch is
    // driven ONLY by the explicit handleFilterChange/handleSortChange callbacks
    // (fired by the child onChange), never by an $effect watching this state —
    // that would risk a reactive loop.
    let audioLangsState = $state<AudioFilterLang[]>(untrack(() => audioLangs));
    let subLangsState = $state<SubtitleFilterLang[]>(untrack(() => subLangs));
    let includeUnknownState = $state<boolean>(
        untrack(() => includeUnknown || qualityIncludeUnknown),
    );
    // Older links stored separate language/quality flags. Preserve their query
    // semantics until the viewer changes the unified playback controls.
    let languageUnknown = untrack(() => includeUnknown);
    let qualityUnknown = untrack(() => qualityIncludeUnknown);
    let sortState = $state<BrowseSort>(untrack(() => sort));
    let resolutionsState = $state<ResolutionTier[]>(untrack(() => resolutions));
    let hdrState = $state<HdrTier[]>(untrack(() => hdr));
    let codecsState = $state<CodecTier[]>(untrack(() => codecs));

    // Letter rail only makes sense for alphabetical sorts.
    let isAlphabeticalSort = $derived(sortState === 'title_asc' || sortState === 'title_desc');

    // A-Z data
    let items: UniversalMediaItem[] = $state([]);
    // Infinite scroll appends pages without dedup (line ~98), so overlapping page
    // boundaries can yield duplicate ids — keying on those directly throws
    // `each_key_duplicate`. createRenderableMediaKeys suffixes the collisions.
    let itemRenderKeys = $derived(createRenderableMediaKeys(items));
    let totalCount = $state(0);
    let offset = 0;
    let hasMore = $state(false);
    let loading = $state(false);
    /** Monotonic token discarding a superseded loadItems() response. */
    let itemsReqSeq = 0;
    /**
     * Identity of the request currently in flight, so an exactly-duplicate call
     * can be skipped. Several handlers mutate state that the reactive $effect
     * below also watches, which makes them fire loadItems() twice for one click.
     */
    let inFlightSignature: string | null = null;

    /** Everything that distinguishes one items request from another. */
    function requestSignature(reset: boolean): string {
        return JSON.stringify([
            reset,
            reset ? 0 : offset,
            mediaType,
            query.trim(),
            selectedLetter,
            selectedGroupId,
            genre,
            tag,
            sortState,
            audioLangsState,
            subLangsState,
            languageUnknown,
            qualityUnknown,
            resolutionsState,
            hdrState,
            codecsState,
        ]);
    }
    /**
     * Whether a load has actually completed. Gates the "no items" empty state:
     * items are fetched in onMount behind a `browser` guard, so the SSR frame
     * has an empty list and no load in flight — without this the server-rendered
     * first paint of a dedicated results route reads "No items found" before
     * hydration even gets a chance to fetch.
     */
    let hasLoadedOnce = $state(false);

    // A-Z + '#' jump-nav. '#' gathers titles that don't start with a Latin
    // letter (digits, Hangul/CJK) so non-Latin series stay reachable in one tap.
    const AZ_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
    // Seeded from the URL (initialLetter) so a deep-linked ?letter=Q restores the
    // filter on load. untrack() makes the "capture initial value only" intent
    // explicit — after mount this component owns the value and reports changes
    // upward via onSelectLetter (the prop is not meant to drive it thereafter).
    let selectedLetter = $state<string | null>(untrack(() => initialLetter));
    let contentCount = $derived(
        Number(!!genre) + Number(!!tag) + Number(!!selectedGroupId) + Number(!!selectedLetter),
    );
    let playbackChips = $derived([
        ...audioLangsState.map((value) => ({
            key: `audio-${value}`,
            label: `${m.catalog_audio()}: ${LANGUAGE_LABELS[value]}`,
            remove: (): void => {
                audioLangsState = audioLangsState.filter((v) => v !== value);
            },
        })),
        ...subLangsState.map((value) => ({
            key: `sub-${value}`,
            label: `${m.catalog_subtitles()}: ${LANGUAGE_LABELS[value]}`,
            remove: (): void => {
                subLangsState = subLangsState.filter((v) => v !== value);
            },
        })),
        ...resolutionsState.map((value) => ({
            key: `res-${value}`,
            label: value,
            remove: (): void => {
                resolutionsState = resolutionsState.filter((v) => v !== value);
            },
        })),
        ...hdrState.map((value) => ({
            key: `hdr-${value}`,
            label: HDR_LABELS[value],
            remove: (): void => {
                hdrState = hdrState.filter((v) => v !== value);
            },
        })),
        ...codecsState.map((value) => ({
            key: `codec-${value}`,
            label: CODEC_LABELS[value],
            remove: (): void => {
                codecsState = codecsState.filter((v) => v !== value);
            },
        })),
        ...(includeUnknownState
            ? [
                  {
                      key: 'unknown',
                      label: m.catalog_unknown_chip(),
                      remove: (): void => {
                          includeUnknownState = false;
                      },
                  },
              ]
            : []),
    ]);
    let letterCounts = $state<{ letter: string; count: number }[]>([]);
    let countByLetter = $derived(new Map(letterCounts.map((c) => [c.letter, c.count])));

    /**
     * Measured on `letterCounts`, NOT `totalCount`.
     *
     * `totalCount` is computed WITH the letter filter applied, so a threshold on
     * it would make the rail delete itself the moment it is used: 140 results →
     * rail shows → click 'K' → 12 results → rail vanishes, taking its own "All"
     * button with it and stranding the user inside the K subset. `letterCounts`
     * comes from the bucket-count query, which takes no letter, and is retained
     * as the last non-empty set — the only letter-independent size signal here.
     */
    let letterRailEarnsItsPlace = $derived(
        showLetterRail === 'always' ||
            letterCounts.reduce((sum, c) => sum + c.count, 0) >= LETTER_RAIL_MIN_ITEMS ||
            // Never retract the rail out from under an active selection. A
            // quality/language filter can shrink the scope below the threshold
            // while a letter is applied, and hiding the rail would take the
            // "All" button with it — leaving the user inside a letter subset
            // with nothing on screen to clear it.
            selectedLetter !== null,
    );

    // Genre/tag facets for the current scope, including legitimately empty results.
    let genreCounts = $state<GenreCount[]>([]);
    let keywordCounts = $state<KeywordCount[]>([]);

    // Library filter
    let libraries: {
        id: string;
        name: string;
        itemCount: number;
        mediaType: 'movie' | 'tv' | 'mixed';
    }[] = $state([]);
    let librariesLoading = $state(false);
    let librariesLoaded = $state(false);

    // Infinite scroll sentinel
    let sentinel: HTMLDivElement | undefined = $state();
    let observer = $state<IntersectionObserver | null>(null);

    let filteredLibraries = $derived(
        libraries.filter((lib) => {
            if (mediaType === 'all') return true;
            if (lib.mediaType === 'mixed') return true;
            return lib.mediaType === mediaType;
        }),
    );

    /**
     * The library row only repeats the media tabs above the grid when every
     * library holds one media type and no two share one: picking "Movies (72)"
     * is then exactly the Movies tab. Two movie libraries, or a mixed one, make
     * it a real choice again. An active selection (e.g. a deep-linked
     * ?libraryGroupId) always keeps the row, so it stays visible and clearable.
     */
    let librariesMirrorTabs = $derived.by(() => {
        if (selectedGroupId) return false;
        const types = libraries.map((lib) => lib.mediaType);
        return !types.includes('mixed') && new Set(types).size === types.length;
    });

    // Clear stale selection if the selected library was filtered out (e.g., music libraries
    // excluded from A-Z browse after browsable_item_count filter took effect).
    // Only once the list has loaded: before that EVERY selection looks stale, and
    // a deep-linked ?libraryGroupId was wiped on mount (and the wipe written to the URL).
    $effect(() => {
        if (
            selectedGroupId &&
            librariesLoaded &&
            !filteredLibraries.some((l) => l.id === selectedGroupId)
        ) {
            selectGroup(null);
        }
    });

    /**
     * Load A-Z items from API
     */
    function azRequestParams(
        pageOffset: number,
        signal?: AbortSignal,
    ): Parameters<typeof browseApi.getAzBrowse>[0] {
        return {
            q: query.trim(),
            signal: signal,
            type: mediaType,
            offset: pageOffset,
            limit: pageSize,
            ...(selectedLetter ? { letter: selectedLetter } : {}),
            ...(selectedGroupId ? { libraryGroupId: selectedGroupId } : {}),
            ...(genre ? { genre } : {}),
            ...(tag ? { tag } : {}),
            ...(audioLangsState.length ? { audio: audioLangsState } : {}),
            ...(subLangsState.length ? { subs: subLangsState } : {}),
            ...(languageUnknown ? { includeUnknown: true } : {}),
            sort: sortState,
            ...(resolutionsState.length ? { res: resolutionsState } : {}),
            ...(hdrState.length ? { hdr: hdrState } : {}),
            ...(codecsState.length ? { codec: codecsState } : {}),
            ...(qualityUnknown ? { qualityIncludeUnknown: true } : {}),
        };
    }

    let countsReqSeq = 0;
    let countsRefreshPending = false;
    let countsRefreshRunning = false;
    let countsDisposed = false;
    async function refreshLoadedCounts(): Promise<void> {
        countsRefreshPending = true;
        await drainCountRefresh();
    }
    async function drainCountRefresh(): Promise<void> {
        if (countsRefreshRunning || loading || queryPending || countsDisposed) return;
        countsRefreshRunning = true;
        try {
            while (countsRefreshPending && !loading && !queryPending && !countsDisposed) {
                countsRefreshPending = false;
                const scope = requestSignature(true);
                const countsReq = ++countsReqSeq;
                const loadedCount = items.length;
                const pages = Math.ceil(loadedCount / pageSize);
                const responses: PromiseSettledResult<
                    Awaited<ReturnType<typeof browseApi.getAzBrowse>>
                >[] = [];
                // Keep restored long lists from flooding the API. A newer mutation
                // or page/scope load stops the remaining batches and coalesces a retry.
                for (let page = 0; page < pages; page += 4) {
                    responses.push(
                        ...(await Promise.allSettled(
                            Array.from({ length: Math.min(4, pages - page) }, (_, index) =>
                                browseApi.getAzBrowse(azRequestParams((page + index) * pageSize)),
                            ),
                        )),
                    );
                    if (
                        countsRefreshPending ||
                        loading ||
                        scope !== requestSignature(true) ||
                        loadedCount !== items.length ||
                        countsDisposed
                    )
                        break;
                }
                if (countsDisposed || countsReq !== countsReqSeq) return;
                // A page appended or scope changed during the refresh. Retry after
                // the active load so every currently displayed page gets fresh counts.
                if (scope !== requestSignature(true) || loading || loadedCount !== items.length) {
                    countsRefreshPending = true;
                    continue;
                }
                if (countsRefreshPending) continue;
                const refreshed: Record<string, UniversalMediaItem> = {};
                const failedIds: Record<string, boolean> = {};
                for (const [page, response] of responses.entries()) {
                    if (
                        response.status !== 'fulfilled' ||
                        response.value.error ||
                        !response.value.data
                    ) {
                        for (const item of items.slice(page * pageSize, (page + 1) * pageSize))
                            failedIds[item.id] = true;
                        continue;
                    }
                    for (const item of response.value.data.items ?? []) refreshed[item.id] = item;
                }
                items = items.map((item) => {
                    const fresh = refreshed[item.id];
                    if (failedIds[item.id]) {
                        const unknown = { ...item };
                        delete unknown.availableEpisodeCount;
                        delete unknown.watchedEpisodeCount;
                        delete unknown.unwatchedEpisodeCount;
                        return unknown;
                    }
                    return fresh
                        ? {
                              ...item,
                              seasonCount: fresh.seasonCount,
                              episodeCount: fresh.episodeCount,
                              availableEpisodeCount: fresh.availableEpisodeCount,
                              watchedEpisodeCount: fresh.watchedEpisodeCount,
                              unwatchedEpisodeCount: fresh.unwatchedEpisodeCount,
                          }
                        : item;
                });
            }
        } finally {
            countsRefreshRunning = false;
        }
    }

    export async function loadItems(reset = false): Promise<void> {
        clearTimeout(queryTimer);
        // Monotonic request token, NOT `if (loading) return`.
        //
        // That early return dropped a load outright, and the genre/tag effect
        // below consumes the change (it updates prevGenre/prevTag) BEFORE
        // calling here — so a filter changed mid-flight was never refetched and
        // nothing retried it: the grid kept the old filter's items while the
        // URL and chips claimed the new one, permanently. Reachable in one
        // click now that the filter picker rides along with the grid.
        //
        // Superseded responses are discarded on arrival instead (see the guards
        // after each await), which is the same pattern BrowseFilterSearch uses.
        //
        // The guard it replaced did double duty, though: it also deduped the
        // handlers that mutate state the reactive $effect below ALSO watches
        // (selectGroup sets selectedGroupId, then both it and the effect call
        // here). So identical in-flight requests are dropped explicitly —
        // narrower than "any load while loading", so a genuinely different
        // filter still supersedes.
        const signature = requestSignature(reset);
        if (loading && signature === inFlightSignature) return;

        const myReq = ++itemsReqSeq;
        requestController?.abort();
        requestController = new AbortController();
        inFlightSignature = signature;

        if (reset) {
            items = [];
            offset = 0;
            totalCount = 0;
            hasMore = false;
        }

        loading = true;
        loadError = false;
        queryPending = false;
        try {
            const result = await browseApi.getAzBrowse(
                azRequestParams(offset, requestController.signal),
            );

            // A newer load started while this one was in flight — its results
            // are the truth now, so drop these rather than appending them into
            // the wrong filter's list.
            if (myReq !== itemsReqSeq) return;

            if (!result.error && result.data) {
                const azItems = result.data.items ?? [];
                items = reset ? azItems : [...items, ...azItems];
                totalCount = result.data.page.total ?? 0;
                hasMore = result.data.page.hasMore ?? false;
                offset = (result.data.page.offset ?? offset) + result.data.page.limit;
                // Letter counts are independent of the selected letter.
                letterCounts = result.data.letterCounts ?? [];
                genreCounts = result.data.genreCounts ?? [];
                keywordCounts = result.data.keywordCounts ?? [];
            } else {
                loadError = true;
            }
        } catch (e) {
            if (myReq !== itemsReqSeq) return;
            loadError = true;
            console.error('Failed to load A-Z items:', e);
        } finally {
            // Only the newest request owns the spinner; a superseded one
            // clearing it would hide the load that is still running.
            if (myReq === itemsReqSeq) {
                loading = false;
                hasLoadedOnce = true;
                inFlightSignature = null;
                void drainCountRefresh();
            }
        }
    }

    /**
     * Load library list from API
     */
    async function loadLibraries() {
        if (librariesLoading || librariesLoaded) return;

        librariesLoading = true;
        try {
            const { data, error } = await browseApi.getLibraries();
            if (error || !data) {
                libraries = [];
                return;
            }
            librariesLoaded = true;
            libraries = (data.libraries ?? []).map((lib) => ({
                id: lib.id,
                name: lib.name,
                itemCount: lib.itemCount ?? 0,
                // API wire format uses 'series' (public convention); this component's
                // internal Library type follows the storage/comparison convention
                // ('tv') so it lines up with the `mediaType` prop values passed in
                // from the parent ('all' | 'movie' | 'tv').
                mediaType: lib.mediaType === 'series' ? 'tv' : lib.mediaType,
            }));
        } catch (e) {
            console.error('[AzBrowseView] Failed to load libraries:', e);
            libraries = [];
        } finally {
            librariesLoading = false;
        }
    }

    /**
     * Handle group selection change
     */
    // NOTE: selectGroup/selectLetter mutate the state the reactive `$effect`
    // below also watches, so that effect fires a second loadItems(true) after
    // this handler. It's deduped ONLY by loadItems()'s `if (loading) return`
    // guard (loading is set true synchronously before the await, so the effect's
    // microtask-later call is a no-op). If loadItems ever awaits before setting
    // loading=true, this would reintroduce a double fetch — keep that guard first.
    function selectGroup(libraryGroupId: string | null) {
        selectedGroupId = libraryGroupId;
        selectedLetter = null;
        // Report upward so the parent reflects it in the URL (?libraryGroupId=…, letter cleared).
        onSelectLibrary?.(libraryGroupId);
        loadItems(true);
    }

    /**
     * Handle letter (or '#') selection from the jump-nav rail.
     * Passing null clears the filter ("All").
     */
    function selectLetter(letter: string | null) {
        selectedLetter = selectedLetter === letter ? null : letter;
        // Report the resolved value (may be null after toggling off) for the URL.
        onSelectLetter?.(selectedLetter);
        loadItems(true);
    }

    /**
     * Handle a change to the audio/subtitle/quality filter.
     * Fired by <AzFilterPanel>'s onChange after each mutation. Mirrors
     * selectLetter: reset + refetch, then report upward so the parent persists
     * it and reflects it in the URL. Refetch happens here (explicit callback),
     * NOT in an $effect on the bound state — avoids a read/trigger loop.
     */
    function handleFilterChange() {
        languageUnknown = includeUnknownState;
        qualityUnknown = includeUnknownState;
        loadItems(true);
        onFilterChange?.({
            audioLangs: audioLangsState,
            subLangs: subLangsState,
            includeUnknown: includeUnknownState,
            resolutions: resolutionsState,
            hdr: hdrState,
            codecs: codecsState,
        });
    }

    /**
     * Handle a change to the sort order.
     * Fired by <AzSortDropdown>'s onChange. Resets pagination; if the new sort
     * is not alphabetical the letter rail no longer applies, so clear any
     * selected letter. Then refetch + report upward (explicit callback, no
     * $effect on the bound state — avoids a read/trigger loop).
     */
    function handleSortChange() {
        offset = 0;
        if (!isAlphabeticalSort) {
            selectedLetter = null;
        }
        loadItems(true);
        onSortChange?.(sortState);
    }

    /**
     * Forward item click event to parent
     */
    function handleItemClick(item: UniversalMediaItem) {
        onitemClick?.(item);
    }

    /**
     * Forward item play event to parent
     */
    function handleItemPlay(item: UniversalMediaItem) {
        onitemPlay?.(item);
    }

    /**
     * Forward item more event to parent
     */
    function handleItemMore(item: UniversalMediaItem) {
        onitemMore?.(item);
    }

    // Track previous prop values to detect changes (plain let — not $state, to avoid self-triggering effects)
    let prevMediaType: typeof mediaType | undefined;
    let prevSelectedGroupId: typeof selectedGroupId | undefined;
    // genre/tag are `string | undefined` themselves, so unlike mediaType/
    // selectedGroupId (whose domains exclude undefined) a `!== undefined`
    // check can't double as "has this effect run before" — undefined is a
    // legitimate "no filter" value for both. A dedicated flag distinguishes
    // "never run" from "ran once with an undefined value".
    let prevGenre: string | undefined;
    let prevTag: string | undefined;
    let hasTrackedGenreTag = false;
    let previousQuery = untrack(() => query);

    $effect(() => {
        const next = query;
        if (next === previousQuery) return;
        previousQuery = next;
        clearTimeout(queryTimer);
        // Invalidate on input, not after debounce: old replies cannot repaint
        // under the newly typed title. Keep the request itself debounced.
        itemsReqSeq++;
        requestController?.abort();
        queryPending = true;
        loading = false;
        loadError = false;
        items = [];
        hasMore = false;
        if (selectedLetter) {
            selectedLetter = null;
            onSelectLetter?.(null);
        }
        queryTimer = setTimeout(() => {
            void loadItems(true);
        }, 220);
    });

    // Reactively reload items when mediaType, selectedGroupId, genre, or tag changes
    $effect(() => {
        // Read current prop values to establish reactive dependencies
        const currentMediaType = mediaType;
        const currentLibrary = selectedGroupId;
        const currentGenre = genre;
        const currentTag = tag;

        // Check if props actually changed (not just initial reactivity)
        const mediaTypeChanged = prevMediaType !== undefined && currentMediaType !== prevMediaType;
        const libraryChanged =
            prevSelectedGroupId !== undefined && currentLibrary !== prevSelectedGroupId;
        const genreChanged = hasTrackedGenreTag && currentGenre !== prevGenre;
        const tagChanged = hasTrackedGenreTag && currentTag !== prevTag;

        // Update tracked values for next comparison
        prevMediaType = currentMediaType;
        prevSelectedGroupId = currentLibrary;
        prevGenre = currentGenre;
        prevTag = currentTag;
        hasTrackedGenreTag = true;

        // Reload items if props changed (skip initial mount)
        if (browser && (mediaTypeChanged || libraryChanged || genreChanged || tagChanged)) {
            // A letter filter from the previous media type/library/genre/tag no
            // longer applies — reset to "All" so the new set isn't hidden behind it.
            //
            // Report it upward too. Clearing only the local copy left the parent
            // holding the old letter, and the parent is what writes the URL: the
            // next library/sort/filter click re-emitted `letter=K` into the
            // address bar while the rail showed "All", so reloading or sharing
            // that link re-applied a filter the screen said was gone.
            if (selectedLetter !== null) {
                selectedLetter = null;
                onSelectLetter?.(null);
            }
            loadItems(true);
        }
    });

    onMount(() => {
        if (!browser) return;

        // Set up IntersectionObserver for infinite scroll
        observer = new IntersectionObserver(
            (entries) => {
                if (
                    entries[0].isIntersecting &&
                    hasMore &&
                    !loading &&
                    !loadError &&
                    !queryPending
                ) {
                    loadItems();
                }
            },
            { rootMargin: scrollMargin },
        );

        // Load initial data (only once, on mount)
        loadLibraries();
        let watchVersion: number | undefined;
        const unsubscribeWatch = watchStateVersion.subscribe((version) => {
            if (watchVersion !== undefined && watchVersion !== version) void refreshLoadedCounts();
            watchVersion = version;
        });
        let mounted = true;
        void (async (): Promise<void> => {
            const scope = requestSignature(true);
            await loadItems(true);
            while (
                mounted &&
                scope === requestSignature(true) &&
                !loadError &&
                hasMore &&
                items.length < restoreCount
            ) {
                const count = items.length;
                await loadItems();
                if (items.length <= count) break;
            }
            if (mounted && scope === requestSignature(true)) onRestored?.();
        })();

        return () => {
            countsDisposed = true;
            countsReqSeq++;
            unsubscribeWatch();
            mounted = false;
            itemsReqSeq++;
            requestController?.abort();
            clearTimeout(queryTimer);
            observer?.disconnect();
        };
    });

    // Track which sentinel we've observed to avoid re-observing
    let observedSentinel: HTMLDivElement | null = null;

    // Reactively observe the sentinel when it exists
    $effect(() => {
        if (browser && sentinel && observer && sentinel !== observedSentinel) {
            observer.observe(sentinel);
            observedSentinel = sentinel;
        }
    });
</script>

<div class="az-browse-container">
    <!-- Controls bar: sort dropdown + audio/subtitle/quality filter popover -->
    <div class="az-controls">
        <AzSortDropdown bind:sort={sortState} onChange={handleSortChange} />
        <div class="view-switch" role="group" aria-label={m.catalog_grid()}>
            <button
                type="button"
                aria-label={m.catalog_grid()}
                aria-pressed={view === 'grid'}
                onclick={() => changeView('grid')}
                ><Icon src={Squares2x2} class="h-5 w-5" aria-hidden="true" /></button>
            <button
                type="button"
                aria-label={m.catalog_list()}
                aria-pressed={view === 'list'}
                onclick={() => changeView('list')}
                ><Icon src={ListBullet} class="h-5 w-5" aria-hidden="true" /></button>
        </div>
        <CatalogFilterPanel
            bind:audioLangs={audioLangsState}
            bind:subLangs={subLangsState}
            bind:includeUnknown={includeUnknownState}
            bind:resolutions={resolutionsState}
            bind:hdr={hdrState}
            bind:codecs={codecsState}
            {contentCount}
            onClearContent={clearContent}
            onChange={handleFilterChange}>
            {#snippet content()}
                <label class="catalog-library-field"
                    >{m.catalog_library_label()}
                    <select
                        value={selectedGroupId ?? ''}
                        onchange={(event) => selectGroup(event.currentTarget.value || null)}>
                        <option value="">{m.az_all_libraries()}</option>
                        {#each filteredLibraries as library (library.id)}<option value={library.id}
                                >{library.name}</option
                            >{/each}
                    </select>
                </label>
                <BrowseFilterSearch
                    mediaType={mediaType === 'movie'
                        ? 'movies'
                        : mediaType === 'tv'
                          ? 'series'
                          : 'all'}
                    onselect={selectContent} />
                <div class="facet-options">
                    {#each genreCounts.slice(0, 12) as facet (facet.name)}
                        <button
                            type="button"
                            aria-pressed={genre === facet.name}
                            onclick={() =>
                                onContentChange?.({
                                    genre: genre === facet.name ? undefined : facet.name,
                                    tag,
                                })}>{facet.name}</button>
                    {/each}
                    {#each keywordCounts.slice(0, 6) as facet (facet.keyword)}
                        <button
                            type="button"
                            aria-pressed={tag === facet.keyword}
                            onclick={() =>
                                onContentChange?.({
                                    genre,
                                    tag: tag === facet.keyword ? undefined : facet.keyword,
                                })}>{keywordDisplayName(facet.keyword)}</button>
                    {/each}
                </div>
            {/snippet}
        </CatalogFilterPanel>
    </div>

    <!-- Library Filter (filtered by selected media type) -->
    {#if librariesMirrorTabs && filteredLibraries.length > 0}
        <!-- Redundant with the media tabs — see librariesMirrorTabs. -->
    {:else if filteredLibraries.length > 0}
        <div class="az-library-selector">
            <button
                class="az-type-chip {selectedGroupId === null ? 'active' : ''}"
                aria-pressed={selectedGroupId === null}
                onclick={() => selectGroup(null)}>
                {m.az_all_libraries()}
            </button>
            {#each filteredLibraries as library (library.id)}
                <button
                    class="az-type-chip {selectedGroupId === library.id ? 'active' : ''}"
                    aria-pressed={selectedGroupId === library.id}
                    onclick={() => selectGroup(library.id)}>
                    {library.name}
                    <span class="az-library-count">({library.itemCount})</span>
                </button>
            {/each}
        </div>
    {:else if libraries.length > 0}
        <div style="padding: 1rem; text-align: center; color: var(--color-surface-400);">
            {m.az_no_libraries_match()}
        </div>
    {:else if librariesLoading}
        <div style="padding: 1rem; text-align: center; color: var(--color-surface-400);">
            {m.az_libraries_loading()}
        </div>
    {:else}
        <div style="padding: 1rem; text-align: center; color: var(--color-surface-400);">
            {m.az_no_libraries_available()}
        </div>
    {/if}

    <!-- A-Z + # jump-nav rail (only meaningful for alphabetical sorts, and on
         the results view only once the scope is big enough to need it) -->
    {#if !query.trim() && (letterCounts.length > 0 || selectedLetter) && isAlphabeticalSort && letterRailEarnsItsPlace}
        <div class="az-letter-rail" role="group" aria-label={m.az_jump_to_letter()}>
            <button
                class="az-letter {selectedLetter === null ? 'active' : ''}"
                aria-pressed={selectedLetter === null}
                onclick={() => selectLetter(null)}>
                {m.az_all_letters()}
            </button>
            {#each AZ_LETTERS as letter (letter)}
                {@const count = countByLetter.get(letter) ?? 0}
                <button
                    class="az-letter {selectedLetter === letter ? 'active' : ''}"
                    aria-pressed={selectedLetter === letter}
                    disabled={count === 0}
                    title={count > 0
                        ? m.az_item_count({ count: count.toLocaleString() })
                        : m.az_no_items_found()}
                    onclick={() => selectLetter(letter)}>
                    {letter}
                </button>
            {/each}
        </div>
    {/if}

    <div class="active-filters">
        {#if genre}<button
                type="button"
                aria-label={m.catalog_remove({ filter: genre })}
                onclick={() => onContentChange?.({ tag })}>{genre} ×</button
            >{/if}
        {#if tag}<button
                type="button"
                aria-label={m.catalog_remove({ filter: keywordDisplayName(tag) })}
                onclick={() => onContentChange?.({ genre })}>{keywordDisplayName(tag)} ×</button
            >{/if}
        {#each playbackChips as chip (chip.key)}<button
                type="button"
                aria-label={m.catalog_remove({ filter: chip.label })}
                onclick={() => {
                    chip.remove();
                    handleFilterChange();
                }}>{chip.label} ×</button
            >{/each}
        {#if contentCount || playbackChips.length}<button
                type="button"
                class="clear-filters"
                onclick={clearFilters}>{m.catalog_clear()}</button
            >{/if}
    </div>
    <div class="az-count-header" role="status">
        {#if loading || queryPending || !hasLoadedOnce}{m.catalog_updating()}
        {:else if !loadError}{m.az_item_count({ count: totalCount.toLocaleString() })}{/if}
        {#if selectedGroupId}
            <span class="az-filter-indicator"
                >in {libraries.find((l) => l.id === selectedGroupId)?.name ||
                    'selected library'}</span>
        {/if}
    </div>

    <!-- Initial Loading State. `!hasLoadedOnce` counts as loading so the SSR
         frame (no fetch has run yet) shows the spinner rather than "no items". -->
    {#if loadError}
        <div class="az-empty-state" role="alert">
            <p>{m.catalog_error()}</p>
            <button
                type="button"
                class="catalog-action"
                onclick={() => loadItems(items.length === 0)}>{m.btn_retry()}</button>
        </div>
    {/if}
    {#if (loading || queryPending || !hasLoadedOnce) && items.length === 0}
        <LoadingState loading={true} loadingMessage={m.az_loading()} />
    {:else if items.length === 0 && !loadError}
        <div class="az-empty-state">
            <p>{m.catalog_empty()}</p>
            <p>{m.catalog_empty_hint()}</p>
            {#if query}<button type="button" class="catalog-action" onclick={onClearSearch}
                    >{m.btn_clear_search()}</button
                >{/if}
            {#if contentCount || playbackChips.length}<button
                    type="button"
                    class="catalog-action"
                    onclick={clearFilters}>{m.catalog_clear()}</button
                >{/if}
        </div>
    {:else if items.length > 0}
        <!-- A-Z Grid -->
        <div
            class="az-grid"
            class:compact-list={view === 'list'}
            aria-busy={loading || queryPending}>
            {#each items as item, itemIdx (itemRenderKeys[itemIdx])}
                <!-- priority (eager images): native loading=lazy never fires
                     for this grid inside the app shell's nested overflow
                     chain (Chrome leaves every poster unloaded even while
                     visible). The grid is already windowed by the infinite-
                     scroll sentinel (~50 thumbs per chunk), so eager is the
                     same request volume the rails produce above the fold. -->
                <UniversalMediaCard
                    showSeriesCountBadge
                    {item}
                    widthClass="w-full"
                    variant={view === 'list' ? 'list' : 'poster'}
                    priority={true}
                    {hasRequestPermission}
                    onclick={() => handleItemClick(item)}
                    onplay={() => handleItemPlay(item)}
                    onmore={() => handleItemMore(item)} />
            {/each}
        </div>

        <!-- Infinite Scroll Sentinel -->
        {#if hasMore}
            <div bind:this={sentinel} class="az-load-more">
                {#if loading}
                    <span class="loading-spinner loading-spinner-primary"></span>
                    <span>{m.az_loading_more()}</span>
                {:else if !loadError}
                    <button type="button" class="catalog-action" onclick={() => loadItems()}
                        >{m.catalog_more()}</button>
                {/if}
            </div>
        {:else}
            <div class="az-end-of-results">
                {m.az_showing_all({ count: items.length.toLocaleString() })}
            </div>
        {/if}
    {/if}
</div>

<style lang="postcss">
    .catalog-library-field {
        display: grid;
        gap: 0.5rem;
        margin-bottom: 1rem;
        font-size: 0.875rem;
    }
    .catalog-library-field select {
        padding: 0.7rem;
        background: var(--color-surface-800);
        border-radius: 0.4rem;
        color: var(--color-surface-100);
        width: 100%;
    }
    .view-switch {
        display: flex;
        gap: 0.2rem;
        margin-left: auto;
    }
    .view-switch button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        width: 44px;
        height: 44px;
        border-radius: 0.4rem;
        font-size: 1.25rem;
        color: var(--color-surface-400);
        cursor: pointer;
    }
    .view-switch button[aria-pressed='true'] {
        background: var(--color-surface-800);
        color: var(--color-primary-300);
    }
    .active-filters,
    .facet-options {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .facet-options {
        margin-top: 1rem;
    }
    .active-filters button,
    .facet-options button {
        min-height: 36px;
        padding: 0.35rem 0.65rem;
        border-radius: 0.4rem;
        font-size: 0.8rem;
        background: var(--color-surface-800);
        color: var(--color-surface-200);
        cursor: pointer;
    }
    .facet-options button[aria-pressed='true'] {
        background: var(--color-primary-700);
        color: white;
    }
    .active-filters .clear-filters {
        background: transparent;
        color: var(--color-primary-300);
    }
    .catalog-action {
        padding: 0.65rem 1rem;
        background: var(--color-surface-800);
        border-radius: 0.5rem;
        color: var(--color-primary-200);
        cursor: pointer;
    }
    button:focus-visible,
    select:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 3px;
    }
    .az-grid.compact-list {
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 25rem), 1fr));
        gap: 0.65rem;
    }

    .az-browse-container {
        padding: 0;
    }

    .az-controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-bottom: 0.75rem;
    }

    .az-type-chip {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.5rem 1rem;
        border-radius: 0.45rem;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .az-type-chip:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .az-type-chip.active {
        background: var(--color-primary-600);
        border-color: var(--color-primary-500);
        color: white;
    }

    .az-library-selector {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-start;
        margin-bottom: 1rem;
        flex-wrap: wrap;
    }

    .az-library-count {
        font-size: 0.75rem;
        opacity: 0.7;
        margin-left: 0.25rem;
    }

    .az-letter-rail {
        display: flex;
        flex-wrap: nowrap;
        overflow-x: auto;
        gap: 0.25rem;
        justify-content: flex-start;
        margin-bottom: 1rem;
    }

    .az-letter {
        /* ≥40px hit target for touch/a11y (WCAG 2.5.5 target size). */
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2rem;
        flex-shrink: 0;
        min-height: 2.5rem;
        padding: 0.25rem 0.5rem;
        border-radius: 0.375rem;
        background: transparent;
        border: 1px solid transparent;
        color: var(--color-surface-300);
        font-size: 0.8125rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .az-letter:hover:not(:disabled) {
        background: rgb(var(--color-surface-600-rgb) / 0.6);
        color: var(--color-surface-100);
    }

    .az-letter.active {
        background: var(--color-primary-600);
        border-color: var(--color-primary-500);
        color: white;
    }

    .az-letter:disabled {
        opacity: 0.3;
        cursor: default;
    }

    .az-count-header {
        text-align: left;
        color: var(--color-surface-400);
        font-size: 0.875rem;
        margin: 1rem 0 1.5rem;
    }

    .az-filter-indicator {
        color: var(--color-primary-400);
        font-weight: 500;
    }

    .az-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
    }

    @media (min-width: 480px) {
        .az-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }
    }

    @media (min-width: 640px) {
        .az-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 1rem;
        }
    }

    @media (min-width: 768px) {
        .az-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
        }
    }

    @media (min-width: 1024px) {
        .az-grid {
            grid-template-columns: repeat(5, minmax(0, 1fr));
        }
    }

    @media (min-width: 1280px) {
        .az-grid {
            grid-template-columns: repeat(6, minmax(0, 1fr));
        }
    }

    .az-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 30vh;
        gap: 1rem;
        color: var(--color-surface-400);
    }

    .az-load-more {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 2rem;
        color: var(--color-surface-400);
        font-size: 0.875rem;
    }

    .az-end-of-results {
        text-align: center;
        color: var(--color-surface-500);
        font-size: 0.875rem;
        padding: 2rem;
    }
</style>
