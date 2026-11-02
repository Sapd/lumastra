// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/homepage-reset-widgets.ts
 *
 * POST /api/admin/homepage/reset-widgets — reset all user home widget
 * orders and visibility back to admin-configured defaults by deleting
 * every user_widget_order row.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * POST → { resetCount: number }
 * 503  → dependency_unavailable when DB is down
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { deleteAllWidgetOrder } from '$lib/server/database/queries/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const logger = Logger.for('AdminHomepageReset');

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const deleted = await deleteAllWidgetOrder.execute(sql, {});
            const resetCount = deleted.length;

            logger.info('Reset all user home widgets to admin defaults', {
                resetCount,
                admin: event.locals.user?.username ?? null,
            });
            // Wipes every user's saved layout: an operator must be able to see who did it.
            auditLog('homepage.widgets.reset_all', 'config', auditActor(event), { resetCount });

            return json(
                { resetCount },
                { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
            );
        },
    },
});
