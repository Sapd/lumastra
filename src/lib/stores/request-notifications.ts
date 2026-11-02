// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request Notifications Store
 *
 * Tracks user's media requests and shows notifications when:
 * - Request is submitted (transient toast)
 * - Download starts (persistent notification with progress)
 * - Media becomes available (persistent notification, stays until played or dismissed)
 *
 * Provider-agnostic: Uses externalIds and composite keys (provider:id:mediaType)
 * for future extensibility beyond TMDB.
 *
 * ## Per-device and poll-owned, including the terminal `available` card
 *
 * This store used to ALSO render the durable inbox: `hydrateFromInbox()` turned
 * an unread `request.available` row into a card, adopted the row id onto
 * poll-tracked cards, and routed dismissal through `POST /notifications/{id}/read`
 * for those. All of that is gone (2026-08-25).
 *
 * It was a SECOND reconciliation channel for a job the server already does in
 * one place. `request-dismissal-sync.service.ts` runs both directions already:
 * a popup dismiss marks the matching `request.available` row read, and a row
 * read / deleted / read-all writes both `request_dismissed` flag shapes, which
 * this store's `syncFromServer()` eviction filter then acts on. Deleting the
 * client half changes no cross-surface behaviour — it only removes the identity
 * bridging between two id vocabularies (composite `tmdb:550:movie` here, bare
 * UUID there), which is exactly where the `tv`/`series` dismissal-key bug lived.
 *
 * What the popup owns now is what it owned before the inbox existed: the live
 * request lifecycle on THIS device, terminal card included. Cross-device "your
 * thing is ready" is the drawer's job, and push's — durable surfaces, which is
 * the point of them.
 *
 * OWNS the polling lifecycle (A2): poll-response interpretation, the adaptive
 * 10s/30s scheduler (with the document.hidden gate + in-flight guard), and the
 * focus/visibility/online/storage re-sync listeners all live here so they are
 * unit-testable and reusable. The widget renders + emits intents only.
 */
