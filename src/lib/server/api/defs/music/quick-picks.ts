// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/music/quick-picks
 * Also published at POST /api/v1/music/quick-picks (beta).
 *
 * AI-ranked music quick picks for the current user, for infinite-scroll
 * "load more" UIs.
 *
 * Body: { limit?: number, excludeIds?: string[] }
 * Response: bare object { items: UniversalMediaItem[], exhausted: boolean }
 * DB-down → 503 dependency_unavailable.
 * Rate limited per user (this query is a multi-bucket AI-ranking pipeline —
 * expensive enough to need a cap now that it's reachable by any bearer client,
 * not just the authenticated dashboard).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { getRecentlyPlayed } from '$lib/server/database/queries/music.queries.js';
import { getQuickPicks } from '$lib/server/services/music/quick-picks.service.js';
import { buildQuickPicksSection } from '$lib/server/utils/music-section-builder.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { MusicQuickPicksResponseSchema } from '$lib/schemas/api-music-responses.js';

const ARTIFACT_TITLES = new Set(['cover', 'folder', 'front', 'back']);
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const MAX_EXCLUDE_IDS = 1000;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_S = 60;

export const BodySchema = z.object({
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
    excludeIds: z.array(z.string()).max(MAX_EXCLUDE_IDS).optional().default([]),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { body: BodySchema },

    docs: {
        POST: {
            tags: ['Music'],
            summary: 'Get quick picks for the current user',
            stability: 'beta',
            auth: 'bearer',
            description: `AI-ranked personalized track recommendations, intended for infinite-scroll "load more" UIs — pass previously-seen track ids in \`excludeIds\` on subsequent calls. Rate limited to ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_S}s per user. Each item's \`id\` is the playable track UUID; \`itemKey\` is its carousel identity.`,
            body: BodySchema,
            responses: {
                200: { schema: MusicQuickPicksResponseSchema, description: 'Ranked tracks' },
                401: 'Authentication required',
                429: 'Rate limit exceeded',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const { limit } = ctx.input!.body;
            const excludeIds = ctx
                .input!.body.excludeIds.map((id) => id.trim())
                .filter((id) => id.length > 0)
                .slice(0, MAX_EXCLUDE_IDS);

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            // DB-availability is checked before the rate limit: every request is
            // guaranteed to 503 while the DB is down, so checking the limit first
            // would burn an authenticated caller's Valkey rate-limit budget on
            // requests that can never succeed anyway.
            const rl = await checkRateLimit(
                `music:quick-picks:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            const recentlyPlayed = await getRecentlyPlayed(sql, user.userId, 20);
            const recentlyPlayedIds = recentlyPlayed
                .filter((track) => !ARTIFACT_TITLES.has(track.title.toLowerCase()))
                .map((track) => track.id);

            const accessCtx = await buildSearchAccessContext(sql, user);
            const tracks = await getQuickPicks(
                sql,
                user.userId,
                limit,
                [...recentlyPlayedIds, ...excludeIds],
                {
                    deniedGroupIds: accessCtx.deniedGroupIds,
                    ageRating: accessCtx.ageRating,
                },
            );
            const section = buildQuickPicksSection(tracks, ctx.surface);

            return withRateLimitHeaders(
                json({
                    items: section?.items ?? [],
                    exhausted: tracks.length < limit,
                }),
                rl,
            );
        },
    },
});
