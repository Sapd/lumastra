<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * WatchingStrip - the "Continue Watching" / "New Episodes" lane.
     *
     * Owns:
     * - watchingSections (PageSection[]) hydrated from SSR + the three-state
     *   mount strategy that decides what the client fetches on first paint
     *   ('full' | 'alerts-only' | 'overlay-catchup'); see the comment block
     *   on watchingMountStrategy below.
     * - newEpisodeAlerts and the <NewEpisodeBanner> mount.
     * - The SSE subscriptions (set_changed, session_changed) and
     *   visibility/focus/pageshow lifecycle listeners that drive
     *   in-the-background refresh.
     * - Card-level handlers for the CW row: dismiss (UI-only flag), mark-as-
     *   watched (real watch event), and clear-all (which bubbles up to the
     *   shell so the modal can mount in one place).
     *
     * Does not own: the recommendation feed, mood selector, or the clear
     * modal itself. Those live in the shell / RecommendationFeed.
     */
    import { onMount, untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { env } from '$env/dynamic/public';
    import { page } from '$app/stores';
    import { toasts } from '$lib/stores/toast.store';
    import { SectionRenderer } from '$lib/components/sections';
    import NewEpisodeBanner from '$lib/components/NewEpisodeBanner.svelte';
    import { openSeriesModalFromEpisode } from '$lib/utils/modal-utils';
    import { isEpisode } from '$lib/shared/media-types';
    import * as m from '$lib/paraglide/messages';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { getPlayableId } from '$lib/utils/media-id-helpers';
    import {
        getCwDismissArgs,
        dismissCwItem,
        restoreCwItem,
        getCwDismissDisplayName,
        type CwDismissTargetType,
    } from '$lib/utils/cw-dismiss-helper';
    import * as forYouApi from '$lib/api/for-you';
    import * as contentApi from '$lib/api/content';
    import * as userApi from '$lib/api/user';
    import * as playbackApi from '$lib/api/playback';
    import { watchStateVersion } from '$lib/stores/watch-state-version';
    import { sessionChangedRevision } from '$lib/services/sse/watch-state-sse';
    import {
        handleItemClick,
        handleItemPlay,
        handleItemRequest,
        handleItemMore,
        handleNavigateToWatch,
    } from './item-handlers';
    import { isSeedFresh } from '$lib/utils/ssr-seed';
    import { trendingAvailable, withTrendingCta } from '$lib/stores/trending-availability';

    // "New episodes available" cards: GET /api/for-you/new-episodes → { items, truncated }.
    type NewEpisodeAlert = import('$lib/schemas/api-for-you-responses').NewEpisodeAlert;

    interface Props {
        /** Bubbled whenever the CW row's "has any items" status flips. The
         *  shell uses this to gate visibility of the clear-history trigger. */
        onhasContinueWatchingChange?: (hasContinueWatching: boolean) => void;
        /** Bubbled when SectionRenderer's "Clear all" action fires on the
         *  continue-watching section. The shell owns the modal state. */
        onclearAllRequested?: () => void;
    }

    let { onhasContinueWatchingChange, onclearAllRequested }: Props = $props();

    // Feature flags from layout data — passed through to the shared item
    // handlers since they need the request feature at call time.
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    const requestUrl = env.PUBLIC_REQUESTURL || '';

    // ForYou config — only the watching defaultLimit is consumed here.
    let defaultLimit = $derived($page.data?.forYou?.defaultLimit ?? 10);

    // =========================================================================
    // State
    // =========================================================================

    // Server-Driven UI sections from API. The watching strip is SSR'd by
    // /+page.server.ts so it paints with first byte; the client takes
    // over for SSE-driven patches and manual refresh after hydration. If
    // the SSR primitive failed (returned null), this falls back to the
    // empty array and the onMount fetch repopulates it.
    // Seeded below the freshness gate (`ssrHasWatchingSections`), so a stale
    // cached shell starts empty and repaints from the mount fetch rather than
    // flashing days-old cards.
    let watchingSections: PageSection[] = $state([]);
    /**
     * Mount strategy for the watching strip — three-state instead of a
     * single boolean because the SSR handoff has more than two outcomes:
     *
     * - 'full': no SSR data (or empty). Client fetches both watching
     *   sections and new-episode alerts as in the pre-P4 onMount path.
     * - 'alerts-only': SSR delivered both sections AND `liveOverlayApplied`,
     *   so the strip is correct. Client TRUSTS the seeded strip on first
     *   mount and only fetches the alerts (which the SSR loader skips by
     *   design — different latency profile). Later drift is covered by the
     *   SSE session/set-changed subscriptions and the visibility/focus/
     *   pageshow lifecycle refreshes below — so no reconciling strip fetch
     *   is issued on mount for the healthy case.
     * - 'overlay-catchup': SSR delivered sections but the live overlay
     *   exceeded its 50ms budget. The strip is on stale durable progress.
     *   This is the ONE intentional live catch-up fetch: the client fetches
     *   alerts AND re-fetches the watching strip with refresh=true so the
     *   live position lands without waiting for an unrelated SSE event
     *   (which carries no heartbeat traffic and may never arrive in a
     *   steady-state playback session).
     */
    const ssrWatchingSections = $page.data?.watchingSections as PageSection[] | null | undefined;
    // ...but only when the HTML carrying that seed is actually recent. `/` is
    // cached by the service worker as an app shell with no TTL, so a
    // cache-served reopen replays the strip — progress bars, Next Up, the lot —
    // exactly as it stood when the shell was written, potentially days ago.
    // Note `watchingLiveOverlayApplied` cannot save us here: it is a
    // server-latency signal that replays as `true` from the cache, which
    // disarms 'overlay-catchup' — the one strategy that would have refetched.
    // A stale seed is therefore demoted to 'full': client owns first paint.
    const ssrSeedFresh = isSeedFresh($page.data?.ssrRenderedAt as number | null | undefined);
    const ssrHasWatchingSections =
        ssrSeedFresh && Array.isArray(ssrWatchingSections) && ssrWatchingSections.length > 0;
    const ssrOverlayApplied = $page.data?.watchingLiveOverlayApplied !== false;
    const watchingMountStrategy: 'full' | 'alerts-only' | 'overlay-catchup' =
        !ssrHasWatchingSections ? 'full' : ssrOverlayApplied ? 'alerts-only' : 'overlay-catchup';

    // Adopt the SSR seed only once it has cleared the freshness gate above.
    if (ssrHasWatchingSections && ssrWatchingSections) {
        watchingSections = ssrWatchingSections;
    }

    // New episode alerts for actively watched shows. Dismissals are now
    // persisted server-side via `new_episode_alert_dismissed` flags (P3) —
    // the new-episodes service anti-joins on the user's active flags so
    // the banner doesn't re-appear after a reload or on another device.
    let newEpisodeAlerts: NewEpisodeAlert[] = $state([]);

    // If SSR delivered the strip, the strip itself isn't loading even if
    // an overlay-catchup or alerts fetch is still in flight (those don't
    // affect the visible card list). 'full' means client owns first paint.
    let loadingWatching = $state(watchingMountStrategy === 'full');

    // L5: surface a first-mount load failure. Only meaningful when the
    // client owns first paint (no SSR data) — a transient fetch failure
    // would otherwise leave a silent blank strip with no way to recover.
    // `fetchNewEpisodeAlertsOnly` flips this too so a failed alerts fetch
    // is not swallowed.
    let watchingLoadError = $state(false);

    let hasContinueWatching = false;
    let watchingRefreshInFlight = $state(false);
    let queuedWatchingRefresh = $state(false);
    let queuedWatchingRefreshBustCache = $state(false);
    let forYouDestroyed = false;
    let lastLifecycleWatchRefreshAt = $state(0);
    const WATCHING_LIFECYCLE_REFRESH_COOLDOWN_MS = 1000;

    function notifyHasContinueWatchingChange(): void {
        const next = watchingSections.some(
            (s) => s.id === 'continue-watching' && s.items.length > 0,
        );
        if (next !== hasContinueWatching) {
            hasContinueWatching = next;
            onhasContinueWatchingChange?.(next);
        }
    }

    // M8: the SSE `watch_state_set_changed` event triggers
    // `invalidate('app:watch-state')`, which re-runs the `/+page.server.ts`
    // loader and pushes fresh `watchingSections` into `$page.data`. Other
    // consumers (the page-level hero refresh, the series page loader) depend
    // on that invalidation, so we keep it and instead re-sync the strip from
    // the recomputed SSR data here — dropping the redundant client refetch
    // that previously also fired on every `set_changed`.
    //
    // Guarded: the loader returns `null` for the no-SSR / age-restricted
    // paths, so we only adopt a non-null array. This avoids blanking a
    // client-fetched ('full' strategy) strip when SSR data is absent.
    $effect(() => {
        const fromPage = $page.data?.watchingSections as PageSection[] | null | undefined;
        if (!Array.isArray(fromPage)) return;
        // Re-check freshness against the CURRENT render stamp, not the one
        // captured at init. This effect also runs on first mount, where a
        // cache-replayed shell would otherwise re-adopt the very seed the
        // mount gate above just rejected. A genuine `invalidate` re-runs the
        // loader and yields a new stamp, so real updates still land.
        if (!isSeedFresh($page.data?.ssrRenderedAt as number | null | undefined)) return;
        untrack(() => {
            watchingSections = fromPage;
            // SSR recompute succeeded — clear any prior first-mount error.
            watchingLoadError = false;
            notifyHasContinueWatchingChange();
        });
    });

    // =========================================================================
    // Data Loading
    // =========================================================================

    /**
     * Fetch ONLY the new-episode alerts and populate `newEpisodeAlerts`.
     * Used by the P4 SSR mount strategies ('alerts-only', 'overlay-catchup')
     * because the SSR loader skips alerts by design (different latency
     * profile — Sonarr calendar) and `performWatchingLoad` always couples
     * its alert fetch to a watching-strip fetch which we may not need.
     */
    async function fetchNewEpisodeAlertsOnly(): Promise<void> {
        if (!browser) return;
        try {
            const newEpisodesResult = await forYouApi.getNewEpisodes(5);
            if (forYouDestroyed) return;
            if (!newEpisodesResult.error) {
                // New contract: paginate(NewEpisodeAlert[], page) → { items, page }
                const newEpisodes = newEpisodesResult.data as {
                    items?: NewEpisodeAlert[];
                } | null;
                newEpisodeAlerts = newEpisodes?.items || [];
            } else {
                // L5: don't swallow — surface so an inline retry can appear
                // when there's no SSR data backing the strip.
                watchingLoadError = true;
            }
        } catch (e) {
            console.error('[ForYou] Failed to load new episode alerts:', e);
            watchingLoadError = true;
        }
    }

    async function performWatchingLoad(refresh = false, includeNewEpisodes = true): Promise<void> {
        if (!browser) return;
        loadingWatching = true;
        try {
            let watchingFailed = false;
            if (includeNewEpisodes) {
                // Load watching sections and new episode alerts in parallel.
                // Only user-initiated paths (lifecycle/mount) refresh new-episodes.
                const [watchingResult, newEpisodesResult] = await Promise.all([
                    forYouApi.getWatching(defaultLimit, refresh),
                    forYouApi.getNewEpisodes(5),
                ]);

                if (forYouDestroyed) return;

                if (!watchingResult.error) {
                    const watching = watchingResult.data as {
                        sections?: PageSection[];
                    } | null;
                    const sections = Array.isArray(watching?.sections) ? watching.sections : [];
                    watchingSections = sections;
                    notifyHasContinueWatchingChange();
                } else {
                    watchingFailed = true;
                }

                if (!newEpisodesResult.error) {
                    // New contract: paginate(NewEpisodeAlert[], page) → { items, page }
                    // Server has already filtered against
                    // `new_episode_alert_dismissed` flags (P3).
                    const newEpisodes = newEpisodesResult.data as {
                        items?: NewEpisodeAlert[];
                    } | null;
                    newEpisodeAlerts = newEpisodes?.items || [];
                }
            } else {
                // SSE set_changed path: only refresh the CW/watching strip.
                // New-episodes only refreshes on user-initiated lifecycle events.
                const watchingResult = await forYouApi.getWatching(defaultLimit, refresh);

                if (forYouDestroyed) return;

                if (!watchingResult.error) {
                    const watching = watchingResult.data as {
                        sections?: PageSection[];
                    } | null;
                    const sections = Array.isArray(watching?.sections) ? watching.sections : [];
                    watchingSections = sections;
                    notifyHasContinueWatchingChange();
                } else {
                    watchingFailed = true;
                }
            }
            // L5: track first-mount fetch failure so the template can offer
            // an inline retry when there's no SSR data to fall back on.
            watchingLoadError = watchingFailed;
        } catch (e) {
            console.error('[ForYou] Failed to load watching data:', e);
            watchingLoadError = true;
        } finally {
            loadingWatching = false;
        }
    }

    async function loadWatchingData(refresh = false, includeNewEpisodes = true): Promise<void> {
        if (!browser) return;

        queuedWatchingRefresh = true;
        queuedWatchingRefreshBustCache = queuedWatchingRefreshBustCache || refresh;

        if (watchingRefreshInFlight) return;

        watchingRefreshInFlight = true;
        try {
            while (queuedWatchingRefresh && !forYouDestroyed) {
                const nextRefresh = queuedWatchingRefreshBustCache;
                queuedWatchingRefresh = false;
                queuedWatchingRefreshBustCache = false;
                await performWatchingLoad(nextRefresh, includeNewEpisodes);
            }
        } finally {
            watchingRefreshInFlight = false;
        }
    }

    function requestWatchingLifecycleRefresh(): void {
        if (!browser) return;

        const now = Date.now();
        if (now - lastLifecycleWatchRefreshAt < WATCHING_LIFECYCLE_REFRESH_COOLDOWN_MS) {
            return;
        }
        lastLifecycleWatchRefreshAt = now;
        void loadWatchingData(true);
    }

    /**
     * Public refresh entrypoint for the shell's refresh button + the
     * ClearHistoryModal confirm path. `refresh=true` busts the server cache.
     */
    export function refresh(bustCache = false): void {
        void loadWatchingData(bustCache);
    }

    // =========================================================================
    // Card Handlers (CW-row scoped)
    // =========================================================================

    function handleClickItem(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }): Promise<void> {
        return handleItemClick(data);
    }

    function handlePlayItem(data: { section: PageSection; item: UniversalMediaItem }): void {
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

        // Handle continue watching items: hide via the dismissal API.
        //
        // Older versions of this code called markWatched here — that was
        // the wrong semantic (hide != watched) and produced bogus "I
        // finished this" events in the user_media_events log. The
        // correct primitive is `POST /api/continue-watching/dismissals`,
        // which records a UI-only flag that the CW/NU read queries
        // anti-join against.
        if (section.id !== 'continue-watching') return;
        await handleDismissContinueWatching(item);
    }

    /**
     * Hide a continue-watching card via the dismissals API.
     * Episodes dismiss at the series level (so the whole show stops
     * showing up in CW), movies dismiss at the movie level.
     */
    async function handleDismissContinueWatching(item: UniversalMediaItem): Promise<void> {
        // Target derivation lives in the shared helper so ForYou and
        // browse/+page.svelte can't drift.
        const args = getCwDismissArgs(item);
        if (!args) {
            console.warn('[ForYou] Cannot dismiss — missing target UUID', {
                itemId: item.id,
                isEp: isEpisode(item.mediaType),
            });
            toasts.error(m.toast_hide_failed());
            return;
        }

        // Optimistic UI: remove the card immediately so the interaction
        // feels instant. If the server rejects the write we reinstate
        // the section below.
        const previousSections = watchingSections;
        watchingSections = watchingSections.map((s) =>
            s.id === 'continue-watching'
                ? { ...s, items: s.items.filter((i) => i.id !== item.id) }
                : s,
        );
        notifyHasContinueWatchingChange();

        const ok = await dismissCwItem(args);
        if (!ok) {
            console.error('[ForYou] Dismissal failed');
            watchingSections = previousSections;
            notifyHasContinueWatchingChange();
            toasts.error(m.toast_hide_failed());
            return;
        }

        // Present an undoable toast. The undo handler DELETEs the
        // same flag — server is the source of truth, the local
        // state just gets a refresh so the card reappears.
        toasts.success(
            m.card_hidden_until_watched_toast({ title: getCwDismissDisplayName(item) }),
            {
                timeout: 5000,
                action: {
                    label: m.card_hidden_undo(),
                    onClick: () => {
                        void undoDismiss(args.targetId, args.targetType);
                    },
                },
            },
        );
    }

    /**
     * Undo a dismissal — DELETEs the flag server-side and refreshes the
     * watching sections so the card comes back. Fire-and-forget from
     * the toast action; any error is surfaced via a toast.
     */
    async function undoDismiss(targetId: string, targetType: CwDismissTargetType): Promise<void> {
        const ok = await restoreCwItem({ targetId, targetType });
        if (!ok) {
            console.error('[ForYou] Undo dismiss failed');
            toasts.error(m.toast_restore_failed());
            return;
        }

        // Refresh the CW row so the un-hidden item reappears with the
        // correct ordering rather than relying on local cache surgery.
        try {
            await loadWatchingData(true);
        } catch {
            // Non-fatal — user can reload if the refresh failed.
        }
    }

    /**
     * Mark-as-watched action from the card menu. Unlike the dismiss
     * path above, this records a real "I watched this" event so the
     * state propagates to stats and recommendation signals.
     */
    async function handleItemMarkWatched(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }): Promise<void> {
        const { item } = data;
        const playableId = getPlayableId(item);
        if (!playableId) {
            console.warn('[ForYou] Cannot mark as watched — no playable id', {
                itemId: item.id,
            });
            return;
        }

        try {
            const { error: watchErr } = await userApi.markWatched(playableId, {
                externalIds: item.externalIds,
                mediaType: isEpisode(item.mediaType) ? 'series' : item.mediaType,
                title: item.title,
            });
            if (watchErr) throw new Error(watchErr);

            // Optimistically drop the card from the CW row so the
            // action feels immediate. The next /watching refresh will
            // reconcile against the server.
            watchingSections = watchingSections.map((s) =>
                s.id === 'continue-watching'
                    ? { ...s, items: s.items.filter((i) => i.id !== item.id) }
                    : s,
            );
            notifyHasContinueWatchingChange();
        } catch (err) {
            console.error('[ForYou] markWatched failed', err);
            toasts.error(m.toast_mark_watched_failed());
        }
    }

    function handleClearAll(data: { section: PageSection }): void {
        const { section } = data;
        if (section.id !== 'continue-watching') return;
        // Bubble up — the shell owns the ClearHistoryModal mount.
        onclearAllRequested?.();
    }

    // =========================================================================
    // New Episode Banner Handlers
    // =========================================================================

    function handleBannerDismiss(detail: { seriesName: string; seriesInternalId?: string }): void {
        const { seriesName, seriesInternalId } = detail;
        // Optimistic UI: drop the banner immediately, then persist.
        //
        // L3: filter by the series UUID (`externalIds.internal`) rather than
        // `seriesName`. `seriesName` is not unique — two distinct series with
        // the same display name (reboots, regional variants) would both be
        // removed. Persistence already scopes by UUID, so the optimistic
        // removal must too. Fall back to name-match only when no UUID is
        // resolvable (the same banners that can't persist).
        // New contract: seriesId is the canonical internal UUID field.
        // Fall back to ids['internal'] when seriesId is absent.
        newEpisodeAlerts = newEpisodeAlerts.filter((a) =>
            seriesInternalId
                ? a.context?.series?.catalogId !== seriesInternalId
                : a.context?.series?.title !== seriesName,
        );

        // P3: persist via POST /api/for-you/dismiss with
        // flagType='new_episode_alert_dismissed' so the dismissal survives
        // reloads and propagates across devices. Series UUID is required
        // (the flag's target_id FKs to media_items.id); banners without a
        // resolved internal id can't persist — they'll re-appear on
        // reload, which is the same as pre-P3 behavior.
        if (!seriesInternalId) {
            toasts.info(m.toast_banner_hidden_session_only());
            return;
        }
        void forYouApi
            .dismissForYouItem({
                targetId: seriesInternalId,
                targetType: 'series',
                flagType: 'new_episode_alert_dismissed',
            })
            .catch((e) => {
                console.error('[ForYou] Failed to persist new-episode banner dismissal:', e);
            });
    }

    function handleBannerOpenSeries(detail: {
        seriesName: string;
        seriesInternalId?: string;
        ids: Record<string, string>;
    }): void {
        const { seriesName, seriesInternalId, ids } = detail;
        // Open the series modal using our utility — pass ids{} as externalIds.
        // The alert's ids are the SERIES' ids; name the series UUID explicitly
        // so the opener does not treat ids.internal as an episode's.
        openSeriesModalFromEpisode({
            seriesName,
            seriesInternalId,
            externalIds: ids as import('$lib/types/api-common').ExternalIds,
        });
    }

    async function handleBannerWatch(detail: {
        seriesName: string;
        seasonNumber: number;
        episodeNumber: number;
        ids: Record<string, string>;
    }): Promise<void> {
        const { seriesName, seasonNumber, episodeNumber, ids } = detail;

        // UUID-first: use internal series UUID + season/episode query params
        const internalId = ids['internal'];
        if (internalId) {
            handleNavigateToWatch(`${internalId}?season=${seasonNumber}&episode=${episodeNumber}`);
            return;
        }

        // Fallback: resolve via Jellyfin API (only if no internal UUID available)
        try {
            const { data, error } = await playbackApi.findJellyfinEpisode({
                seriesName,
                season: seasonNumber,
                episode: episodeNumber,
            });

            if (!error && data?.episodeId) {
                handleNavigateToWatch(data.episodeId);
                return;
            }
            console.warn('[ForYou] Episode not found, opening series modal');
            openSeriesModalFromEpisode({ seriesName });
        } catch (error) {
            console.error('[ForYou] Failed to get episode ID:', error);
            openSeriesModalFromEpisode({ seriesName });
        }
    }

    async function handleBannerExclude(detail: {
        seriesName: string;
        seriesInternalId?: string;
    }): Promise<void> {
        const { seriesName, seriesInternalId } = detail;
        // A mute is keyed by the series UUID; without one there is nothing to mute.
        if (!seriesInternalId) return;

        try {
            // The name is only the label.
            const { error: excludeErr } = await contentApi.excludeSeries({
                seriesName,
                mediaId: seriesInternalId,
                mediaType: 'series',
            });

            if (!excludeErr) {
                // L3: remove by series UUID, not the non-unique `seriesName`,
                // so a same-named sibling series isn't over-removed.
                newEpisodeAlerts = newEpisodeAlerts.filter(
                    (a) => a.context?.series?.catalogId !== seriesInternalId,
                );
            }
        } catch (err) {
            console.error('[ForYou] Error excluding series:', err);
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    onMount(() => {
        forYouDestroyed = false;

        // P4 watching-strip mount strategy. The strategy chosen at
        // hydration determines what fires: 'full' = pre-P4 mount path;
        // 'alerts-only' = only fetch the new-episode banner data (SSR
        // delivered the strip with a valid live overlay);
        // 'overlay-catchup' = fetch alerts AND refresh the strip because
        // the SSR overlay timed out and SSE alone won't update the live
        // position without a state event.
        switch (watchingMountStrategy) {
            case 'full':
                void loadWatchingData(false);
                break;
            case 'alerts-only':
                // Trust the SSR-seeded strip on first mount — its live overlay
                // is valid, so only the alerts (which SSR skips) are fetched.
                // The former N2 reconciling strip fetch is dropped: drift
                // between the SSR snapshot and hydration (e.g. playback
                // continuing on another tab/device) is already caught by the
                // SSE session/set-changed subscriptions and the visibility/
                // focus/pageshow lifecycle refreshes wired below — so re-
                // fetching the strip on every mount was redundant work.
                void fetchNewEpisodeAlertsOnly();
                break;
            case 'overlay-catchup':
                void fetchNewEpisodeAlertsOnly();
                void loadWatchingData(true, false);
                break;
        }

        // Initialise hasContinueWatching from any SSR-delivered sections.
        notifyHasContinueWatchingChange();

        // Local marks and debounced SSE watch changes bump this store. When no
        // fresh, nonempty
        // SSR seed owns the strip, loader invalidation cannot refresh its
        // client-owned data. Use the same ownership gate as the mount path.
        let localWatchStateBaseline: number | undefined;
        const unsubscribeLocalWatchState = watchStateVersion.subscribe((revision) => {
            if (localWatchStateBaseline === undefined) {
                localWatchStateBaseline = revision;
                return;
            }
            localWatchStateBaseline = revision;
            const sections = $page.data?.watchingSections as PageSection[] | null | undefined;
            const ownsFreshSeed =
                isSeedFresh($page.data?.ssrRenderedAt as number | null | undefined) &&
                Array.isArray(sections) &&
                sections.length > 0;
            if (!ownsFreshSeed) void loadWatchingData(true, false);
        });

        // Also refetch CW on session lifecycle transitions (start, pause/resume,
        // stop, crash) so a new session in another tab/device shows up
        // immediately instead of waiting for focus/visibility. Both Lumastra and
        // external (Jellyfin/ABS/LiveTV/music) transitions land here — coalesced
        // server-side at 1 emit/sec/user.
        let sessionChangedBaseline = -1;
        const unsubscribeSessionChanged = sessionChangedRevision.subscribe((rev) => {
            if (sessionChangedBaseline === -1) {
                sessionChangedBaseline = rev;
                return;
            }
            void loadWatchingData(true, false);
        });

        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                requestWatchingLifecycleRefresh();
            }
        };
        const onFocus = () => requestWatchingLifecycleRefresh();
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) requestWatchingLifecycleRefresh();
        };

        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);
        window.addEventListener('pageshow', onPageShow);

        return () => {
            forYouDestroyed = true;
            unsubscribeLocalWatchState();
            unsubscribeSessionChanged();
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('pageshow', onPageShow);
        };
    });
