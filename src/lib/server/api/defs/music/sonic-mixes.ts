// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/sonic-mixes.ts
 *
 * GET /api/music/sonic-mixes — also published at
 * GET /api/v1/music/sonic-mixes (beta).
 *
 * The sonic mix listing: { items: MusicCluster[] }. A cluster's member tracks are a separate
 * resource: see defs/music/sonic-mixes/[id]/tracks.ts.
 *
 * Gating: features.musicClusters (FEATURE_MUSIC_CLUSTERS && FEATURE_MUSIC_SONIC &&
 *         FEATURE_AI_RECOMMENDATIONS).
 * Auth:   any authenticated user.
 *
 * Each cluster carries `images.primary`, the cover collage of its distinct albums.
 *
 * Errors → application/problem+json.
 *   503 dependency_unavailable when the AI-DB is down (NEVER 200-empty).
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
import {
    getClusters,
    CLUSTER_MODEL_ID,
    type ClusterRow,
} from '$lib/server/database/queries/audio-clusters.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { musicCollageImages } from '$lib/server/services/music/collage-images.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    MusicClustersResponseSchema,
    type MusicCluster,
    type MusicClustersResponse,
} from '$lib/schemas/api-music-responses.js';

const logger = Logger.for('MusicClustersDef');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Cluster rows → response items
// ---------------------------------------------------------------------------

async function clusterRowsToItems(
    sql: NonNullable<Awaited<ReturnType<typeof aiDbService.getSql>>>,
    surface: ApiSurface,
    rows: ClusterRow[],
): Promise<MusicCluster[]> {
    const imageSets = await resolveImageSets(
        sql,
        surface,
        [...new Set(rows.flatMap((row) => row.cover_media_ids))].map((id) => ({
            id,
            mediaType: 'track',
        })),
    );
    return rows.map((row) => {
        const images = musicCollageImages(row.cover_media_ids, surface, imageSets);
        const item: MusicCluster = {
            id: row.cluster_id,
            label: row.label,
            trackCount: row.track_count,
            topGenres: row.top_genres,
            topArtists: row.top_artists,
        };
        return images.primary ? { ...item, images } : item;
    });
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'musicClusters', then: { kind: 'user' } },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List sonic mixes',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Lists the library’s sonic clusters (“Sonic Mixes”). `id` is stable across re-clustering: a cluster keeps its id while it is still recognisably the same sound, and an id that disappears is never reused. Fetch the members with GET /api/v1/music/sonic-mixes/{id}/tracks. Requires the musicClusters feature; an empty `items` array means no clustering has run or none of it is visible to the caller.',
            query: querySchema,
            responses: {
                200: {
                    schema: MusicClustersResponseSchema,
                    description: 'Full sonic mix listing.',
                },
                401: 'Authentication required',
                404: 'musicClusters feature is not enabled',
                500: 'Lookup failed — transient, retry',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        query: querySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const accessCtx = await buildSearchAccessContext(sql, user);
            // Required-by-shape boundary for the query module. `accessCtx` itself
            // still keys the cache below — scopedCacheKey partitions on the same
            // two axes this boundary encodes (plus livetv/lib-only), so the SQL
            // predicate and the cache key cannot drift apart.
            const access = searchAccessBoundary(accessCtx);

            // The cover hrefs are surface-specific, so the surface is in the key.
            const listCacheKey = scopedCacheKey(`v2:${ctx.surface}:music-clusters`, accessCtx);
            const listCache = cacheManager.for(CACHE_NAMESPACES.musicClusters);

            const cached = MusicClustersResponseSchema.safeParse(
                await listCache.get<unknown>(listCacheKey),
            );
            if (cached.success) {
                return json(cached.data);
            }

            const clusters: ClusterRow[] = await getClusters(sql, CLUSTER_MODEL_ID, access);

            logger.debug('Cluster list fetched', {
                username: user.username,
                count: clusters.length,
            });

            const payload: MusicClustersResponse = {
                items: await clusterRowsToItems(sql, ctx.surface, clusters),
            };

            if (clusters.length > 0) {
                await listCache.set(listCacheKey, payload);
            }

            return json(payload);
        },
    },
});