import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type {
    RequestNotification,
    RequestStatus,
    SeasonStatus,
    DownloadProgress,
    NotificationMediaType,
} from '$lib/types/notifications';
import type { ExternalIds } from '$lib/types/api-common';
import {
    PendingRequestsResponseSchema,
    type PendingRequestsResponse,
} from '$lib/schemas/api-content-responses';
import { toPublicMediaType, toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';

// Re-export types for consumers
export type {
    RequestNotification,
    RequestStatus,
    DownloadProgress,
    SeasonStatus,
    NotificationMediaType,
} from '$lib/types/notifications';
import { NotificationPersistenceService } from '$lib/services/notification-persistence.service';
import { toasts } from '$lib/stores/toast.store';
import { requestAvailableExpireHours } from '$lib/stores/client-tuning';
import * as contentApi from '$lib/api/content';
import {
    calculateAggregateStatus,
    calculateAggregateDownloadProgress,
    shouldShowNotificationForKeys,
    hasNotificationExpired,
    isNotableStatus,
    getJellyfinIdFromSeasons,
} from '$lib/utils/notification-logic';
import { requestDismissalKeys } from '$lib/shared/request-dismissal-key';
import { buildMediaKey } from '$lib/utils/media-id-helpers';
import { getPreferredExternalId } from '$lib/utils/external-ids';
import { isDownloadingStatus, sortByStatusBestFirst } from '$lib/shared/request-status';

// PendingRequestItem and PendingRequestsResponse are imported from
// '$lib/schemas/api-content-responses' (schema-validated, canonical types).

interface RequestNotificationsState {
    notifications: RequestNotification[];
    lastPoll: number;
}

/**
 * A single status result from the poll endpoint. Mirrors the server's
 * RequestStatusResult — `watched` is populated per result (including per-season
 * results) so the store can auto-dismiss fully-watched shows (M7).
 */
export interface RequestStatusItem {
    externalIds: ExternalIds;
    mediaType: NotificationMediaType;
    status: RequestStatus;
    statusMessage?: string;
    watched?: boolean;
    seasonNumber?: number;
    download?: DownloadProgress;
    jellyfinLibraryId?: string;
}

const STORAGE_KEY_PREFIX = 'dashboard-request-notifications';
// v8: inbox-hydrated cards removed. A persisted v7 card could carry ONLY an
// internal UUID (its inbox row was its whole identity); with the markRead
// dismiss path gone, `/api/request/dismiss` would reject it as "Cannot identify
// media" and the user could never clear it. Bumping purges them.
const STORAGE_VERSION = 8;
// How long an "available" card stays is REQUEST_AVAILABLE_EXPIRE_HOURS, read
// through client-tuning at call time. The store's first load runs at import,
// before the root layout hydrates the tuning, so poll() prunes again later.

// Throttle sync calls to prevent excessive API requests
const MIN_SYNC_INTERVAL_MS = 60000; // 1 minute cooldown
let lastSyncTime = 0;

// Polling cadence: poll active downloads every 10s, everything else every 30s.
const POLL_TICK_MS = 5000; // scheduler granularity
const POLL_THRESHOLD_DOWNLOADING_MS = 10000;
const POLL_THRESHOLD_IDLE_MS = 30000;
const STATUS_BATCH_SIZE = 20;

// Transient, per-tab in-memory poll guard. Never persisted (see schema note).
let isPolling = false;

// Persistence service instance
const persistenceService = new NotificationPersistenceService();

function getStorageKey(): string {
    const username = persistenceService.getUsername();
    return username ? `${STORAGE_KEY_PREFIX}-${username}` : STORAGE_KEY_PREFIX;
}

interface StoredState extends RequestNotificationsState {
    version?: number;
}

function loadFromStorage(): RequestNotificationsState {
    if (!browser) return { notifications: [], lastPoll: 0 };

    try {
        const stored = localStorage.getItem(getStorageKey());
        if (stored) {
            const state = JSON.parse(stored) as StoredState;

            // Clear data if version changed (sync logic updated)
            if (state.version !== STORAGE_VERSION) {
                localStorage.removeItem(getStorageKey());
                return { notifications: [], lastPoll: 0 };
            }

            // Clean up expired available notifications. Dismiss is terminal
            // (a dismissed notification is hard-removed), so there is no
            // dismissedAt-based purge here anymore (M10).
            state.notifications = (state.notifications ?? []).filter(
                (n) => !hasNotificationExpired(n, requestAvailableExpireHours()),
            );
            // Older season pickers persisted the legacy `tv` discriminator.
            // Re-key and merge these cards so canonical `series` poll results
            // update them, and server restoration cannot create a duplicate.
            const normalized = new Map<string, RequestNotification>();
            for (const notification of state.notifications) {
                notification.mediaType =
                    toPublicMediaType(notification.mediaType) === 'series' ? 'series' : 'movie';
                notification.id = generateNotificationId(
                    notification.externalIds,
                    notification.mediaType,
                );
                const existing = normalized.get(notification.id);
                if (existing) {
                    existing.seasons = [
                        ...new Set([...(existing.seasons ?? []), ...(notification.seasons ?? [])]),
                    ].sort((a, b) => a - b);
                } else {
                    normalized.set(notification.id, notification);
                }
            }
            return { notifications: [...normalized.values()], lastPoll: state.lastPoll ?? 0 };
        }
    } catch {
        /* expected: JSON.parse failure or corrupt localStorage data */
    }
    return { notifications: [], lastPoll: 0 };
}

function saveToStorage(state: RequestNotificationsState) {
    if (!browser) return;
    try {
        const toSave: StoredState = {
            notifications: state.notifications,
            lastPoll: state.lastPoll,
            version: STORAGE_VERSION,
        };
        localStorage.setItem(getStorageKey(), JSON.stringify(toSave));
    } catch {
        /* expected: localStorage may be full or unavailable */
    }
}

/**
 * Generate a notification ID from externalIds and mediaType.
 *
 * This is the CARD's identity — how the list dedupes, how localStorage keys a
 * row, what `dismiss()`/`remove()` match on. It is deliberately NOT the
 * dismissal key any more.
 *
 * It used to be claimed as "IDENTICAL to the dismissal key", and that claim was
 * false for every series: this builds `tmdb:95350:series` (the public
 * vocabulary) while the stored flag is `tmdb:95350:tv` (the storage
 * vocabulary), so `dismissedMap.get(id)` missed every series dismissal and the
 * card returned on the next sync, forever. Dismissal lookups now go through
 * `requestDismissalKeys()`, which spells both storage shapes; this function is
 * free to stay in the public vocabulary because nothing compares it to a
 * stored row.
 */
function generateNotificationId(
    externalIds: ExternalIds,
    mediaType: NotificationMediaType,
): string {
    // toTmdbType maps 'series' → 'tv' so buildMediaKey produces a valid
    // ApiMediaType composite key (used only as the UUID-fallback path below).
    //
    // `?? mediaType` rather than `?? 'movie'`: notifications are only ever
    // raised for requests, and `NotificationMediaType` is already limited to the
    // requestable kinds, so the narrowing does not fail in practice. If it ever
    // does, carrying the row's OWN type keeps the key honest and still
    // resolvable by media-key-parser, whereas relabelling it 'movie' would make
    // two different notifications collide on one id.
    mediaType = toPublicMediaType(mediaType) === 'series' ? 'series' : 'movie';
    const key = buildMediaKey(externalIds, toTmdbType(mediaType) ?? mediaType);

    // buildMediaKey includes UUIDs; re-derive without them so the id aligns
    // with the dismissal key. Prefer the external-provider key when available.
    const preferred = getPreferredExternalId(externalIds, { includeUuids: false });
    if (preferred) {
        return `${preferred.provider}:${preferred.id}:${mediaType}`;
    }

    // No external-provider id — fall back to whatever buildMediaKey produced
    // (a UUID-based key) so the notification still has a stable identity.
    if (key) return key;

    // Should never happen, but provide a fallback.
    return `unknown:${Date.now()}:${mediaType}`;
}

function createRequestNotificationsStore() {
    const initial = loadFromStorage();

    const { subscribe, update, set } = writable<RequestNotificationsState>(initial);

    const store = {
        subscribe,

        /**
         * Add a new request notification (called when user submits a request)
         */
        addRequest(
            externalIds: ExternalIds,
            mediaType: NotificationMediaType,
            title: string,
            posterPath?: string,
            seasons?: number[],
            requestedAt?: string,
        ) {
            const id = generateNotificationId(externalIds, mediaType);

            // Clear in-session dismissal so the new request is visible. Every
            // key shape, because the dismissal that hid it may have been
            // written by another surface under the other one.
            persistenceService.removeSessionDismissedFor(externalIds, mediaType);

            // Use server timestamp if provided; guard against malformed input
            // (L7) — NaN would corrupt sort + dismissal comparisons.
            let timestamp = Date.now();
            if (requestedAt) {
                const parsed = new Date(requestedAt).getTime();
                if (!Number.isNaN(parsed)) timestamp = parsed;
            }

            update((state) => {
                const existing = state.notifications.find((n) => n.id === id);
                if (existing) {
                    existing.status = 'pending';
                    existing.title = title;
                    existing.posterPath = posterPath;
                    existing.createdAt = timestamp;
                    existing.shownAt = Date.now();

                    if (seasons && seasons.length > 0) {
                        const mergedSeasons = new Set([...(existing.seasons || []), ...seasons]);
                        existing.seasons = Array.from(mergedSeasons).sort((a, b) => a - b);
                    } else if (seasons === undefined || seasons.length === 0) {
                        existing.seasons = undefined;
                    }
                } else {
                    state.notifications.push({
                        id,
                        externalIds,
                        mediaType,
                        title,
                        posterPath,
                        status: 'pending',
                        createdAt: timestamp,
                        shownAt: Date.now(),
                        seasons,
                    });
                }
                saveToStorage(state);
                return { ...state };
            });
        },

        /**
         * Update notification status (called during polling)
         */
        updateStatus(
            externalIds: ExternalIds,
            mediaType: NotificationMediaType,
            status: RequestStatus,
            options?: {
                jellyfinLibraryId?: string;
                download?: DownloadProgress;
                statusMessage?: string;
            },
        ) {
            update((state) => {
                const id = generateNotificationId(externalIds, mediaType);
                const notification = state.notifications.find((n) => n.id === id);
                if (notification) {
                    const oldStatus = notification.status;
                    notification.status = status;
                    if (options?.jellyfinLibraryId)
                        notification.jellyfinLibraryId = options.jellyfinLibraryId;
                    notification.download = options?.download;
                    notification.statusMessage = options?.statusMessage;

                    if (oldStatus !== status && isNotableStatus(status)) {
                        notification.shownAt = Date.now();
                    }

                    if (status === 'available' || status === 'importing') {
                        notification.download = undefined;
                    }

                    saveToStorage(state);
                }
                return { ...state };
            });
        },

        /**
         * Update download progress for a notification
         */
        updateDownloadProgress(
            externalIds: ExternalIds,
            mediaType: NotificationMediaType,
            progress: DownloadProgress,
        ) {
            update((state) => {
                const id = generateNotificationId(externalIds, mediaType);
                const notification = state.notifications.find((n) => n.id === id);
                if (notification?.status === 'downloading') {
                    notification.download = progress;
                    // Don't save to storage on every progress update (too frequent)
                }
                return { ...state };
            });
        },

        /**
         * Update per-season status for TV show notifications
         */
        updateSeasonStatuses(
            externalIds: ExternalIds,
            mediaType: NotificationMediaType,
            seasonStatuses: SeasonStatus[],
        ) {
            update((state) => {
                const id = generateNotificationId(externalIds, mediaType);
                const notification = state.notifications.find((n) => n.id === id);

                if (notification) {
                    const oldStatus = notification.status;

                    if (seasonStatuses.length === 0) {
                        notification.status = 'unavailable';
                        notification.seasonStatuses = undefined;
                        notification.download = undefined;
                        saveToStorage(state);
                        return { ...state };
                    }

                    notification.seasonStatuses = seasonStatuses;
                    notification.statusMessage = undefined;

                    const aggregateStatus = calculateAggregateStatus(seasonStatuses);
                    if (aggregateStatus) {
                        notification.status = aggregateStatus;
                    }

                    notification.download = calculateAggregateDownloadProgress(seasonStatuses);

                    const jellyfinLibraryId = getJellyfinIdFromSeasons(seasonStatuses);
                    if (jellyfinLibraryId) {
                        notification.jellyfinLibraryId = jellyfinLibraryId;
                    }

                    if (oldStatus !== notification.status && isNotableStatus(notification.status)) {
                        notification.shownAt = Date.now();
                    }

                    saveToStorage(state);
                }
                return { ...state };
            });
        },

        /**
         * Interpret a batch of poll-response status items (A2).
         *
         * Groups per-season results by show, decides auto-remove (all seasons
         * available AND watched — M7) vs. updateSeasonStatuses, and routes
         * single (movie / full-show) results through auto-remove vs.
         * updateStatus. This is the sole interpreter of poll responses — the
         * widget no longer contains this logic.
         */
        applyStatusResults(items: RequestStatusItem[]) {
            if (!Array.isArray(items) || items.length === 0) return;

            const seasonGrouped: Record<string, RequestStatusItem[]> = {};
            const nonSeasonResults: RequestStatusItem[] = [];

            for (const [idx, item] of items.entries()) {
                if (item.seasonNumber !== undefined) {
                    // Stable fallback key: never Date.now() (two distinct shows
                    // in the same tick would otherwise collide-or-split by
                    // wall-clock). buildMediaKey already prefers the internal
                    // UUID, so when it returns null there is no usable id — fall
                    // back to the index, isolating each result rather than
                    // merging unrelated shows into one group.
                    const key =
                        buildMediaKey(item.externalIds, item.mediaType) ?? `unknown-idx-${idx}`;
                    (seasonGrouped[key] ??= []).push(item);
                } else {
                    nonSeasonResults.push(item);
                }
            }

            // Per-season groups
            for (const seasonResults of Object.values(seasonGrouped)) {
                const first = seasonResults[0];

                const allAvailable = seasonResults.every((s) => s.status === 'available');
                const allWatched = seasonResults.every((s) => s.watched);

                // M7: a fully-available AND fully-watched multi-season show
                // auto-dismisses.
                if (allAvailable && allWatched) {
                    store.remove(first.externalIds, first.mediaType);
                    continue;
                }

                store.updateSeasonStatuses(
                    first.externalIds,
                    first.mediaType,
                    seasonResults.map((s) => ({
                        seasonNumber: s.seasonNumber!,
                        status: s.status,
                        download: s.download,
                        jellyfinLibraryId: s.jellyfinLibraryId,
                    })),
                );
            }

            // Single (movie / full TV show) results
            for (const item of nonSeasonResults) {
                if (item.status === 'available' && item.watched) {
                    store.remove(item.externalIds, item.mediaType);
                    continue;
                }

                store.updateStatus(item.externalIds, item.mediaType, item.status, {
                    jellyfinLibraryId: item.jellyfinLibraryId,
                    download: item.download,
                    statusMessage: item.statusMessage,
                });
            }
        },

        /**
         * Drop "available" cards older than REQUEST_AVAILABLE_EXPIRE_HOURS.
         * Without this a card only expired on the next page load, and the
         * import-time load always used the shipped default.
         */
        pruneExpired() {
            const expireHours = requestAvailableExpireHours();
            update((state) => {
                const kept = state.notifications.filter(
                    (n) => !hasNotificationExpired(n, expireHours),
                );
                if (kept.length === state.notifications.length) return state;
                const next = { ...state, notifications: kept };
                saveToStorage(next);
                return next;
            });
        },

        /**
         * Run a single poll cycle: fetch statuses for active notifications and
         * apply the results. Guards against concurrent polls and a hidden tab.
         * Returns immediately when there is nothing to poll.
         */
        async poll(): Promise<void> {
            if (!browser) return;
            if (isPolling) return;
            if (typeof document !== 'undefined' && document.hidden) return;

            store.pruneExpired();

            const activeIds = store.getActiveIds();
            if (activeIds.length === 0) return;

            isPolling = true;
            try {
                // The status endpoint accepts at most 20 titles. Process bounded
                // batches so one large request list cannot freeze every card.
                for (let offset = 0; offset < activeIds.length; offset += STATUS_BATCH_SIZE) {
                    try {
                        const { data, error: apiError } = await contentApi.checkRequestStatuses(
                            activeIds.slice(offset, offset + STATUS_BATCH_SIZE),
                        );
                        if (!apiError && data) {
                            store.applyStatusResults(data as unknown as RequestStatusItem[]);
                        }
                    } catch {
                        // Keep updating other batches; retry this one next cycle.
                    }
                }
            } catch {
                /* expected: poll may fail — next tick retries */
            } finally {
                isPolling = false;
                store.setLastPoll(Date.now());
            }
        },

        /**
         * Dismiss a notification (user clicked X). Terminal: hard-removes from
         * the UI and persists the dismissal. Re-requesting re-surfaces it via
         * shouldShowNotification (requestedAt > dismissedAt).
         *
         * ONE path, deliberately. There used to be a second: a card hydrated
         * from the durable inbox dismissed by marking its row read instead. That
         * branch is gone along with the hydration that created it — see the
         * module doc. `POST /api/request/dismiss` already retires the matching
         * `request.available` row server-side (`upsertDismissal` →
         * `scheduleRequestDismissalSync`), so this single call still clears the
         * popup, the drawer and the For-You rail.
         */
        async dismiss(externalIds: ExternalIds, mediaType: NotificationMediaType) {
            const id = generateNotificationId(externalIds, mediaType);

            let removed: RequestNotification | undefined;
            update((state) => {
                removed = state.notifications.find((n) => n.id === id);
                state.notifications = state.notifications.filter((n) => n.id !== id);
                saveToStorage(state);
                return { ...state };
            });

            const result = await persistenceService.dismissNotification(externalIds, mediaType);

            if (!result.success && removed) {
                update((state) => {
                    state.notifications.push(removed!);
                    saveToStorage(state);
                    return { ...state };
                });
            }
        },

        /**
         * Dismiss every currently-visible notification at once.
         */
        async dismissAll(items: RequestNotification[]) {
            if (items.length === 0) return;

            const removed = items.slice();

            update((state) => {
                const ids = new Set(removed.map((n) => n.id));
                state.notifications = state.notifications.filter((n) => !ids.has(n.id));
                saveToStorage(state);
                return { ...state };
            });

            const results = await Promise.allSettled(
                removed.map((n) =>
                    persistenceService.dismissNotification(n.externalIds, n.mediaType, {
                        silent: true,
                    }),
                ),
            );

            const failed: RequestNotification[] = [];
            results.forEach((r, i) => {
                if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)) {
                    failed.push(removed[i]);
                }
            });

            if (failed.length > 0) {
                update((state) => {
                    state.notifications.push(...failed);
                    saveToStorage(state);
                    return { ...state };
                });
                toasts.warning(
                    `Could not save ${failed.length} dismissal${failed.length === 1 ? '' : 's'}`,
                    3500,
                );
            }
        },

        /**
         * Remove a notification completely (e.g., after playback started)
         */
        remove(externalIds: ExternalIds, mediaType: NotificationMediaType) {
            update((state) => {
                const id = generateNotificationId(externalIds, mediaType);
                state.notifications = state.notifications.filter((n) => n.id !== id);
                saveToStorage(state);
                return { ...state };
            });
        },

        /**
         * Update last poll timestamp
         */
        setLastPoll(timestamp: number) {
            update((state) => {
                state.lastPoll = timestamp;
                saveToStorage(state);
                return { ...state };
            });
        },

        /**
         * Get all notification IDs for polling.
         */
        getActiveIds(): {
            externalIds: ExternalIds;
            mediaType: NotificationMediaType;
            seasons?: number[];
        }[] {
            const state = get({ subscribe });
            return state.notifications.map((n) => ({
                externalIds: n.externalIds,
                mediaType: n.mediaType,
                seasons: n.seasons,
            }));
        },

        /**
         * Check if there are any active notifications.
         */
        hasActiveNotifications(): boolean {
            const state = get({ subscribe });
            return state.notifications.length > 0;
        },

        /**
         * Clear all notifications
         */
        clear() {
            set({ notifications: [], lastPoll: 0 });
            if (browser) localStorage.removeItem(getStorageKey());
        },

        /**
         * Set current username and reload notifications from user-specific
         * storage. On a genuine username change, also reset the persistence
         * service's in-memory dismissal maps (L5) so a previous user's
         * session/server dismissals can't suppress the new user's items on a
         * shared browser.
         */
        setUser(username: string) {
            const currentUsername = persistenceService.getUsername();
            if (currentUsername === username) return;

            persistenceService.reset();
            persistenceService.setUsername(username);

            const state = loadFromStorage();
            set(state);
        },

        /**
         * Sync pending requests from server (Jellyseerr).
         *
         * M5: lastSyncTime is set only AFTER a successful fetch (and the cooldown
         * is checked up front) so a transient blip on load doesn't permanently
         * kill sync for the page lifetime. Safe to call from focus / visibility /
         * online / storage handlers — it self-throttles.
         */
        async syncFromServer() {
            if (!browser) return;

            const currentUsername = persistenceService.getUsername();
            if (!currentUsername) return;

            // Throttle: skip if synced recently.
            const now = Date.now();
            if (now - lastSyncTime < MIN_SYNC_INTERVAL_MS) return;

            try {
                const { data, error: fetchError } = await contentApi.getPendingRequests();
                if (fetchError || !data) return;

                const parsed = PendingRequestsResponseSchema.safeParse(data);
                if (!parsed.success) return;
                const pendingData: PendingRequestsResponse = parsed.data;

                // Only record a successful sync time AFTER the fetch resolves
                // with usable data (M5) — never on the early-return error paths.
                lastSyncTime = now;

                const dismissedMap = persistenceService.getDismissedMap();
                const sessionDismissedIds = persistenceService.getSessionDismissedIds();

                if (Array.isArray(pendingData.dismissals)) {
                    persistenceService.loadDismissalsFromServer(pendingData.dismissals);
                }

                // Work on a local copy — never mutate the object returned by
                // get() in place (Svelte writable anti-pattern; reactive
                // subscribers would not be notified and a no-op branch would
                // silently discard the change).
                const current = get({ subscribe });
                let updated = false;

                // Evict notifications dismissed on another tab/device since this
                // tab last loaded (M5 / L6 cross-device propagation).
                const beforeCount = current.notifications.length;
                const notifications = current.notifications.filter((n) =>
                    shouldShowNotificationForKeys(
                        n.dismissalKey
                            ? [n.dismissalKey]
                            : requestDismissalKeys(n.externalIds, n.mediaType),
                        n.createdAt,
                        dismissedMap,
                        sessionDismissedIds,
                    ),
                );
                if (notifications.length !== beforeCount) {
                    updated = true;
                }

                const maxAge = 14 * 24 * 60 * 60 * 1000; // last 2 weeks

                for (const req of pendingData.items) {
                    const requestedAt = new Date(req.requestedAt).getTime();

                    // L7: malformed requestedAt → fall back to now rather than
                    // letting NaN corrupt the age check and sort key.
                    const safeRequestedAt = Number.isNaN(requestedAt) ? now : requestedAt;

                    if (now - safeRequestedAt > maxAge) continue;
                    if (req.status === 'available') continue;

                    if (!req.externalIds || Object.keys(req.externalIds).length === 0) {
                        continue;
                    }

                    const id = generateNotificationId(req.externalIds, req.mediaType);

                    // Jellyseerr keeps a still-airing series in the pending list
                    // indefinitely (`media.status = PARTIALLY_AVAILABLE`), so
                    // this branch is the one that resurrects a dismissed card
                    // on every focus if the dismissal cannot be found.
                    if (
                        !shouldShowNotificationForKeys(
                            [req.dismissalKey],
                            safeRequestedAt,
                            dismissedMap,
                            sessionDismissedIds,
                        )
                    ) {
                        continue;
                    }

                    const existing = notifications.find((n) => n.id === id);
                    if (existing && existing.dismissalKey !== req.dismissalKey) {
                        existing.dismissalKey = req.dismissalKey;
                        updated = true;
                    }
                    if (!existing) {
                        notifications.push({
                            id,
                            dismissalKey: req.dismissalKey,
                            externalIds: req.externalIds,
                            mediaType: req.mediaType,
                            title: req.title,
                            posterPath: req.posterPath || undefined,
                            status: 'pending',
                            seasons: req.seasons,
                            createdAt: safeRequestedAt,
                            shownAt: Date.now(),
                        });
                        updated = true;
                    } else if (req.seasons?.length) {
                        // Seerr can return several requests for different seasons
                        // of one show. Merge their scope instead of keeping only
                        // the first request encountered during restoration.
                        const seasons = [
                            ...new Set([...(existing.seasons ?? []), ...req.seasons]),
                        ].sort((a, b) => a - b);
                        if (JSON.stringify(seasons) !== JSON.stringify(existing.seasons)) {
                            existing.seasons = seasons;
                            updated = true;
                        }
                    }
                }

                if (updated) {
                    update((s) => {
                        s.notifications = notifications;
                        saveToStorage(s);
                        return { ...s };
                    });
                }
            } catch (e) {
                console.warn('[RequestNotifications] Failed to sync from server', e);
            }
        },

        /**
         * Reload notifications from localStorage and merge with the in-memory
         * set, keeping the furthest-along status per id (L4). Called from the
         * `storage` event so a dismiss in another tab doesn't get resurrected
         * by this tab's blind whole-array save.
         */
        reloadFromStorage() {
            if (!browser) return;
            const persisted = loadFromStorage();
            update((state) => {
                const byId = new Map<string, RequestNotification>();
                // Seed with persisted (other tab's authoritative write)...
                for (const n of persisted.notifications) byId.set(n.id, n);
                // ...then overlay in-memory entries only when still present in
                // the persisted set, so another tab's dismissal (which removed
                // the entry) wins over our stale copy.
                for (const n of state.notifications) {
                    if (byId.has(n.id)) {
                        const other = byId.get(n.id)!;
                        // Keep whichever is further along.
                        byId.set(
                            n.id,
                            sortByStatusBestFirst(n.status, other.status) <= 0 ? n : other,
                        );
                    }
                }
                const merged = Array.from(byId.values());
                return {
                    notifications: merged,
                    lastPoll: Math.max(state.lastPoll, persisted.lastPoll),
                };
            });
        },
    };

    return store;
}

