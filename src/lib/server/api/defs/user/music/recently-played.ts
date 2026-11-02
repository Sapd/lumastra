// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * GET /api/me/music/recently-played?limit=<n> — published at
 * GET /api/v1/me/music/recently-played (beta).
 *
 * The current user's most recently played tracks, most recent first.
 * No offset/cursor — the underlying query is a flat top-N, matching every
 * other internal caller of getRecentlyPlayed. Response: { items, page: { limit,
 * truncated } }; one extra row is fetched to tell a full list from a cut one.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getRecentlyPlayed } from '$lib/server/database/queries/music.queries.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { MusicRecentlyPlayedResponseSchema } from '$lib/schemas/api-music-responses.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Music'],
            summary: "Get the current user's recently played tracks",
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the most recently played tracks for the current user, most recent first. Flat top-N list, no pagination; `page.truncated` is true when more were played than `limit`.',
            query: QuerySchema,
            responses: {
                200: {
                    schema: MusicRecentlyPlayedResponseSchema,
                    description: 'Recently played tracks',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { limit } = parsePagination(event.url, {
                defaultLimit: DEFAULT_LIMIT,
                maxLimit: MAX_LIMIT,
            });

            // One extra row tells a full list from a truncated one.
            const fetched = await getRecentlyPlayed(sql, user.userId, limit + 1);
            const truncated = fetched.length > limit;
            const rows = truncated ? fetched.slice(0, limit) : fetched;
            const accessCtx = await buildSearchAccessContext(sql, user);
            const accessible = await filterAccessibleRows(
                sql,
                rows,
                searchAccessBoundary(accessCtx),
            );

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                accessible.map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            return json({
                items: accessible.map((row) => toMusicTrack(row, imageSets.get(row.id) ?? {})),
                page: { limit, truncated },
            });
        },
    },
});
