// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/notifications/clear-all
 *
 * Deletes every notification in the caller's inbox except currently-pinned
 * administrator announcements (those refuse a single delete with 409 too).
 * Covers rows the drawer has not paged in yet: "clear all" means the inbox,
 * not the loaded page.
 *
 * Internal surface only (the web drawer). Response: { deleted: number }.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { deleteAllUnpinnedNotifications } from '$lib/server/database/queries/user-notifications.queries.js';
import { scheduleDismissalSyncForInboxRow } from '$lib/server/services/request-dismissal-sync.service.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        POST: async (event, _ctx) => {
            const userId =
                (event.locals.principal?.userId as string | undefined) ??
                event.locals.user?.userId ??
                null;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rows = await deleteAllUnpinnedNotifications(sql, userId);

            // Deleting a `request.available` row is a dismissal (see the single
            // DELETE), so the popup and For-You rail must hear about each one.
            for (const row of rows) {
                scheduleDismissalSyncForInboxRow(sql, userId, row);
            }

            return json({ deleted: rows.length }, { status: 200 });
        },
    },
});
