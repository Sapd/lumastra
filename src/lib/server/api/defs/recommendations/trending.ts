// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tier-2 endpoint: GET /api/v1/trending
 *
 * Replaces / merges (§rename-map):
 *   trending               → trending?window=week&type=movie  (keep)
 *   for-you/trending       → collapsed into this endpoint (SDUI wrapper retired)
 *
 * Query params:
 *   window       — time window (currently informational; 'week' | 'month' | 'day')
 *   type         — media type filter ('movie' | 'series' | 'all')
 *   limit        — page size (1–100, default 20)
 *   offset       — page offset (default 0)
 *   availableOnly — per-request availability override: 'true'|'1' returns only
 *                  available items (the tvOS "available only" toggle). Distinct
 *                  from the always-on SHOW_UNAVAILABLE_MEDIA server config gate.
 *
 * Response: { items: RecommendationItem[], page: PageBlock }
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { recommendationPreviews } from '$lib/server/services/media-preview.service.js';
import { getDb as previewDb } from '$lib/server/database/connection.js';
import { paginate, ApiProblem, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { runRecommender, buildAccessContext } from './recommender.js';
import { trendingStrategy } from './strategies/index.js';
import { TrendingResponseSchema } from '$lib/schemas/api-recommender-responses';

const TrendingQuerySchemaFromDocs = z.object({
    window: z
        .enum(['day', 'week', 'month'])
        .optional()
        .meta({ description: 'Time window (default: week)' }),
    type: z
        .enum(['movie', 'series', 'all'])
        .optional()
        .meta({ description: 'Media type filter (default: all)' }),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .meta({ description: 'Page size (default 20)' }),
    offset: z.number().int().min(0).optional().meta({ description: 'Page offset (default 0)' }),
    availableOnly: z
        .string()
        .optional()
        .meta({
            description:
                'Per-request availability override. Pass "true" or "1" to restrict results to ' +
                'library-available items only (the tvOS "available only" toggle). ' +
                'Distinct from the always-on SHOW_UNAVAILABLE_MEDIA server-config gate.',
        }),
});

const TrendingQuerySchema = z.object({
    window: z.enum(['day', 'week', 'month']).optional().default('week'),
    type: z.enum(['movie', 'series', 'all']).optional().default('all'),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
    /**
     * Per-request availability override — the tvOS "available only" toggle.
     * Accepts: 'true' | '1'.
     * When true, only items with isAvailable === true are returned.
     * Distinct from the always-on SHOW_UNAVAILABLE_MEDIA server-config gate.
     */
    availableOnly: z
        .string()
        .optional()
        .transform((v) => v === 'true' || v === '1'),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Trending'],
            summary: 'Get trending content',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns trending content from the library sorted by recent play activity. ' +
                'Each item is the MediaPreview with an opaque id handle, catalogId and ImageSet ' +
                '(`reason.kind` = "trending"). Supports time window and type filters. ' +
                'Pass `?availableOnly=true` to restrict results to ' +
                'library-available items only — the per-request counterpart to the server-wide ' +
                'SHOW_UNAVAILABLE_MEDIA configuration gate.',
            query: TrendingQuerySchemaFromDocs,
            responses: {
                200: {
                    schema: TrendingResponseSchema,
                    description: 'Trending items',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: TrendingQuerySchema,
    },
    handlers: {
        GET: async (event, surfaceCtx) => {
            // Parse + validate query params
            const raw = {
                window: event.url.searchParams.get('window') ?? undefined,
                type: event.url.searchParams.get('type') ?? undefined,
                limit: event.url.searchParams.get('limit') ?? undefined,
                offset: event.url.searchParams.get('offset') ?? undefined,
                availableOnly: event.url.searchParams.get('availableOnly') ?? undefined,
            };

            const parsed = TrendingQuerySchema.safeParse(raw);
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

            const mediaType: 'movie' | 'series' | undefined =
                q.type === 'all' ? undefined : (q.type as 'movie' | 'series');

            // Per-request availability override: ?availableOnly=true|1.
            const availableOnly = q.availableOnly;

            // Tier-2 data-plane: a dependency-down signal must surface as
            // 503 dependency_unavailable — NEVER a 200 with an empty array.
            let result;
            try {
                result = await runRecommender(trendingStrategy, ctx, {
                    surface: surfaceCtx.surface,
                    limit: q.limit,
                    offset: q.offset,
                    mediaType,
                    availableOnly,
                });
            } catch (err) {
                if (isDependencyUnavailable(err)) {
                    return ApiProblem.dependencyUnavailable(err.message);
                }
                throw err;
            }

            return json(
                paginate(
                    await recommendationPreviews(previewDb()!, surfaceCtx.surface, result.items),
                    {
                        limit: q.limit,
                        offset: q.offset,
                        hasMore: result.hasMore,
                    },
                ),
            );
        },
    },
});
