// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/PUT /api/integrations/trakt/direction — the current user's configured
 * watch-sync direction ('both'|'pull'|'push') for the Trakt connection.
 *
 * PUT is rate-limited (10 req / 60 s per user) — cheap DB write, but a
 * client-side retry loop would otherwise hammer watch_sync_preferences.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPreference,
    setDirection,
} from '$lib/server/database/queries/watch-sync-preferences.queries.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    DirectionSchema,
    SyncDirectionResponseSchema,
} from '$lib/schemas/api-integrations-responses.js';

const PROVIDER = 'trakt';
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_S = 60;

export const traktDirectionDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        body: z.object({ direction: DirectionSchema }),
    },
    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const pref = await getPreference(sql, user.userId, PROVIDER);
            return json(
                SyncDirectionResponseSchema.parse({
                    provider: PROVIDER,
                    direction: pref.direction,
                }),
            );
        },
        PUT: async (event, ctx) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rl = await checkRateLimit(
                `watch-sync-direction:${PROVIDER}:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            const { direction } = ctx.input!.body;
            await setDirection(sql, user.userId, PROVIDER, direction);
            return json(SyncDirectionResponseSchema.parse({ provider: PROVIDER, direction }));
        },
    },
});
