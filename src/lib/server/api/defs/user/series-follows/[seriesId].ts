// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { removeFlag, setFlag } from '$lib/server/database/queries/user-media-flags.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { invalidateUpcoming } from './index.js';

const SeriesIdParamsSchema = z.object({ seriesId: z.string().uuid() });
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { params: SeriesIdParamsSchema },
    docs: {
        PUT: {
            tags: ['Watchlist'],
            summary: 'Follow a series',
            stability: 'stable',
            auth: 'bearer',
            params: SeriesIdParamsSchema,
            responses: {
                204: 'Series followed',
                401: 'Authentication required',
                404: 'Series not found or not accessible',
                422: 'Validation failed',
                503: 'Database unavailable',
            },
        },
        DELETE: {
            tags: ['Watchlist'],
            summary: 'Unfollow a series',
            stability: 'stable',
            auth: 'bearer',
            params: SeriesIdParamsSchema,
            responses: {
                204: 'Series unfollowed',
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        PUT: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { seriesId } = ctx.input!.params;
            if (!(await checkMediaAccess(sql, seriesId, user)))
                return ApiProblem.notFound('Series');
            const rows = await sql<{ exists: boolean }[]>`
                SELECT EXISTS(SELECT 1 FROM media_items WHERE id = ${seriesId}::uuid AND media_type = 'tv') AS exists
            `;
            if (!rows[0]?.exists) return ApiProblem.notFound('Series');
            await setFlag.execute(sql, {
                userId: user.userId,
                targetId: seriesId,
                targetType: 'series',
                flagType: 'series_episode_notifications',
            });
            await invalidateUpcoming(user.userId);
            return new Response(null, { status: 204 });
        },
        DELETE: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { seriesId } = ctx.input!.params;
            await removeFlag(sql, {
                userId: user.userId,
                targetId: seriesId,
                flagType: 'series_episode_notifications',
            });
            await invalidateUpcoming(user.userId);
            return new Response(null, { status: 204 });
        },
    },
});
