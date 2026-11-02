// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/notifications/[id]/read/index.ts
 *
 *   POST /api/v1/notifications/{id}/read  — mark one notification as read
 *
 * Auth: {kind:'user'} — owner only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { markRead } from '$lib/server/database/queries/user-notifications.queries.js';
import { scheduleDismissalSyncForInboxRow } from '$lib/server/services/request-dismissal-sync.service.js';

const ReadNotificationResponseSchema = z.object({
    id: z.string(),
    readAt: z.string().nullable().meta({ description: 'ISO-8601 timestamp when marked as read' }),
});

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Notifications'],
            summary: 'Mark a notification as read',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Marks a single notification as read. Idempotent: already-read notifications ' +
                'still return 200 with the current state. ' +
                'Returns 404 if the notification does not exist or does not belong to the caller, ' +
                'and 422 if `{id}` is not a UUID.',
            responses: {
                200: {
                    schema: ReadNotificationResponseSchema,
                    description: 'Notification read state',
                },
                401: 'Authentication required',
                404: 'Notification not found',
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
         * POST /api/v1/notifications/{id}/read
         *
         * Marks a single notification as read. Idempotent: already-read rows
         * still return 200 (the read is a no-op at the DB level).
         * Returns the updated notification row.
         */
        POST: async (event, _ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const notificationId = event.params.id;
            if (!notificationId) return ApiProblem.notFound('Notification id required');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // markRead returns null when not found or already read.
            // We re-fetch when already read to give the client the row either way.
            const updated = await markRead(sql, notificationId, userId);
            if (!updated) {
                // Either not found or already read — distinguish by trying a bare
                // SELECT (owner check included).
                const rows = await sql<{ id: string; read_at: Date | null }[]>`
                    SELECT id, read_at
                    FROM user_notifications
                    WHERE id = ${notificationId}::uuid
                      AND user_id = ${userId}::uuid
                    LIMIT 1
                `;
                if (rows.length === 0) return ApiProblem.notFound('Notification not found');
                // Already read — 200 with current state (idempotent)
                return json({ id: notificationId, readAt: rows[0].read_at?.toISOString() ?? null });
            }

            // Marking a `request.available` row read IS a dismissal — reconcile
            // it out to the `request_dismissed` flag surfaces. Only on the
            // transition (the `updated` branch): the already-read path above is
            // idempotent and re-firing the sync there would re-assert a flag the
            // user may since have cleared by re-requesting the media.
            scheduleDismissalSyncForInboxRow(sql, userId, updated);

            return json({ id: updated.id, readAt: updated.readAt });
        },
    },
});
