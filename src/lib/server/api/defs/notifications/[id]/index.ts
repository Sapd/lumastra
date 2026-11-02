// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/notifications/[id]/index.ts
 *
 *   GET    /api/v1/notifications/{id}  — read one notification
 *   DELETE /api/v1/notifications/{id}  — delete one notification
 *
 * Auth: {kind:'user'} — owner only (query enforces user_id match).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    deleteNotification,
    getNotificationForUser,
} from '$lib/server/database/queries/user-notifications.queries.js';
import { scheduleDismissalSyncForInboxRow } from '$lib/server/services/request-dismissal-sync.service.js';
import { buildNotificationPresentation } from '$lib/server/services/notification-display.service.js';
import { resolvePushLocale } from '$lib/server/services/push/push-payload.js';
import { getLocale } from '$lib/paraglide/runtime.js';
import { InboxNotificationItemSchema } from '$lib/schemas/notifications-types';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Notifications'],
            summary: 'Get one notification',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns a single notification owned by the authenticated user, in the same ' +
                'shape as an item from `GET /notifications`. ' +
                'Intended for HYDRATING a reference the client already holds — the ' +
                '`notificationId` on a live SSE frame, or the `id` in a tapped push payload — ' +
                'so a client never has to render a notification from `payload` itself. ' +
                'Unlike the list endpoint, this deliberately does NOT filter out EXPIRED rows: a ' +
                'push tapped days later must still resolve to the notification it was about, ' +
                'and hiding it would answer 404 for a row that exists. ' +
                'Returns 404 when the notification is absent OR belongs to another user — the ' +
                'two are indistinguishable by design, so the endpoint cannot be used to probe ' +
                'which ids exist. ' +
                'Unlike the list endpoint, this does not hide a PINNED row either: the list ' +
                'moves a pinned announcement into its own `pinned` block, but a lookup by id is ' +
                'answering "what is this notification", and a pinned one exists. Such a row ' +
                'carries `pinnedAt`. ' +
                '`link.target` is an OPEN set — new values may be added over time, and a client ' +
                'that does not recognize one MUST treat the link as absent (a readable, ' +
                'non-navigable row) rather than failing to decode the notification.',
            responses: {
                200: {
                    schema: InboxNotificationItemSchema,
                    description: 'The notification',
                },
                401: 'Authentication required',
                404: 'Notification not found',
                422: 'Malformed notification id',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Notifications'],
            summary: 'Delete a notification',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Deletes a single notification owned by the authenticated user. ' +
                'Returns 204 on success, 404 if the notification is not found or does not belong ' +
                'to the caller, and 422 if `{id}` is not a UUID. ' +
                'Returns 409 while the notification is a CURRENTLY-PINNED administrator ' +
                'announcement: an operator pinned it so it would stay visible, and a dismissal ' +
                'would undo that unilaterally. Marking it read (`POST .../{id}/read`) is still ' +
                'allowed and is the intended action — it clears the unread badge while the ' +
                'announcement stays pinned. The row becomes deletable on its own the moment the ' +
                'pin is removed or its expiry passes. A client should therefore not offer a ' +
                'dismiss affordance on a row carrying `pinnedAt`; the 409 is the backstop, not ' +
                'the primary mechanism.',
            responses: {
                204: 'Notification deleted',
                401: 'Authentication required',
                404: 'Notification not found',
                409: 'Notification is pinned and cannot be dismissed',
                422: 'Malformed notification id',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        // `uuid()`, not `min(1)`. The handler interpolates this straight into a
        // `::uuid` cast, and Postgres THROWS on a malformed one — which mount.ts
        // turns into a 500 `internal_error`. A caller who mistyped an id gets a
        // truthful 422 here instead of a server-fault status for their own bad
        // input.
        params: z.object({ id: z.string().uuid() }),
    },
    handlers: {
        /**
         * GET /api/v1/notifications/{id}
         *
         * Returns one notification owned by the caller, presented exactly as the
         * list endpoint presents it. 404 when absent or owned by someone else.
         */
        GET: async (event, ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const notificationId = event.params.id;
            if (!notificationId) return ApiProblem.notFound('Notification not found');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Owner-scoped in the SQL, not filtered afterwards — and 404 rather
            // than 403 for a row owned by someone else, matching DELETE, {id}/read
            // and the codebase-wide `resolveAndGate` convention. A 403 would
            // confirm the id exists.
            const row = await getNotificationForUser(sql, notificationId, userId);
            if (!row) return ApiProblem.notFound('Notification not found');

            const locale = resolvePushLocale(getLocale());
            // `isPinned` is destructured OFF the wire shape: it and `pinnedAt`
            // are the same fact, and `pinnedAt` is the one the schema declares.
            // Emitting both would put an undeclared field on a validated
            // response and hand clients two things to keep in sync.
            const { userId: _self, isPinned: _isPinned, pinnedAt, ...rest } = row;
            return json({
                ...rest,
                // Spread-on-presence, matching the schema's `.optional()`:
                // absent means not pinned, and `pinnedAt: null` would be a
                // third state the contract does not define.
                ...(pinnedAt !== null ? { pinnedAt } : {}),
                ...buildNotificationPresentation(row, { locale, surface: ctx.surface }),
            });
        },

        /**
         * DELETE /api/v1/notifications/{id}
         *
         * Deletes a notification owned by the caller.
         * Returns 204 on success, 404 if not found, 409 if currently pinned.
         */
        DELETE: async (event, _ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const notificationId = event.params.id;
            if (!notificationId) return ApiProblem.notFound('Notification id required');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Read before deleting, so a pinned announcement can be refused
            // rather than removed.
            //
            // This costs one extra round trip on every dismissal and that is the
            // right trade: the alternative — a `WHERE NOT EXISTS (…pinned…)`
            // predicate on the DELETE itself — is atomic but cannot tell "did
            // not exist" from "refused", so both would collapse into the same
            // 404 and a user would be told a notification they can see does not
            // exist. The window between the two statements is real but benign in
            // both directions: unpinned-then-deleted is what the user asked for,
            // and pinned-then-deleted loses a pin that was placed a millisecond
            // after the user pressed dismiss.
            //
            // The scoped read also does the 404 work for us, so the DELETE below
            // is not doing a second existence check for free.
            const existing = await getNotificationForUser(sql, notificationId, userId);
            if (!existing) return ApiProblem.notFound('Notification not found');
            if (existing.isPinned) {
                return ApiProblem.conflict(
                    'This announcement is pinned by an administrator and cannot be dismissed. ' +
                        'Mark it as read instead.',
                );
            }

            const deleted = await deleteNotification(sql, notificationId, userId);
            if (!deleted) return ApiProblem.notFound('Notification not found');

            // Deleting a `request.available` row IS a dismissal — reconcile it
            // to the `request_dismissed` flag surfaces (popup + For-You rail).
            // Fire-and-forget: a sync failure must not fail the delete.
            scheduleDismissalSyncForInboxRow(sql, userId, deleted);

            return new Response(null, { status: 204 });
        },
    },
});
