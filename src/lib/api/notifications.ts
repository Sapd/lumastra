// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Notifications API domain module — user notification inbox.
 *
 * Typed functions for the durable notification inbox (user_notifications table).
 * Hits /api/notifications (browser/forward-auth surface) via the typed client.
 *
 * These are the user's own inbox notifications (system events, request
 * fulfilments, etc.) — distinct from the request-notification widget which
 * tracks Jellyseerr media requests via /api/requests.
 *
 * All functions use Zod schema validation for type-safe responses.
 */

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import type { ApiRequestOptions } from './types.js';
import {
    InboxNotificationItemSchema,
    InboxNotificationsResponseSchema,
    NotificationUnreadCountResponseSchema,
    NotificationReadAllResponseSchema,
    NotificationReadResponseSchema,
} from '$lib/schemas/notifications-types.js';
import { z } from 'zod';

// =========================================================================
// Inbox listing
// =========================================================================

export interface GetNotificationsOptions {
    /** When true, return only unread notifications. */
    unread?: boolean;
    /** Max rows per page (1–100, default 50). */
    limit?: number;
    /**
     * Opaque cursor from a previous page's `page.nextCursor`. Pass it back
     * verbatim — it encodes a (created_at, id) keyset position and is not
     * something to construct or parse.
     */
    cursor?: string;
    /** ISO instant — return only rows created strictly after it (reconnect delta). */
    since?: string;
}

/**
 * GET /api/notifications
 *
 * Returns the paginated notification inbox for the current user.
 * Response shape: { items: InboxNotification[], page: { limit, hasMore, nextCursor } }
 */
export function getNotifications(opts: GetNotificationsOptions = {}, options?: ApiRequestOptions) {
    return apiGet('/api/notifications', InboxNotificationsResponseSchema, {
        ...options,
        params: {
            ...options?.params,
            ...(opts.unread !== undefined && { unread: String(opts.unread) }),
            ...(opts.limit !== undefined && { limit: opts.limit }),
            ...(opts.cursor !== undefined && { cursor: opts.cursor }),
            ...(opts.since !== undefined && { since: opts.since }),
        },
    });
}

/**
 * GET /api/notifications/{id}
 *
 * Hydrates one notification into its fully rendered form. This is how a client
 * turns a REFERENCE it already holds — the `notificationId` on a live SSE frame,
 * or the id in a tapped push — into something renderable, instead of deriving a
 * view from the raw `payload` itself.
 */
export function getNotification(id: string, options?: ApiRequestOptions) {
    return apiGet(`/api/notifications/${id}`, InboxNotificationItemSchema, options);
}

// =========================================================================
// Unread count
// =========================================================================

/**
 * GET /api/notifications/unread-count
 *
 * Returns { count: number } — fast path for the notification badge.
 * Response is private, no-cache.
 */
export function getNotificationUnreadCount(options?: ApiRequestOptions) {
    return apiGet(
        '/api/notifications/unread-count',
        NotificationUnreadCountResponseSchema,
        options,
    );
}

// =========================================================================
// Mark as read
// =========================================================================

/**
 * POST /api/notifications/{id}/read
 *
 * Marks a single notification as read. Idempotent.
 * Returns { id, readAt } — the notification's current read state.
 */
export function markNotificationRead(id: string, options?: ApiRequestOptions) {
    return apiPost(
        `/api/notifications/${id}/read`,
        NotificationReadResponseSchema,
        undefined,
        options,
    );
}

/**
 * POST /api/notifications/read-all
 *
 * Marks all unread notifications as read.
 * Returns { updated: number } — count of rows updated.
 */
export function markAllNotificationsRead(options?: ApiRequestOptions) {
    return apiPost(
        '/api/notifications/read-all',
        NotificationReadAllResponseSchema,
        undefined,
        options,
    );
}

// =========================================================================
// Delete
// =========================================================================

/** Schema for 204 No Content (DELETE returns no body). */
const DeleteResponseSchema = z.null();

const FollowedSeriesResponseSchema = z.object({
    items: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
    page: z.object({ limit: z.number().int(), offset: z.number().int(), hasMore: z.boolean() }),
});

export function getSeriesFollows(limit = 50, offset = 0) {
    return apiGet('/api/me/series-follows', FollowedSeriesResponseSchema, {
        params: { limit, offset },
    });
}

export function followSeries(seriesId: string) {
    return apiPut(`/api/me/series-follows/${encodeURIComponent(seriesId)}`, z.null(), undefined);
}

export function unfollowSeries(seriesId: string) {
    return apiDelete(`/api/me/series-follows/${encodeURIComponent(seriesId)}`, z.null());
}

/**
 * DELETE /api/notifications/{id}
 *
 * Deletes a single notification owned by the caller.
 * Returns 204 on success, 404 if not found or not owned by the caller.
 */
export function deleteNotification(id: string, options?: ApiRequestOptions) {
    return apiDelete(`/api/notifications/${id}`, DeleteResponseSchema, undefined, options);
}
