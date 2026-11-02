// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/explore-keywords
 *
 * Popular keywords as clickable genre chips for exploration.
 * Global cache (15min L1 / 1hr L2).
 *
 * Response: bare object { keywords: ExploreKeyword[], section: PageSection }
 * where section is a keyword-chips PageSection carrying the chips in
 * `meta.keywords` (items: []).
 *
 * Migrated to new contract:
 * - No success wrapper
 * - No z.unknown().passthrough() — fully typed
 * - 503 when DB unavailable
 *
 * B-UNTYPED justification: visibility:'internal' BFF endpoint. defineEndpoint has no
 * response slot; response shape is fully typed via ExploreKeywordSchema + inline section
 * literal inline — no runtime z.any()/z.unknown() in the emitted body.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';

const ExploreKeywordSchema = z.object({
    keyword: z.string(),
    displayName: z.string(),
    count: z.number().int(),
});

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(30).optional().default(20),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event) => {
            const raw = { limit: event.url.searchParams.get('limit') ?? undefined };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit } = parsed.data;

            const { getDb } = await import('$lib/server/database/index.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { fetchPopularKeywords } =
                await import('$lib/server/services/for-you.service.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const { buildSearchAccessContext, scopedCacheKey, searchAccessBoundary } =
                await import('$lib/server/utils/search-access-context.js');
            const { m } = await import('$lib/paraglide/messages.js');

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const CACHE_FETCH_SIZE = 30;
            const cacheKey = scopedCacheKey('explore-keywords:global:v1', accessCtx);

            const curatedCache = cacheManager.for(CACHE_NAMESPACES.curatedContent);

            type ExploreKeyword = z.infer<typeof ExploreKeywordSchema>;
            let keywords: ExploreKeyword[];

            const cached = await curatedCache.get<ExploreKeyword[]>(cacheKey);
            if (cached) {
                keywords = cached;
            } else {
                const raw = await fetchPopularKeywords(
                    sql,
                    CACHE_FETCH_SIZE,
                    searchAccessBoundary(accessCtx),
                );
                keywords = ExploreKeywordSchema.array().parse(raw);
                await curatedCache.set(cacheKey, keywords);
            }

            keywords = keywords.slice(0, limit);

            // PageSection contract (client ExploreKeywordsResponseSchema →
            // PageSectionSchema): keyword-chips carries no media items, and
            // KeywordChipsSection.svelte reads the chips from `section.meta.keywords`
            // — NOT a top-level `section.keywords`. Emitting them at the top level
            // left the section validating-empty and rendering no chips.
            const section = {
                id: 'explore-keywords',
                type: 'keyword-chips' as const,
                title: m.explore_by_genre?.() ?? 'Explore by Genre',
                items: [],
                meta: { keywords },
            };

            return json({ keywords, section });
        },
    },
});
