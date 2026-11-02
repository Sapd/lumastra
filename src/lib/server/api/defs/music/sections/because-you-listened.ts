// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/sections/because-you-listened
 *
 * "Because you listened to X" music recommendation carousel section.
 * Internal BFF — dashboard only, not published on the v1 external surface.
 *
 * Response: bare `PageSection | null` (the consumer, LazySection.svelte,
 * reads `await res.json() as PageSection | null` directly — NOT a wrapper).
 *   - null when the user has no recent playback, no accessible seed, or
 *     the AI recommendations path returned nothing (soft dep).
 *
 * DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { PageSectionSchema } from '$lib/schemas/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getRecentlyPlayed } from '$lib/server/database/queries/music.queries.js';
import { getMusicBecauseYouListened } from '$lib/server/database/queries/music-recommendations.queries.js';
import { getDislikedTrackIds } from '$lib/server/database/queries/music-quick-picks.queries.js';
import { buildBecauseYouListenedSection } from '$lib/server/utils/music-section-builder.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import type { PageSection } from '$lib/types/server-driven-ui';

const logger = Logger.for('BylSectionDef');

const ARTIFACT_TITLES = new Set(['cover', 'folder', 'front', 'back']);
const SEED_POOL = 5;
const REC_LIMIT = 15;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get the "because you listened" carousel',
            stability: 'beta',
            auth: 'bearer',
            description:
                'A recommendation carousel seeded from a track the caller recently played. Returns `null` (HTTP 200) when there is no recent playback, no accessible seed, or the recommendation path produced nothing — render nothing in that case rather than an empty rail. Requires play reporting via `music/progress/*`; a client that never reports plays will always get `null`.',
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
                // AI DB down -> 503 (matches sibling section endpoints smart-mixes/
                // mood-recommendations). The /feed aggregator catches per-section, so
                // the composed feed still omits this section gracefully; the standalone
                // data-plane endpoint must not mask a dependency-down as 200.
                return ApiProblem.dependencyUnavailable('AI database is unavailable');
            }

            try {
                const accessCtx = await buildSearchAccessContext(sql, user);

                // Per-user cache. The seed is drawn from recent plays with
                // Math.random on the cold miss, so caching freezes that choice
                // for the TTL window — which also keeps "Because you listened to
                // X" coherent across back-navigation instead of re-rolling X on
                // every visit. Wrapped value so cached nulls read as a hit.
                const cache = cacheManager.for(CACHE_NAMESPACES.musicBecauseYouListened);
                // The cached value is a fully-built section whose imageUrl carries this
                // surface's prefix, so the surface MUST be part of the key — otherwise
                // whichever surface warms the entry decides the prefix for the other.
                const cacheKey = scopedCacheKey('music-byl-dto-v3', accessCtx, [
                    user.userId,
                    ctx.surface,
                ]);
                const cached = await cache.get<{ section: PageSection | null }>(cacheKey);
                if (cached) return json(cached.section);

                const recentlyPlayed = await getRecentlyPlayed(sql, user.userId, 20);
                const filteredPlayed = recentlyPlayed.filter(
                    (t) => !ARTIFACT_TITLES.has(t.title.toLowerCase()),
                );
                if (filteredPlayed.length === 0) {
                    void cache.set(cacheKey, { section: null });
                    return json(null);
                }

                // Pick the seed from the recent-play pool, but require the user
                // can still access it — otherwise the embedding query would seed
                // from a now-restricted track and pull related results.
                const seedPool = filteredPlayed.slice(0, SEED_POOL);
                const accessibleSeeds: typeof seedPool = [];
                for (const t of seedPool) {
                    if (await checkMediaAccess(sql, t.id, user)) {
                        accessibleSeeds.push(t);
                    }
                }
                if (accessibleSeeds.length === 0) {
                    void cache.set(cacheKey, { section: null });
                    return json(null);
                }
                const seedIndex = Math.floor(Math.random() * accessibleSeeds.length);
                const seed = accessibleSeeds[seedIndex];

                const excludeIds = filteredPlayed.map((t) => t.id);
                // Best-effort: a dislike-lookup hiccup must not blank the section.
                const dislikedIds = await getDislikedTrackIds(sql, user.userId).catch((err) => {
                    logger.warn(
                        'Disliked track lookup failed for because-you-listened',
                        err as Error,
                    );
                    return [] as string[];
                });
                const recs = await getMusicBecauseYouListened(
                    sql,
                    seed.id,
                    excludeIds,
                    REC_LIMIT,
                    {
                        deniedGroupIds: accessCtx.deniedGroupIds,
                        ageRating: accessCtx.ageRating,
                    },
                    dislikedIds,
                );

                const imageSets = await resolveImageSets(
                    sql,
                    ctx.surface,
                    recs.map((row) => ({ id: row.id, mediaType: 'track' })),
                );
                const section = buildBecauseYouListenedSection(
                    {
                        title: seed.title,
                        artist: seed.artist_title ?? 'Unknown Artist',
                        imageUrl: entityImageUrl(seed.id, 'poster', ctx.surface, {
                            size: 'thumb',
                        }),
                    },
                    recs,
                    imageSets,
                );
                void cache.set(cacheKey, { section });
                return json(section);
            } catch (err) {
                // A failure querying the AI DB is a dependency-down condition -> 503
                // (matches sibling section endpoints). The /feed aggregator catches
                // per-section, so the composed feed still omits it gracefully rather
                // than rendering an error — but the standalone endpoint must not mask
                // a dependency-down as 200.
                logger.error('BYL section endpoint failed', err as Error);
                return ApiProblem.dependencyUnavailable(
                    'Recommendations are temporarily unavailable',
                );
            }
        },
    },
});
