// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/notifications/index.ts
 *
 *   GET  /api/v1/notifications            — paginated inbox
 *   GET  /api/v1/notifications/unread-count — fast unread badge count
 *   POST /api/v1/notifications/read-all   — mark all as read
 *
 * The durable notifications inbox. SSE frames with persist:true write rows to
 * `user_notifications`; this surface exposes read/manage operations on those rows.
 *
 * Auth: {kind:'user'} — self-only (reads/writes own rows; no admin cross-read here).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';

// ---------------------------------------------------------------------------
// Request contract schemas
// ---------------------------------------------------------------------------

/**
 * Query params for GET /notifications.
 * All optional — handler applies defaults inline.
 * `z.coerce` turns the string value from URLSearchParams into the right type.
 *
 * The gate ENFORCES the documented contract: `unread` is the boolean enum
 * {true,false} and `limit` is bounded to [1, 100]. Out-of-range limits are
 * rejected at mount() with a 422 rather than silently clamped by the handler.
 *
 * `cursor` and `since` are only SHAPE-checked here; their contents are validated
 * in the handler (a cursor has to decode, a `since` has to parse as a date) so
 * both can answer 422 with a field-specific message instead of a bare
 * "malformed string".
 */
const NotificationsQuerySchema = z.object({
    /** When "true", return only unread notifications. */
    unread: z.enum(['true', 'false']).optional(),
    /** Max rows per page — bounded to [1, 100]; >100 → 422. */
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** Opaque keyset cursor from a previous page's `page.nextCursor`. */
    cursor: z.string().min(1).optional(),
    /** ISO instant — return only rows created strictly after it. */
    since: z.string().min(1).optional(),
});
import { getDb } from '$lib/server/database/connection.js';
import {
    listNotifications,
    listPinnedBroadcastsForUser,
    countUnread,
    markAllRead,
} from '$lib/server/database/queries/user-notifications.queries.js';
import { scheduleDismissalSyncForInboxRow } from '$lib/server/services/request-dismissal-sync.service.js';
import { buildNotificationPresentation } from '$lib/server/services/notification-display.service.js';
import { resolvePushLocale } from '$lib/server/services/push/push-payload.js';
import {
    decodeNotificationCursor,
    encodeNotificationCursor,
} from '$lib/server/utils/notification-cursor.js';
import { getLocale } from '$lib/paraglide/runtime.js';
import { InboxNotificationsResponseSchema } from '$lib/schemas/notifications-types';

/**
 * The forward-compatibility contract, stated once and reused by both read
 * endpoints. Every word of it is a promise clients are entitled to rely on.
 */
