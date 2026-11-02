// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Notification and Device Action Zod Schemas
 *
 * Shared schemas for request notifications and device push notification system.
 * These schemas define the contract for:
 * - Request tracking and notification system (Jellyseerr integration)
 * - Device push notifications ("Send to TV", Watch Together invites)
 *
 * Usage:
 * - Server: Validate API responses and database data
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { ExternalIdsResponseSchema } from './api-responses';

// ============================================================================
// Request Notification Types (from src/lib/types/notifications.ts)
// ============================================================================

/**
 * Download progress information for active downloads
 */
export const DownloadProgressSchema = z
    .object({
        /** Download completion percentage (0-100) */
        percentage: z.number().min(0).max(100).describe('Download percentage (0-100)'),
        /** Estimated time remaining (e.g., "2h 15m") */
        timeLeft: z.string().optional().describe('Time remaining'),
        /** Total download size (e.g., "4.5 GB") */
        size: z.string().optional().describe('Total size'),
        /** Remaining download size (e.g., "2.1 GB") */
        sizeLeft: z.string().optional().describe('Size remaining'),
    })
    .meta({
        id: 'DownloadProgress',
        description: 'Download progress information',
    });

export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

/**
 * Request status lifecycle
 */
export const RequestStatusSchema = z
    .enum([
        'pending',
        'searching',
        'queued',
        'paused',
        'downloading',
        'importing',
        'synching',
        'available',
        'unavailable',
        'monitored',
    ])
    .describe('Request status')
    .meta({ id: 'RequestStatus' });

export type RequestStatus = z.infer<typeof RequestStatusSchema>;

/**
 * Notification media type - only movie and series are requestable.
 * 'series' is the canonical public discriminator (replaces legacy 'tv').
 * Consumers that call TMDB/image APIs must map series → 'tv' via toTmdbType().
 */
export const NotificationMediaTypeSchema = z
    .enum(['movie', 'series'])
    .describe('Notification media type (movie or series)')
    .meta({ id: 'NotificationMediaType' });

export type NotificationMediaType = z.infer<typeof NotificationMediaTypeSchema>;

/**
 * Per-season status details for TV show requests
 */
export const SeasonStatusSchema = z
    .object({
        /** Season number */
        seasonNumber: z.number().int().describe('Season number'),
        /** Current request status for this season */
        status: RequestStatusSchema,
        /** Download progress for this season */
        download: DownloadProgressSchema.optional().describe('Download progress'),
        /** Jellyfin library ID when available */
        jellyfinLibraryId: z.string().optional().describe('Jellyfin library ID'),
    })
    .meta({
        id: 'SeasonStatus',
        description: 'Per-season status for TV shows',
    });

export type SeasonStatus = z.infer<typeof SeasonStatusSchema>;

/**
 * Request notification
 */
export const RequestNotificationSchema = z
    .object({
        dismissalKey: z.string().optional().describe('Server-issued dismissal key for a request'),
        /** Unique composite key: provider:id:mediaType (e.g., "tmdb:550:movie") */
        id: z.string().describe('Unique composite key'),
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media type (movie or tv) */
        mediaType: NotificationMediaTypeSchema,
        /** Display title */
        title: z.string().describe('Display title'),
        /** Poster image path */
        posterPath: z.string().optional().describe('Poster image path'),
        /** Current request status */
        status: RequestStatusSchema,
        /** Timestamp when notification was created */
        createdAt: z.number().describe('Creation timestamp'),
        /** Timestamp when this status was first shown */
        shownAt: z.number().optional().describe('First shown timestamp'),
        /** Timestamp when user dismissed it */
        dismissedAt: z.number().optional().describe('Dismissal timestamp'),
        /** Jellyfin library ID (populated when available) */
        jellyfinLibraryId: z.string().optional().describe('Jellyfin library ID'),
        /** Download progress (populated when downloading) */
        download: DownloadProgressSchema.optional().describe('Download progress'),
        /** Optional status message (e.g., "Searching for release...") */
        statusMessage: z.string().optional().describe('Status message'),
        /** For TV shows: which seasons were requested (e.g. [2,3,4]) */
        seasons: z.array(z.number().int()).optional().describe('Requested seasons'),
        /** Per-season status details (when seasons are specified) */
        seasonStatuses: z.array(SeasonStatusSchema).optional().describe('Season status details'),
    })
    .meta({
        id: 'RequestNotification',
        description: 'Request notification with status and progress',
    });

