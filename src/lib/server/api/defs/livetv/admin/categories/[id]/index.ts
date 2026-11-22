// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/categories/[id]/index.ts
 *
 * GET    /livetv/admin/categories/{categoryId} — get single category (bare object)
 * PUT    /livetv/admin/categories/{categoryId} — edit a category or its channels (bare object)
 * DELETE /livetv/admin/categories/{categoryId} — delete empty category (bare object)
 *
 * Auth: scope livetv:admin (all methods)
 * Mounted on:
 *   /api/admin/livetv/categories/[categoryId]        (internal SPA surface)
 *   /api/v1/livetv/admin/categories/{categoryId}     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    deleteEmptyCategory,
    getCategoryById,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { updateLiveTvCategory } from '$lib/server/services/livetv/category-admin.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { mapCategoryToApi } from '$lib/server/mappers/livetv-category.mapper.js';
import { UpdateCategoryRequestSchema } from '$lib/schemas/livetv.js';
import {
    AdminCategoryResponseSchema,
    CategoryUpdateResponseSchema,
    LiveTvAckResponseSchema,
} from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Get a Live TV category',
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: { schema: AdminCategoryResponseSchema, description: 'Category (bare object)' },
                401: 'Authentication required',
                404: 'Category not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Live TV'],
            summary: 'Update a Live TV category or its channels',
            stability: 'experimental',
            auth: 'bearer',
            body: UpdateCategoryRequestSchema,
            responses: {
                200: { schema: CategoryUpdateResponseSchema, description: 'Category updated' },
                401: 'Authentication required',
                404: 'Category not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Live TV'],
            summary: 'Delete an empty Live TV category',
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: { schema: LiveTvAckResponseSchema, description: 'Category deleted' },
                401: 'Authentication required',
                404: 'Category not found',
                422: 'Category still has channels',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    // No def-level `request.body`: mount() applies a declared body schema to
    // every method that can carry one, including DELETE (see mount.ts
    // `methodCanHaveBody`). Declaring it here would reject DELETE requests
    // with no body. PUT validates the body itself instead.
    handlers: {
        /**
         * GET /livetv/admin/categories/{categoryId}
         *
         * Returns the category as a bare mapped object.
         */
        GET: async (event, _ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const categoryId = event.params.categoryId;
            if (!categoryId || !isUuid(categoryId)) {
                return ApiProblem.validationFailed('Invalid category ID');
            }

            const row = await getCategoryById(sql, categoryId);
            if (!row) {
                return ApiProblem.notFound('Category not found');
            }

            return json(mapCategoryToApi(row));
        },

        /**
         * PUT /livetv/admin/categories/{categoryId}
         *
         * Partially updates a category or the visibility of its channels.
         * A changed nonzero start also renumbers the category's visible unpinned stations.
         *
         * Body is validated manually here — see the no-def-level-body note above.
         */
        PUT: async (event): Promise<Response> => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const categoryId = event.params.categoryId;
            if (!categoryId || !isUuid(categoryId)) {
                return ApiProblem.validationFailed('Invalid category ID');
            }

            let rawBody: unknown;
            try {
                rawBody = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsedBody = UpdateCategoryRequestSchema.safeParse(rawBody);
            if (!parsedBody.success) {
                return ApiProblem.validationFailed(
                    parsedBody.error.issues.map((issue) => ({
                        field: issue.path.join('.'),
                        message: issue.message,
                    })),
                );
            }
            const result = await updateLiveTvCategory(sql, categoryId, parsedBody.data);
            if (!result) return ApiProblem.notFound('Category not found');

            await invalidateLiveTvCaches();

            return json(result);
        },

        /**
         * DELETE /livetv/admin/categories/{categoryId}
         *
         * Deletes a category only when it has no channels.
         * Response: bare object { success: true } on success.
         * 422 validation_failed when category still has channels (move them first).
         * 404 not_found when category does not exist.
         */
        DELETE: async (event, _ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const categoryId = event.params.categoryId;
            if (!categoryId || !isUuid(categoryId)) {
                return ApiProblem.validationFailed('Invalid category ID');
            }

            const result = await deleteEmptyCategory(sql, categoryId);
            if (!result.deleted) {
                if (result.reason === 'has_channels') {
                    return ApiProblem.validationFailed(
                        'Cannot delete category with channels — move channels first',
                    );
                }
                return ApiProblem.notFound('Category not found');
            }

            await invalidateLiveTvCaches();

            return json({ ok: true as const });
        },
    },
});
