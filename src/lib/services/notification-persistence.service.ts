// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Notification Persistence Service
 *
 * Thin layer over the dismissal API:
 * - Tracks current username (for store key partitioning)
 * - Holds an in-memory dismissedMap so the widget doesn't flicker between
 *   optimistic-dismiss and the next syncFromServer()
 * - Awaits the dismiss POST and surfaces errors via toast; returns a result
 *   so the caller can roll back the optimistic UI on failure.
 *
 * No localStorage queue, no retry machinery, no exponential backoff —
 * the server-side INSERT into user_media_flags (flag_type='request_dismissed',
 * since the user_notification_dismissals table was dropped in migration
 * 16.108.0) only fails on a genuine error: a bad/garbage-collected user_id
 * trips the FK to users(id), but for a live signed-in session a save error
 * means the network was down. Acceptable degradation for an informational
 * widget.
 */

import type { NotificationMediaType } from '$lib/types/notifications';
import type { ExternalIds } from '$lib/types/api-common';
import { toasts } from '$lib/stores/toast.store';
import {
    buildRequestDismissalExtKey,
    requestDismissalKeys,
} from '$lib/shared/request-dismissal-key';
import * as contentApi from '$lib/api/content';

export type DismissResult = { success: true } | { success: false };

/**
 * Canonical K-EXT dismissal key. Delegates to the shared builder so this side
 * and `request-status/dismissals.ts` cannot spell the media-type token
 * differently — which they did: the server stored `tmdb:95350:tv` while this
 * file looked up `tmdb:95350:series`, so no series dismissal was ever legible
 * to the popup. See `$lib/shared/request-dismissal-key.ts`.
 */
function generateDismissalKey(
    externalIds: ExternalIds,
    mediaType: NotificationMediaType,
): string | null {
    return buildRequestDismissalExtKey(externalIds, mediaType);
}

export class NotificationPersistenceService {
    private currentUsername: string | null = null;
    private dismissedMap = new Map<string, string>();
    private sessionDismissedIds = new Set<string>();

    getUsername(): string | null {
        return this.currentUsername;
    }

    setUsername(username: string) {
        this.currentUsername = username;
    }

    /**
     * Clear all in-memory dismissal tracking (L5). Called on a genuine username
     * change so one user's session/server dismissals on a shared browser can't
     * suppress the next user's notifications. Does NOT touch the server.
     */
    reset() {
        this.dismissedMap.clear();
        this.sessionDismissedIds.clear();
    }

    getDismissedMap(): Map<string, string> {
        return this.dismissedMap;
    }

    getSessionDismissedIds(): Set<string> {
        return this.sessionDismissedIds;
    }

    /**
     * Fold the authoritative server list into the in-memory dismissedMap.
     *
     * This used to `clear()` first. That looks like the safe choice — the
     * server IS the truth — but a sync whose response was computed before this
     * tab's dismiss row landed arrives afterwards and erases the local entry,
     * and the very next pending-sync then re-adds the notification the user
     * just dismissed. Keeping local-only entries costs nothing in the opposite
     * direction: when a re-request deletes the server row, the re-request's
     * newer `requestedAt` already beats the stale `dismissedAt` in
     * `shouldShowNotification`, so the notification still comes back.
     */
    loadDismissalsFromServer(dismissals: Array<{ key: string; dismissedAt: string }>) {
        if (!Array.isArray(dismissals)) return;

        for (const d of dismissals) {
            if (
                typeof d?.key === 'string' &&
                d.key.length > 0 &&
                typeof d.dismissedAt === 'string'
            ) {
                this.dismissedMap.set(d.key, d.dismissedAt);
            }
        }
    }