export type RequestNotification = z.infer<typeof RequestNotificationSchema>;

/**
 * Request notifications state
 *
 * NOTE: `isPolling` is intentionally NOT part of this shape. It is a transient,
 * per-tab in-memory flag (a concurrency guard for the poller) — never persisted
 * and never restored. Keeping it out of the validated/stored shape avoids the
 * dead "always-forced-false" round-trip it used to take through localStorage.
 */
export const RequestNotificationsStateSchema = z
    .object({
        /** Array of request notifications */
        notifications: z.array(RequestNotificationSchema).describe('Request notifications'),
        /** Timestamp of last poll */
        lastPoll: z.number().describe('Last poll timestamp'),
    })
    .meta({
        id: 'RequestNotificationsState',
        description: 'Request notifications state',
    });

export type RequestNotificationsState = z.infer<typeof RequestNotificationsStateSchema>;

// ============================================================================
// Inbox Notification Types (durable `user_notifications` table)
// ============================================================================
//
// Distinct from RequestNotificationSchema above (Jellyseerr request-polling
// widget). Backs GET /api/v1/notifications — mirrors UserNotificationRow from
// user-notifications.queries.ts field-for-field.

/**
 * Everything a client needs to RENDER a row, whatever its `kind`.
 *
 * Rendered server-side by `notification-display.service.ts` from the same
 * per-kind text renderer the push banner uses, so a row reads identically on the
 * lock screen and in the drawer. `title` is non-optional because that renderer
 * has a guaranteed non-empty fallback — there is no row it cannot title.
 *
 * `imageUrl` is BEST-EFFORT and its absence means "no id to build one from",
 * NOT "this item has no artwork" (the image route serves a placeholder for an
 * item with none). Deliberately unlike the push payload's `image_url`, whose
 * absence IS the signal. Render a fallback when it fails to load.
 */
export const NotificationDisplaySchema = z
    .object({
        title: z.string().describe('Headline, always non-empty'),
        body: z.string().optional().describe('Secondary line'),
        imageUrl: z.string().optional().describe('Best-effort artwork URL; may 404'),
    })
    .meta({
        id: 'NotificationDisplay',
        description: 'Everything needed to render a notification row, for any kind',
    });

export type NotificationDisplay = z.infer<typeof NotificationDisplaySchema>;

/**
 * Where a row navigates to, as STRUCTURED data rather than a URL.
 *
 * A path would bake this server's routing into a durable row that outlives the
 * route table, and would be useless to the iOS app, which has its own
 * navigation. The client maps `target` onto its own screen.
 *
 * `target: 'episode'` carries the SERIES id in `mediaId`, with
 * `seasonNumber`/`episodeNumber` selecting within it — opening an episode's own
 * id yields a bare episode with no series context or play button.
 *
 * ABSENT means "not navigable" — which is what an unrecognised future kind gets,
 * because guessing a route sends the user somewhere the notification was not
 * about. Render such a row as readable but not tappable.
 *
 * ## `target` is an OPEN set, and that is the contract
 *
 * New values may appear over time — `'url'` is the first one to have done so.
 * A client that does not recognise a `target` MUST treat the link as ABSENT
 * (render the row, do not make it tappable) rather than failing to decode the
 * notification. That rule is what let `'url'` ship without breaking a client
 * already in the App Store, and it is the rule the next value will rely on too.
 * Decode `target` as a permissive string, never as a closed enum.
 *
 * ## The fields are flat, and only some apply to each target
 *
 * `mediaId` is present for `media`/`episode`/`request` and ABSENT for `url`;
 * `url` is present only for `url`. Same arrangement `seasonNumber`/
 * `episodeNumber`/`requestId` already had — optional fields whose applicability
 * is decided by `target` — rather than a discriminated union, which would give
 * every existing client a new decoding shape to learn for one added variant.
 *
 * `target: 'url'` is an EXTERNAL destination an administrator attached to an
 * announcement (see `admin-broadcasts.ts`). It is validated at write time to be
 * an absolute `http:`/`https:` URL — no other scheme can be stored — but it
 * points outside this application, so a client should open it the way it opens
 * any untrusted external link (a browser/new tab with no opener), never through
 * its own in-app router.
 */