const FORWARD_COMPAT_CONTRACT =
    'A client MUST be able to render any row from `display` alone and route any tap from ' +
    '`link` alone. `kind` is an open string — new values may appear at any time. ' +
    '`link.target` is likewise an OPEN set: new values may be added over time, and a client ' +
    'that does not recognize one MUST treat the link as absent (render the row, do not make ' +
    'it navigable) rather than failing to decode the notification — decode `target` as a ' +
    'permissive string, never as a closed enum. `payload` ' +
    'is advisory: shape may change within a kind without notice.';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Notifications'],
            summary: 'List notifications (inbox)',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the paginated notification inbox for the authenticated user. ' +
                '?unread=true filters to unread notifications only. ' +
                '?limit=<n> sets the max rows (1–100, default 50). ' +
                '?cursor=<opaque> continues from a previous page — pass `page.nextCursor` back ' +
                'verbatim; it encodes a (created_at, id) keyset position and MUST NOT be parsed ' +
                'or constructed by clients. ' +
                '?since=<ISO> instead returns only rows created strictly after that instant, for ' +
                'fetching the delta after a dropped SSE connection. `since` is compared against ' +
                '`created_at` and NOT against an SSE frame id on purpose: the frame counter falls ' +
                'back to a process-local sequence starting at 0 whenever Valkey is unavailable, ' +
                'so it is not durable across a Valkey restart and is unusable as a cursor. ' +
                'Do not "fix" this to use frame ids. ' +
                'A `pinned` array of currently-pinned administrator announcements accompanies ' +
                'the FIRST page (a request with no `?cursor=`) and any `?since=` delta, and is ' +
                'omitted from every cursor continuation — a client accumulating pages must not ' +
                'clear its pinned block when a later page omits the field. `pinned` is ' +
                'UNPAGINATED (the cursor does not walk it) and NEVER appears inside `items`: a ' +
                'currently-pinned row is excluded from `items` for as long as the pin holds, so ' +
                'render `pinned` above the list rather than merging and de-duplicating. When a ' +
                'pin is removed or its expiry passes, the row reappears in `items` at its ' +
                'original chronological position on the next fetch; there is no wire event for ' +
                'unpinning. ' +
                FORWARD_COMPAT_CONTRACT,
            query: z.object({
                unread: z
                    .enum(['true', 'false'])
                    .optional()
                    .meta({ description: 'Return only unread notifications' }),
                limit: z.coerce
                    .number()
                    .min(1)
                    .max(100)
                    .optional()
                    .meta({ description: 'Max rows (default 50)' }),
                cursor: z
                    .string()
                    .optional()
                    .meta({ description: 'Opaque cursor from a previous page.nextCursor' }),
                since: z
                    .string()
                    .optional()
                    .meta({ description: 'ISO instant; return rows created after it' }),
            }),
            responses: {
                200: {
                    schema: InboxNotificationsResponseSchema,
                    description: 'Notification inbox',
                },
                401: 'Authentication required',
                422: 'Malformed cursor or since',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: NotificationsQuerySchema,
    },
    handlers: {
        /**
         * GET /api/v1/notifications
         *
         * Returns the paginated notification inbox for the authenticated user.
         *
         * Query params:
         *   unread    boolean  — when "true", return only unread notifications
         *   limit     number   — max rows (1–100, default 50)
         *   cursor    string   — opaque keyset cursor from page.nextCursor
         *   since     string   — ISO instant; rows created strictly after it
         */
        GET: async (event, ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const params = event.url.searchParams;
            const unreadOnly = params.get('unread') === 'true';
            const limitRaw = params.get('limit');
            const limit = limitRaw ? Math.min(Math.max(1, parseInt(limitRaw, 10) || 50), 100) : 50;

            // Both are validated HERE rather than left to the SQL layer: each is
            // interpolated into a `::timestamptz`/`::uuid` cast, where a
            // malformed value makes Postgres throw and mount.ts report a 500 for
            // what is really the caller's bad input.
            const cursorRaw = params.get('cursor');
            const cursor = cursorRaw ? decodeNotificationCursor(cursorRaw) : null;
            if (cursorRaw && !cursor) {
                return ApiProblem.validationFailed([
                    { field: 'cursor', message: 'Malformed or unrecognized cursor' },
                ]);
            }

            const sinceRaw = params.get('since');
            if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
                return ApiProblem.validationFailed([
                    { field: 'since', message: 'Expected an ISO-8601 timestamp' },
                ]);
            }

            const { items: rows, hasMore } = await listNotifications(sql, {
                userId,
                unreadOnly,
                limit,
                ...(cursor ? { cursor } : {}),
                ...(sinceRaw ? { since: sinceRaw } : {}),
            });

            // One locale for the whole page. `getLocale()` is Paraglide's own
            // request-scoped resolution (cookie → Accept-Language → base), the
            // same one every other localized surface reads, narrowed to the two
            // locales the notification text actually has messages for.
            const locale = resolvePushLocale(getLocale());
            // `userId` is destructured off rather than spread through: this is a
            // self-only endpoint, so every row would carry the caller's own id
            // back to them — noise on the wire that a client could mistake for a
            // meaningful field.
            const items = rows.map(({ userId: _self, ...row }) => ({
                ...row,
                ...buildNotificationPresentation(row, { locale, surface: ctx.surface }),
            }));

            // Minted from the last row KEPT, not from the over-fetched probe row
            // — the cursor has to name where this page ended.
            const last = rows[rows.length - 1];
            const nextCursor = hasMore && last ? encodeNotificationCursor(last) : null;

            // Pinned announcements ride along with the FIRST page and with a
            // `?since=` delta, never with a cursor continuation.
            //
            // The cursor case is the one worth arguing. `pinned` is a small,
            // unpaginated set that is identical on every page, so repeating it
            // on page four would be pure waste — but the real reason is that a
            // client accumulating pages APPENDS `items` while it REPLACES
            // `pinned`, and re-sending an unchanged block invites a client to
            // treat it as a delta it must merge. Sending it exactly where a
            // client would replace, and nowhere else, keeps that unambiguous.
            //
            // `since` is included even though it is a delta, and deliberately
            // so: it is the reconnect path, and the disconnection is precisely
            // when a pin the client never saw could have been placed. The set
            // is small and the assignment is idempotent, so the cost of always
            // sending it is far below the cost of a client that silently never
            // learns about a pin.
            //
            // Each entry carries `pinnedAt`, exactly as `GET /notifications/{id}`
            // does for the same row, and by the same spread-on-presence rule:
            // `pinnedAt` IS the wire definition of "pinned", so a client
            // suppresses its dismiss affordance on that presence and the schema
            // gives `pinnedAt: null` no meaning. `isPinned` is destructured off
            // rather than emitted — it and `pinnedAt` are one fact, and only
            // `pinnedAt` is declared.
            const includePinned = !cursor;
            const pinned = includePinned
                ? (await listPinnedBroadcastsForUser(sql, userId)).map(
                      ({ userId: _self, isPinned: _isPinned, pinnedAt, ...row }) => ({
                          ...row,
                          ...(pinnedAt !== null ? { pinnedAt } : {}),
                          ...buildNotificationPresentation(row, { locale, surface: ctx.surface }),
                      }),
                  )
                : null;

            return json({
                items,
                // Spread-on-presence: an explicit `pinned: undefined` and a
                // missing key serialize identically, but keeping the key out
                // entirely means anything inspecting the object before
                // serialization (the contract test, a future middleware) sees
                // the same "absent" the client will.
                ...(pinned !== null ? { pinned } : {}),
                page: { limit, hasMore: nextCursor !== null, nextCursor },
            });
        },
    },
});

