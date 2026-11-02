// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/browse/genres.ts — GET /api/browse/genres
 *
 * The genre facet for browse: which genres actually have content, and how much,
 * under the caller's scope. The companion to `?genre=` on /browse/az — render
 * these as a rail, send `name` back verbatim as the filter.
 *
 * Contract:
 *   GET /browse/genres?type&libraryGroupId&tag&audio&subs&includeUnknown&res&hdr&codec&qUnknown
 *     → bare BrowseGenresResponse ({ genres: [{ name, count }], … })
 *
 * Scoped identically to /browse/az (active, library-local `has_files = true`,
 * media-type / library-group / keyword-tag / language / quality filters,
 * per-user library and age access), so a pill's count matches the grid it
 * navigates to. `tag` narrows the counts exactly as it narrows `/browse/az`'s
 * own embedded `genreCounts` facet — the genre axis is meant to agree with the
 * keyword axis regardless of which endpoint computed it. Genres with no
 * content are omitted rather than returned as zeroes — a client that renders
 * the whole list can never strand a viewer on an empty grid.
 *
 * Auth: user.  Surface: public.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { browseGenresQuerySchema } from '$lib/schemas/browse.js';
import { getGenreFacetCounts } from '$lib/server/database/queries/browse.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    buildSearchAccessContext,
    browseScopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { BrowseGenresResponseSchema, type GenreCount } from '$lib/schemas/api-browse-responses.js';

const logger = Logger.for('Browse:Genres');

const azCache = cacheManager.for(CACHE_NAMESPACES.browseAZ);

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Browse'],
            summary: 'List genres that have content',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the genres present in the catalog under the requested scope, ' +
                'each with its item count, ordered by count descending. Accepts the same ' +
                'filters as `/browse/az` (`type`, `libraryGroupId`, `tag`, language and quality ' +
                'filters) so the counts describe exactly the page ' +
                '`/browse/az?genre=<name>&tag=<tag>` would return. Genres with no content ' +
                'are omitted — render the list as-is and no entry can lead to an empty ' +
                'result. The same data is available on the `genreCounts` field of ' +
                '`/browse/az` when a client wants it in one trip.',
            query: browseGenresQuerySchema,
            responses: {
                200: {
                    schema: BrowseGenresResponseSchema,
                    description: 'Genres with item counts for the requested scope',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    visibility: 'public',
    request: {
        query: browseGenresQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const {
                type: mediaType,
                libraryGroupId,
                tag,
                audio,
                subs,
                includeUnknown,
                res,
                hdr,
                codec,
                qUnknown,
            } = ctx.input!.query;
            // Translate canonical public value to the internal DB discriminator.
            const dbMediaType: 'movie' | 'tv' | 'all' = mediaType === 'series' ? 'tv' : mediaType;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = searchAccessBoundary(accessCtx);

            // Deliberately the SAME key family (and namespace) az.ts uses for its
            // `genreCounts` facet, with no letter narrowing — this endpoint and a
            // letter-less /browse/az request share one cached aggregate instead of
            // each paying for it.
            const langKey = `${audio.join('+') || '-'}:${subs.join('+') || '-'}:${includeUnknown ? 'u' : ''}`;
            const qKey = `${res.join('+') || '-'}:${hdr.join('+') || '-'}:${codec.join('+') || '-'}:${qUnknown ? 'u' : ''}`;
            // `tag` is free-form (values carry spaces, e.g. "time travel") and
            // matched case-insensitively against the lowercased keyword projection
            // (unlike `genre`, which is case-sensitive elsewhere in this file's key
            // family), so it must be lowercased before it goes into the key — same
            // treatment az.ts gives its own `tagKey`.
            const tagKey = tag ? `t_${encodeURIComponent(tag.trim().toLowerCase())}` : '-';
            const cacheKey = browseScopedCacheKey(
                `v3genrefacets:${dbMediaType}:all:${libraryGroupId || 'all'}:${tagKey}:${langKey}:${qKey}`,
                accessCtx,
            );

            try {
                let genres = await azCache.get<GenreCount[]>(cacheKey);
                if (!genres) {
                    const facets = await getGenreFacetCounts(sql, {
                        mediaType: dbMediaType,
                        availableOnly: true,
                        groupId: libraryGroupId,
                        keyword: tag,
                        access,
                        audioLangs: audio,
                        subLangs: subs,
                        includeUnknown,
                        resolutions: res,
                        hdr,
                        codecs: codec,
                        qualityIncludeUnknown: qUnknown,
                    });
                    genres = facets.map((g) => ({ name: g.genre, count: g.count }));
                    await azCache.set(cacheKey, genres);
                }

                return json({
                    genres,
                    // Echoes the applied `?type=` filter under the field name
                    // BrowseGenresResponseSchema declares (`mediaType`) — a deliberate
                    // passthrough, not an item-level discriminator leak.
                    // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                    mediaType,
                    libraryGroupId: libraryGroupId || undefined,
                });
            } catch (error) {
                logger.error('Failed to fetch genre facet', error as Error);
                return ApiProblem.internalError('Failed to fetch genres');
            }
        },
    },
});