export const NotificationLinkSchema = z
    .object({
        // OPEN string, not z.enum(...): an OpenAPI `enum:` constraint is exactly
        // what swift-openapi-generator (and any strict-decode client) turns into
        // a closed Swift enum with no fallback case — a client that doesn't
        // decode-tolerate an unrecognized case then fails the WHOLE containing
        // array, not just this row, the moment a new target value ships. This
        // bit a real client (confirmed live in prod: adding 'url' as a 4th
        // closed case broke notification-list decoding for any user who
        // received one). Known values documented below; do not reintroduce the
        // enum constraint to "tighten" this — that is what caused the outage.
        target: z
            .string()
            .describe(
                'What kind of thing to open; an OPEN set — known values today: media, episode, ' +
                    'request, url. Treat an unrecognized value as absent (not navigable), not a decode failure.',
            ),
        mediaId: z
            .string()
            .optional()
            .describe('Media item to open; the SERIES when target=episode. Absent when target=url'),
        seasonNumber: z.number().int().optional().describe('Season to preselect'),
        episodeNumber: z.number().int().optional().describe('Episode to preselect'),
        requestId: z.number().int().optional().describe('Associated request id'),
        url: z
            .string()
            .optional()
            .describe(
                'Absolute http(s) URL to open EXTERNALLY; present only when target=url. ' +
                    'Validated at write time; open it as an untrusted external link',
            ),
    })
    .meta({
        id: 'NotificationLink',
        description: 'Structured navigation target for a notification row',
    });

export type NotificationLink = z.infer<typeof NotificationLinkSchema>;

/**
 * A single durable inbox notification.
 *
 * Forward-compatibility contract, and it is a contract rather than advice:
 *
 *  - A client MUST be able to render any row from `display` ALONE, and route any
 *    tap from `link` alone.
 *  - `kind` is an OPEN string. New values may appear at any time; never switch
 *    on it exhaustively and never fail a row you do not recognise.
 *  - `link.target` is an OPEN set for the same reason. A client that does not
 *    recognise a `target` MUST treat the link as ABSENT — a readable,
 *    non-navigable row — rather than failing to decode the notification.
 *  - `payload` is ADVISORY. Its shape may change within a kind without notice.
 *    It is retained for debugging and for server-side coalescing, not as a
 *    rendering input.
 */
export const InboxNotificationItemSchema = z
    .object({
        /** Notification id */
        id: z.string().describe('Notification id'),
        /** Notification kind/category — an OPEN string, not an enum */
        kind: z.string().describe('Notification kind (open set)'),
        /** Server-rendered, kind-agnostic rendering data */
        display: NotificationDisplaySchema,
        /** Navigation target; absent = not navigable */
        link: NotificationLinkSchema.optional(),
        /** Arbitrary notification payload (advisory; shape may change) */
        payload: z.record(z.string(), z.unknown()).nullable().describe('Advisory payload'),
        /** Timestamp when the notification was read; null = unread */
        readAt: z.string().nullable().describe('ISO-8601 read timestamp; null = unread'),
        /** Timestamp when the notification was created */
        createdAt: z.string().describe('ISO-8601 creation timestamp'),
        /** Timestamp when the notification expires; null = never expires */
        expiresAt: z
            .string()
            .nullable()
            .describe('ISO-8601 expiration timestamp; null = never expires'),
        /**
         * Present IFF this row is currently pinned by an administrator.
         *
         * Optional rather than nullable, because absence is the common case by
         * a wide margin and a client should treat "no field" and "not pinned"
         * as the same thing. It is the pin's timestamp rather than a boolean so
         * a client can order or age the pinned block without a second field.
         *
         * "Currently" is exact: an admin can put an expiry on a pin, and this
         * field disappears the moment that expiry passes — it never reports a
         * historical pin. A pinned row is also SUPPRESSED from `items` while
         * pinned (see `InboxNotificationsResponse.pinned`), so a client that
         * renders both blocks does not show it twice.
         */
        pinnedAt: z
            .string()
            .optional()
            .describe('ISO-8601 timestamp the pin was placed; absent = not pinned'),
    })
    .meta({
        id: 'InboxNotificationItem',
        description: 'Durable inbox notification item (user_notifications table)',
    });

