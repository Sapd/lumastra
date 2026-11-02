// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getSyncActivity } from '$lib/server/database/queries/watch-sync-activity.queries.js';

/** GET /api/integrations/mal/activity — last ~15 sync items for the current user. */
export const malActivityDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return json({ items: [] });
            const items = await getSyncActivity(sql, {
                userId: user.userId,
                provider: 'mal',
                limit: 15,
            });
            return json({ items });
        },
    },
});
