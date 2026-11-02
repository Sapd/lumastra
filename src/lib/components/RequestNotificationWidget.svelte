<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * RequestNotificationWidget - Shows request status notifications
     *
     * Displays in bottom-right corner:
     * - Pending requests (waiting for the admin)
     * - Requests in progress (with progress bar)
     * - Available content (with play button)
     */
    import { Z } from '$lib/utils/z-index';
    import { onMount, onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { fly } from 'svelte/transition';
    import { saveReturnPath } from '$lib/stores/playerNavigation';
    import {
        Icon,
        XMark,
        Check,
        Clock,
        Play,
        InboxStack,
        ExclamationTriangle,
        ArrowPath,
        Eye,
    } from 'svelte-hero-icons';
    import {
        visibleNotifications,
        requestNotifications,
        startPolling,
        stopPolling,
        installNotificationListeners,
        type RequestNotification,
        type RequestStatus,
    } from '$lib/stores/request-notifications';
    import { isSeries } from '$lib/shared/media-types';
    import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
    import {
        getStatusLabel,
        isAvailableStatus,
        isDownloadingStatus,
    } from '$lib/shared/request-status';
    import { page } from '$app/stores';
    import { openMediaModalFromUrl } from '$lib/utils/modal-utils';
    import { buildMediaKey, hasValidExternalId } from '$lib/utils/media-id-helpers';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { hasAnyExternalId } from '$lib/utils/external-ids';
    import * as m from '$lib/paraglide/messages';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { toasts } from '$lib/stores/toast.store';

    let minimized = $state(false);
    let isMobileView = $state(false);

    // Skip polling on /music (heavy page — don't compete for bandwidth).
    // On mobile, only poll when expanded (user actively watching progress);
    // when collapsed we stick with the initial sync.
    let onMusicPage = $derived(($page.url.pathname ?? '').startsWith('/music'));

    // Feature flag check
    let requestModalEnabled = $derived($page.data?.features?.requests === true);

    // Get current username - check devUser override in dev mode, otherwise use page data
    function getEffectiveUsername(): string | undefined {
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
            const devUser = localStorage.getItem('devUser');
            if (devUser) return devUser;
        }
        return $page.data?.user?.username as string | undefined;
    }

    // Re-check on mount since localStorage isn't available during SSR
    let effectiveUsername = $derived(getEffectiveUsername());

    function dismiss(notification: RequestNotification) {
        requestNotifications.dismiss(notification.externalIds, notification.mediaType);
    }

    function dismissAll() {
        // Snapshot the visible set; the store handles the optimistic
        // removal, parallel POSTs, and a single error toast on partial
        // failure (rather than one toast per failed dismiss).
        void requestNotifications.dismissAll($visibleNotifications.slice());
    }

    async function handlePlay(notification: RequestNotification) {
        const playableId = notification.externalIds?.internal;
        if (playableId) {
            saveReturnPath();
            // toTmdbType maps canonical 'series' → 'tv' for composite-key correctness.
            // `notification.mediaType` is `NotificationMediaType` = 'movie' |
            // 'series' (requests exist for nothing else), so the narrowing cannot
            // fail; the fallback keeps it checked rather than asserted.
            const key =
                buildMediaKey(
                    notification.externalIds,
                    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- request notifications are movie/series only.
                    toTmdbType(notification.mediaType) ?? 'movie',
                ) ?? playableId;
            goto(resolve(`/watch/${key}`));
            // Remove notification after starting playback
            requestNotifications.remove(notification.externalIds, notification.mediaType);
        } else if (hasValidExternalId(notification.externalIds)) {
            // Nothing to navigate to, so show the detail modal instead — via the
            // SHARED hydrated opener, the same one the `?modal=` deep link and
            // the admin panels use.
            //
            // This used to hand-roll the open: fetch /media/{key} WITHOUT
            // `include=details` and forward four fields (title, overview,
            // mediaType, isAvailable) on top of the notification's own external
            // ids. Everything that makes the modal a detail view was dropped —
            // most visibly the response's merged `ids` map, so the modal never
            // saw an internal/jellyfin id, ModalMovie's seriesPickerData stayed
            // null, and a series rendered with no episode list and no Watch
            // button; genres, year, cast, ratings and canRequest went the same
            // way. openMediaModalFromUrl requests the detail block, merges the
            // ids, resolves an episode/season to its parent series, and shows
            // the modal-loading indicator while it does.
            try {
                const opened = await openMediaModalFromUrl(
                    notification.externalIds,
                    // NotificationMediaType is 'movie' | 'series'; 'tv' is the
                    // storage token buildMediaKey() matches against
                    // external_ids.media_type ('tv', never 'series').
                    isSeries(notification.mediaType) ? 'tv' : 'movie',
                );
                // It swallows its own failures and reports them as `false`
                // (unbuildable key, API error). Without this the button would
                // just do nothing at all — the loading indicator flashes and no
                // modal appears, which reads as a dead control.
                if (!opened) toasts.error(m.toast_media_details_unavailable());
            } catch (error) {
                console.error('Failed to open media modal:', error);
                toasts.error(m.toast_media_details_unavailable());
            }
        }
    }

    function getStatusIcon(status: RequestStatus) {
        switch (status) {
            case 'available':
                return Check;
            case 'downloading':
                return ArrowPath;
            case 'queued':
                return Clock;
            case 'paused':
                return Clock;
            case 'importing':
                return ArrowPath;
            case 'synching':
                return ArrowPath;
            case 'searching':
                return Clock;
            case 'monitored':
                return Eye;
            case 'unavailable':
                return ExclamationTriangle;
            default:
                return Clock;
        }
    }

    function getStatusColor(status: RequestStatus) {
        switch (status) {
            case 'available':
                return 'text-green-400';
            case 'downloading':
                return 'text-blue-400';
            case 'queued':
                return 'text-cyan-400';
            case 'paused':
                return 'text-amber-400';
            case 'importing':
                return 'text-purple-400';
            case 'synching':
                return 'text-indigo-400';
            case 'searching':
                return 'text-orange-400';
            case 'monitored':
                return 'text-indigo-400';
            case 'unavailable':
                return 'text-red-400';
            default:
                return 'text-yellow-400';
        }
    }

    function getStatusText(status: RequestStatus, statusMessage?: string) {
        if (statusMessage) return statusMessage;
        // Fall back to the canonical shared status→label table so the widget
        // and the server resolver (getStatusMessage) agree.
        return getStatusLabel(status);
    }

    // M9: surface the Play affordance whenever there's something watchable,
    // not only when the aggregate headline is "available". A 9/10-available
    // show keeps a "downloading" headline (worst-case aggregation) but still
    // has playable seasons — the user must be able to start watching those.
    function hasPlayableContent(notification: RequestNotification): boolean {
        if (isAvailableStatus(notification.status)) return true;
        return (notification.seasonStatuses ?? []).some((s) => isAvailableStatus(s.status));
    }

    let resizeListener: (() => void) | null = null;
    // Teardown for the store-owned window listeners (focus/visibility/online/
    // storage). Installed once on mount; the scheduler + interpretation live
    // in the store (A2).
    let teardownListeners: (() => void) | null = null;
    let cancelInitialSync: (() => void) | null = null;

    onMount(async () => {
        isMobileView = browser && window.innerWidth < 768;
        // On mobile, collapse by default so we don't start polling automatically.
        // Expanding (user tap) flips `minimized` → the effect below starts polling.
        if (isMobileView) minimized = true;

        if (browser) {
            resizeListener = () => {
                isMobileView = window.innerWidth < 768;
            };
            window.addEventListener('resize', resizeListener);
            // Recovery + cross-tab coherence (M5/L3/L4): focus/visibility/online
            // re-sync, storage merge. Self-throttled inside the store.
            teardownListeners = installNotificationListeners();
        }

        // Get username on mount (after localStorage is available)
        effectiveUsername = getEffectiveUsername();

        // Always sync once so existing downloads are discovered even when we
        // won't poll (e.g. user lands directly on /music, or mobile+collapsed).
        // Deferred to idle: this only feeds a badge, and the sync costs a Seerr
        // round-trip that otherwise competes with the page's own first requests.
        if (requestModalEnabled && effectiveUsername) {
            requestNotifications.setUser(effectiveUsername);
            const sync = (): void => void requestNotifications.syncFromServer();
            if (browser && 'requestIdleCallback' in window) {
                const handle = window.requestIdleCallback(sync, { timeout: 3000 });
                cancelInitialSync = () => window.cancelIdleCallback(handle);
            } else {
                await requestNotifications.syncFromServer();
            }
        }
    });

    onDestroy(() => {
        cancelInitialSync?.();
        stopPolling();
        teardownListeners?.();
        if (browser && resizeListener) {
            window.removeEventListener('resize', resizeListener);
        }
    });

    // Reactive: Set user when username changes (prevents cross-user data leakage)
    $effect(() => {
        if (effectiveUsername && requestModalEnabled) {
            requestNotifications.setUser(effectiveUsername);
        }
    });

    // Reactive: unified polling gate
    // - No feature / no user → stop
    // - On /music → stop (don't compete with music page loads)
    // - Mobile + collapsed → stop (one-time sync only; expand to resume)
    // - Otherwise poll while we have notifications
    $effect(() => {
        const shouldPoll =
            requestModalEnabled &&
            !!effectiveUsername &&
            !onMusicPage &&
            !(isMobileView && minimized) &&
            $requestNotifications.notifications.length > 0;

        if (shouldPoll) {
            startPolling();
        } else {
            stopPolling();
        }
    });

    // Reactive: $requestNotifications is used implicitly through visibleNotifications
    let hasNotifications = $derived($visibleNotifications.length > 0);
