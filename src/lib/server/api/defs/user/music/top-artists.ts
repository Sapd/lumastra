// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toArtistSummary } from '$lib/server/services/music/track-projection.js';

/**
 * GET /api/me/music/top-artists?limit=<n> — published at
 * GET /api/v1/me/music/top-artists (beta).
 *
 * The current user's most-played artists (all-time play count). Falls back
 * to a global "popular in the catalog" list (by album count) when the user
 * has no personal play history — each item's `source` field distinguishes
 * the two. Response: { items, page: { limit, truncated } }.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getArtistSummaries,
    getMostPlayedArtists,
    getTopArtistsByAlbumCount,
    type TopArtistRow,
} from '$lib/server/database/queries/music.queries.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { MusicTopArtistsResponseSchema } from '$lib/schemas/api-music-responses.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
});

/**
 * getTopArtistsByAlbumCount (the catalog-fallback branch) is a catalog-wide,
 * user-agnostic aggregation with a track-level JOIN + two correlated
 * per-row subqueries (buildLibraryAccessFilter) — reachable by any bearer
 * client with no play history. Rate limit the whole handler rather than
 * just the catalog branch; the personal branch is cheap enough that a
 * shared limit costs nothing there.
 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_S = 60;

async function toApiArtists(
    sql: Parameters<typeof getArtistSummaries>[0],
    rows: TopArtistRow[],
    source: 'personal' | 'catalog',
    surface: ApiSurface,
    access: Parameters<typeof getArtistSummaries>[2],
) {
    const summaries = new Map(
        (
            await getArtistSummaries(
                sql,
                rows.map((row) => row.id),
                access,
            )
        ).map((row) => [row.id, row]),
    );
    const imageSets = await resolveImageSets(
        sql,
        surface,
        rows.map((row) => ({ id: row.id, mediaType: 'artist' })),
    );
    return rows.flatMap((row) => {
        const summary = summaries.get(row.id);
        return summary
            ? [
                  {
                      ...toArtistSummary(summary, imageSets.get(summary.id) ?? {}),
                      playCount: row.play_count,
                      source,
                  },
              ]
            : [];
    });
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Music'],
            summary: "Get the current user's most-played artists",
            stability: 'beta',
            auth: 'bearer',
            description: `Returns artists ranked by the play count of the current user's tracks. Falls back to catalog-wide "popular artists" (by album count) when the user has no personal play history; check \`source\` on each item to tell the two apart. \`page.truncated\` is true when more artists than \`limit\` qualify. Rate limited to ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_S}s per user.`,
            query: QuerySchema,
            responses: {
                200: {
                    schema: MusicTopArtistsResponseSchema,
                    description: 'Most-played (or catalog-popular) artists',
                },
                401: 'Authentication required',
                429: 'Rate limit exceeded',
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

            // DB-availability is checked before the rate limit (matches
            // mood-recommendations.ts): every request is guaranteed to 503
            // while the DB is down, so checking the limit first would burn an
            // authenticated caller's Valkey rate-limit budget on requests
            // that can never succeed anyway.
            const rl = await checkRateLimit(
                `music:top-artists:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            const { limit } = parsePagination(event.url, {
                defaultLimit: DEFAULT_LIMIT,
                maxLimit: MAX_LIMIT,
            });

            const accessCtx = await buildSearchAccessContext(sql, user);
            // One extra row tells a full list from a truncated one.
            const personal = await getMostPlayedArtists(
                sql,
                user.userId,
                limit + 1,
                accessCtx.deniedGroupIds,
                accessCtx.ageRating,
            );

            if (personal.length > 0) {
                const truncated = personal.length > limit;
                return withRateLimitHeaders(
                    json({
                        items: await toApiArtists(
                            sql,
                            truncated ? personal.slice(0, limit) : personal,
                            'personal',
                            ctx.surface,
                            searchAccessBoundary(accessCtx),
                        ),
                        page: { limit, truncated },
                    }),
                    rl,
                );
            }

            const catalog = await getTopArtistsByAlbumCount(
                sql,
                limit + 1,
                accessCtx.deniedGroupIds,
                accessCtx.ageRating,
            );

            const catalogTruncated = catalog.length > limit;
            return withRateLimitHeaders(
                json({
                    items: await toApiArtists(
                        sql,
                        catalogTruncated ? catalog.slice(0, limit) : catalog,
                        'catalog',
                        ctx.surface,
                        searchAccessBoundary(accessCtx),
                    ),
                    page: { limit, truncated: catalogTruncated },
                }),
                rl,
            );
        },
    },
});
