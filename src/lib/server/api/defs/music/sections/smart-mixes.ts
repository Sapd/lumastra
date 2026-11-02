// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/sections/smart-mixes
 *
 * Personal genre selections derived from listening history and library embeddings.
 * Shared by the dashboard and the public v1 endpoint used by native clients.
 *
 * Response: bare object { sections: PageSection[] }
 * DB-down → 503 dependency_unavailable.
 */

import { warmCollageUrls } from '$lib/server/services/music/collage-warmup.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { MusicSmartMixSectionsSchema } from '$lib/schemas/api-music-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getMusicSmartMixes } from '$lib/server/database/queries/music-recommendations.queries.js';
import { getDislikedTrackIds } from '$lib/server/database/queries/music-quick-picks.queries.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { buildSmartMixSection } from '$lib/server/utils/music-section-builder.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import type { PageSection } from '$lib/types/server-driven-ui';
import { musicCollageImages } from '$lib/server/services/music/collage-images.js';
import type { Sql } from 'postgres';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';

const logger = Logger.for('SmartMixesSectionDef');

const MIX_LIMIT = 5;

/**
 * Attach the mix's cover collage (its tracks' albums, in mix order). Done per
 * request, not before caching: the collage href is surface-specific, so it is
 * built for the request surface rather than baked into the cached entry.
 */
async function withMixCover(
    sql: Sql,
    sections: PageSection[],
    surface: ApiSurface,
): Promise<PageSection[]> {
    const coverIds = sections.map((section) =>
        section.items
            .map((item) => {
                const albumId = item.clickData?.albumId;
                return typeof albumId === 'string'
                    ? albumId
                    : getExternalIdFor(item.externalIds, 'internal');
            })
            .filter((id): id is string => !!id),
    );
    const members = await resolveImageSets(
        sql,
        surface,
        [...new Set(coverIds.flat())].map((id) => ({ id })),
    );
    return sections.map((section, index) => {
        const cover = musicCollageImages(coverIds[index], surface, members).primary;
        return cover ? { ...section, meta: { ...section.meta, coverImage: cover.href } } : section;
    });
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get smart-mix carousels',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Themed carousels built from k-means genre clusters over the library. Returns `{ sections: [] }` when the clustering task has not produced usable clusters yet.',
            responses: {
                200: {
                    schema: MusicSmartMixSectionsSchema,
                    description: 'Smart-mix carousel sections (possibly empty)',
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

            try {
                const accessCtx = await buildSearchAccessContext(sql, user);

                // Per-user cache: the k-means clusters are computed over the
                // user's own library/play signal, so the key carries the userId.
                // The built items carry surface-resolved ImageSets, so the
                // surface is part of the key too.
                const cache = cacheManager.for(CACHE_NAMESPACES.musicSmartMixes);
                const cacheKey = scopedCacheKey('music-smart-mixes-v4', accessCtx, [
                    user.userId,
                    ctx.surface,
                ]);
                const cached = await cache.get<{ sections: PageSection[] }>(cacheKey);
                if (cached)
                    return json({
                        sections: await withMixCover(sql, cached.sections, ctx.surface),
                    });

                // Best-effort: a dislike-lookup hiccup must not blank an
                // otherwise-fine mix — degrade gracefully.
                const dislikedIds = await getDislikedTrackIds(sql, user.userId).catch((err) => {
                    logger.warn('Disliked track lookup failed for smart mixes', err as Error);
                    return [] as string[];
                });
                const mixes = await getMusicSmartMixes(
                    sql,
                    user.userId,
                    MIX_LIMIT,
                    {
                        deniedGroupIds: accessCtx.deniedGroupIds,
                        ageRating: accessCtx.ageRating,
                    },
                    dislikedIds,
                );
                // One batched ImageSet lookup across every mix's tracks.
                const imageSets = await resolveImageSets(
                    sql,
                    ctx.surface,
                    mixes.flatMap((mix) =>
                        mix.tracks.map((t) => ({ id: t.id, mediaType: 'track' })),
                    ),
                );
                const sections: PageSection[] = [];
                for (const mix of mixes) {
                    const section = buildSmartMixSection(mix, imageSets);
                    if (section) sections.push(section);
                }
                void cache.set(cacheKey, { sections });
                const published = await withMixCover(sql, sections, ctx.surface);
                void warmCollageUrls(
                    published.flatMap((section) =>
                        typeof section.meta?.coverImage === 'string'
                            ? [section.meta.coverImage]
                            : [],
                    ),
                );
                return json({ sections: published });
            } catch (err) {
                logger.error('Smart mixes section endpoint failed', err as Error);
                return ApiProblem.dependencyUnavailable('Smart mixes unavailable');
            }
        },
    },
});
