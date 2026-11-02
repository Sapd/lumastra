<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * RecommendationFeed - the personalised section list below the
     * Continue-Watching strip.
     *
     * Owns:
     * - forYouSections, moodSections, exploreKeywordsSection,
     *   secondBecauseSection, featuredPickSection — all populated by the
     *   ForYouDataLoader's progressive callback. The 'taste' rail
     *   (strategy-backed "From your ratings") is a forYouSections entry like
     *   any other for-you rail; tasteStatus separately tracks its explicit
     *   ready/generating/exhausted page state for the skeleton/empty UI.
     * - The MoodSelector mount + mood suggestion / mood recommendation
     *   loaders.
     * - handleBecauseDismiss + the non-CW branches of handleItemRemove
     *   (fulfilled-requests, because-you-watched).
     * - sectionsAfterMood: the canonical render order for the long tail
     *   of recommendation rows (because → youlike → taste → explore →
     *   short → anime → fresh-releases → secondBecause → binge → trending
     *   → popular-shows → recently-added → music-quick-picks → random).
     *
     * The watching strip and new-episode banner are NOT here — those
     * live in WatchingStrip.svelte. The clear-history modal mounts in
     * the shell.
     */
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { browser } from '$app/environment';
    import { env } from '$env/dynamic/public';
    import { page } from '$app/stores';
    import { toasts } from '$lib/stores/toast.store';
    import { Icon, ArrowPath, Sparkles, EllipsisHorizontal } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { LoadingState, ErrorMessage, EmptyState, Skeleton } from '$lib/components/ui';
    import { SectionRenderer } from '$lib/components/sections';
    import MoodSelector, { type MoodInfo } from '$lib/components/foryou/MoodSelector.svelte';
    import TasteTrainerCard from '$lib/components/foryou/TasteTrainerCard.svelte';
    import {
        ForYouDataLoader,
        buildTasteRailSection,
        tasteItemToUniversal,
        type ProgressiveUpdate,
    } from '$lib/services/foryou-loader';
    import { MIN_RATINGS_FOR_RECOMMENDATIONS } from '$lib/shared/rating-thresholds';
    import * as m from '$lib/paraglide/messages';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { buildMediaKey } from '$lib/utils/media-id-helpers';
    import {
        markSeen,
        resetSeenMedia,
        FOR_YOU_FRESH_RELEASES_RANK,
    } from '$lib/stores/seen-media.svelte';
    import type { ApiMediaType } from '$lib/types/api-common';
    import * as forYouApi from '$lib/api/for-you';
    import {
        handleItemClick,
        handleItemPlay,
        handleItemRequest,
        handleItemMore,
    } from './item-handlers';
    import { toMovieOrSeries } from '$lib/shared/media-type-domain';
    import {
        sectionKind,
        isSectionVisible,
        isSectionIdVisible,
        DEFAULT_FEED_PREFS,
        type FeedPrefs,
    } from '$lib/shared/feed-section-kinds';

    interface Props {
        /** Bubbled whenever the feed-level loading state flips so the
         *  shell's refresh button can be disabled while a load is in flight. */
        onloadingChange?: (loading: boolean) => void;
    }

    let { onloadingChange }: Props = $props();

    // Per-user feed preferences (injected by +layout.server.ts). Drives which
    // sections are fetched/rendered. Defaults to "full" (show everything).
    let feedPrefs = $derived(
        ($page.data?.feedPreferences as FeedPrefs | undefined) ?? DEFAULT_FEED_PREFS,
    );

    // Feature flags from layout data
    let aiEnabled = $derived($page.data?.features?.aiRecommendations !== false);
    // Section engagement ranker (M3) — reorders the long-tail carousel
    // sections (sectionsAfterMood) by per-user engagement. Off by default;
    // see FEATURE_FORYOU_SECTION_RANKER in config.ts.
    let forYouSectionRankerEnabled = $derived($page.data?.features?.forYouSectionRanker === true);

    // The mood selector only makes sense when the mood-recommendations row is
    // visible — hiding that kind also hides the picker that feeds it.
    let moodVisible = $derived(isSectionVisible('mood-recommendations', feedPrefs));
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);

    // ForYou configuration from layout data (with defaults)
    let forYouConfig = $derived({
        defaultLimit: $page.data?.forYou?.defaultLimit ?? 10,
        sourcesLimit: $page.data?.forYou?.sourcesLimit ?? 3,
        similarPerSource: $page.data?.forYou?.similarPerSource ?? 8,
        keywordRows: $page.data?.forYou?.keywordRows ?? 2,
        keywordItems: $page.data?.forYou?.keywordItems ?? 8,
        moodLimit: $page.data?.forYou?.moodLimit ?? 12,
        secondBecauseLimit: $page.data?.forYou?.secondBecauseLimit ?? 8,
    });

    const requestUrl = env.PUBLIC_REQUESTURL || '';

    // =========================================================================
    // State
    // =========================================================================

    let forYouSections: PageSection[] = $state([]);
    // Explicit page state for the 'taste' rail (see LoadResult.tasteStatus /
    // ProgressiveUpdate 'taste' in foryou-loader.ts). The rail's own
    // PageSection (when non-empty) lives in forYouSections like every other
    // for-you rail — this only tracks 'generating'/'exhausted' so the feed
    // can render a skeleton or hide the rail when there are zero items.
    let tasteStatus = $state<'ready' | 'generating' | 'exhausted' | null>(null);
    // Lifetime rating count, fetched once by the loader alongside the taste
    // rail (see ProgressiveUpdate 'userStats' in foryou-loader.ts). Drives
    // TasteTrainerCard's locked/unlocked copy and the rail-replacement gate
    // below. `null` until it resolves (AI disabled / hidden kind → never).
    let totalRatings = $state<number | null>(null);
    // "Refresh available" chip on the taste rail header — set when a rating
    // is submitted ELSEWHERE on the page (modal/sidebar AIRatingButton) while
    // the rail is showing, via the 'rating-submitted' document event. Cleared
    // by an explicit click (refreshTasteRail) — the rail never auto-reshuffles
    // out from under the user just because they rated something.
    let tasteRefreshAvailable = $state(false);
    let tasteRefreshing = $state(false);
    // "Include my watch history" toggle — mirrors the
    // server-persisted `user_profiles.preferences.includeWatchHistory` value
    // carried on the taste-rail GET response. Defaults true (the server-side
    // default) until the first taste fetch resolves.
    let includeWatchHistory = $state(true);
    let includeWatchHistorySaving = $state(false);
    let tasteMenuOpen = $state(false);
    let tasteMenuEl = $state<HTMLDivElement | null>(null);
    let moodSections: PageSection[] = $state([]);
    let exploreKeywordsSection = $state<PageSection | null>(null);
    let secondBecauseSection = $state<PageSection | null>(null); // Second "Because you watched" section (minority media type)
    let featuredPickSection = $state<PageSection | null>(null); // Featured Pick hero section
    // Section-ranker (M3): ranked long-tail KIND order fetched once per mount
    // when the flag is on (see loadSectionOrder). `null` until it resolves —
    // sectionsAfterMood falls back to canonical order until then, so there is
    // no flash-of-unranked-then-reranked content, just a slightly later
    // reorder on first paint.
    let rankedLongTailOrder = $state<string[] | null>(null);

    let loading = $state(true);
    let loadingMore = $state(false); // True while Phase 2 (slower sections) are still loading
    let error = $state<string | null>(null);

    // Cancels the in-flight loader fan-out. A route change (component destroy)
    // or a manual refresh aborts the previous load so its ~15-20 parallel
    // fetches stop immediately instead of racing to completion in the
    // background. Not $state — it's control plumbing, not rendered.
    let loadAbort: AbortController | null = null;
    // Set on unmount so late-resolving fetches (e.g. mood suggestions, which have
    // no AbortSignal of their own) don't write state on a torn-down component.
    let feedDestroyed = false;

    // Mood selector state
    let selectedMoods: string[] = $state([]);
    let suggestedMoods: string[] = $state([]);
    let availableMoods: MoodInfo[] = $state([]);
    let moodLoading = $state(false);

    // =========================================================================
    // Section ordering — sectionsBeforeMood drops the watching strip
    // because that lives in WatchingStrip.svelte. The only "before mood"
    // entry left at this layer is the fulfilled-requests row.
    // =========================================================================

    // Bucket forYouSections in a single pass so we don't run 15 sequential
    // .filter() scans every time the array reference changes. The shape is
    // stable: each bucket is either a list (for the 'because-*'/'youlike-*'
    // prefix patterns) or a list keyed by exact id. Buckets are arrays even
    // for fixed ids so we preserve the original .filter() behavior when the
    // upstream feed accidentally yields duplicate ids — the previous code
    // rendered both copies, so this code keeps both copies.
    //
    // The byId index is created via Object.create(null) so a hostile id like
    // '__proto__' or 'constructor' can't collide with Object.prototype keys.
    let forYouBuckets = $derived.by(() => {
        const because: PageSection[] = [];
        const youlike: PageSection[] = [];
        const byId = Object.create(null) as Record<string, PageSection[]>;
        for (const s of forYouSections) {
            if (s.id.startsWith('because-')) because.push(s);
            else if (s.id.startsWith('youlike-')) youlike.push(s);
            else (byId[s.id] ??= []).push(s);
        }
        return { because, youlike, byId };
    });

    let sectionsBeforeMood = $derived(
        (forYouBuckets.byId['fulfilled-requests'] ?? []).filter((s) =>
            isSectionIdVisible(s.id, feedPrefs),
        ),
    );

    // Cross-rail dedup hook: publish the "New Releases" (fresh-releases) rail's
    // item keys into the seen-media registry so the client-fetched Trending
    // widget below can thin the titles it duplicates. Reuses keyForItem so the
    // published keys match the feed's own within-feed dedup keys. Runs whenever
    // the fresh-releases rail (re)resolves via progressive streaming.
    $effect(() => {
        const sections = forYouBuckets.byId['fresh-releases'];
        if (!sections) return;
        const ids: string[] = [];
        for (const s of sections) {
            for (const item of s.items ?? []) ids.push(keyForItem(item));
        }
        markSeen(FOR_YOU_FRESH_RELEASES_RANK, ids);
    });

    // =========================================================================
    // Taste rail trainer-card replacement gate
    //
    // THE single authoritative gate for "trainer card instead of the rail":
    // true when the user hasn't rated enough yet
    // (totalRatings < MIN_RATINGS_FOR_RECOMMENDATIONS) or the rail is
    // genuinely exhausted. When true, the 'taste' section is EXCLUDED from
    // sectionsAfterMood below — so the rail, its refresh chip, and its
    // trailing trainer card (all keyed off section.id === 'taste' in the
    // render loop) all disappear together and only the replacement card
    // renders. Without that exclusion a locked user whose rail still
    // returned items (e.g. persisted suggestions from before ratings were
    // cleared) would see the replacement card AND the live rail stacked.
    // `totalRatings === null` (not yet resolved) intentionally falls through
    // to the 'generating' skeleton rather than flashing the trainer card and
    // then swapping to the rail a moment later.
    // =========================================================================
    let tasteRailReplace = $derived(
        aiEnabled &&
            ((totalRatings !== null && totalRatings < MIN_RATINGS_FOR_RECOMMENDATIONS) ||
                tasteStatus === 'exhausted'),
    );

    // =========================================================================
    // Cross-section de-duplication
    //
    // The feed is assembled from ~18 independent endpoints, each deduped only
    // WITHIN its own build. A popular title can therefore appear in Trending,
    // Fresh Releases, a Because-you-watched row, a keyword row, etc. at once.
    // We thin later (lower-priority) rows of any item already shown above them,
    // preserving the first (higher-signal) occurrence. Render order is the
    // priority order, so earlier rows win.
    //
    // Scope: fulfilled-requests, featured-pick, and mood render ABOVE the long
    // tail below (see the template's actual DOM order) but used to be excluded
    // from this pass entirely, so a title in any of those three could duplicate
    // — or be duplicated by — Trending/binge-worthy/etc. `crossRailDeduped`
    // below walks all four groups through ONE shared `seen` set in true
    // render-priority order (fulfilled-requests → featured-pick → mood → the
    // long tail), so every rail — not just the long tail's own internal
    // ordering — thins against everything rendered above it.
    //
    // Sections whose items are entirely consumed by higher rows are dropped so
    // the feed never renders a now-empty row. Keys are UUID-first (buildMediaKey)
    // and fall back to the item id when no media key resolves.
    // =========================================================================
    // Per-item media-key memo. This $derived re-flushes on every progressive rail
    // append (~18×/load), and each flush rescans EVERY item already in the feed.
    // buildMediaKey parses externalIds and builds a composite key — recomputing it
    // for the whole feed on each flush is the O(n²) hot path. Item objects are
    // stable across flushes (sections are appended, never mutated), so a WeakMap
    // memo turns the ~18 rescans into a single buildMediaKey call per item; the
    // per-flush work drops to cheap Set string inserts. WeakMap so keys are GC'd
    // with their items — no manual eviction, no leak on refresh.
    const mediaKeyCache = new WeakMap<UniversalMediaItem, string>();
    function keyForItem(item: UniversalMediaItem): string {
        let key = mediaKeyCache.get(item);
        if (key === undefined) {
            key =
                buildMediaKey(item.externalIds, (item.mediaType as ApiMediaType) || 'movie') ??
                item.id;
            mediaKeyCache.set(item, key);
        }
        return key;
    }

    // `seen` is threaded in by the caller (rather than allocated here) so
    // multiple render-priority groups (fulfilled-requests, featured-pick,
    // mood, the long tail) can share ONE accumulating set across several
    // calls — see crossRailDeduped below. Uses SvelteSet to satisfy
    // svelte/prefer-svelte-reactivity; the dominant cost was the per-item
    // buildMediaKey (now memoized via keyForItem), so the set's overhead is
    // negligible.
    function dedupeAcrossSections(sections: PageSection[], seen: SvelteSet<string>): PageSection[] {
        const out: PageSection[] = [];
        for (const section of sections) {
            // A section's `items` can be undefined while its rail is still loading
            // (the section object exists with a title/id before its data arrives).
            // This runs in a $derived that re-flushes on every rail update, so guard
            // the iteration — otherwise `for…of undefined` throws
            // "section.items is not iterable" on every flush until all rails settle.
            const items = Array.isArray(section.items) ? section.items : [];
            const kept: UniversalMediaItem[] = [];
            for (const item of items) {
                const key = keyForItem(item);
                if (seen.has(key)) continue;
                seen.add(key);
                kept.push(item);
            }
            if (kept.length === 0) continue;
            // Only allocate a new object when items were actually removed.
            out.push(kept.length === items.length ? section : { ...section, items: kept });
        }
        return out;
    }

    // Defense-in-depth: the loader already skips hidden kinds, but filter the
    // rendered list too so a hidden section can never slip through (e.g. a stale
    // section left over from a previous prefs state before a refresh completes).
    //
    // Single shared `seen` set walked in true render-priority order (matches
    // the template's actual DOM order): fulfilled-requests → featured-pick →
    // mood → the long tail. This is what lets mood/featured/fulfilled
    // participate in cross-rail dedupe instead of being silently excluded.
    let crossRailDeduped = $derived.by(() => {
        const seen = new SvelteSet<string>();

        const beforeMood = dedupeAcrossSections(sectionsBeforeMood, seen);

        const featuredVisible: PageSection[] =
            featuredPickSection && isSectionIdVisible(featuredPickSection.id, feedPrefs)
                ? [featuredPickSection]
                : [];
        const featuredPick = dedupeAcrossSections(featuredVisible, seen)[0] ?? null;

        const moodVisible = moodSections.filter((s) => isSectionIdVisible(s.id, feedPrefs));
        const mood = dedupeAcrossSections(moodVisible, seen);

        const { because, youlike, byId } = forYouBuckets;

        // Each block is one reorderable long-tail slot, tagged with its
        // feedback KIND (see feed-section-kinds.ts's sectionKind() /
        // FORYOU_LONG_TAIL_ORDER). Built in the EXACT canonical push order
        // below — when the section-ranker flag is off (or no ranked order has
        // arrived yet), blocks are flattened in this same order, so behavior
        // is identical to before the ranker existed.
        const blocks: { kind: string; sections: PageSection[] }[] = [];
        const pushBlock = (kind: string, sections: PageSection[] | undefined): void => {
            if (sections && sections.length > 0) blocks.push({ kind, sections });
        };

        pushBlock('because-you-watched', because);
        pushBlock('you-like', youlike);
        // Suppressed while the trainer card replaces the rail — see
        // tasteRailReplace above (single gate; every taste-scoped render
        // branch lives inside this list's loop and vanishes with it).
        if (!tasteRailReplace) pushBlock('taste', byId['taste']);
        if (exploreKeywordsSection) pushBlock('explore-keywords', [exploreKeywordsSection]);
        pushBlock('short-movies', byId['short-movies']);
        pushBlock('anime', byId['anime']);
        pushBlock('fresh-releases', byId['fresh-releases']);
        // Same KIND as the 'because-you-watched' block above (both are
        // "because you watched X" rows) — see the ranker tie-break note below.
        if (secondBecauseSection) pushBlock('because-you-watched', [secondBecauseSection]);
        pushBlock('binge-worthy', byId['binge-worthy']);
        pushBlock('trending', byId['trending']);
        pushBlock('popular-shows', byId['popular-shows']);
        pushBlock('recently-added', byId['recently-added']);
        pushBlock('music-quick-picks', byId['music-quick-picks']);
        // "Because You Listened To…" — the id is the dynamic `music-because-{trackId}`,
        // so a plain byId lookup can't match it. Scan byId for the prefix and
        // collect every matching section (there is normally one seed track at a time).
        const musicBecauseSections: PageSection[] = [];
        for (const id in byId) {
            if (id.startsWith('music-because-')) {
                const matches = byId[id];
                if (matches) musicBecauseSections.push(...matches);
            }
        }
        pushBlock('music-because', musicBecauseSections);
        pushBlock('random-picks', byId['random-picks']);

        // Section-ranker (M3): when the flag is on and a ranked order has
        // arrived, stable-reorder the blocks by the server-provided rank.
        // Ties (unranked kinds, or two blocks sharing a kind — e.g. the two
        // 'because-you-watched' blocks above) keep their canonical relative
        // order via the original-index tiebreak, exactly mirroring
        // computeSectionOrder()'s own tie-break. Flag off (or no ranked order
        // yet) => blocks flatten in canonical push order — today's exact
        // behavior.
        const orderedBlocks =
            forYouSectionRankerEnabled && rankedLongTailOrder
                ? blocks
                      .map((block, index) => ({ block, index }))
                      .sort((a, b) => {
                          const rankA = rankedLongTailOrder!.indexOf(a.block.kind);
                          const rankB = rankedLongTailOrder!.indexOf(b.block.kind);
                          const effectiveA = rankA === -1 ? rankedLongTailOrder!.length : rankA;
                          const effectiveB = rankB === -1 ? rankedLongTailOrder!.length : rankB;
                          if (effectiveA !== effectiveB) return effectiveA - effectiveB;
                          return a.index - b.index;
                      })
                      .map(({ block }) => block)
                : blocks;

        const result: PageSection[] = [];
        for (const block of orderedBlocks) result.push(...block.sections);

        const visible = result.filter((s) => isSectionIdVisible(s.id, feedPrefs));
        const afterMood = dedupeAcrossSections(visible, seen);

        return { beforeMood, featuredPick, mood, afterMood };
    });

    let dedupedBeforeMood = $derived(crossRailDeduped.beforeMood);
    // Post-dedupe hero pick — may be null even when the raw featuredPickSection
    // state is set, if its item was already shown in a section rendered above
    // it (fulfilled-requests). See crossRailDeduped.
    let dedupedFeaturedPick = $derived(crossRailDeduped.featuredPick);
    let dedupedMoodSections = $derived(crossRailDeduped.mood);
    // Keeps the historical name — still "the canonical render order for the
    // long tail", now deduped against fulfilled-requests/featured-pick/mood
    // too via the shared `seen` set in crossRailDeduped.
    let sectionsAfterMood = $derived(crossRailDeduped.afterMood);

    let hasAnySections = $derived(
        forYouSections.length > 0 ||
            moodSections.length > 0 ||
            exploreKeywordsSection !== null ||
            secondBecauseSection !== null ||
            featuredPickSection !== null,
    );

    // =========================================================================
    // Loading orchestration
    // =========================================================================
    //
    // P3 — Featured-pick "recently shown" tracking moved server-side. The
    // /api/for-you/featured-pick endpoint now reads the user's
    // `featured_pick_shown` flags (TTL 7d) and writes a flag after every
    // fresh selection, so suppression works across devices and survives
    // clearing browser storage. The client doesn't track or send anything.

    async function loadForYou(refresh = false): Promise<void> {
        if (!browser) return;

        // Cancel any in-flight load (route change already destroyed us, or a
        // rapid re-refresh) so its fetches stop and its progressive callbacks
        // can't bleed into this load. A fresh controller scopes this load.
        loadAbort?.abort();
        const controller = new AbortController();
        loadAbort = controller;

        loading = true;
        loadingMore = true;
        onloadingChange?.(true);
        error = null;

        // Reset sections on refresh
        if (refresh) {
            forYouSections = [];
            tasteStatus = null;
            totalRatings = null;
            tasteRefreshAvailable = false;
            tasteMenuOpen = false;
            moodSections = [];
            exploreKeywordsSection = null;
            secondBecauseSection = null;
            featuredPickSection = null;
            // Re-arm the impression beacon so the second view of the
            // same sections after a manual refresh is counted again —
            // otherwise a refresh produces zero telemetry.
            sentImpressions.clear();
        }

        // P3: dismissed fulfilled-requests are filtered server-side via
        // an anti-join on `request_dismissed` flags in
        // `/api/for-you/fulfilled-requests`. The pre-P3 client-side
        // filter on localStorage['dismissedFulfilledRequests'] is gone.

        // Progressive update callback - updates UI as sections arrive.
        // Ignore late callbacks from a superseded/aborted load so a stale
        // fan-out can't push sections into the current one.
        const handleProgress = (update: ProgressiveUpdate) => {
            if (loadAbort !== controller || controller.signal.aborted) return;
            switch (update.type) {
                case 'forYou':
                    if (update.sections) {
                        forYouSections = [...forYouSections, ...update.sections];
                    }
                    break;
                case 'taste':
                    tasteStatus = update.status ?? 'ready';
                    if (typeof update.includeWatchHistory === 'boolean') {
                        includeWatchHistory = update.includeWatchHistory;
                    }
                    if (update.section) {
                        forYouSections = [...forYouSections, update.section];
                    }
                    break;
                case 'userStats':
                    if (typeof update.totalRatings === 'number') {
                        totalRatings = update.totalRatings;
                    }
                    break;
                case 'mood':
                    if (update.sections) {
                        moodSections = [...moodSections, ...update.sections];
                    }
                    break;
                case 'exploreKeywords':
                    if (update.section) {
                        exploreKeywordsSection = update.section;
                    }
                    break;
                case 'secondBecause':
                    if (update.section) {
                        secondBecauseSection = update.section;
                    }
                    break;
                case 'featuredPick':
                    if (update.section) {
                        featuredPickSection = update.section;
                        // Shown-pick tracking is server-side (P3): the
                        // featured-pick endpoint writes a
                        // `featured_pick_shown` flag with TTL 7d on each
                        // fresh selection. Nothing for the client to do.
                    }
                    break;
            }
            // Show content as soon as first section arrives
            if (loading) {
                loading = false;
                onloadingChange?.(false);
            }
        };

        try {
            // Use ForYouDataLoader service with progressive callback
            const loader = new ForYouDataLoader(forYouConfig, aiEnabled, feedPrefs);
            await loader.loadSections(refresh, handleProgress, controller.signal);

            console.log('[ForYou] Loaded sections:', {
                forYouSections: forYouSections.length,
                tasteStatus,
                moodSections: moodSections.length,
            });
        } catch (e) {
            // A superseded/destroyed load was aborted — swallow quietly (no
            // error surfaced to the user for an intentional cancellation).
            if (controller.signal.aborted) return;
            console.error('[ForYou] Error loading data:', e);
            error = e instanceof Error ? e.message : m.foryou_unknown_error();
        } finally {
            // Only the current load owns the loading flags; a superseded load
            // must not clear the spinner the newer load just turned on.
            if (loadAbort === controller) {
                loading = false;
                loadingMore = false;
                onloadingChange?.(false);
            }
        }
    }

    /**
     * Load the ranked long-tail section order (section-ranker, M3). No-op
     * unless the flag is on. Fetched once per mount — feedback accumulates
     * slowly, so a per-load refetch isn't warranted (mirrors loadMoodSuggestions'
     * once-per-mount cadence).
     */
    async function loadSectionOrder(): Promise<void> {
        if (!browser || !forYouSectionRankerEnabled) return;

        try {
            const { data, error: err } = await forYouApi.getSectionOrder();
            if (feedDestroyed) return;
            if (!err && data?.order) {
                rankedLongTailOrder = data.order;
            }
        } catch (e) {
            console.error('[ForYou] Failed to load section order:', e);
        }
    }

    /**
     * Load mood suggestions (available moods and time-based suggestions)
     */
    async function loadMoodSuggestions(): Promise<void> {
        if (!browser || !aiEnabled || !moodVisible) return;

        try {
            const { data, error: err } = await forYouApi.getMoodSuggestions();
            if (feedDestroyed) return;
            if (!err && data) {
                availableMoods = (data.moods || []) as MoodInfo[];
                // Surface both primary and secondary suggested moods (MoodSelector
                // accepts a list); the secondary was previously discarded.
                suggestedMoods = [data.primary, data.secondary].filter((mood): mood is string =>
                    Boolean(mood),
                );
            }
        } catch (e) {
            console.error('[ForYou] Failed to load mood suggestions:', e);
        }
    }

    /**
     * Handle mood selection - fetches mood-specific recommendations.
     * Empty array = auto (time-based). Multiple moods fetch in parallel
     * and their sections are combined in selection order.
     * A generation counter discards responses from superseded calls.
     */
    let moodFetchGen = 0;
    async function handleMoodSelect(moods: string[]): Promise<void> {
        selectedMoods = moods;
        moodLoading = true;
        const gen = ++moodFetchGen;

        try {
            if (moods.length === 0) {
                const { data, error: err } = await forYouApi.getMoodRecommendations({
                    limit: forYouConfig.moodLimit,
                });
                if (gen !== moodFetchGen) return;
                if (!err && data) {
                    const typed = data as { sections?: PageSection[] };
                    moodSections = typed.sections || [];
                }
            } else {
                const results = await Promise.all(
                    moods.map((mood) =>
                        forYouApi.getMoodRecommendations({
                            limit: forYouConfig.moodLimit,
                            mood,
                            mode: 'vector',
                        }),
                    ),
                );
                if (gen !== moodFetchGen) return;
                // Suffix each section's id with the mood key so that sections
                // from different moods remain distinct in the {#each} key —
                // the API always returns the fixed id 'mood-recommendations'.
                const combined: PageSection[] = [];
                for (let i = 0; i < results.length; i++) {
                    const { data, error: err } = results[i];
                    if (!err && data) {
                        const typed = data as { sections?: PageSection[] };
                        for (const section of typed.sections ?? []) {
                            combined.push({
                                ...section,
                                id: `${section.id}-${moods[i]}`,
                            });
                        }
                    }
                }
                moodSections = combined;
            }
        } catch (e) {
            console.error('[ForYou] Failed to load mood recommendations:', e);
        } finally {
            if (gen === moodFetchGen) moodLoading = false;
        }
    }

    /** Public refresh entrypoint for the shell's refresh button. */
    export function refresh(): void {
        void loadForYou(true);
    }

    /**
     * Manual "refresh available" chip on the taste rail header — refetches
     * ONLY the taste rail (`refresh: true`) rather than the whole feed, and
     * replaces just the 'taste' entry in forYouSections in place. Scoped
     * this narrowly on purpose: a rating submitted elsewhere on the page
     * (modal, sidebar) must never silently reshuffle the rest of the feed —
     * the user opts in by clicking the chip.
     */
    async function refreshTasteRail(): Promise<void> {
        if (!browser || tasteRefreshing) return;
        tasteRefreshing = true;
        try {
            const { data, error: err } = await forYouApi.getTasteRail({ refresh: true });
            if (feedDestroyed) return;
            if (!err && data) {
                const { status, section } = buildTasteRailSection(data);
                tasteStatus = status;
                if (typeof data.includeWatchHistory === 'boolean') {
                    includeWatchHistory = data.includeWatchHistory;
                }
                forYouSections = section
                    ? [...forYouSections.filter((s) => s.id !== 'taste'), section]
                    : forYouSections.filter((s) => s.id !== 'taste');
                // Only a SUCCESSFUL refetch consumes the chip — a failed one
                // keeps it visible (with a toast below) so the user can retry
                // instead of the affordance silently vanishing.
                tasteRefreshAvailable = false;
            } else {
                toasts.error(m.ai_load_more_error());
            }
        } catch (e) {
            console.error('[ForYou] Failed to refresh taste rail:', e);
            if (!feedDestroyed) toasts.error(m.ai_load_more_error());
        } finally {
            tasteRefreshing = false;
        }
    }

    /**
     * Rail overflow menu — "Include my watch history" checkbox (Plan 3
     * Task 3). Optimistic toggle: flips the local checkbox immediately, then
     * persists via PATCH; a failed request reverts the checkbox and toasts
     * an error rather than leaving the UI showing a value the server never
     * saved. Does NOT auto-refresh the rail itself — the server-side rebuild
     * is synchronous, but re-fetching here would fight the same
     * never-auto-reshuffle contract as `refreshTasteRail` (the user opts in
     * via the existing "New ratings — refresh" chip / next natural refresh).
     */
    async function toggleIncludeWatchHistory(): Promise<void> {
        if (!browser || includeWatchHistorySaving) return;
        const next = !includeWatchHistory;
        const previous = includeWatchHistory;
        includeWatchHistory = next;
        includeWatchHistorySaving = true;
        try {
            const { error: err } = await forYouApi.patchTasteIncludeWatchHistory(next);
            if (err) {
                includeWatchHistory = previous;
                toasts.error(m.ai_load_more_error());
            } else {
                // The server already rebuilt the profile synchronously — surface
                // the same "refresh available" affordance used after an
                // elsewhere-submitted rating, so the user can opt into seeing the
                // effect without the rail silently reshuffling under them.
                tasteRefreshAvailable = true;
            }
        } catch (e) {
            console.error('[ForYou] Failed to save includeWatchHistory:', e);
            includeWatchHistory = previous;
            if (!feedDestroyed) toasts.error(m.ai_load_more_error());
        } finally {
            includeWatchHistorySaving = false;
        }
    }

    function closeTasteMenu(): void {
        tasteMenuOpen = false;
    }

    function handleTasteMenuWindowClick(e: MouseEvent): void {
        if (!tasteMenuOpen) return;
        if (tasteMenuEl && !tasteMenuEl.contains(e.target as Node)) {
            closeTasteMenu();
        }
    }

    function handleTasteMenuKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') closeTasteMenu();
    }

    // =========================================================================
    // Card Handlers
    // =========================================================================

    function handleClickItem(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }): Promise<void> {
        return handleItemClick(data);
    }

    function handlePlayItem(data: { section: PageSection; item: UniversalMediaItem }): void {
        emitSectionFeedback(data.section.id, 'play');
        handleItemPlay(data, requestsEnabled, requestUrl, hasRequestPermission);
    }

    function handleRequestItem(data: { section: PageSection; item: UniversalMediaItem }): void {
        handleItemRequest(data, requestsEnabled, requestUrl, hasRequestPermission);
    }

    function handleMoreItem(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }): Promise<void> {
        return handleItemMore(data);
    }

    async function handleItemRemove(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }): Promise<void> {
        const { section, item } = data;

        // Section-ranker signal: the user dismissed an item from this section.
        emitSectionFeedback(section.id, 'dismiss');

        // Handle dismissed fulfilled requests — server-side via
        // POST /api/for-you/dismiss with flagType='request_dismissed'.
        // The internal UUID is the dismissal target (matches the
        // user_media_flags.target_id FK to media_items).
        if (section.id === 'fulfilled-requests') {
            const internalId =
                item.externalIds &&
                typeof (item.externalIds as Record<string, unknown>).internal === 'string'
                    ? (item.externalIds as Record<string, string>).internal
                    : undefined;
            if (!internalId) return;

            // user_media_flags.target_type uses the dismissal taxonomy
            // ('series' / 'movie') rather than the catalog media_type
            // ('tv' / 'movie'). Matches /api/continue-watching/dismissals
            // and resolveDismissalTarget in user-media-flags.queries.ts so
            // a future GET-list endpoint can render hidden requests
            // alongside hidden CW items without translating types.
            // `?? 'movie'` is safe on THIS branch only: the section is
            // 'fulfilled-requests', and a request can only ever be for a movie or
            // a series (Radarr / Sonarr / Jellyseerr have no other entity). The
            // old helper applied the same clamp to EVERY type unconditionally,
            // which is what made an audiobook dismissal write a movie-typed flag.
            // eslint-disable-next-line callback-safety/no-inline-media-type-default -- fulfilled requests are movie/series only.
            const targetType = toMovieOrSeries(item.mediaType) ?? 'movie';

            // Optimistic remove — capture the original items so we can roll back
            // if the server rejects the dismissal (otherwise the card vanishes
            // locally but reappears on the next reload, which reads as a bug).
            const sectionIndex = forYouSections.findIndex((s) => s.id === 'fulfilled-requests');
            const originalItems =
                sectionIndex !== -1 ? [...forYouSections[sectionIndex].items] : null;
            if (sectionIndex !== -1) {
                const updatedSection = { ...forYouSections[sectionIndex] };
                updatedSection.items = updatedSection.items.filter((i) => i.id !== item.id);
                forYouSections = [
                    ...forYouSections.slice(0, sectionIndex),
                    updatedSection,
                    ...forYouSections.slice(sectionIndex + 1),
                ];
            }

            const rollback = (): void => {
                if (originalItems === null) return;
                forYouSections = forYouSections.map((s) =>
                    s.id === 'fulfilled-requests' ? { ...s, items: originalItems } : s,
                );
                toasts.error(m.toast_dismiss_failed());
            };

            try {
                const { error: dismissErr } = await forYouApi.dismissForYouItem({
                    targetId: internalId,
                    targetType,
                    flagType: 'request_dismissed',
                });
                if (dismissErr) rollback();
            } catch (e) {
                console.error('[ForYou] Failed to persist request dismissal:', e);
                rollback();
            }
            return;
        }

        // Handle "Because you watched" dismissals
        if (section.id.startsWith('because-')) {
            await handleBecauseDismiss(section, item);
            return;
        }
        // CW dismissals are handled by WatchingStrip — not our concern here.
    }

    /**
     * Handle dismiss in "Because you watched" sections.
     * Records dismiss via API and refreshes with vector steering after 3+ dismissals.
     */
    async function handleBecauseDismiss(
        section: PageSection,
        item: UniversalMediaItem,
    ): Promise<void> {
        const meta = section.meta;

        // Build source media key from section metadata
        const sourceMediaType = meta?.sourceMediaType as ApiMediaType;
        const sourceExternalIds = meta?.sourceExternalIds;
        if (!sourceExternalIds || !sourceMediaType) {
            console.warn('[ForYou] Cannot dismiss: missing source metadata', section.id);
            return;
        }

        const sourceKey = buildMediaKey(sourceExternalIds, sourceMediaType);
        const dismissedKey = buildMediaKey(
            item.externalIds,
            (item.mediaType as ApiMediaType) || 'movie',
        );

        if (!sourceKey || !dismissedKey) {
            console.warn('[ForYou] Cannot dismiss: invalid media keys', {
                sourceKey,
                dismissedKey,
            });
            return;
        }

        // Optimistic update: remove item immediately
        const sectionIndex = forYouSections.findIndex((s) => s.id === section.id);
        if (sectionIndex === -1) return;

        const originalItems = [...forYouSections[sectionIndex].items];
        forYouSections = forYouSections.map((s) =>
            s.id === section.id ? { ...s, items: s.items.filter((i) => i.id !== item.id) } : s,
        );

        try {
            // Record dismiss via API
            const { data: dismissData, error: dismissErr } = await forYouApi.dismissRecommendation({
                sourceMediaKey: sourceKey,
                dismissedMediaKey: dismissedKey,
            });

            if (dismissErr) {
                // Revert on failure
                forYouSections = forYouSections.map((s) =>
                    s.id === section.id ? { ...s, items: originalItems } : s,
                );
                toasts.error(m.toast_dismiss_failed());
                return;
            }

            const dismissCount = dismissData?.dismissCount ?? 0;

            // After 3+ dismissals, refresh with steering
            if (dismissCount >= 3) {
                const { data: steeringData, error: steeringErr } = await forYouApi.getSimilar({
                    key: sourceKey,
                    steering: true,
                    limit: 8,
                });
                if (!steeringErr && steeringData) {
                    const items = steeringData.items;
                    if (items && items.length > 0) {
                        const universalItems = items.map((item) => ({
                            ...tasteItemToUniversal(item),
                            reason: item.reason?.label,
                        }));
                        forYouSections = forYouSections.map((s) =>
                            s.id === section.id ? { ...s, items: universalItems } : s,
                        );
                        toasts.success(m.toast_recommendations_updated());
                    }
                }
            }
        } catch (error) {
            console.error('[ForYou] Dismiss failed:', error);
            forYouSections = forYouSections.map((s) =>
                s.id === section.id ? { ...s, items: originalItems } : s,
            );
            toasts.error(m.toast_dismiss_failed());
        }
    }

    // =========================================================================
    // Impression beacon — fires once per (mount, sectionType) pair via
    // IntersectionObserver (threshold 0.5). keepalive: true lets the
    // request survive a page unload. Errors are swallowed.
    // =========================================================================

    /**
     * Map dynamic section IDs to the canonical KIND accepted by the
     * /api/for-you/feedback Zod enum. Delegates to the shared `sectionKind`
     * helper so feed-visibility and telemetry can never drift on the dynamic-id
     * prefixes (because-*, youlike-*, music-*, mood-*).
     */
    function canonicalSectionType(id: string): string {
        return sectionKind(id);
    }

    /**
     * Fire a section-level interaction beacon (play / dismiss) for the section
     * ranker, mirroring the impression beacon below. Best-effort; errors
     * swallowed. (We deliberately do NOT emit an 'abandon' event: a shown-but-
     * not-engaged section is already derivable as impressions − plays, so an
     * explicit per-scroll-past beacon would be redundant low-signal noise.)
     */
    function emitSectionFeedback(sectionId: string, event: 'play' | 'dismiss'): void {
        if (!browser) return;
        void forYouApi
            .feedbackForYouSection({ sectionType: canonicalSectionType(sectionId), event })
            .catch(() => {});
    }

    let feedRef = $state<HTMLElement | null>(null);
    const sentImpressions = new SvelteSet<string>();

    $effect(() => {
        if (!browser || !feedRef) return;

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const raw = (entry.target as HTMLElement).dataset.sectionType;
                    if (!raw) continue;
                    const canonical = canonicalSectionType(raw);
                    if (sentImpressions.has(canonical)) continue;
                    sentImpressions.add(canonical);
                    // Observe once then unobserve to avoid repeated firing
                    observer.unobserve(entry.target);
                    void forYouApi
                        .feedbackForYouSection({ sectionType: canonical, event: 'impression' })
                        .catch(() => {});
                }
            },
            { threshold: 0.5 },
        );

        // Observe all data-section-type children of the feed container.
        // We re-observe whenever new sections are appended (Svelte re-runs
        // the effect when feedRef's children change via MutationObserver).
        const observeChildren = () => {
            const nodes = feedRef?.querySelectorAll<HTMLElement>('[data-section-type]');
            if (!nodes) return;
            for (const node of nodes) {
                // Only observe nodes we haven't already sent for — avoids
                // double-observe when the effect re-runs.
                const raw = node.dataset.sectionType ?? '';
                const canonical = canonicalSectionType(raw);
                if (!sentImpressions.has(canonical)) {
                    observer.observe(node);
                }
            }
        };

        observeChildren();

        const mutation = new MutationObserver(observeChildren);
        mutation.observe(feedRef, { childList: true, subtree: false });

        return () => {
            observer.disconnect();
            mutation.disconnect();
        };
    });

    /**
     * A rating submitted from ANY surface on the page (modal actions, movie
     * sidebar, detailed rating panel — all AIRatingButton instances) fires
     * this document event (see use-modal-data.svelte.ts's handleRated /
     * handleRatingCleared). The taste rail's content is only as fresh as its
     * last fetch, so surface a "new ratings available" chip on its header
     * rather than silently reshuffling the rail out from under the user.
     */
    function handleRatingSubmittedElsewhere(): void {
        tasteRefreshAvailable = true;
    }

    onMount(() => {
        // Clear the cross-rail seen-media registry from any previous page so a
        // client-side navigation can't leave stale "already shown" ids behind
        // (the registry is module-scoped and shared with the Trending widget).
        resetSeenMedia();
        void loadForYou();
        void loadMoodSuggestions();
        void loadSectionOrder();
        document.addEventListener('rating-submitted', handleRatingSubmittedElsewhere);
        // Cancel the in-flight fan-out if the feed unmounts (route change)
        // mid-load so its parallel fetches don't complete in the background.
        return () => {
            feedDestroyed = true;
            loadAbort?.abort();
            loadAbort = null;
            document.removeEventListener('rating-submitted', handleRatingSubmittedElsewhere);
        };
    });
