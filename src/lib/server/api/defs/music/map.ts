// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import type { MusicMapResponse } from '$lib/schemas/api-music-responses.js';

/**
 * defs/music/map.ts
 *
 * GET /api/music/map
 *
 * Returns the 2D UMAP projection of all accessible tracks' MSCLAP audio
 * embeddings, ready for the /music/map interactive starfield UI.
 *
 * Gating: features.musicMap (FEATURE_MUSIC_MAP && FEATURE_MUSIC_SONIC &&
 *         FEATURE_AI_RECOMMENDATIONS).
 * Auth:   any authenticated user.
 *
 * Response shape (bare object — not a paginated collection):
 *   {
 *     points: MapPoint[],
 *     hasCoords: boolean,
 *     embeddedCount: number,
 *     totalTracks: number,
 *     projectedCount: number,
 *   }
 *   Points use the existing snake_case field names (legacy UI contract — the
 *   starfield component reads them directly). No `images{}` needed here since
 *   points carry inheriting `images` refs for artwork (rather than an
 *   image href map).
 *
 * Coverage counts are always fresh (never cached) so the empty-state progress
 * bar stays live. Only the (potentially large) point list is cached.
 *
 * Errors → application/problem+json.
 *   503 dependency_unavailable when the AI-DB is down (NEVER 200-empty).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { deniesEverything } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    getMapPoints,
    countMapCoords,
    countSonicEmbeddingCoverage,
} from '$lib/server/database/queries/music-map.queries.js';
import type { MapPointRow } from '$lib/server/database/queries/music-map.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicMapDef');

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

type MapPoint = MusicMapResponse['points'][number];

function rowToPoint(row: MapPointRow, images: ImageSet): MapPoint {
    let topMood: string | null = row.top_mood ?? null;
    if (topMood !== null) {
        topMood = topMood.replace(/^"|"$/g, '').toLowerCase().trim() || null;
    }
    return {
        id: row.media_id,
        x: row.x,
        y: row.y,
        title: row.title,
        artist: row.artist_title ?? null,
        topMood,
        images,
    };
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'musicMap', then: { kind: 'user' } },
    visibility: 'internal',

    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const accessCtx = await buildSearchAccessContext(sql, user);
            // Single conversion point for this route: the query module takes a
            // required-by-shape MediaAccessBoundary, not the loose context.
            const access = searchAccessBoundary(accessCtx);

            // Coverage counts are always computed fresh — they power the progress bar
            // and must stay live across polls.
            const coverage = await countSonicEmbeddingCoverage(sql, access);

            // A deny-everything boundary must never reach the cache. `cacheKey`
            // below is derived from `accessCtx`, whose suffix has no denyAll
            // token — a denyAll caller would otherwise share (and could warm)
            // the unrestricted entry and be served the full point list from
            // cache, bypassing SQL entirely for the 30-minute L2 TTL.
            // `searchAccessBoundary` cannot currently produce a denyAll, so this
            // is a structural guard, not a live code path. Keep it if that ever
            // changes; do not "simplify" it away.
            if (deniesEverything(access)) {
                return json({
                    points: [],
                    hasCoords: false,
                    embeddedCount: coverage.embedded,
                    totalTracks: coverage.total,
                    projectedCount: 0,
                });
            }

            const cacheKey = scopedCacheKey(`music-map-v3:${ctx.surface}`, accessCtx);

            const cache = cacheManager.for(CACHE_NAMESPACES.musicMapPoints);
            const cached = await cache.get<{ points: MapPoint[]; hasCoords: boolean }>(cacheKey);
            if (cached) {
                return json({
                    ...cached,
                    embeddedCount: coverage.embedded,
                    totalTracks: coverage.total,
                    projectedCount: cached.points.length,
                });
            }

            const rows = await getMapPoints(sql, access);

            logger.debug('Music map points fetched', {
                username: user.username,
                count: rows.length,
                embedded: coverage.embedded,
                total: coverage.total,
            });

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                rows.map((row) => ({ id: row.media_id, mediaType: 'track' })),
            );
            const pointPayload = {
                points: rows.map((row) => rowToPoint(row, imageSets.get(row.media_id) ?? {})),
                hasCoords: rows.length > 0,
            };

            if (rows.length > 0) {
                await cache.set(cacheKey, pointPayload);
            }

            const projectedCount = rows.length > 0 ? rows.length : await countMapCoords(sql);

            return json({
                ...pointPayload,
                embeddedCount: coverage.embedded,
                totalTracks: coverage.total,
                projectedCount,
            });
        },
    },
});
