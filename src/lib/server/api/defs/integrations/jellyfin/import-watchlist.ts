// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/integrations/jellyfin/import-watchlist — one-time import of the
 * caller's Jellyfin Favorites (Movies + Series) into their Lumastra
 * watchlist. Idempotent; safe to call repeatedly.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { importJellyfinFavoritesToWatchlist } from '$lib/server/services/jellyfin-watchlist-import.service.js';

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_S = 60;

export const jellyfinImportWatchlistDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rl = await checkRateLimit(
                `jellyfin-import-watchlist:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            const result = await importJellyfinFavoritesToWatchlist(sql, user);
            if (!result.ok) {
                return ApiProblem.dependencyUnavailable(
                    'Jellyfin is not configured or unavailable',
                );
            }
            return json({
                imported: result.imported,
                skipped: result.skipped,
                total: result.total,
            });
        },
    },
});