</script>

<!-- New Episode Banner - shown at the top when new episodes are available -->
{#if newEpisodeAlerts.length > 0}
    <NewEpisodeBanner
        alerts={newEpisodeAlerts}
        ondismiss={handleBannerDismiss}
        onexclude={handleBannerExclude}
        onopenSeries={handleBannerOpenSeries}
        onwatch={handleBannerWatch} />
{/if}

<!-- Watching Sections Skeleton - shown while watching data loads -->
{#if loadingWatching && watchingSections.length === 0}
    <div class="space-y-2 animate-pulse">
        <!-- Section header skeleton -->
        <div class="h-5 bg-surface-700 rounded w-40"></div>
        <!-- Cards skeleton row — backdrop variant (16:9, w-44) to match the
             actual continue-watching/next-up card dimensions rendered by
             StandardSection when section.type is 'continue-watching'. -->
        <div class="flex gap-3 overflow-hidden">
            {#each Array(8) as _, i (i)}
                <div class="shrink-0 w-44">
                    <div class="aspect-video bg-surface-700 rounded-lg"></div>
                </div>
            {/each}
        </div>
    </div>
{/if}

<!-- L5: inline error + retry. Only shown when the client owned first paint
     (no SSR sections to fall back on) and the mount fetch failed — otherwise
     a transient network blip leaves a silent blank strip with no recovery. -->
{#if watchingLoadError && !loadingWatching && watchingSections.length === 0}
    <div
        class="flex items-center justify-between gap-3 rounded-lg border border-surface-600 bg-surface-800/60 px-4 py-3">
        <span class="text-muted text-sm">{m.error_failed_to_load()}</span>
        <button
            type="button"
            class="btn btn-sm variant-soft"
            onclick={() => {
                watchingLoadError = false;
                void loadWatchingData(true);
            }}>
            {m.common_retry()}
        </button>
    </div>
{/if}

<!-- Watching sections (continue-watching, etc.) — typically above the fold
     on first load, so the first ~6 cards in the first section get priority
     loading. -->
{#each withTrendingCta(watchingSections, $trendingAvailable) as section, sectionIdx (section.id)}
    <SectionRenderer
        {section}
        {hasRequestPermission}
        priorityCount={sectionIdx === 0 ? 6 : 0}
        onitemClick={handleClickItem}
        onitemPlay={handlePlayItem}
        onitemRequest={handleRequestItem}
        onitemMore={handleMoreItem}
        onitemRemove={handleItemRemove}
        onitemMarkWatched={handleItemMarkWatched}
        onclearAll={handleClearAll} />
{/each}
