// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/sections/new-for-you
 *
 * "New For You" carousel — recently added, never-played library tracks
 * ranked by the user's sonic taste vector when available. Internal BFF —
 * dashboard only, not published on the v1 external surface.
 *
 * Response: bare `PageSection | null` (the consumer, LazySection.svelte,
 * reads `await res.json() as PageSection | null` directly — NOT a wrapper).
 *   - null when there aren't enough qualifying tracks even after widening
 *     the lookback window.
 *
 * DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { PageSectionSchema } from '$lib/schemas/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getNewForYouTracks } from '$lib/server/database/queries/music-recommendations.queries.js';
import { getDislikedTrackIds } from '$lib/server/database/queries/music-quick-picks.queries.js';
import { computeSonicTasteVector } from '$lib/server/database/queries/sonic-taste.queries.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { buildNewForYouSection } from '$lib/server/utils/music-section-builder.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import type { PageSection } from '$lib/types/server-driven-ui';

const logger = Logger.for('NewForYouSectionDef');

const TRACK_LIMIT = 20;
const PRIMARY_SINCE_DAYS = 30;
const FALLBACK_SINCE_DAYS = 90;
// Below this count, retry with the wider lookback window before giving up.
const WIDEN_THRESHOLD = 6;
// Below this count even after widening, there isn't enough to show a shelf.
const MIN_TRACKS = 4;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get the "new for you" carousel',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Recently added, never-played library tracks, ranked by the caller’s sonic taste vector when one exists. Returns `null` (HTTP 200) when too few tracks qualify even after widening the lookback window.',
            responses: {
                200: {
                    schema: PageSectionSchema.nullable(),
                    description: 'Carousel section, or null when there is nothing to show',
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
            if (!sql) {
                // AI DB down -> 503 (matches sibling section endpoints). The
                // /feed aggregator catches per-section, so the composed feed
                // still omits this section gracefully; the standalone
                // data-plane endpoint must not mask a dependency-down as 200.
                return ApiProblem.dependencyUnavailable('AI database is unavailable');
            }

            try {
                const accessCtx = await buildSearchAccessContext(sql, user);

                // Per-user cache: ranking depends on the user's sonic taste
                // vector + dislikes, so the key carries the userId. The built
                // items carry surface-resolved ImageSets, so the surface is part
                // of the key too. Wrapped so a cached null (too few qualifying
                // tracks) reads as a hit.
                const cache = cacheManager.for(CACHE_NAMESPACES.musicNewForYou);
                const cacheKey = scopedCacheKey('music-new-for-you-dto-v3', accessCtx, [
                    user.userId,
                    ctx.surface,
                ]);
                const cached = await cache.get<{ section: PageSection | null }>(cacheKey);
                if (cached) return json(cached.section);

                // Best-effort: a dislike-lookup hiccup must not blank the section.
                const dislikedIds = await getDislikedTrackIds(sql, user.userId).catch((err) => {
                    logger.warn('Disliked track lookup failed for new-for-you', err as Error);
                    return [] as string[];
                });

                // Best-effort: cold-start users (no signal yet) fall back to
                // created_at-only ranking rather than blanking the section.
                const tasteVector = await computeSonicTasteVector(sql, user.userId).catch((err) => {
                    logger.debug('Sonic taste vector unavailable for new-for-you', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return null;
                });

                const baseOpts = {
                    access: searchAccessBoundary(accessCtx),
                    tasteVector,
                };

                let tracks = await getNewForYouTracks(sql, user.userId, dislikedIds, TRACK_LIMIT, {
                    ...baseOpts,
                    sinceDays: PRIMARY_SINCE_DAYS,
                });

                if (tracks.length < WIDEN_THRESHOLD) {
                    tracks = await getNewForYouTracks(sql, user.userId, dislikedIds, TRACK_LIMIT, {
                        ...baseOpts,
                        sinceDays: FALLBACK_SINCE_DAYS,
                    });
                }

                const section: PageSection | null =
                    tracks.length < MIN_TRACKS
                        ? null
                        : buildNewForYouSection(
                              tracks,
                              await resolveImageSets(
                                  sql,
                                  ctx.surface,
                                  tracks.map((t) => ({ id: t.id, mediaType: 'track' })),
                              ),
                          );
                void cache.set(cacheKey, { section });
                return json(section);
            } catch (err) {
                // A failure querying the AI DB is a dependency-down condition
                // -> 503 (matches sibling section endpoints).
                logger.error('New For You section endpoint failed', err as Error);
                return ApiProblem.dependencyUnavailable(
                    'Recommendations are temporarily unavailable',
                );
            }
        },
    },
});
