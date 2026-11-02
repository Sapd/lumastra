// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/categories/index.ts
 *
 * GET  /livetv/admin/categories — list all categories, { items, page }
 * POST /livetv/admin/categories — create a new category, bare object
 *
 * Auth: scope livetv:admin (both methods)
 * Mounted on:
 *   /api/admin/livetv/categories          (internal SPA surface)
 *   /api/v1/livetv/admin/categories       (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    listCategories,
    createCategory,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { mapCategoryToApi } from '$lib/server/mappers/livetv-category.mapper.js';
import { CreateCategoryRequestSchema } from '$lib/schemas/livetv.js';
import { z } from 'zod';
import { LiveTvCategorySchema, AdminCategoryResponseSchema } from '$lib/schemas/livetv';
import { PageBlockSchema } from '$lib/schemas/api-for-you-responses';

// The list handler maps rows through mapCategoryToApi, which emits
// createdAt/updatedAt (and never emits channelCount). AdminCategoryResponseSchema
// mirrors mapCategoryToApi exactly; LiveTvCategorySchema does not (it lacks the
// timestamps and declares an unused channelCount). POST still returns the
// create row (no timestamps), so it keeps LiveTvCategorySchema.
const CategoriesListResponseSchema = z
    .object({
        items: z.array(AdminCategoryResponseSchema),
        page: PageBlockSchema,
    })
    .meta({ id: 'CategoriesListResponse', description: 'Paginated category list' });

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'List channel categories',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: CategoriesListResponseSchema,
                    description: 'Paginated list of Live TV categories',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Live TV'],
            summary: 'Create a channel category',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                201: { schema: LiveTvCategorySchema, description: 'Newly created category' },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        // body is declared so mount() parses + validates it for POST.
        // GET never reads a body — the schema is not applied there.
        body: CreateCategoryRequestSchema,
    },
    handlers: {
        /**
         * GET /livetv/admin/categories
         *
         * Returns all categories ordered by sort_order.
         * Response: { items, page } — standard collection envelope.
         */
        GET: async (_event, _ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const rows = await listCategories(sql);
            const items = rows.map(mapCategoryToApi);

            return json(
                paginate(items, {
                    limit: items.length,
                    offset: 0,
                    hasMore: false,
                }),
            );
        },

        /**
         * POST /livetv/admin/categories
         *
         * Creates a new category.
         * Response: bare object { id, name, sortOrder } — the DB-returned row.
         *
         * mount() has already validated ctx.input.body via CreateCategoryRequestSchema.
         */
        POST: async (_event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const { name } = ctx.input!.body as { name: string };
            const category = await createCategory(sql, name);

            await invalidateLiveTvCaches();

            // Bare object: { id, name, sortOrder }
            return json(category, { status: 201 });
        },
    },
});
