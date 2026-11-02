// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import {
    getArtistSummaries,
    isMediaItemOfType,
} from '$lib/server/database/queries/music.queries.js';
import { toArtistSummary } from '$lib/server/services/music/track-projection.js';

/**
 * defs/music/artists/[id]/similar.ts
 *
 * GET /api/music/artists/{id}/similar — also published at
 * GET /api/v1/music/artists/{id}/similar (beta).
 *
 * Returns artists acoustically similar to the seed artist `[id]`, ranked by
 * cosine similarity against the centroid of all the seed artist's MSCLAP-2023
 * track embeddings.
 *
 * Gating: features.sonicEmbeddings (FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS).
 * Auth:   any authenticated user.
 *
 * Response shape: { items: SimilarArtist[], source: 'sonic', page: { limit, truncated } }
 *   Each artist carries a canonical `images{}` href map and a `similarityScore`.
 *
 * Errors → application/problem+json.
 *   503 dependency_unavailable when the AI-DB is down (NEVER 200-empty).
 *   404 not_found when the seed artist is not accessible to the caller.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    findSonicNeighborArtists,
    type SonicArtistNeighborRow,
} from '$lib/server/database/queries/sonic-similarity.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { SimilarArtistsResponseSchema } from '$lib/schemas/api-music-responses.js';

const logger = Logger.for('SimilarArtistsDef');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const querySchema = z.object({
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .meta({ description: 'Maximum items to return (default 10, max 50)' }),
});

const paramsSchema = z.object({
    id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'sonicEmbeddings', then: { kind: 'user' } },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get similar artists',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns artists whose aggregate acoustic profile is closest to the seed artist, using MSCLAP audio embeddings. Requires the sonicEmbeddings feature (404 when the server has none). `source` is always `sonic`; `similarityScore` is the cosine similarity in [-1, 1]; `page.truncated` is true when more than `limit` similar artists exist.',
            query: querySchema,
            responses: {
                200: {
                    schema: SimilarArtistsResponseSchema,
                    description: 'Acoustically similar artists',
                },
                401: 'Authentication required',
                404: 'Artist not found, not accessible, or sonicEmbeddings disabled',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        query: querySchema,
        params: paramsSchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const artistId = event.params.id;
            if (!artistId) return ApiProblem.validationFailed('Missing artist ID');

            const limit = ctx.input?.query?.limit ?? 10;

            const canAccess = await checkMediaAccess(sql, artistId, user);
            if (!canAccess) return ApiProblem.notFound('Artist not found or not accessible');
            if (!(await isMediaItemOfType(sql, artistId, 'artist'))) {
                return ApiProblem.notFound('Artist not found or not accessible');
            }

            const accessCtx = await buildSearchAccessContext(sql, user);

            // Bucket the caller-controlled limit before it enters the cache
            // key or the query. Without this, iterating limit=1..50 forces up
            // to 50 distinct full scans per artist (see findSonicNeighborArtists
            // comment below) since the 24h cache is keyed per-limit. Bucketing
            // collapses that to 3 cache keys (the extra row detects truncation); the response is still sliced
            // down to the caller's requested `limit` before it's returned.
            const cacheLimit = limit + 1 <= 11 ? 11 : limit + 1 <= 26 ? 26 : 51;

            // findSonicNeighborArtists computes a centroid over the seed
            // artist's tracks and then aggregates cosine similarity against
            // every other artist's embedded tracks via a plain JOIN + GROUP
            // BY — that shape can't use the HNSW index (only a literal-vector
            // ORDER BY ... LIMIT probe does), so it's a genuine full scan
            // that takes 15-20s on prod-sized libraries. Results only change
            // when embeddings are (re)computed or the library changes, so
            // cache aggressively. Library/age access is baked into the SQL
            // filter, so the key MUST be access-scoped (scopedCacheKey) —
            // never a plain per-artist key.
            const similarCache = cacheManager.for(CACHE_NAMESPACES.musicSimilarArtists);
            const similarKey = scopedCacheKey('music-similar-artists', accessCtx, [
                artistId,
                cacheLimit,
            ]);
            let rows = await similarCache.get<SonicArtistNeighborRow[]>(similarKey);
            if (!rows) {
                // Single-flight so concurrent opens of the same artist modal
                // (or a cold cache after deploy) don't stampede the DB with
                // this expensive scan in parallel. lockTtlSeconds is raised
                // well above the single-flight default (10s) because the
                // compute itself can take 15-20s.
                const ns = CACHE_NAMESPACES.musicSimilarArtists;
                const rawKey = `${ns.name}:${similarKey}`;
                const ttlSeconds = Math.floor(ns.l2TTL / 1000);
                const jsonStr = await getOrComputeSingleFlight({
                    cacheKey: rawKey,
                    ttlSeconds,
                    lockTtlSeconds: 30,
                    compute: async () =>
                        JSON.stringify(
                            await findSonicNeighborArtists(
                                sql,
                                artistId,
                                cacheLimit,
                                searchAccessBoundary(accessCtx),
                            ),
                        ),
                });
                rows = JSON.parse(jsonStr) as SonicArtistNeighborRow[];
                // Populate L1 so subsequent in-process reads skip Valkey.
                void similarCache.set(similarKey, rows);
            }

            // Truncation is judged on what the caller can see: neighbours dropped
            // by the summary join (access, no playable tracks) do not count.
            const summaries = new Map(
                (
                    await getArtistSummaries(
                        sql,
                        rows.map((row) => row.artist_id),
                        searchAccessBoundary(accessCtx),
                    )
                ).map((row) => [row.id, row]),
            );
            const visible = rows.filter((row) => summaries.has(row.artist_id));
            const truncated = visible.length > limit;
            const limited = visible.slice(0, limit);

            logger.debug('Sonic similar artists fetched', {
                username: user.username,
                artistId,
                count: limited.length,
            });

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                limited.map((row) => ({ id: row.artist_id, mediaType: 'artist' })),
            );
            return json({
                items: limited.flatMap((row) => {
                    const summary = summaries.get(row.artist_id);
                    return summary
                        ? [
                              {
                                  ...toArtistSummary(summary, imageSets.get(summary.id) ?? {}),
                                  similarityScore: Math.round(row.similarity_score * 10000) / 10000,
                              },
                          ]
                        : [];
                }),
                source: 'sonic',
                page: { limit, truncated },
            });
        },
    },
});
