// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/keywords
 *
 * Query params:
 *   limit   — page size (1–100, default 20)
 *   offset  — page offset (default 0)
 *
 * Response: { items: KeywordItem[], page: PageBlock }
 * A `KeywordItem` is { keyword: string, count?: number } — resource-shaped,
 * not a recommendation envelope.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { paginate, ApiProblem } from '$lib/server/api/problem.js';
import { buildAccessContext } from './recommender.js';

const KeywordSchema = z.object({
    keyword: z.string(),
    count: z
        .number()
        .int()
        .optional()
        .meta({ description: 'Number of items tagged with this keyword' }),
});

const KeywordsResponseSchema = z.object({
    items: z.array(KeywordSchema),
    page: z.object({ limit: z.number().int(), offset: z.number().int(), hasMore: z.boolean() }),
});

const KeywordsQuerySchemaFromDocs = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
});

const KeywordsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

/** Keyword item shape. */
interface KeywordItem {
    keyword: string;
    count?: number;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Browse'],
            summary: 'Discover keywords',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns popular library keywords for content discovery, with optional item counts. ' +
                'Results are paged with limit and offset; no personalization modes are implemented.',
            query: KeywordsQuerySchemaFromDocs,
            responses: {
                200: { schema: KeywordsResponseSchema, description: 'Keywords' },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: KeywordsQuerySchema,
    },
    handlers: {
        GET: async (event) => {
            const raw = {
                limit: event.url.searchParams.get('limit') ?? undefined,
                offset: event.url.searchParams.get('offset') ?? undefined,
            };

            const parsed = KeywordsQuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const q = parsed.data;

            const ctx = await buildAccessContext(event);
            if (!ctx) return ApiProblem.unauthorized();

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const { fetchPopularKeywords } =
                await import('$lib/server/services/for-you.service.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');

            // Library axis from ctx.deniedGroupIds — exactly what this route
            // passed before. The age axis is carried too (it was previously not
            // expressible in the signature at all); fetchPopularKeywords does not
            // apply it, so this changes no rows. See that function's MISSING AXIS
            // note.
            const keywordAccess = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating ?? null,
                allowUnrated: ctx.allowUnrated,
            });

            const fetchLimit = q.limit + 1;
            const rawKeywords = await fetchPopularKeywords(
                sql,
                fetchLimit + q.offset,
                keywordAccess,
            );
            const keywords: KeywordItem[] = rawKeywords.slice(q.offset).map((k) => ({
                keyword: k.keyword,
                count: k.count,
            }));

            const hasMore = keywords.length > q.limit;
            const page = keywords.slice(0, q.limit);

            return json(
                paginate(page, {
                    limit: q.limit,
                    offset: q.offset,
                    hasMore,
                }),
            );
        },
    },
});
