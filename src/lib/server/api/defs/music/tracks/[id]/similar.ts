// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/tracks/[id]/similar.ts
 *
 * GET /api/music/tracks/{id}/similar?basis=auto|metadata|sonic&limit=
 * Also published at GET /api/v1/music/tracks/{id}/similar (beta).
 *
 * Tracks similar to a seed track, by one of two bases:
 *   - metadata: text embedding plus audio features (getSimilarTracks);
 *   - sonic:    MSCLAP audio embeddings (findSonicNeighbors, cached and
 *               single-flighted). Needs features.sonicEmbeddings.
 * `auto` (default) takes sonic when the server has sonic embeddings and the
 * track has accessible sonic neighbours, else metadata. The response says
 * which was used in `source`.
 *
 * Response: { items, source, page: { limit, truncated } }. Each item is a
 * Track with `similarityScore` (cosine in [-1, 1], 4 decimals).
 *
 * Access gating: the seed track passes the library + age gate (404 if not);
 * result tracks are filtered by library + age.
 *
 * Errors: problem+json incl. 503 dependency_unavailable on DB-down;
 * basis=sonic without the sonicEmbeddings feature → 422.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { features } from '$lib/server/config.js';
import { getTrackDetail, getSimilarTracks } from '$lib/server/database/queries/music.queries.js';
import {
    findSonicNeighbors,
    type SonicNeighborRow,
} from '$lib/server/database/queries/sonic-similarity.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { SimilarTracksResponseSchema } from '$lib/schemas/api-music-responses.js';

const logger = Logger.for('MusicSimilarTracksDef');

const querySchema = z.object({
    basis: z.enum(['auto', 'metadata', 'sonic']).optional().default('auto').meta({
        description:
            'What "similar" means. `metadata`: text embedding plus audio features (BPM, key, energy). `sonic`: audio embeddings, i.e. timbre and production; needs the server to have sonic embeddings, otherwise 422. `auto` (default): `sonic` when available and the track has sonic neighbours, else `metadata`. The response `source` says which was used.',
    }),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .meta({ description: 'Maximum tracks to return (default 20, max 50)' }),
});

const paramsSchema = z.object({ id: z.string().min(1) });

