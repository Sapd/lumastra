// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * GET /api/me/music/top-tracks?limit=<n> — published at
 * GET /api/v1/me/music/top-tracks (beta).
 *
 * The current user's most-played tracks (all-time play count, with a
 * skip-count burnout penalty baked into the underlying query). No
 * time-window param — matches the existing AI-assistant tool's contract.
 * Response: { items, page: { limit, truncated } }.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getMostPlayedTracks } from '$lib/server/database/queries/music-quick-picks.queries.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { MusicTopTracksResponseSchema } from '$lib/schemas/api-music-responses.js';

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
            summary: "Get the current user's most-played tracks",
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns tracks ranked by all-time play count (with a skip-count penalty). No time-window filter. `page.truncated` is true when more tracks than `limit` qualify.',
            query: QuerySchema,
            responses: {
                200: {
                    schema: MusicTopTracksResponseSchema,
                    description: 'Most-played tracks',
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

            const accessCtx = await buildSearchAccessContext(sql, user);
            // One extra row tells a full list from a truncated one.
            const fetched = await getMostPlayedTracks(
                sql,
                user.userId,
                limit + 1,
                accessCtx.deniedGroupIds,
                accessCtx.ageRating,
            );
            const truncated = fetched.length > limit;
            const rows = truncated ? fetched.slice(0, limit) : fetched;

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                rows.map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            return json({
                items: rows.map((row) => toMusicTrack(row, imageSets.get(row.id) ?? {})),
                page: { limit, truncated },
            });
        },
    },
});