    /**
     * Latest dismissal recorded under ANY key shape this item could carry.
     *
     * Callers compare it against the request's own timestamp, so "latest wins"
     * is what keeps a re-request visible: an older K-UUID row must not mask a
     * newer K-EXT one, or vice versa.
     */
    getDismissedAtFor(
        externalIds: ExternalIds,
        mediaType: NotificationMediaType,
    ): string | undefined {
        let latest: string | undefined;
        let latestMs = -Infinity;
        for (const key of requestDismissalKeys(externalIds, mediaType)) {
            const raw = this.dismissedMap.get(key);
            if (!raw) continue;
            const ms = new Date(raw).getTime();
            // A malformed timestamp is kept only as a last resort: callers fail
            // open on NaN, so preferring a parseable one is strictly better.
            if (Number.isNaN(ms)) {
                latest ??= raw;
                continue;
            }
            if (ms > latestMs) {
                latestMs = ms;
                latest = raw;
            }
        }
        return latest;
    }

    /** Record an in-session dismissal under every key shape at once. */
    markSessionDismissedFor(
        externalIds: ExternalIds,
        mediaType: NotificationMediaType,
        timestamp: string,
    ) {
        for (const key of requestDismissalKeys(externalIds, mediaType)) {
            this.markSessionDismissed(key, timestamp);
        }
    }

    /** Clear every key shape — used when a re-request must re-surface the card. */
    removeSessionDismissedFor(externalIds: ExternalIds, mediaType: NotificationMediaType) {
        for (const key of requestDismissalKeys(externalIds, mediaType)) {
            this.removeSessionDismissed(key);
        }
    }

    markSessionDismissed(id: string, timestamp: string) {
        this.sessionDismissedIds.add(id);
        this.dismissedMap.set(id, timestamp);
    }

    removeSessionDismissed(id: string) {
        this.sessionDismissedIds.delete(id);
        this.dismissedMap.delete(id);
    }

    /**
     * Optimistically mark dismissed, then POST. Returns success/failure so
     * the store can re-add the notification on failure (the toast alone
     * would otherwise leave the widget visually stale).
     *
     * `silent: true` suppresses the user-facing toast — used by dismissAll()
     * which shows one consolidated toast for any failures rather than N.
     */
    async dismissNotification(
        externalIds: ExternalIds,
        mediaType: NotificationMediaType,
        opts: { silent?: boolean } = {},
    ): Promise<DismissResult> {
        const id = generateDismissalKey(externalIds, mediaType);
        if (!id) {
            if (!opts.silent) {
                toasts.warning('Cannot dismiss item without provider ID', 3000);
            }
            return { success: false };
        }

        // Optimism covers EVERY key shape, not just the one being POSTed: the
        // server's reconcile mirrors this dismissal to the K-UUID row too, and
        // a reader that finds the item under that shape must not re-surface it
        // in the window before the mirror is visible.
        const keys = requestDismissalKeys(externalIds, mediaType);
        const optimisticTimestamp = new Date().toISOString();
        for (const key of keys) this.markSessionDismissed(key, optimisticTimestamp);

        try {
            const { error, status } = await contentApi.dismissRequest({
                externalIds,
                // `dismissRequestBodySchema` preprocesses 'series' -> 'tv' at parse
                // time, so 'series' is valid runtime input despite the schema's
                // post-preprocess output type only naming 'movie' | 'tv'.
                mediaType: mediaType === 'movie' ? 'movie' : 'series',
            });

            if (error) {
                for (const key of keys) this.removeSessionDismissed(key);
                if (!opts.silent) {
                    if (status === 401 || status === 403) {
                        toasts.warning('Session expired — refresh to dismiss', 5000);
                    } else {
                        toasts.warning('Could not save dismissal', 3000);
                    }
                }
                return { success: false };
            }

            for (const key of keys) this.dismissedMap.set(key, optimisticTimestamp);

            // Once the server has acknowledged the dismissal, sessionDismissedIds
            // is no longer load-bearing for these keys — the dismissedMap
            // timestamp (and future server syncs) handles hiding via
            // shouldShowNotification. Keeping them in the set would
            // unconditionally short-circuit that check and block cross-device
            // re-requests from re-surfacing the notification after another
            // device's POST /api/request deletes the row.
            for (const key of keys) this.sessionDismissedIds.delete(key);
            return { success: true };
        } catch (err) {
            console.warn('[Persistence] dismiss failed', err);
            for (const key of keys) this.removeSessionDismissed(key);
            if (!opts.silent) {
                toasts.warning('Could not save dismissal', 3000);
            }
            return { success: false };
        }
    }
}
