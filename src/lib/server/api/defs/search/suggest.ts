// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Title-only typeahead. Uses the shared preview shape and a bounded {items,truncated} envelope. */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { isUnavailableMediaVisibleInSearch } from '$lib/server/config.js';
import {
    buildSearchAccessContext,
    buildSearchAccessCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { SearchService, type SuggestPage } from '$lib/server/services/search.service.js';
import { searchSuggestQuerySchema } from '$lib/schemas/browse.js';

import { SuggestResponseSchema } from './search-item.schemas.js';
import { suggestPreviews } from './preview-mapper.js';

const logger = Logger.for('SearchSuggestV1Def');

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** See the matching helper in defs/search/search.ts for the rationale. */
function sanitizeKeyPart(s: string): string {
    return s.replace(/\|/g, '_');
}

/**
 * Build the cache key for a `GET /api/v1/search/suggest` page. Suggest has no
 * offset/fulltext/year/rating/exclude params — only q, limit, the resolved
 * type filter, the effective unavailable-media gate (the
 * SHOW_UNAVAILABLE_MEDIA_IN_SEARCH flag narrowed by `availableOnly`), and the
 * caller's access scope affect SearchService.suggest()'s output.
 */
function buildSuggestCacheKey(
    params: {
        q: string;
        limit: number;
        types: string[] | null;
        showUnavailableMedia: boolean;
    },
    accessCtx: SearchAccessContext,
): string {
    const parts = [
        'v2',
        sanitizeKeyPart(params.q.trim().toLowerCase()),
        `l${params.limit}`,
        params.types && params.types.length > 0
            ? `t:${[...params.types].sort().join(',')}`
            : 't:all',
        params.showUnavailableMedia ? 'unavail1' : 'unavail0',
    ];
    const accessSuffix = buildSearchAccessCacheKey(accessCtx);
    return accessSuffix ? `${parts.join(':')}|${accessSuffix}` : parts.join(':');
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Search'],
            summary: 'Typeahead suggestions',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Title-only typeahead returning MediaPreview items in {items,truncated}. A down dependency returns 503.',
            query: searchSuggestQuerySchema,
            responses: {
                200: {
                    schema: SuggestResponseSchema,
                    description: 'Typeahead suggestions',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Search dependency unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        query: searchSuggestQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const parsed = searchSuggestQuerySchema.safeParse(
                Object.fromEntries(event.url.searchParams),
            );
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { q: rawQuery, limit } = parsed.data;
            const q = rawQuery.trim();

            // Too-short query → genuine zero-result (200 empty page, never 503).
            if (q.length < 2) {
                return json({ items: [], truncated: false });
            }

            // Canonical-type filter (CSV of public discriminators). Map to the
            // internal DB groupings the primitives understand.
            const requestedTypes = parsed.data.types
                ? parsed.data.types
                      .split(',')
                      .map((t) => t.trim().toLowerCase())
                      .filter(Boolean)
                : null;
            const sources = {
                movies: !requestedTypes || requestedTypes.includes('movie'),
                series: !requestedTypes || requestedTypes.includes('series'),
                episodes: !requestedTypes || requestedTypes.includes('episode'),
                music:
                    !requestedTypes ||
                    requestedTypes.includes('track') ||
                    requestedTypes.includes('album') ||
                    requestedTypes.includes('artist') ||
                    requestedTypes.includes('music'),
            };

            // ── Access scope (denied library groups + age rating) ──
            // `auth: { kind: 'user' }` guarantees locals.user is populated by
            // resolveAuth() for every credential path (session, PAT, service
            // token, JWT) before this handler runs — see hooks.server.ts /
            // forward-auth.ts. The guard below is standard defensive practice
            // (matches every other buildSearchAccessContext call site) and
            // makes the closed-by-default contract explicit at the call site.
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            const accessCtx = await buildSearchAccessContext(sql, user);

            // Effective gate: the IN_SEARCH toggle AND a configured request
            // path (un-requestable ghosts are dead ends — see config.ts).
            //
            // NOTE: deliberately NOT accessCtx.showUnavailableMedia — see the
            // matching note in defs/search/search.ts. Suggest shares search's
            // own SHOW_UNAVAILABLE_MEDIA_IN_SEARCH gate, not the Trending/For-You
            // SHOW_UNAVAILABLE_MEDIA one the shared context field carries.
            //
            // `availableOnly` can only NARROW that gate, never widen it, so the
            // `unavail0/1` cache-key part below already covers it.
            const showUnavailableMedia =
                isUnavailableMediaVisibleInSearch() && parsed.data.availableOnly !== true;

            // Each source contributes up to `window` of its best title matches;
            // we merge, sort by rank, then slice to `limit`. +1 to detect more.
            const window = limit + 1;

            let result: SuggestPage;
            try {
                // Short-TTL (20s), access-scoped, single-flighted cache — same
                // discipline as the full search def (see
                // CACHE_NAMESPACES.searchSuggestResults). No translation overlay
                // to worry about here (suggest never localizes titles), so the
                // cached page is served as-is with no clone-before-mutate step.
                const cacheKey = buildSuggestCacheKey(
                    { q, limit, types: requestedTypes, showUnavailableMedia },
                    accessCtx,
                );
                const suggestCache = cacheManager.for(CACHE_NAMESPACES.searchSuggestResults);
                const cached = await suggestCache.get<SuggestPage>(cacheKey);
                if (cached) {
                    result = cached;
                } else {
                    const ns = CACHE_NAMESPACES.searchSuggestResults;
                    const rawKey = `${ns.name}:${cacheKey}`;
                    const ttlSeconds = Math.floor(ns.l2TTL / 1000);
                    const jsonStr = await getOrComputeSingleFlight({
                        cacheKey: rawKey,
                        ttlSeconds,
                        compute: async () =>
                            JSON.stringify(
                                await SearchService.suggest({
                                    sql,
                                    q,
                                    window,
                                    limit,
                                    deniedGroupIds: accessCtx.deniedGroupIds,
                                    ageRating: accessCtx.ageRating,
                                    showUnavailableMedia,
                                    surface: ctx.surface,
                                    sources,
                                }),
                            ),
                    });
                    result = JSON.parse(jsonStr) as SuggestPage;
                    void suggestCache.set(cacheKey, result);
                }
            } catch (error) {
                // A genuine query failure (not "no results") is a dependency
                // fault — surface it, never mask it as an empty page.
                logger.error('Suggest query failed', error as Error, { query: q });
                return ApiProblem.dependencyUnavailable('Search backend is unavailable');
            }

            return json({
                items: await suggestPreviews(sql, ctx.surface, result.items),
                truncated: result.truncated,
            });
        },
    },
});
