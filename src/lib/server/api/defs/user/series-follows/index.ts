// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isAvailableExpr } from '$lib/server/database/queries/availability.queries.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserFlags } from '$lib/server/database/queries/user-media-flags.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';

/**
 * The upcoming-episodes list includes followed series, so a follow change must
 * not wait out that list's per-user cache. Best-effort: a failed delete only
 * leaves the list stale until its TTL.
 */
export async function invalidateUpcoming(userId: string): Promise<void> {
    try {
        await cacheManager.for(CACHE_NAMESPACES.upcomingEpisodes).deleteUserCache(userId);
    } catch {
        // stale for at most the cache TTL
    }
}

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
});
export const FollowedSeriesListSchema = z.object({
    items: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
    page: z.object({ limit: z.number().int(), offset: z.number().int(), hasMore: z.boolean() }),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: QuerySchema },
    docs: {
        GET: {
            tags: ['Watchlist'],
            summary: 'List followed series',
            stability: 'stable',
            auth: 'bearer',
            query: QuerySchema,
            responses: {
                200: {
                    schema: FollowedSeriesListSchema,
                    description: 'Followed accessible series',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const flags = await getUserFlags.all(sql, {
                userId: user.userId,
                flagType: 'series_episode_notifications',
            });
            const items: Array<{ id: string; title: string }> = [];
            for (const flag of flags) {
                if (!(await checkMediaAccess(sql, flag.target_id, user))) continue;
                const rows = await sql<{ id: string; title: string; media_type: string }[]>`
                    SELECT mi.id::text, mi.title, mi.media_type FROM media_items mi
                    WHERE mi.id = ${flag.target_id}::uuid
                      AND ${isAvailableExpr(sql)} AND mi.status = 'active' AND mi.is_dismissed = false
                `;
                const row = rows[0];
                if (row?.media_type === 'tv') items.push({ id: row.id, title: row.title });
            }
            items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
            const { limit, offset } = ctx.input!.query;
            return json(
                paginate(items.slice(offset, offset + limit), {
                    limit,
                    offset,
                    hasMore: items.length > offset + limit,
                }),
            );
        },
    },
});
