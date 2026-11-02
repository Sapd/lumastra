// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/browse/tags.ts — GET /api/browse/tags
 *
 * The keyword/tag facet for browse, with prefix typeahead: given `?q=`, the
 * keywords that have content and whose normalized value starts with that
 * prefix, count-descending. The companion to `?tag=` on /browse/az — render
 * the result as a typeahead list, send `keyword` back verbatim as the filter.
 *
 * Contract:
 *   GET /browse/tags?q&limit&type&libraryGroupId&letter&genre&audio&subs&includeUnknown&res&hdr&codec&qUnknown
 *     → bare { tags: [{ keyword, count }] }
 *
 * Scoped identically to /browse/az (active, library-local `has_files = true`,
 * media-type / library-group / language / quality filters, per-user library
 * and age access) minus the `tag` axis itself, so a suggestion's count
 * matches the grid it navigates to.
 *
 * Restricted to the curated `ALLOWED_KEYWORDS` vocabulary (see
 * `$lib/shared/keyword-vocabulary`). The raw `media_keywords` space is mostly
 * provider slug noise, so this endpoint SUGGESTS only curated keywords — while
 * `/browse/az?tag=` still FILTERS on any of them, so old deep links keep working.
 *
 * Deliberately the OPPOSITE error policy of /browse/az's `keywordCounts`
 * facet: there the facet is one field among several on a larger response, so
 * a facet-query failure degrades to `[]` rather than failing the whole page.
 * Here the facet list IS the entire payload, so a query failure is left to
 * propagate — mount()'s outer error handler turns it into a 500, never a 200
 * with an empty list that would read as "no tags".
 *
 * Auth: user.  Surface: public.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { tagsQuerySchema } from '$lib/schemas/browse.js';
import { searchKeywordFacets } from '$lib/server/database/queries/browse.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    buildSearchAccessContext,
    browseScopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { KeywordCountSchema, type KeywordCount } from '$lib/schemas/api-browse-responses.js';

// Same namespace az.ts/genres.ts use, so one browse invalidation clears all
// three. The ENTRIES are disjoint by design and never shared: this endpoint
// keys on `v3tags:…` (which folds in `q` and `limit`) while az.ts keys its
// facet on `v3keywordfacets:…`, so a request here never reuses a page's facet
// aggregate and vice versa.
const azCache = cacheManager.for(CACHE_NAMESPACES.browseAZ);

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Browse'],
            summary: 'Search keywords/tags with prefix typeahead',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the keywords present in the catalog under the requested scope, ' +
                'optionally narrowed to those starting with `q`, each with its item count, ' +
                'ordered by count descending. Accepts the same filters as `/browse/az` ' +
                '(minus the `tag` axis itself) so the counts describe exactly what ' +
                '`/browse/az?tag=<keyword>` would return. Only curated keywords are ' +
                'suggested (`/browse/az?tag=` still filters on any keyword, so existing ' +
                'deep links keep working). A capped top slice of the same data ' +
                '(unfiltered by `q`) rides on the `keywordCounts` field of `/browse/az` ' +
                'when a client wants it in one trip.',
            query: tagsQuerySchema,
            responses: {
                200: {
                    schema: z.object({ tags: z.array(KeywordCountSchema) }),
                    description: 'Keywords with item counts for the requested scope',
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
        query: tagsQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const {
                type: mediaType,
                libraryGroupId,
                letter,
                genre,
                audio,
                subs,
                includeUnknown,
                res,
                hdr,
                codec,
                qUnknown,
                q,
                limit,
            } = ctx.input!.query;
            // Translate canonical public value to the internal DB discriminator.
            const dbMediaType: 'movie' | 'tv' | 'all' = mediaType === 'series' ? 'tv' : mediaType;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = searchAccessBoundary(accessCtx);

            // Free-form `q` is percent-encoded and prefixed so browseScopedCacheKey's
            // reserved-'|' guard can never see a raw user string; absent q gets the
            // '-' sentinel so "no prefix" and "empty-string prefix" can't collide.
            const qKey = q ? `q_${encodeURIComponent(q.trim().toLowerCase())}` : '-';
            const langKey = `${audio.join('+') || '-'}:${subs.join('+') || '-'}:${includeUnknown ? 'u' : ''}`;
            const qualityKey = `${res.join('+') || '-'}:${hdr.join('+') || '-'}:${codec.join('+') || '-'}:${qUnknown ? 'u' : ''}`;
            // `genre` must preserve case (the SQL match is case-sensitive, unlike
            // `tag`/`q` above) and needs a present-value prefix so a literal
            // `?genre=-` can't collide with the absent-genre sentinel — see the
            // comment above the equivalent `genreKey` in az.ts.
            const genreKey = genre ? `g_${encodeURIComponent(genre)}` : '-';
            const cacheKey = browseScopedCacheKey(
                `v3tags:${dbMediaType}:${qKey}:${limit}:${libraryGroupId || 'all'}:${letter?.toUpperCase() || '-'}:${genreKey}:${langKey}:${qualityKey}`,
                accessCtx,
            );

            let tags = await azCache.get<KeywordCount[]>(cacheKey);
            if (!tags) {
                // No try/catch: the facet list IS this endpoint's entire payload, so a
                // query failure must propagate — mount()'s outer error handler turns
                // it into a 500, never a 200 with an empty list that reads as "no tags".
                tags = await searchKeywordFacets(sql, q ?? '', {
                    mediaType: dbMediaType,
                    availableOnly: true,
                    letter,
                    groupId: libraryGroupId,
                    genreName: genre,
                    access,
                    audioLangs: audio,
                    subLangs: subs,
                    includeUnknown,
                    resolutions: res,
                    hdr,
                    codecs: codec,
                    qualityIncludeUnknown: qUnknown,
                    max: limit,
                });
                await azCache.set(cacheKey, tags);
            }

            return json({ tags });
        },
    },
});