export type InboxNotificationItem = z.infer<typeof InboxNotificationItemSchema>;

/**
 * Paginated notification inbox response.
 *
 * Pagination is CURSOR-based. `nextCursor` is opaque — pass it back verbatim as
 * `?cursor=`; do not parse, construct, or persist it as a durable reference.
 * `null` means this is the last page, and `hasMore` is exactly
 * `nextCursor !== null` (kept as a convenience, not a second source of truth).
 *
 * `pinned` sits OUTSIDE that pagination entirely — see its own note below.
 */
export const InboxNotificationsResponseSchema = z
    .object({
        /** Notification items */
        items: z.array(InboxNotificationItemSchema).describe('Notification items'),
        /**
         * Currently-pinned administrator announcements, newest pin first.
         *
         * Three properties, all of which a client has to respect:
         *
         *  1. **Unpaginated.** It is not a page of `items` and the cursor does
         *     not walk it. The set is bounded by how many announcements an
         *     operator chose to pin at once — in practice zero or one.
         *  2. **First page only.** Present when the request carried no
         *     `?cursor=`; absent on every continuation. A client accumulating
         *     pages must not clear its pinned block when a later page omits the
         *     field. (A `?since=` delta DOES carry the full current set, because
         *     a client that was disconnected while a pin was placed would
         *     otherwise never learn about it.)
         *  3. **Disjoint from `items`.** A row appears in exactly one of the
         *     two, never both — the list query excludes anything currently
         *     pinned. Render `pinned` above `items`; do not merge and
         *     de-duplicate.
         *
         * Every entry carries `pinnedAt`. When a pin lapses or an admin unpins,
         * the row simply reappears in `items` at its original chronological
         * position on the next fetch — there is no wire event for unpinning and
         * none is needed.
         */
        pinned: z
            .array(InboxNotificationItemSchema)
            .optional()
            .describe(
                'Currently-pinned admin announcements, newest pin first. Unpaginated and returned ' +
                    'only on the first page (no ?cursor=) or on a ?since= delta. Never overlaps ' +
                    '`items`. Render above the list.',
            ),
        /** Pagination metadata */
        page: z
            .object({
                limit: z.number().int().describe('Page size limit'),
                hasMore: z.boolean().describe('Whether more results exist'),
                nextCursor: z
                    .string()
                    .nullable()
                    .describe('Opaque cursor for the next page; null = last page'),
            })
            .describe('Pagination metadata'),
    })
    .meta({
        id: 'InboxNotificationsResponse',
        description: 'Paginated notification inbox response',
    });

export type InboxNotificationsResponse = z.infer<typeof InboxNotificationsResponseSchema>;

/**
 * Unread notification count response.
 */
export const NotificationUnreadCountResponseSchema = z
    .object({
        count: z.number().int().describe('Number of unread notifications'),
    })
    .meta({
        id: 'NotificationUnreadCountResponse',
        description: 'Unread notification count',
    });

export type NotificationUnreadCountResponse = z.infer<typeof NotificationUnreadCountResponseSchema>;

/**
 * Mark-all-as-read response.
 *
 * `ids` names the rows this call actually flipped — the UPDATE already returns
 * them (it has to, to drive the cross-surface dismissal sync), so discarding
 * them and reporting only a count forced every client into a full refetch to
 * find out WHICH rows changed. With the ids, a client reconciles its own list in
 * place. The set is exact: rows already read before this call are not included.
 */
export const NotificationReadAllResponseSchema = z
    .object({
        updated: z.number().describe('Number of notifications marked as read'),
        ids: z.array(z.string()).describe('Ids of the rows this call marked as read'),
    })
    .meta({
        id: 'NotificationReadAllResponse',
        description: 'Result of marking all notifications as read',
    });

export type NotificationReadAllResponse = z.infer<typeof NotificationReadAllResponseSchema>;

/**
 * Single notification read-state response.
 */
export const NotificationReadResponseSchema = z
    .object({
        id: z.string().describe('Notification id'),
        readAt: z.string().nullable().describe('ISO-8601 timestamp when marked as read'),
    })
    .meta({
        id: 'NotificationReadResponse',
        description: 'Notification read state',
    });

export type NotificationReadResponse = z.infer<typeof NotificationReadResponseSchema>;