</script>

<svelte:window onclick={handleTasteMenuWindowClick} onkeydown={handleTasteMenuKeydown} />

{#if loading && !hasAnySections}
    <LoadingState loading={true} loadingMessage={m.foryou_loading_personalized()} />
{/if}

{#if error && !hasAnySections}
    <ErrorMessage message={error} variant="error" />
{/if}

{#if !loading && !hasAnySections && !error}
    <EmptyState
        variant="minimal"
        title={m.foryou_empty_title()}
        description={m.foryou_empty_description()} />
{:else if !loading || hasAnySections}
    <!-- Feed container — bind:this lets the impression beacon observer
         attach to [data-section-type] wrappers as sections render.
         space-y-8 carries the vertical rhythm that was previously
         provided by the shell's outer space-y-8 wrapping each
         SectionRenderer directly (pre-decomposition). -->
    <div bind:this={feedRef} class="space-y-8">
        <!-- Sections before mood (fulfilled-requests only — watching is in
             WatchingStrip). The first section is typically above the fold,
             so its first ~6 cards opt into priority loading; the rest stay
             lazy as before. -->
        {#each dedupedBeforeMood as section, sectionIdx (section.id)}
            <div data-section-type={section.id}>
                <SectionRenderer
                    {section}
                    {hasRequestPermission}
                    priorityCount={sectionIdx === 0 ? 6 : 0}
                    onitemClick={handleClickItem}
                    onitemPlay={handlePlayItem}
                    onitemRequest={handleRequestItem}
                    onitemMore={handleMoreItem}
                    onitemRemove={handleItemRemove} />
            </div>
        {/each}

        <!-- Featured Pick Section - hero-style recommendation after Continue Watching.
             Visibility + cross-rail dedupe already applied in crossRailDeduped —
             dedupedFeaturedPick is null both when hidden by prefs AND when its
             item was already shown in a section rendered above it. -->
        {#if dedupedFeaturedPick}
            <div data-section-type={dedupedFeaturedPick.id}>
                <SectionRenderer
                    section={dedupedFeaturedPick}
                    {hasRequestPermission}
                    onitemClick={handleClickItem}
                    onitemPlay={handlePlayItem}
                    onitemRequest={handleRequestItem}
                    onitemMore={handleMoreItem}
                    onitemRemove={handleItemRemove} />
            </div>
        {/if}

        <!-- Mood Selector + Mood Sections -->
        {#if aiEnabled && moodVisible && availableMoods.length > 0}
            <MoodSelector
                {selectedMoods}
                {suggestedMoods}
                {availableMoods}
                loading={moodLoading}
                onselect={handleMoodSelect} />
        {/if}

        {#each dedupedMoodSections as section (section.id)}
            <div data-section-type={section.id}>
                <SectionRenderer
                    {section}
                    {hasRequestPermission}
                    onitemClick={handleClickItem}
                    onitemPlay={handlePlayItem}
                    onitemRequest={handleRequestItem}
                    onitemMore={handleMoreItem}
                    onitemRemove={handleItemRemove} />
            </div>
        {/each}

        <!-- Mood empty state: a user-selected mood that matches nothing leaves an
             otherwise silent, collapsed gap below the selector. Surface a message
             so the user knows the mood simply has no matching content. -->
        {#if aiEnabled && moodVisible && !moodLoading && selectedMoods.length > 0 && moodSections.length === 0}
            <EmptyState
                variant="minimal"
                title={m.mood_no_results_title()}
                description={m.mood_no_results_desc()} />
        {/if}

        <!-- Taste rail trainer-card replacement — stands in for the ENTIRE
             rail (instead of the generating skeleton below) once we know the
             user hasn't rated enough yet, or the rail is genuinely exhausted.
             See tasteRailReplace's derivation above. -->
        <!-- State machine for the 'generating' gate (Plan 4 honest-state fix):
             tasteStatus 'generating' means the taste rail's profile embedding
             hasn't produced a page yet, but that has two very different
             causes the skeleton alone can't distinguish:
               1. totalRatings === null — the userStats fetch hasn't resolved
                  yet (or AI is disabled/hidden). We don't know if the user is
                  even unlocked, so keep showing the skeleton rather than
                  flash a card that might immediately swap to something else.
               2. totalRatings !== null && >= MIN_RATINGS_FOR_RECOMMENDATIONS
                  — the user IS unlocked (tasteRailReplace above already
                  ruled out "not enough ratings") but the embedding is STILL
                  null. Per AiStrategy's contract this happens when none of
                  their ratings are positive (>=6) and watch-history signals
                  are off/absent — there is no in-flight generation that will
                  ever resolve; the skeleton would spin forever. Render the
                  honest "rate something you like" card instead (same
                  component/slot as the locked-replacement card above, just
                  with different copy) rather than changing AiStrategy's
                  contract to fabricate a fake "empty" status.
             (totalRatings !== null && < MIN is unreachable here — tasteRailReplace
             already takes that branch above.) -->
        {#if tasteRailReplace}
            <TasteTrainerCard
                totalRatings={totalRatings ?? 0}
                minRatings={MIN_RATINGS_FOR_RECOMMENDATIONS}
                variant="replacement" />
        {:else if aiEnabled && tasteStatus === 'generating' && totalRatings !== null && totalRatings >= MIN_RATINGS_FOR_RECOMMENDATIONS}
            <!-- Case 2 above: unlocked, but no positive signal to embed.
                 The >= check is defensive/explicit — tasteRailReplace above
                 already took the branch for totalRatings < MIN, so this is
                 always true here, but spelling it out keeps this branch
                 correct even if tasteRailReplace's derivation ever changes. -->
            <TasteTrainerCard
                {totalRatings}
                minRatings={MIN_RATINGS_FOR_RECOMMENDATIONS}
                variant="replacement"
                message={m.taste_trainer_no_positive()} />
        {:else if aiEnabled && tasteStatus === 'generating'}
            <!-- Case 1 above: totalRatings unresolved — the rail's own
                 PageSection only exists once the AI profile has produced a
                 page (status 'ready'); until we know whether the user is
                 unlocked, there is nothing in sectionsAfterMood to render
                 for it yet, so show the plain skeleton. -->
            <div class="space-y-3">
                <div class="flex items-center gap-2">
                    <Icon src={Sparkles} class="w-5 h-5 text-purple-400" />
                    <h2 class="text-lg font-heading">{m.section_taste()}</h2>
                </div>
                <p class="text-sm text-surface-400">{m.rec_generating()}</p>
                <div class="flex gap-3 overflow-hidden">
                    {#each Array(6) as _, i (i)}
                        <Skeleton width="w-32 sm:w-40" height="h-48 sm:h-60" rounded="lg" />
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Sections after mood -->
        {#each sectionsAfterMood as section (section.id)}
            <div data-section-type={section.id} class="space-y-3">
                <!-- Taste rail header row: refresh-available chip (only ever
                     shown above the RAIL itself — tasteRailReplace already
                     stood in for it otherwise, and this loop only reaches id
                     'taste' when the rail has content) + the overflow menu
                     (always shown alongside the rail). Explicit opt-in
                     refetch — see refreshTasteRail's doc comment for why the
                     chip never fires automatically. -->
                {#if section.id === 'taste'}
                    <div class="flex items-center justify-end gap-2">
                        {#if tasteRefreshAvailable}
                            <button
                                type="button"
                                class="btn btn-sm variant-ghost-primary flex items-center gap-1.5"
                                onclick={refreshTasteRail}
                                disabled={tasteRefreshing}>
                                <Icon
                                    src={ArrowPath}
                                    class="w-3.5 h-3.5 {tasteRefreshing ? 'animate-spin' : ''}" />
                                {m.taste_refresh_available()}
                            </button>
                        {/if}
                        <div class="relative" bind:this={tasteMenuEl}>
                            <button
                                type="button"
                                class="btn-icon btn-icon-sm variant-ghost-surface"
                                aria-label={m.taste_rail_options()}
                                aria-haspopup="true"
                                aria-expanded={tasteMenuOpen}
                                onclick={() => (tasteMenuOpen = !tasteMenuOpen)}>
                                <Icon src={EllipsisHorizontal} class="w-4 h-4" />
                            </button>
                            {#if tasteMenuOpen}
                                <div
                                    class="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-surface-600 bg-surface-800 py-1 shadow-xl"
                                    role="menu">
                                    <label
                                        class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-surface-100 hover:bg-surface-700">
                                        <input
                                            type="checkbox"
                                            checked={includeWatchHistory}
                                            disabled={includeWatchHistorySaving}
                                            onchange={toggleIncludeWatchHistory} />
                                        {m.taste_include_watch()}
                                    </label>
                                    <a
                                        href={resolve('/rate')}
                                        role="menuitem"
                                        class="block px-3 py-2 text-sm text-surface-100 hover:bg-surface-700"
                                        onclick={closeTasteMenu}>
                                        {m.taste_train_link()}
                                    </a>
                                </div>
                            {/if}
                        </div>
                    </div>
                {/if}
                <SectionRenderer
                    {section}
                    {hasRequestPermission}
                    onitemClick={handleClickItem}
                    onitemPlay={handlePlayItem}
                    onitemRequest={handleRequestItem}
                    onitemMore={handleMoreItem}
                    onitemRemove={handleItemRemove} />
                <!-- Taste trainer card, trailing the rail once it has content
                     (the locked/exhausted replacement above is a DIFFERENT
                     branch — this only renders once totalRatings has resolved
                     so the copy doesn't flash from unlocked to locked). -->
                {#if section.id === 'taste' && totalRatings !== null}
                    <TasteTrainerCard
                        {totalRatings}
                        minRatings={MIN_RATINGS_FOR_RECOMMENDATIONS}
                        variant="trailing" />
                {/if}
            </div>
        {/each}

        <!-- Loading more indicator - shown while additional sections are loading -->
        {#if loadingMore && hasAnySections}
            <div class="center gap-2 py-4 text-gray-400">
                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                <span class="text-sm">{m.foryou_loading_more()}</span>
            </div>
        {/if}
    </div>
{/if}