// ---------------------------------------------------------------------------
// Unread count sub-route (mounted at /notifications/unread-count)
// ---------------------------------------------------------------------------

export const unreadCountDef = defineEndpoint({
    // OpenAPI docs for the /api/v1/notifications/unread-count surface. Migrated
    // verbatim from the retired
    // src/routes/api/v1/notifications/unread-count/_openapi.ts.
    docs: {
        GET: {
            tags: ['Notifications'],
            summary: 'Get unread notification count',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the total count of unread notifications for the authenticated user. ' +
                'Fast path for the notification badge — no pagination, just a count. ' +
                'Response is `private, no-cache`.',
            responses: {
                200: {
                    schema: z.object({
                        count: z
                            .number()
                            .int()
                            .meta({ description: 'Number of unread notifications' }),
                    }),
                    description: 'Unread notification count',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'user' },
    handlers: {
        /**
         * GET /api/v1/notifications/unread-count
         *
         * Returns { count: number } — fast path for the notification badge.
         */
        GET: async (event, _ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const count = await countUnread(sql, userId);
            return json({ count }, { headers: { 'Cache-Control': 'private, no-cache' } });
        },
    },
});

// ---------------------------------------------------------------------------
// Read-all sub-route (mounted at /notifications/read-all)
// ---------------------------------------------------------------------------

export const readAllDef = defineEndpoint({
    // OpenAPI docs for the /api/v1/notifications/read-all surface. Migrated
    // verbatim from the retired
    // src/routes/api/v1/notifications/read-all/_openapi.ts.
    docs: {
        POST: {
            tags: ['Notifications'],
            summary: 'Mark all notifications as read',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Marks all unread notifications as read for the authenticated user. ' +
                'Returns the ids it actually flipped alongside the count, so a client can ' +
                'reconcile its own list in place instead of refetching to discover which rows ' +
                'changed. Rows already read before the call are not included.',
            responses: {
                200: {
                    schema: z.object({
                        updated: z
                            .number()
                            .meta({ description: 'Number of notifications marked as read' }),
                        ids: z
                            .array(z.string())
                            .meta({ description: 'Ids of the rows this call marked as read' }),
                    }),
                    description: 'Notifications marked as read',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'user' },
    handlers: {
        /**
         * POST /api/v1/notifications/read-all
         *
         * Marks all unread notifications as read.
         * Returns { updated: number, ids: string[] }.
         */
        POST: async (event, _ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rows = await markAllRead(sql, userId);

            // "Mark all read" dismisses every fulfilled request in the inbox,
            // so each one has to reach the flag surfaces too — otherwise
            // clearing the badge leaves the popup and the For-You rail still
            // showing the same items. One sync per row, fire-and-forget.
            for (const row of rows) {
                scheduleDismissalSyncForInboxRow(sql, userId, row);
            }

            // The rows were already in hand for the dismissal sync above —
            // reporting only their count and throwing the ids away is what
            // forced every client into a blind refetch.
            return json({ updated: rows.length, ids: rows.map((row) => row.id) }, { status: 200 });
        },
    },
});