</script>

{#if requestModalEnabled && hasNotifications}
    <div
        class="fixed bottom-4 right-4 max-w-sm pointer-events-auto"
        style="z-index: {Z.TOAST}"
        in:fly={{ y: 100, duration: 300 }}
        out:fly={{ y: 50, duration: 200 }}>
        <!-- Header (collapsible) -->
        <div
            class="w-full between px-4 py-2 bg-surface-800 rounded-t-lg border border-surface-600 border-b-0 hover:bg-surface-700 transition-colors cursor-pointer"
            role="button"
            tabindex="0"
            onclick={() => (minimized = !minimized)}
            onkeydown={(e) => e.key === 'Enter' && (minimized = !minimized)}>
            <div class="flex items-center gap-2">
                <Icon src={InboxStack} class="w-4 h-4 text-primary-400" />
                <span class="text-sm font-medium text-white">
                    {m.req_requests()} ({$visibleNotifications.length})
                </span>
            </div>
            <div class="flex items-center gap-2">
                {#if !minimized}
                    <button
                        class="text-surface-400 hover:text-white p-1"
                        onclick={stopPropagation(dismissAll)}
                        title={m.req_close_all()}>
                        <Icon src={XMark} class="w-4 h-4" />
                    </button>
                {/if}
                <svg
                    class="w-4 h-4 text-surface-400 transition-transform"
                    class:rotate-180={minimized}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M5 15l7-7 7 7" />
                </svg>
            </div>
        </div>

        <!-- Notifications list -->
        {#if !minimized}
            <div
                class="bg-surface-800 rounded-b-lg border border-surface-600 border-t-0 overflow-hidden max-h-96 overflow-y-auto">
                {#each $visibleNotifications as notification (notification.id)}
                    <div
                        class="flex items-start gap-3 p-3 border-b border-surface-700 last:border-b-0 hover:bg-surface-700/50 transition-colors"
                        in:fly={{ x: 50, duration: 200 }}>
                        <!-- Poster -->
                        <div class="shrink-0 w-12 h-18 rounded overflow-hidden bg-surface-700">
                            {#if notification.posterPath || hasAnyExternalId(notification.externalIds)}
                                {@const posterUrl =
                                    imageFromIds(
                                        notification.externalIds,
                                        'poster',
                                        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- request notifications are movie/series only.
                                        toTmdbType(notification.mediaType) ?? 'movie',
                                        { size: 'thumb' },
                                    ) ||
                                    // Sync-created cards carry Jellyseerr's own
                                    // posterPath; keep it as the fallback for
                                    // ids imageFromIds can build no URL from.
                                    notification.posterPath ||
                                    ''}
                                {#if posterUrl}
                                    <img
                                        src={posterUrl}
                                        alt={notification.title}
                                        class="w-full h-full object-cover" />
                                {/if}
                            {/if}
                        </div>

                        <!-- Content -->
                        <div class="flex-1 min-w-0">
                            <div class="flex items-start justify-between gap-2">
                                <h4 class="text-sm font-medium text-white truncate">
                                    {notification.title}
                                </h4>
                                <button
                                    class="shrink-0 text-surface-400 hover:text-white p-0.5"
                                    onclick={() => dismiss(notification)}
                                    aria-label={m.a11y_dismiss()}>
                                    <Icon src={XMark} class="w-4 h-4" />
                                </button>
                            </div>

                            <!-- Status -->
                            <div class="flex items-center gap-1.5 mt-1">
                                {#if notification.status === 'importing' || notification.status === 'synching' || notification.status === 'searching'}
                                    <span
                                        class="loading-spinner w-3.5 h-3.5 {getStatusColor(
                                            notification.status,
                                        )}"
                                        style="border-color: currentColor; border-top-color: transparent; opacity: 0.6;"
                                    ></span>
                                {:else}
                                    <Icon
                                        src={getStatusIcon(notification.status)}
                                        class="w-3.5 h-3.5 {getStatusColor(notification.status)}" />
                                {/if}
                                <span class="text-xs {getStatusColor(notification.status)}">
                                    {getStatusText(notification.status, notification.statusMessage)}
                                </span>
                            </div>

                            <!-- Season breakdown (for TV shows with per-season tracking) -->
                            {#if notification.seasonStatuses && notification.seasonStatuses.length > 0}
                                {@const availableSeasons = notification.seasonStatuses.filter((s) =>
                                    isAvailableStatus(s.status),
                                ).length}
                                {@const totalSeasons = notification.seasonStatuses.length}
                                {@const downloadingSeasons = notification.seasonStatuses.filter(
                                    (s) => isDownloadingStatus(s.status),
                                ).length}

                                <div class="mt-1.5 text-xs text-surface-400">
                                    {#if availableSeasons === totalSeasons}
                                        All {totalSeasons} season{totalSeasons > 1 ? 's' : ''} available
                                    {:else}
                                        {availableSeasons} of {totalSeasons} season{totalSeasons > 1
                                            ? 's'
                                            : ''} available
                                        {#if downloadingSeasons > 0}
                                            • {m.request_seasons_in_progress({
                                                count: downloadingSeasons,
                                            })}
                                        {/if}
                                    {/if}
                                </div>
                            {/if}

                            <!-- Download progress (for downloading, queued, paused) -->
                            {#if (notification.status === 'downloading' || notification.status === 'queued' || notification.status === 'paused') && notification.download}
                                <div class="mt-2">
                                    <div class="between text-xs text-surface-400 mb-1">
                                        <span>{notification.download.percentage}%</span>
                                        {#if notification.download.size}
                                            <span>{notification.download.size}</span>
                                        {/if}
                                    </div>
                                    <div class="h-1.5 bg-surface-600 rounded-full overflow-hidden">
                                        <div
                                            class="h-full transition-all duration-300"
                                            class:bg-blue-500={notification.status ===
                                                'downloading'}
                                            class:bg-cyan-500={notification.status === 'queued'}
                                            class:bg-amber-500={notification.status === 'paused'}
                                            style="width: {notification.download.percentage}%">
                                        </div>
                                    </div>
                                    {#if notification.download.timeLeft && notification.status === 'downloading'}
                                        <div class="text-xs text-surface-500 mt-1">
                                            {notification.download.timeLeft}
                                            {m.req_remaining()}
                                        </div>
                                    {/if}
                                </div>
                            {/if}

                            <!-- Play button: show when watchable, even if the
                                 aggregate headline is still "downloading" (M9). -->
                            {#if hasPlayableContent(notification)}
                                <button
                                    class="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-primary-500 hover:bg-primary-600 text-white text-xs font-medium rounded transition-colors"
                                    onclick={() => handlePlay(notification)}>
                                    <Icon src={Play} class="w-3.5 h-3.5" />
                                    {m.req_watch_now()}
                                </button>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
{/if}

<style>
    .h-18 {
        height: 4.5rem;
    }
</style>
