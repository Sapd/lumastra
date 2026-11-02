// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { deleteTraktCredential } from '$lib/server/database/queries/trakt-credentials.queries.js';

/**
 * DELETE /api/integrations/trakt/link
 * Unlinks the current user's Trakt account. Bare empty object.
 */
export const traktLinkDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        DELETE: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            await deleteTraktCredential(sql, user.userId);
            try {
                await sql`DELETE FROM watch_sync_activity WHERE user_id = ${user.userId}::uuid AND provider = 'trakt'`;
            } catch {
                // best-effort cleanup — unlink already succeeded; database-cleanup prunes any leftovers
            }
            return json({});
        },
    },
});