function roundScore(score: number): number {
    return Math.round(score * 10000) / 10000;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get similar tracks',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Tracks similar to the given track. `basis` picks the notion of similarity: `metadata` (text embedding plus audio features), `sonic` (audio embeddings; requires a server with sonic embeddings, else 422) or `auto` (sonic when available and the track has neighbours, otherwise metadata). `source` in the response tells which basis produced `items`. Every item carries `similarityScore` (cosine similarity in [-1, 1]) when the basis has one. `page.truncated` is true when more similar tracks exist than `limit`.',
            query: querySchema,
            responses: {
                200: {
                    schema: SimilarTracksResponseSchema,
                    description: 'Similar tracks',
                },
                401: 'Authentication required',
                404: 'Track not found or not accessible',
                422: 'Invalid query, or basis=sonic on a server without sonic embeddings',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        params: paramsSchema,
        query: querySchema,
    },
    visibility: 'public',
    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const trackId = event.params.id;
            if (!trackId) return ApiProblem.validationFailed('Missing track ID');

            const basis = ctx.input?.query?.basis ?? 'auto';
            const limit = ctx.input?.query?.limit ?? 20;

            if (basis === 'sonic' && !features.sonicEmbeddings) {
                return ApiProblem.validationFailed([
                    {
                        field: 'basis',
                        message:
                            'basis=sonic needs sonic embeddings, which this server does not have. Use basis=metadata or basis=auto.',
                    },
                ]);
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const sourceTrack = await getTrackDetail(sql, trackId);
            if (!sourceTrack) return ApiProblem.notFound('Track not found');

            // Library + age gate on the source track.
            if (!(await checkMediaAccess(sql, sourceTrack.id, user))) {
                return ApiProblem.notFound('Track not found');
            }

            const accessCtx = await buildSearchAccessContext(sql, user);
            const boundary = searchAccessBoundary(accessCtx);

            // ---------------------------------------------------------------
            // Sonic basis
            // ---------------------------------------------------------------
            if ((basis === 'sonic' || basis === 'auto') && features.sonicEmbeddings) {
                try {
                    // limit+1 detects truncation. findSonicNeighbors is a genuine
                    // HNSW-eligible ORDER BY embedding <=> seed LIMIT n probe, but
                    // still costs a DB roundtrip and join on every open, and results
                    // only change when embeddings or the library change, so cache it.
                    // Library/age access is baked into the SQL filter, so the key MUST
                    // be access-scoped (scopedCacheKey), never a plain per-track key.
                    const similarCache = cacheManager.for(CACHE_NAMESPACES.musicSimilarTracks);
                    const similarKey = scopedCacheKey('music-similar-tracks', accessCtx, [
                        trackId,
                        limit + 1,
                    ]);
                    let rows = await similarCache.get<SonicNeighborRow[]>(similarKey);
                    if (!rows) {
                        // Single-flight so concurrent opens of the same track modal
                        // (or a cold cache after deploy) don't stampede the DB.
                        const ns = CACHE_NAMESPACES.musicSimilarTracks;
                        const jsonStr = await getOrComputeSingleFlight({
                            cacheKey: `${ns.name}:${similarKey}`,
                            ttlSeconds: Math.floor(ns.l2TTL / 1000),
                            lockTtlSeconds: 30,
                            compute: async () =>
                                JSON.stringify(
                                    await findSonicNeighbors(sql, trackId, limit + 1, boundary),
                                ),
                        });
                        rows = JSON.parse(jsonStr) as SonicNeighborRow[];
                        // Populate L1 so subsequent in-process reads skip Valkey.
                        void similarCache.set(similarKey, rows);
                    }

                    if (rows.length > 0 || basis === 'sonic') {
                        const truncated = rows.length > limit;
                        const pageRows = rows.slice(0, limit);

                        logger.debug('Sonic similar tracks fetched', {
                            username: user.username,
                            trackId,
                            count: pageRows.length,
                        });

                        const imageSets = await resolveImageSets(
                            sql,
                            ctx.surface,
                            pageRows.map((row) => ({ id: row.media_id, mediaType: 'track' })),
                        );
                        return json({
                            items: pageRows.map((row) => ({
                                ...musicSearchRowToTrack(row, imageSets.get(row.media_id) ?? {}),
                                similarityScore: roundScore(row.similarity_score),
                            })),
                            source: 'sonic',
                            page: { limit, truncated },
                        });
                    }
                } catch (err) {
                    // basis=sonic keeps failing loudly; auto degrades to metadata.
                    if (basis === 'sonic') throw err;
                    logger.warn('Sonic similar tracks failed, falling back to metadata', {
                        trackId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            // ---------------------------------------------------------------
            // Metadata basis
            // ---------------------------------------------------------------
            // Overfetch before the access filter: rows the caller may not see are
            // dropped afterwards, and truncation must be judged on what is left.
            const rows = await getSimilarTracks(sql, trackId, limit * 3 + 1);
            const filteredRows = await filterAccessibleRows(sql, rows, boundary);

            const truncated = filteredRows.length > limit;
            const pageItems = filteredRows.slice(0, limit);

            logger.debug('Similar tracks fetched', {
                username: user.username,
                trackId,
                count: pageItems.length,
            });

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                pageItems.map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            return json({
                items: pageItems.map((row) => ({
                    ...toMusicTrack(row, imageSets.get(row.id) ?? {}),
                    ...(typeof row.similarity_score === 'number'
                        ? { similarityScore: roundScore(row.similarity_score) }
                        : {}),
                })),
                source: 'metadata',
                page: { limit, truncated },
            });
        },
    },
});