export const requestNotifications = createRequestNotificationsStore();

/**
 * Polling controller (A2): owns the adaptive scheduler so the widget only
 * decides WHETHER polling should run (feature flag, user, route, visibility),
 * not HOW it runs.
 */
let pollInterval: ReturnType<typeof setInterval> | null = null;

function shouldPollNow(): boolean {
    const state = get(requestNotifications);
    if (state.notifications.length === 0) return false;
    // Fast cadence whenever anything is actively in flight — not just the
    // 'downloading' headline. queued/importing items are progressing too, so
    // they should poll at the fast rate to keep ETA/progress fresh.
    const hasDownloading = state.notifications.some(
        (n) => isDownloadingStatus(n.status) || n.status === 'importing',
    );
    const threshold = hasDownloading ? POLL_THRESHOLD_DOWNLOADING_MS : POLL_THRESHOLD_IDLE_MS;
    return Date.now() - state.lastPoll >= threshold;
}

/**
 * Start the adaptive poll scheduler. The interval body re-checks shouldPoll +
 * document.hidden each tick (L2: one long-lived interval rather than tear-down/
 * rebuild). The initial kick-off poll is routed through `poll()`, which itself
 * enforces the hidden/in-flight guards (L1).
 */
export function startPolling(): void {
    if (!browser || pollInterval) return;

    // Initial kick-off — guarded inside poll() (L1).
    void requestNotifications.poll();

    pollInterval = setInterval(() => {
        // poll() already guards document.hidden + in-flight; gate on cadence here.
        if (shouldPollNow()) {
            void requestNotifications.poll();
        }
    }, POLL_TICK_MS);
}

