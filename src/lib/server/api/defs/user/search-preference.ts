// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/search-preference.ts — GET /user/search-preference
 *                                   POST /user/search-preference
 *
 * Replaces the createPreferenceHandlers factory route.
 * Returns a bare object: { fulltextSearch: boolean }.
 * Auth: {kind:'user'} — self-scoped.
 * Errors: problem+json.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';

const SearchPrefBody = z.object({
    fulltextSearch: z.boolean(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: {
        body: SearchPrefBody,
    },
    handlers: {
        /**
         * GET /user/search-preference
         * Returns the authenticated user's fulltext search preference.
         */
        GET: async (event, _ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const rows = await sql<{ fulltext_search: boolean }[]>`
                SELECT fulltext_search
                FROM user_search_preferences
                WHERE user_id = ${userId}::uuid
            `.catch(() => []);

            const fulltextSearch = rows[0]?.fulltext_search ?? false;
            return json({ fulltextSearch });
        },

        /**
         * POST /user/search-preference
         * Updates the authenticated user's fulltext search preference.
         */
        POST: async (event, ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const body = ctx.input?.body as { fulltextSearch: boolean } | undefined;
            if (body === undefined) {
                return ApiProblem.validationFailed([
                    { field: 'body.fulltextSearch', message: 'Required boolean field' },
                ]);
            }
            const { fulltextSearch } = body;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            await sql`
                INSERT INTO user_search_preferences (user_id, fulltext_search, updated_at)
                VALUES (${userId}::uuid, ${fulltextSearch}, NOW())
                ON CONFLICT (user_id)
                DO UPDATE SET
                    fulltext_search = ${fulltextSearch},
                    updated_at = NOW()
            `;

            return json({ fulltextSearch });
        },
    },
});
