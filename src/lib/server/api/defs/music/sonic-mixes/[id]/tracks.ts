// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/sonic-mixes/[id]/tracks.ts
 *
 * GET /api/music/sonic-mixes/[id]/tracks[?limit=<n>] — also published at
 * GET /api/v1/music/sonic-mixes/{id}/tracks (beta).
 *
 * The member tracks of one sonic cluster, most representative first:
 * { items: Track[], page: { limit, offset, hasMore } }.
 *
 * Gating: features.musicClusters. Auth: any authenticated user.
 *
 * Errors → application/problem+json.
 *   404 not_found for a cluster id the model has never issued. A known cluster
 *       with nothing visible to the caller is 200 with empty `items`.
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
    clusterExists,
    getClusterMembers,
    CLUSTER_MODEL_ID,
} from '$lib/server/database/queries/audio-clusters.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    MusicClusterTracksResponseSchema,
    type MusicClusterTracksResponse,
} from '$lib/schemas/api-music-responses.js';

const logger = Logger.for('MusicClusterTracksDef');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const paramsSchema = z.object({
    id: z.coerce.number().int().min(0).max(2147483647),
});

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
});

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'musicClusters', then: { kind: 'user' } },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List the tracks of a sonic mix',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the member tracks of one sonic cluster the caller may see, most representative of the cluster first. Take the id from GET /api/v1/music/sonic-mixes. `page.hasMore` is true when the cluster has more visible tracks beyond the requested page. An empty `items` array means no visible tracks remain at this offset; a failed lookup is a 5xx, never an empty list. Requires the musicClusters feature.',
            query: querySchema,
            responses: {
                200: {
                    schema: MusicClusterTracksResponseSchema,
                    description: 'Cluster member tracks',
                },
                401: 'Authentication required',
                404: 'Unknown cluster id, or the musicClusters feature is not enabled',
                422: 'Invalid cluster id or limit',
                500: 'Lookup failed — transient, retry',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        params: paramsSchema,
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

            const clusterId = ctx.input?.params?.id ?? Number(event.params.id);
            const limit = ctx.input?.query?.limit ?? DEFAULT_LIMIT;
            const offset = ctx.input?.query?.offset ?? 0;

            // Before any cached read: a retired id must answer 404 even while
            // its members are still cached.
            if (!(await clusterExists(sql, CLUSTER_MODEL_ID, clusterId))) {
                return ApiProblem.notFound('Cluster not found');
            }

            const accessCtx = await buildSearchAccessContext(sql, user);
            const access = searchAccessBoundary(accessCtx);

            // Image hrefs are surface-specific, so the surface is in the key.
            const cacheKey = scopedCacheKey(
                `v5:${ctx.surface}:cluster-tracks:${clusterId}:limit=${limit}:offset=${offset}`,
                accessCtx,
            );
            const cache = cacheManager.for(CACHE_NAMESPACES.musicClusterMembers);

            const cached = MusicClusterTracksResponseSchema.safeParse(
                await cache.get<unknown>(cacheKey),
            );
            if (cached.success) {
                return json(cached.data);
            }

            // One lookahead row detects another page without an expensive count.
            const members = await getClusterMembers(
                sql,
                CLUSTER_MODEL_ID,
                clusterId,
                access,
                limit + 1,
                offset,
            );

            logger.debug('Cluster members fetched', {
                username: user.username,
                clusterId,
                count: members.length,
            });

            if (members.length === 0) {
                // A known cluster with no visible tracks left at this offset.
                return json({
                    items: [],
                    page: { limit, offset, hasMore: false },
                } satisfies MusicClusterTracksResponse);
            }

            const hasMore = members.length > limit;
            const page = hasMore ? members.slice(0, limit) : members;

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                page.map((row) => ({ id: row.media_id, mediaType: 'track' })),
            );
            const payload: MusicClusterTracksResponse = {
                items: page.map((row) =>
                    musicSearchRowToTrack(row, imageSets.get(row.media_id) ?? {}),
                ),
                page: { limit, offset, hasMore },
            };

            await cache.set(cacheKey, payload);

            return json(payload);
        },
    },
});