export function stopPolling(): void {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

/**
 * Gated refresh used by focus / visibilitychange / online / storage listeners
 * (L3): poll immediately if cadence allows, and opportunistically re-sync from
 * the server (self-throttled) so cross-device dismissals propagate (M5 / L6).
 */
export function refreshOnFocus(): void {
    if (!browser) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    void requestNotifications.syncFromServer();
    if (shouldPollNow()) void requestNotifications.poll();
}

let listenersInstalled = false;

/**
 * Install window-level listeners that drive recovery + cross-tab coherence
 * (M5, L3, L4). Idempotent. Returns a teardown function.
 */
export function installNotificationListeners(): () => void {
    if (!browser || listenersInstalled) return () => {};
    listenersInstalled = true;

    const onVisibility = () => {
        if (!document.hidden) refreshOnFocus();
    };
    const onFocus = () => refreshOnFocus();
    const onOnline = () => refreshOnFocus();
    const onStorage = (e: StorageEvent) => {
        // Only react to our own exact user-partitioned key (not other users'
        // partitions that merely share the prefix).
        if (e.key !== getStorageKey()) return;
        // Ignore writes from a tab on a DIFFERENT storage version (e.g. an old
        // tab still on v6 during a deploy). Reloading here would trip the
        // version-mismatch branch in loadFromStorage, which wipes the shared key
        // and drops all of this tab's in-flight notifications.
        if (e.newValue) {
            try {
                const incoming = JSON.parse(e.newValue) as { version?: number };
                if (incoming.version !== STORAGE_VERSION) return;
            } catch {
                return;
            }
        }
        requestNotifications.reloadFromStorage();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('storage', onStorage);

    return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('storage', onStorage);
        listenersInstalled = false;
    };
}

// Derived store for visible notifications.
// Dismiss is terminal (dismissed notifications are hard-removed), so every
// notification in the array is visible — we only sort here (M10).
export const visibleNotifications = derived(requestNotifications, ($state) =>
    [...$state.notifications].sort((a, b) => {
        // Best-first: available bubbles to the top, unavailable sinks.
        const byStatus = sortByStatusBestFirst(a.status, b.status);
        if (byStatus !== 0) return byStatus;
        // Then by creation time (newest first)
        return b.createdAt - a.createdAt;
    }),
);

// Derived store for count of active notifications
export const notificationCount = derived(visibleNotifications, ($visible) => $visible.length);
