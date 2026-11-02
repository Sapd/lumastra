<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
    /**
     * Watch Statistics Tab - Analytics and Insights
     * This page displays watch history analytics, top content, user activity, and trends
     */
    import * as m from '$lib/paraglide/messages.js';
    import { onMount } from 'svelte';
    import CustomActivityChart from '$lib/components/CustomActivityChart.svelte';
    import {
        AdminPageHeader,
        MediaRankCard,
        TimeframeSelector,
        ChartCard,
        UserRankCard,
    } from '$lib/components/admin';
    import StatsUserAvatar from '$lib/components/admin/stats/StatsUserAvatar.svelte';
    import { LoadingState } from '$lib/components/ui';
    import {
        loadWatchStat,
        loadStat,
        transformChartData,
    } from '$lib/utils/admin/stats-data-loader';
    import type { StatState } from '$lib/utils/admin/stats-data-loader';
    import { apiGet } from '$lib/api/client.js';
    import { z } from 'zod';
    import { getPreferredExternalId } from '$lib/utils/external-ids';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';

    // Grouped state for better organization
    // Server returns bare { stats: T, day?: string } — no legacy `success` wrapper.
    type WatchStatsResponse<T> = { stats: T; day?: string };
    type ChartDatum = {
        label: string;
        count: number;
        minutes: number;
        percentage: number;
    };
    type ChartResult = { success: boolean; data: ChartDatum[]; error?: string | null };
    type MediaStatRow = {
        title?: string;
        year?: number | null;
        rating?: number | null;
        externalIds?: { tmdb?: string; imdb?: string; internal?: string };
        uniqueViewers?: number;
        totalPlayTime?: number;
    };
    type ActivityStats = {
        dayOfWeek: Array<{
            day: string;
            count: number;
            minutes: number;
            percentage: number;
        }>;
        hourOfDay: Array<{
            hour: number;
            count: number;
            minutes: number;
            percentage: number;
        }>;
        totalSessions: number;
        totalMinutes: number;
        avgMinutesPerUser: number;
    };
    type TopUser = {
        id: string;
        name: string;
        sessions: number;
        avgSessionLength: number;
        minutes?: number;
        totalPlayTime?: string;
        lastActive?: string;
        hours?: number;
        images?: ImageSet;
    };

    type SurfaceMixStats = {
        segments: Array<{ surface: string; sessions: number; percentage: number }>;
        liveTvSessions: number;
        totalSessions: number;
        attributedSessions: number;
        windowDays: number;
    };

    /**
     * Human label for a `play_sessions.surface` value.
     *
     * An explicit switch, NOT a dynamic `m[...]()` lookup. A paraglide lookup
     * for a key that does not exist throws at runtime and takes the whole page
     * down — and this value comes from the database, so the day a new surface
     * ships ahead of its translation is the day insights breaks. The default
     * returns the raw value: ugly, visible, and harmless.
     */
    function surfaceLabel(value: string): string {
        switch (value) {
            case 'web':
                return m.admin_stats_surface_web();
            case 'native_app':
                return m.admin_stats_surface_native_app();
            case 'third_party_api':
                return m.admin_stats_surface_third_party_api();
            case 'jellyfin_compat':
                return m.admin_stats_surface_jellyfin_compat();
            case 'subsonic':
                return m.admin_stats_surface_subsonic();
            case 'jellyfin_mirror':
                return m.admin_stats_surface_jellyfin_mirror();
            case 'unknown':
                return m.admin_stats_surface_unknown();
            default:
                return value;
        }
    }

    // New stat types
    type ColdContentSort = 'cold' | 'skyline';
    type ColdContentItem = {
        title: string;
        mediaType: 'movie' | 'tv';
        year: number | null;
        internalId: string;
        posterUrl: string;
        addedAt: string;
        ageDays: number;
        sizeBytes: number;
        watchCount: number;
        isSkyline?: boolean;
    };
    type CompletionLeaderboardItem = {
        title: string;
        mediaType: 'movie' | 'tv';
        year: number | null;
        internalId?: string;
        posterUrl?: string;
        avgCompletion: number;
        sessions: number;
        abandonRate: number;
    };
    type DormantUser = {
        id: string;
        name: string;
        images?: ImageSet;
        lastActive: string;
        daysSinceActive: number;
        lifetimeSessions: number;
    };
    type Segment = {
        label: string;
        sessions: number;
        watchSeconds: number;
        percentage: number;
    };
    type DeviceMixStats = {
        byClient: Segment[];
        byDevice: Segment[];
        byResolution: Segment[];
        byCodec: Segment[];
        totalSessions: number;
        totalWatchSeconds: number;
    };

    let movies: StatState<WatchStatsResponse<MediaStatRow[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let tvShows: StatState<WatchStatsResponse<MediaStatRow[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let activity: StatState<WatchStatsResponse<ActivityStats>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let topUsers: StatState<WatchStatsResponse<TopUser[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let activeUsers: StatState<WatchStatsResponse<TopUser[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });

    // New stat states
    let coldContent: StatState<WatchStatsResponse<ColdContentItem[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let completionLeaderboard: StatState<WatchStatsResponse<CompletionLeaderboardItem[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let dormantUsers: StatState<WatchStatsResponse<DormantUser[]>> = $state({
        data: null,
        loading: false,
        error: null,
    });
    let surfaceMix: StatState<WatchStatsResponse<SurfaceMixStats>> = $state({
        data: null,
        loading: true,
        error: null,
    });

    let deviceMix: StatState<WatchStatsResponse<DeviceMixStats>> = $state({
        data: null,
        loading: false,
        error: null,
    });

    let contentFreshness = $state<ChartResult | null>(null);
    let genreBreakdown = $state<ChartResult | null>(null);

    let moviesTimeframe: 'AllTime' | 'LastWeek' | 'LastMonth' = $state('AllTime');
    let coldContentTimeframe: 'AllTime' | 'LastWeek' | 'LastMonth' = $state('AllTime');
    let topUsersTimeframe: 'AllTime' | 'LastWeek' | 'LastMonth' = $state('AllTime');

    // Cold-content ordering: 'cold' (least-watched first) | 'skyline' (biggest
    // space-wasters first — the least-watched×biggest Pareto frontier).
    let coldContentSort: ColdContentSort = $state('cold');

    // Per-section "Load more" page sizes. Each list starts at one PAGE_SIZE page
    // and grows in place; a fresh timeframe/sort change resets it to one page.
    const PAGE_SIZE = 10;
    let moviesLimit = $state(PAGE_SIZE);
    let tvShowsLimit = $state(PAGE_SIZE);
    let topUsersLimit = $state(PAGE_SIZE);
    let activeUsersLimit = $state(PAGE_SIZE);
    let coldContentLimit = $state(PAGE_SIZE);
    let completionLimit = $state(PAGE_SIZE);
    let dormantUsersLimit = $state(PAGE_SIZE);

    // "Load more" loading flags, kept SEPARATE from each section's `loading` so a
    // grow-in-place refetch does not unmount the already-rendered list (the
    // LoadingState wrapper hides children whenever `loading` is true).
    let moviesLoadingMore = $state(false);
    let tvShowsLoadingMore = $state(false);
    let topUsersLoadingMore = $state(false);
    let activeUsersLoadingMore = $state(false);
    let coldContentLoadingMore = $state(false);
    let completionLoadingMore = $state(false);
    let dormantUsersLoadingMore = $state(false);

    onMount(() => {
        loadAllStats();
    });

    let moviesList = $derived(movies.data?.stats ?? []);
    let tvShowsList = $derived(tvShows.data?.stats ?? []);
    let topUsersList = $derived(topUsers.data?.stats ?? []);
    let activeUsersList = $derived(activeUsers.data?.stats ?? []);
    let coldContentList = $derived(coldContent.data?.stats ?? []);
    let completionList = $derived(completionLeaderboard.data?.stats ?? []);
    let dormantUsersList = $derived(dormantUsers.data?.stats ?? []);
    let deviceMixData = $derived(deviceMix.data?.stats ?? null);
    let surfaceMixData = $derived(surfaceMix.data?.stats ?? null);

    // Device-mix is volume-weighted (power users intentionally dominate — it's a load
    // view). The toggle only changes the WEIGHT: count of sessions vs. summed watch
    // time. Both metrics ship in one response, so switching is instant (no re-fetch).
    // Default to Hours: for resolution/codec especially, hours-of-stream is the
    // load-relevant quantity, not play-button presses.
    type DeviceMixWeight = 'sessions' | 'hours';
    let deviceMixWeight: DeviceMixWeight = $state('hours');

    type WeightedSegment = {
        label: string;
        sessions: number;
        watchSeconds: number;
        /** Share of the dimension by the ACTIVE weight (0–100). */
        percentage: number;
    };

    /**
     * Re-rank a dimension's segments by the active weight and recompute each
     * segment's share against that weight's dimension total. Sessions mode reuses
     * the server-sent percentage; hours mode derives the share from watchSeconds.
     */
    function weightSegments(segments: Segment[], weight: DeviceMixWeight): WeightedSegment[] {
        if (weight === 'sessions') {
            return segments
                .map((s) => ({
                    label: s.label,
                    sessions: s.sessions,
                    watchSeconds: s.watchSeconds,
                    percentage: s.percentage,
                }))
                .sort((a, b) => b.sessions - a.sessions);
        }
        const totalSeconds = segments.reduce((sum, s) => sum + s.watchSeconds, 0);
        return segments
            .map((s) => ({
                label: s.label,
                sessions: s.sessions,
                watchSeconds: s.watchSeconds,
                percentage: totalSeconds > 0 ? (s.watchSeconds / totalSeconds) * 100 : 0,
            }))
            .sort((a, b) => b.watchSeconds - a.watchSeconds);
    }

    /**
     * Format minutes into a human-readable duration.
     * Shows minutes when under 60 (avoids "0h" for short totals).
     */
    function formatWatchTime(totalMinutes: number): string {
        if (totalMinutes < 60) {
            return `${Math.round(totalMinutes)}m`;
        }
        return `${Math.round(totalMinutes / 60)}h`;
    }

    /**
     * Format bytes into a human-readable size string (GB/MB).
     */
    function formatBytes(bytes: number): string {
        if (bytes >= 1_073_741_824) {
            return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
        }
        return `${(bytes / 1_048_576).toFixed(0)} MB`;
    }

    /**
     * Load stats in parallel groups to optimize loading time
     * Group 1: Primary stats (movies, TV, activity, users) - most visible
     * Group 2: Secondary stats (genre breakdown, content freshness)
     * Group 3: New stats (cold-content, completion, dormant, device-mix)
     */
    const loadAllStats = async () => {
        // Every section loads in parallel; each dedicated loader reads its own
        // timeframe / sort / page-size state so initial load, timeframe changes,
        // sort changes and "Load more" all share one code path.
        await Promise.all([
            loadMovies(),
            loadActivity(),
            loadTvShows(),
            loadTopUsers(),
            loadActiveUsers(),
            loadGenreBreakdown('AllTime'),
            loadContentFreshness('AllTime'),
            loadColdContent(),
            loadCompletion(),
            loadDormant(),
            loadDeviceMix(),
            loadSurfaceMix(),
        ]);
    };

    // ── Dedicated per-section loaders ───────────────────────────────────────
    // Each list section loads through `loadSection`, which adds two guarantees
    // on top of `loadWatchStat`:
    //  1. A per-section request GENERATION: a newer load supersedes a slower
    //     older one (e.g. a wide "Load more" still in flight when the timeframe
    //     or sort changes), so a stale response can't overwrite fresher data.
    //  2. `more` (Load more) routes loading through the section's `loadingMore`
    //     flag (the list stays mounted — LoadingState only hides children on
    //     `loading`), and a failed/empty grow-in-place keeps the rows already
    //     shown instead of blanking them, surfacing the error as a toast.
    const loadGen: Record<string, number> = {};

    function loadSection<T>(
        key: string,
        type: string,
        timeframe: string,
        state: StatState<WatchStatsResponse<T>>,
        setLoadingMore: (loading: boolean) => void,
        more: boolean,
        params?: Record<string, string | number>,
        onMoreFailed?: () => void,
    ): Promise<void> {
        const gen = (loadGen[key] = (loadGen[key] ?? 0) + 1);
        const stale = () => gen !== loadGen[key];
        return loadWatchStat<WatchStatsResponse<T>>(
            type,
            timeframe,
            (d) => {
                if (stale()) return;
                // Load-more error/empty yields null → keep the mounted list,
                // and hand the page size back: the button is shown only while
                // the list fills the limit, so a raised limit after a failed
                // grow hid it and left no way to retry.
                if (more && !d) {
                    onMoreFailed?.();
                    return;
                }
                state.data = d;
            },
            (l) => {
                if (stale()) return;
                if (more) {
                    setLoadingMore(l);
                } else {
                    state.loading = l;
                    // A full (re)load subsumes any in-flight "Load more" for this
                    // section. Clear its flag on start so a load-more that gets
                    // superseded here (its own finally is gated by `stale()`)
                    // can't leave the button disabled forever.
                    if (l) setLoadingMore(false);
                }
            },
            params,
            (e) => {
                if (stale()) return;
                if (more) {
                    if (e) toasts.error(e);
                } else {
                    state.error = e;
                }
            },
        );
    }

    function loadMovies(more = false, onMoreFailed?: () => void) {
        return loadSection<MediaStatRow[]>(
            'movies',
            'movies',
            moviesTimeframe,
            movies,
            (l) => (moviesLoadingMore = l),
            more,
            { limit: moviesLimit },
            onMoreFailed,
        );
    }

    function loadActivity() {
        return loadSection<ActivityStats>(
            'activity',
            'activity',
            moviesTimeframe,
            activity,
            () => {},
            false,
        );
    }

    function loadTvShows(more = false, onMoreFailed?: () => void) {
        return loadSection<MediaStatRow[]>(
            'tvshows',
            'tvshows',
            'AllTime',
            tvShows,
            (l) => (tvShowsLoadingMore = l),
            more,
            { limit: tvShowsLimit },
            onMoreFailed,
        );
    }

    function loadTopUsers(more = false, onMoreFailed?: () => void) {
        return loadSection<TopUser[]>(
            'top-users',
            'top-users',
            topUsersTimeframe,
            topUsers,
            (l) => (topUsersLoadingMore = l),
            more,
            { limit: topUsersLimit },
            onMoreFailed,
        );
    }

    function loadActiveUsers(more = false, onMoreFailed?: () => void) {
        // Server ignores timeframe for active-users (fixed last-30-days window).
        return loadSection<TopUser[]>(
            'active-users',
            'active-users',
            'AllTime',
            activeUsers,
            (l) => (activeUsersLoadingMore = l),
            more,
            { limit: activeUsersLimit },
            onMoreFailed,
        );
    }

    function loadColdContent(more = false, onMoreFailed?: () => void) {
        return loadSection<ColdContentItem[]>(
            'cold-content',
            'cold-content',
            coldContentTimeframe,
            coldContent,
            (l) => (coldContentLoadingMore = l),
            more,
            { limit: coldContentLimit, sort: coldContentSort },
            onMoreFailed,
        );
    }

    function loadCompletion(more = false, onMoreFailed?: () => void) {
        return loadSection<CompletionLeaderboardItem[]>(
            'completion-leaderboard',
            'completion-leaderboard',
            'AllTime',
            completionLeaderboard,
            (l) => (completionLoadingMore = l),
            more,
            { limit: completionLimit },
            onMoreFailed,
        );
    }

    function loadDormant(more = false, onMoreFailed?: () => void) {
        // Server ignores timeframe for dormant-users (fixed 30-day threshold).
        return loadSection<DormantUser[]>(
            'dormant-users',
            'dormant-users',
            'AllTime',
            dormantUsers,
            (l) => (dormantUsersLoadingMore = l),
            more,
            { limit: dormantUsersLimit },
            onMoreFailed,
        );
    }

    function loadSurfaceMix() {
        return loadStat<WatchStatsResponse<SurfaceMixStats>>(
            '/api/watch-stats?type=surface-mix',
            (d) => {
                surfaceMix.data = d;
            },
            (l) => {
                surfaceMix.loading = l;
            },
            (e) => {
                surfaceMix.error = e;
            },
        );
    }

    function loadDeviceMix() {
        return loadStat<WatchStatsResponse<DeviceMixStats>>(
            '/api/watch-stats?type=device-mix',
            (d) => {
                deviceMix.data = d;
            },
            (l) => {
                deviceMix.loading = l;
            },
            (e) => {
                deviceMix.error = e;
            },
        );
    }

    // ── "Load more" handlers — grow the page by PAGE_SIZE, refetch in place ──
    function loadMoreMovies() {
        const prev = moviesLimit;
        moviesLimit += PAGE_SIZE;
        void loadMovies(true, () => (moviesLimit = prev));
    }
    function loadMoreTvShows() {
        const prev = tvShowsLimit;
        tvShowsLimit += PAGE_SIZE;
        void loadTvShows(true, () => (tvShowsLimit = prev));
    }
    function loadMoreTopUsers() {
        const prev = topUsersLimit;
        topUsersLimit += PAGE_SIZE;
        void loadTopUsers(true, () => (topUsersLimit = prev));
    }
    function loadMoreActiveUsers() {
        const prev = activeUsersLimit;
        activeUsersLimit += PAGE_SIZE;
        void loadActiveUsers(true, () => (activeUsersLimit = prev));
    }
    function loadMoreColdContent() {
        const prev = coldContentLimit;
        coldContentLimit += PAGE_SIZE;
        void loadColdContent(true, () => (coldContentLimit = prev));
    }
    function loadMoreCompletion() {
        const prev = completionLimit;
        completionLimit += PAGE_SIZE;
        void loadCompletion(true, () => (completionLimit = prev));
    }
    function loadMoreDormant() {
        const prev = dormantUsersLimit;
        dormantUsersLimit += PAGE_SIZE;
        void loadDormant(true, () => (dormantUsersLimit = prev));
    }

    const ContentFreshnessSchema = z
        .object({
            stats: z.object({
                recentContent: z.object({
                    items: z.number().optional(),
                    totalHours: z.number().optional(),
                    percentage: z.number().optional(),
                }),
                olderContent: z.object({
                    items: z.number().optional(),
                    totalHours: z.number().optional(),
                    percentage: z.number().optional(),
                }),
                unknownContent: z
                    .object({
                        items: z.number().optional(),
                        totalHours: z.number().optional(),
                        percentage: z.number().optional(),
                    })
                    .optional(),
            }),
        })
        .passthrough();

    const loadContentFreshness = async (timeframe = 'AllTime') => {
        const { data: result, error } = await apiGet(
            `/api/watch-stats?type=content-freshness&timeframe=${timeframe}`,
            ContentFreshnessSchema,
        );
        if (error || !result) {
            contentFreshness = { success: false, data: [], error: error ?? 'Failed to load' };
            return;
        }
        const buckets: ChartDatum[] = [
            {
                label: m.admin_stats_recent_content(),
                count: result.stats.recentContent.items || 0,
                minutes: Math.round((result.stats.recentContent.totalHours || 0) * 60),
                percentage: result.stats.recentContent.percentage || 0,
            },
            {
                label: m.admin_stats_older_content(),
                count: result.stats.olderContent.items || 0,
                minutes: Math.round((result.stats.olderContent.totalHours || 0) * 60),
                percentage: result.stats.olderContent.percentage || 0,
            },
        ];
        if (result.stats.unknownContent && (result.stats.unknownContent.items || 0) > 0) {
            buckets.push({
                label: m.admin_stats_unknown_content(),
                count: result.stats.unknownContent.items || 0,
                minutes: Math.round((result.stats.unknownContent.totalHours || 0) * 60),
                percentage: result.stats.unknownContent.percentage || 0,
            });
        }
        contentFreshness = { success: true, data: buckets };
    };

    const GenreBreakdownSchema = z
        .object({
            stats: z
                .array(
                    z.object({
                        name: z.string().optional(),
                        genre: z.string().optional(),
                        itemCount: z.number().optional(),
                        count: z.number().optional(),
                        totalMinutes: z.number().optional(),
                        totalWatchTime: z.number().optional(),
                        percentage: z.number().optional(),
                    }),
                )
                .optional(),
        })
        .passthrough();

    const loadGenreBreakdown = async (timeframe = 'AllTime') => {
        const { data: result, error } = await apiGet(
            `/api/watch-stats?type=genre-breakdown&limit=10&timeframe=${timeframe}`,
            GenreBreakdownSchema,
        );
        if (error || !result) {
            genreBreakdown = {
                success: false,
                data: [],
                error: error ?? m.admin_stats_error_loading(),
            };
            return;
        }
        if (!result.stats?.length) {
            genreBreakdown = { success: true, data: [] };
            return;
        }
        genreBreakdown = {
            success: true,
            data: result.stats.map((genre) => ({
                label: genre.name || genre.genre || m.admin_unknown_genre(),
                count: genre.itemCount || genre.count || 0,
                minutes: genre.totalMinutes || genre.totalWatchTime || 0,
                percentage: genre.percentage || 0,
            })),
        };
    };

    // ── Timeframe / sort change handlers — reset the page to one PAGE_SIZE so a
    //    wide page isn't carried across a different slice of data. ────────────
    function handleColdContentTimeframeChange() {
        coldContentLimit = PAGE_SIZE;
        void loadColdContent();
    }

    function handleColdContentSortChange(next: ColdContentSort) {
        if (coldContentSort === next) return;
        coldContentSort = next;
        coldContentLimit = PAGE_SIZE;
        void loadColdContent();
    }

    function handleMoviesTimeframeChange() {
        // Movies + activity share the movies timeframe; reload both.
        moviesLimit = PAGE_SIZE;
        void Promise.all([loadMovies(), loadActivity()]);
    }

    function handleTopUsersTimeframeChange() {
        topUsersLimit = PAGE_SIZE;
        void loadTopUsers();
    }
</script>

<!--
  Reusable "Load more" footer. `canLoad` is true while the last page came back
  full (list.length >= current limit), implying more rows may exist; it hides
  once a short page is returned (end reached). `loadingMore` disables the button
  during a grow-in-place refetch (the list stays mounted meanwhile).
-->
{#snippet loadMoreButton(canLoad: boolean, loadingMore: boolean, onclick: () => void)}
    {#if canLoad}
        <div class="flex justify-center pt-2">
            <button
                type="button"
                class="px-4 py-2 text-sm font-medium rounded-lg bg-surface-700/50 text-surface-200 hover:bg-surface-600/50 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={loadingMore}
                {onclick}>
                {m.section_load_more()}
            </button>
        </div>
    {/if}
{/snippet}

<div class="space-y-8">
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/insights']}
        title={m.admin_stats_title()}
        description={m.admin_stats_description()} />

    <!-- Cold Content (Never Watched / Prune Candidates) — flagship, near top -->
    <section class="space-y-4" aria-labelledby="cold-content-heading">
        <div class="between">
            <h3 id="cold-content-heading" class="text-xl font-semibold">
                {m.admin_stats_cold_content_title()}
            </h3>
            <div class="flex items-center gap-2">
                <!-- Least-watched ⇄ Space-hogs (skyline) sort toggle -->
                <div
                    class="inline-flex rounded-lg bg-surface-700/50 p-0.5"
                    role="group"
                    aria-label={m.admin_stats_cold_content_sort_label()}>
                    <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors {coldContentSort ===
                        'cold'
                            ? 'bg-blue-600 text-white'
                            : 'text-surface-300 hover:text-white'}"
                        aria-pressed={coldContentSort === 'cold'}
                        onclick={() => handleColdContentSortChange('cold')}>
                        {m.admin_stats_cold_content_sort_least_watched()}
                    </button>
                    <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors {coldContentSort ===
                        'skyline'
                            ? 'bg-blue-600 text-white'
                            : 'text-surface-300 hover:text-white'}"
                        aria-pressed={coldContentSort === 'skyline'}
                        onclick={() => handleColdContentSortChange('skyline')}>
                        {m.admin_stats_cold_content_sort_space_hogs()}
                    </button>
                </div>
                <TimeframeSelector
                    bind:value={coldContentTimeframe}
                    onchange={handleColdContentTimeframeChange} />
            </div>
        </div>
        <p class="text-sm text-surface-400 -mt-2">
            {coldContentSort === 'skyline'
                ? m.admin_stats_cold_content_skyline_subtitle()
                : m.admin_stats_cold_content_subtitle()}
        </p>
        <LoadingState
            loading={coldContent.loading}
            error={coldContent.error}
            isEmpty={coldContentList.length === 0}
            emptyMessage={m.admin_stats_cold_content_no_data()}>
            <ul
                class="grid grid-cols-1 lg:grid-cols-2 gap-4"
                aria-label={m.admin_stats_cold_content_title()}>
                {#each coldContentList as item, index (`cold-${item.internalId}-${index}`)}
                    <li>
                        <div
                            class="bg-surface-700/50 rounded-lg p-3 border border-surface-600/50 hover:border-surface-500 transition-all">
                            <div class="between gap-4">
                                <!-- Left: poster + title -->
                                <div class="flex items-center gap-3 flex-1 min-w-0">
                                    <!-- Index badge -->
                                    <div
                                        class="w-8 h-8 center rounded-full bg-gradient-to-br from-red-600 to-red-700 text-white font-bold text-sm shrink-0 shadow-lg"
                                        aria-label={m.admin_stats_rank_label({ rank: index + 1 })}>
                                        <span aria-hidden="true">#{index + 1}</span>
                                    </div>

                                    <!-- Poster -->
                                    {#if item.posterUrl}
                                        <div
                                            class="w-12 h-18 bg-surface-600 rounded-md overflow-hidden shrink-0">
                                            <img
                                                src={item.posterUrl}
                                                alt="{item.title} poster"
                                                class="w-full h-full object-cover"
                                                loading="lazy"
                                                onerror={(e) => {
                                                    const t = e.currentTarget as HTMLElement;
                                                    if (t) t.style.display = 'none';
                                                }} />
                                        </div>
                                    {/if}

                                    <!-- Title & year -->
                                    <div class="min-w-0 flex-1">
                                        <h4 class="font-medium text-white truncate">
                                            {item.title}
                                        </h4>
                                        <div class="flex items-center gap-2 mt-0.5">
                                            {#if item.year}
                                                <span class="text-hint">{item.year}</span>
                                            {/if}
                                            <span class="text-xs text-surface-400 uppercase">
                                                {item.mediaType}
                                            </span>
                                            {#if item.isSkyline}
                                                <span
                                                    class="text-xs font-semibold text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded"
                                                    title={m.admin_stats_cold_content_skyline_subtitle()}>
                                                    {m.admin_stats_cold_content_skyline_badge()}
                                                </span>
                                            {/if}
                                        </div>
                                    </div>
                                </div>

                                <!-- Right: watch count + age + size -->
                                <div class="flex flex-col items-end gap-1 shrink-0 text-right">
                                    {#if item.watchCount === 0}
                                        <span
                                            class="text-xs font-semibold text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
                                            {m.admin_stats_cold_content_never_watched()}
                                        </span>
                                    {:else if item.watchCount === 1}
                                        <span class="text-xs font-medium text-surface-300">
                                            {m.admin_stats_cold_content_play_one()}
                                        </span>
                                    {:else}
                                        <span class="text-xs font-medium text-surface-300">
                                            {m.admin_stats_cold_content_plays({
                                                count: item.watchCount,
                                            })}
                                        </span>
                                    {/if}
                                    <span class="text-xs text-amber-400">
                                        {m.admin_stats_cold_content_added_days({
                                            days: item.ageDays,
                                        })}
                                    </span>
                                    <span class="text-xs text-surface-400">
                                        {m.admin_stats_cold_content_size({
                                            size: formatBytes(item.sizeBytes),
                                        })}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
            {@render loadMoreButton(
                coldContentList.length >= coldContentLimit,
                coldContentLoadingMore,
                loadMoreColdContent,
            )}
        </LoadingState>
    </section>

    <!-- Top Movies -->
    <div class="space-y-4">
        <div class="between">
            <h3 class="text-xl font-semibold">{m.admin_stats_top_movies()}</h3>
            <TimeframeSelector
                bind:value={moviesTimeframe}
                onchange={handleMoviesTimeframeChange} />
        </div>
        <LoadingState
            loading={movies.loading}
            error={movies.error}
            isEmpty={moviesList.length === 0}
            emptyMessage={m.admin_stats_no_data()}>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {#each moviesList as movie, index (`${getPreferredExternalId(movie.externalIds)?.id || movie.title || 'movie'}-${index}`)}
                    <MediaRankCard
                        rank={index + 1}
                        title={movie.title || m.admin_unknown_title()}
                        year={movie.year ?? null}
                        rating={movie.rating ?? null}
                        externalIds={movie.externalIds ?? null}
                        mediaType="movie"
                        stats={[
                            {
                                label: m.admin_stats_viewers(),
                                value: movie.uniqueViewers || 0,
                                color: 'text-blue-400',
                            },
                            {
                                label: m.admin_stats_watch_time(),
                                value: formatWatchTime(movie.totalPlayTime || 0),
                                color: 'text-green-400',
                            },
                        ]} />
                {/each}
            </div>
            {@render loadMoreButton(
                moviesList.length >= moviesLimit,
                moviesLoadingMore,
                loadMoreMovies,
            )}
        </LoadingState>
    </div>

    <!-- Top TV Shows (locked to AllTime) -->
    <div class="space-y-4">
        <div class="between">
            <h3 class="text-xl font-semibold">{m.admin_stats_top_tv_shows()}</h3>
            <span class="text-sm text-surface-400 bg-surface-700/50 px-2 py-1 rounded">
                {m.admin_timeframe_all_time()}
            </span>
        </div>
        <LoadingState
            loading={tvShows.loading}
            error={tvShows.error}
            isEmpty={tvShowsList.length === 0}
            emptyMessage={m.admin_stats_no_data()}>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {#each tvShowsList as show, index (`${getPreferredExternalId(show.externalIds)?.id || show.title || 'show'}-${index}`)}
                    <MediaRankCard
                        rank={index + 1}
                        title={show.title || m.admin_unknown_title()}
                        year={show.year ?? null}
                        rating={show.rating ?? null}
                        externalIds={show.externalIds ?? null}
                        mediaType="tv"
                        stats={[
                            {
                                label: m.admin_stats_viewers(),
                                value: show.uniqueViewers || 0,
                                color: 'text-blue-400',
                            },
                            {
                                label: m.admin_stats_watch_time(),
                                value: formatWatchTime(show.totalPlayTime || 0),
                                color: 'text-green-400',
                            },
                        ]} />
                {/each}
            </div>
            {@render loadMoreButton(
                tvShowsList.length >= tvShowsLimit,
                tvShowsLoadingMore,
                loadMoreTvShows,
            )}
        </LoadingState>
    </div>

    <!-- Completion Leaderboard (Lowest Completion Rates) — near content sections -->
    <section class="space-y-4" aria-labelledby="completion-leaderboard-heading">
        <div class="between">
            <h3 id="completion-leaderboard-heading" class="text-xl font-semibold">
                {m.admin_stats_completion_leaderboard_title()}
            </h3>
            <span class="text-sm text-surface-400 bg-surface-700/50 px-2 py-1 rounded">
                {m.admin_timeframe_all_time()}
            </span>
        </div>
        <LoadingState
            loading={completionLeaderboard.loading}
            error={completionLeaderboard.error}
            isEmpty={completionList.length === 0}
            emptyMessage={m.admin_stats_completion_no_data()}>
            <ul
                class="grid grid-cols-1 lg:grid-cols-2 gap-4"
                aria-label={m.admin_stats_completion_leaderboard_title()}>
                {#each completionList as item, index (`completion-${item.internalId ?? item.title}-${index}`)}
                    <li>
                        <div
                            class="bg-surface-700/50 rounded-lg p-3 border border-surface-600/50 hover:border-surface-500 transition-all">
                            <div class="between gap-4">
                                <!-- Left: poster + title -->
                                <div class="flex items-center gap-3 flex-1 min-w-0">
                                    <div
                                        class="w-8 h-8 center rounded-full bg-gradient-to-br from-orange-500 to-orange-600 text-white font-bold text-sm shrink-0 shadow-lg"
                                        aria-label={m.admin_stats_rank_label({ rank: index + 1 })}>
                                        <span aria-hidden="true">#{index + 1}</span>
                                    </div>

                                    {#if item.posterUrl && item.internalId}
                                        <div
                                            class="w-12 h-18 bg-surface-600 rounded-md overflow-hidden shrink-0">
                                            <img
                                                src={item.posterUrl}
                                                alt="{item.title} poster"
                                                class="w-full h-full object-cover"
                                                loading="lazy"
                                                onerror={(e) => {
                                                    const t = e.currentTarget as HTMLElement;
                                                    if (t) t.style.display = 'none';
                                                }} />
                                        </div>
                                    {/if}

                                    <div class="min-w-0 flex-1">
                                        <h4 class="font-medium text-white truncate">
                                            {item.title || m.admin_unknown_title()}
                                        </h4>
                                        <div class="flex items-center gap-2 mt-0.5">
                                            {#if item.year}
                                                <span class="text-hint">{item.year}</span>
                                            {/if}
                                            <span class="text-xs text-surface-400 uppercase">
                                                {item.mediaType}
                                            </span>
                                        </div>
                                        <!-- Completion bar -->
                                        <div class="mt-1.5">
                                            <div
                                                class="h-1.5 bg-surface-600 rounded-full overflow-hidden"
                                                role="progressbar"
                                                aria-valuenow={Math.round(item.avgCompletion)}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-label="{m.admin_stats_completion_avg()}: {Math.round(
                                                    item.avgCompletion,
                                                )}%">
                                                <div
                                                    class="h-full bg-orange-500 rounded-full"
                                                    style="width: {item.avgCompletion}%">
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- Right: stats -->
                                <div class="flex flex-col items-end gap-1 shrink-0 text-right">
                                    <div class="text-center">
                                        <div class="text-hint text-xs">
                                            {m.admin_stats_completion_avg()}
                                        </div>
                                        <div class="text-sm font-bold text-orange-400">
                                            {Math.round(item.avgCompletion)}%
                                        </div>
                                    </div>
                                    <div class="text-center">
                                        <div class="text-hint text-xs">
                                            {m.admin_stats_completion_abandon_rate()}
                                        </div>
                                        <div class="text-sm font-bold text-red-400">
                                            {Math.round(item.abandonRate)}%
                                        </div>
                                    </div>
                                    <div class="text-hint text-xs">
                                        {m.admin_stats_completion_sessions()}: {item.sessions}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
            {@render loadMoreButton(
                completionList.length >= completionLimit,
                completionLoadingMore,
                loadMoreCompletion,
            )}
        </LoadingState>
    </section>

    <!-- Activity Chart (follows Movies timeframe) -->
    <div class="space-y-4">
        <div class="between">
            <h3 class="text-xl font-semibold">{m.admin_stats_watch_activity()}</h3>
            <span class="text-sm text-surface-400 bg-surface-700/50 px-2 py-1 rounded">
                {m.admin_stats_activity_follows_timeframe({
                    timeframe:
                        moviesTimeframe === 'AllTime'
                            ? m.admin_timeframe_all_time()
                            : moviesTimeframe === 'LastMonth'
                              ? m.admin_timeframe_last_month()
                              : m.admin_timeframe_last_week(),
                })}
            </span>
        </div>
        <LoadingState
            loading={activity.loading}
            error={activity.error}
            isEmpty={!activity.data?.stats}
            emptyMessage={m.admin_stats_no_activity_data()}>
            <div class="card-base p-6">
                {#if activity.data?.stats}
                    <CustomActivityChart data={activity.data.stats} timeframe={moviesTimeframe} />
                {/if}
            </div>
        </LoadingState>
    </div>

    <!--
        Access Surfaces — which protocol clients actually spoke.
        Sits ABOVE Device & Client Mix because it is the coarser cut: this says
        HOW playback reached us, that one says what it was played on. Separate
        card rather than a fifth Device-Mix dimension because it reads
        play_sessions (90-day window) — watch_history never sees Subsonic or
        Jellyfin-mirror stops, so sourcing it there would show those surfaces
        as empty. See getSurfaceMix().
    -->
    <section class="space-y-4" aria-labelledby="surface-mix-heading">
        <div class="between">
            <h3 id="surface-mix-heading" class="text-xl font-semibold">
                {m.admin_stats_surface_mix_title()}
            </h3>
            {#if surfaceMixData}
                <span class="text-xs text-surface-400">
                    {m.admin_stats_surface_mix_window({ days: surfaceMixData.windowDays })}
                </span>
            {/if}
        </div>
        <LoadingState
            loading={surfaceMix.loading}
            error={surfaceMix.error}
            isEmpty={surfaceMixData === null || surfaceMixData.totalSessions === 0}
            emptyMessage={m.admin_stats_surface_mix_no_data()}>
            {#if surfaceMixData && surfaceMixData.totalSessions > 0}
                <div class="bg-surface-700/50 rounded-lg p-4 border border-surface-600/50">
                    <ul class="space-y-2">
                        {#each surfaceMixData.segments as seg (seg.surface)}
                            <li>
                                <div class="between mb-0.5">
                                    <span class="text-sm text-surface-200 truncate mr-2"
                                        >{surfaceLabel(seg.surface)}</span>
                                    <span class="text-xs text-surface-400 shrink-0">
                                        {m.admin_stats_surface_mix_sessions_count({
                                            count: seg.sessions,
                                        })}
                                        ({seg.percentage.toFixed(1)}%)
                                    </span>
                                </div>
                                <div
                                    class="h-1.5 bg-surface-600 rounded-full overflow-hidden"
                                    role="progressbar"
                                    aria-valuenow={Math.round(seg.percentage)}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-label="{surfaceLabel(
                                        seg.surface,
                                    )}: {seg.percentage.toFixed(1)}%">
                                    <div
                                        class="h-full bg-blue-500 rounded-full"
                                        style="width: {seg.percentage}%">
                                    </div>
                                </div>
                            </li>
                        {/each}
                    </ul>
                    <!--
                        Coverage and blind spots are not decoration. `surface` is
                        forward-only, so for the first 90 days most rows are
                        genuinely unattributed — without this the card reads as a
                        claim about all traffic, which it is not.
                    -->
                    <p class="text-hint text-xs mt-3">
                        {m.admin_stats_surface_mix_coverage({
                            attributed: surfaceMixData.attributedSessions,
                            total: surfaceMixData.totalSessions,
                        })}
                        {#if surfaceMixData.liveTvSessions > 0}
                            · {m.admin_stats_surface_mix_livetv({
                                count: surfaceMixData.liveTvSessions,
                            })}
                        {/if}
                    </p>
                    <p class="text-hint text-xs mt-1">
                        {m.admin_stats_surface_mix_blind_spots()}
                    </p>
                </div>
            {/if}
        </LoadingState>
    </section>

    <!-- Device & Client Mix — near activity -->
    <section class="space-y-4" aria-labelledby="device-mix-heading">
        <div class="between">
            <h3 id="device-mix-heading" class="text-xl font-semibold">
                {m.admin_stats_device_mix_title()}
            </h3>
            <div class="flex items-center gap-2">
                <!-- Sessions ⇄ Hours weight toggle (client-side; both metrics in one response) -->
                <div
                    class="inline-flex rounded-lg bg-surface-700/50 p-0.5"
                    role="group"
                    aria-label={m.admin_stats_device_mix_weight_label()}>
                    <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors {deviceMixWeight ===
                        'hours'
                            ? 'bg-blue-600 text-white'
                            : 'text-surface-300 hover:text-white'}"
                        aria-pressed={deviceMixWeight === 'hours'}
                        onclick={() => (deviceMixWeight = 'hours')}>
                        {m.admin_stats_device_mix_weight_hours()}
                    </button>
                    <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors {deviceMixWeight ===
                        'sessions'
                            ? 'bg-blue-600 text-white'
                            : 'text-surface-300 hover:text-white'}"
                        aria-pressed={deviceMixWeight === 'sessions'}
                        onclick={() => (deviceMixWeight = 'sessions')}>
                        {m.admin_stats_device_mix_weight_sessions()}
                    </button>
                </div>
                <span class="text-sm text-surface-400 bg-surface-700/50 px-2 py-1 rounded">
                    {m.admin_timeframe_all_time()}
                </span>
            </div>
        </div>
        <LoadingState
            loading={deviceMix.loading}
            error={deviceMix.error}
            isEmpty={deviceMixData === null}
            emptyMessage={m.admin_stats_device_mix_no_data()}>
            {#if deviceMixData}
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {#each [{ label: m.admin_stats_device_mix_clients(), segments: deviceMixData.byClient }, { label: m.admin_stats_device_mix_devices(), segments: deviceMixData.byDevice }, { label: m.admin_stats_device_mix_resolutions(), segments: deviceMixData.byResolution }, { label: m.admin_stats_device_mix_codecs(), segments: deviceMixData.byCodec }] as group (group.label)}
                        {@const segs = weightSegments(group.segments, deviceMixWeight)}
                        <div class="bg-surface-700/50 rounded-lg p-4 border border-surface-600/50">
                            <h4 class="font-semibold text-white mb-3">{group.label}</h4>
                            {#if segs.length === 0}
                                <p class="text-hint text-sm">
                                    {m.admin_stats_device_mix_no_data()}
                                </p>
                            {:else}
                                <ul class="space-y-2">
                                    {#each segs as seg, segIdx (seg.label + '-' + segIdx)}
                                        <li>
                                            <div class="between mb-0.5">
                                                <span class="text-sm text-surface-200 truncate mr-2"
                                                    >{seg.label}</span>
                                                <span class="text-xs text-surface-400 shrink-0">
                                                    {#if deviceMixWeight === 'hours'}
                                                        {formatWatchTime(seg.watchSeconds / 60)}
                                                    {:else}
                                                        {m.admin_stats_device_mix_sessions_count({
                                                            count: seg.sessions,
                                                        })}
                                                    {/if}
                                                    ({seg.percentage.toFixed(1)}%)
                                                </span>
                                            </div>
                                            <div
                                                class="h-1.5 bg-surface-600 rounded-full overflow-hidden"
                                                role="progressbar"
                                                aria-valuenow={Math.round(seg.percentage)}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-label="{seg.label}: {seg.percentage.toFixed(
                                                    1,
                                                )}%">
                                                <div
                                                    class="h-full bg-blue-500 rounded-full"
                                                    style="width: {seg.percentage}%">
                                                </div>
                                            </div>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        </LoadingState>
    </section>

    <!-- Top Users -->
    <div class="space-y-4">
        <div class="between">
            <h3 class="text-xl font-semibold">{m.admin_stats_top_users()}</h3>
            <TimeframeSelector
                bind:value={topUsersTimeframe}
                onchange={handleTopUsersTimeframeChange} />
        </div>
        <LoadingState
            loading={topUsers.loading}
            error={topUsers.error}
            isEmpty={topUsersList.length === 0}
            emptyMessage={m.admin_stats_no_user_data()}>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {#each topUsersList as user, index (`${user.id || 'user'}-${index}`)}
                    <UserRankCard rank={index + 1} {user} />
                {/each}
            </div>
            {@render loadMoreButton(
                topUsersList.length >= topUsersLimit,
                topUsersLoadingMore,
                loadMoreTopUsers,
            )}
        </LoadingState>
    </div>

    <!-- Active Users (recently active, last 30 days) -->
    <div class="space-y-4">
        <div class="between">
            <h3 class="text-xl font-semibold">{m.admin_stats_active_users()}</h3>
            <span class="text-sm text-surface-400 bg-surface-700/50 px-2 py-1 rounded">
                {m.admin_stats_last_30_days()}
            </span>
        </div>
        <LoadingState
            loading={activeUsers.loading}
            error={activeUsers.error}
            isEmpty={activeUsersList.length === 0}
            emptyMessage={m.admin_stats_no_user_data()}>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {#each activeUsersList as user, index (`active-${user.id || 'user'}-${index}`)}
                    <UserRankCard rank={index + 1} {user} />
                {/each}
            </div>
            {@render loadMoreButton(
                activeUsersList.length >= activeUsersLimit,
                activeUsersLoadingMore,
                loadMoreActiveUsers,
            )}
        </LoadingState>
    </div>

    <!-- Dormant Users — near Top/Active Users -->
    <section class="space-y-4" aria-labelledby="dormant-users-heading">
        <div class="between">
            <h3 id="dormant-users-heading" class="text-xl font-semibold">
                {m.admin_stats_dormant_users_title()}
            </h3>
            <span class="text-sm text-surface-400 bg-surface-700/50 px-2 py-1 rounded">
                {m.admin_stats_dormant_threshold_note()}
            </span>
        </div>
        <LoadingState
            loading={dormantUsers.loading}
            error={dormantUsers.error}
            isEmpty={dormantUsersList.length === 0}
            emptyMessage={m.admin_stats_dormant_no_data()}>
            <ul
                class="grid grid-cols-1 lg:grid-cols-2 gap-4"
                aria-label={m.admin_stats_dormant_users_title()}>
                {#each dormantUsersList as user, index (`dormant-${user.id}-${index}`)}
                    <li>
                        <div
                            class="bg-surface-700/50 rounded-lg p-3 border border-surface-600/50 hover:border-surface-500 transition-all">
                            <div class="between gap-4">
                                <!-- Left: rank + avatar + name -->
                                <div class="flex items-center gap-3 flex-1 min-w-0">
                                    <div
                                        class="w-8 h-8 center rounded-full bg-gradient-to-br from-surface-500 to-surface-600 text-white font-bold text-sm shrink-0 shadow-lg"
                                        aria-label={m.admin_stats_rank_label({ rank: index + 1 })}>
                                        <span aria-hidden="true">#{index + 1}</span>
                                    </div>

                                    <StatsUserAvatar name={user.name} images={user.images} />

                                    <div class="min-w-0 flex-1">
                                        <h4 class="font-medium text-white truncate">
                                            {user.name || m.admin_unknown_user()}
                                        </h4>
                                        <p class="text-hint">
                                            {m.admin_stats_dormant_last_seen({
                                                days: user.daysSinceActive,
                                            })}
                                        </p>
                                    </div>
                                </div>

                                <!-- Right: lifetime sessions -->
                                <div class="text-center shrink-0">
                                    <div class="text-hint text-xs">
                                        {m.admin_stats_completion_sessions()}
                                    </div>
                                    <div class="text-sm font-bold text-surface-300">
                                        {user.lifetimeSessions}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
            {@render loadMoreButton(
                dormantUsersList.length >= dormantUsersLimit,
                dormantUsersLoadingMore,
                loadMoreDormant,
            )}
        </LoadingState>
    </section>

    <!-- Advanced Statistics -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {#if genreBreakdown}
            {#if genreBreakdown.success}
                <ChartCard
                    title={m.admin_stats_genre_breakdown()}
                    chartType="doughnut"
                    data={genreBreakdown.data}
                    valueType="minutes" />
            {:else}
                <div
                    class="bg-gradient-to-br from-surface-800 via-surface-850 to-surface-900 rounded-xl p-6 border border-surface-700 shadow-2xl">
                    <h3 class="text-lg font-bold text-white mb-4">
                        {m.admin_stats_genre_breakdown()}
                    </h3>
                    <p class="text-error-400 text-sm">
                        {genreBreakdown.error ?? m.admin_stats_error_loading()}
                    </p>
                </div>
            {/if}
        {/if}

        {#if contentFreshness}
            {#if contentFreshness.success}
                <ChartCard
                    title={m.admin_stats_content_freshness()}
                    chartType="doughnut"
                    data={contentFreshness.data}
                    valueType="minutes" />
            {:else}
                <div
                    class="bg-gradient-to-br from-surface-800 via-surface-850 to-surface-900 rounded-xl p-6 border border-surface-700 shadow-2xl">
                    <h3 class="text-lg font-bold text-white mb-4">
                        {m.admin_stats_content_freshness()}
                    </h3>
                    <p class="text-error-400 text-sm">
                        {contentFreshness.error ?? m.admin_stats_error_loading()}
                    </p>
                </div>
            {/if}
        {/if}
    </div>
</div>
