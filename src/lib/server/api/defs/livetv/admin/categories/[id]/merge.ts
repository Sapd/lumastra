// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/categories/[id]/merge.ts
 *
 * POST /livetv/admin/categories/{categoryId}/merge
 *   Moves all channels from the source category into the target category and
 *   deletes the (now-empty) source category.
 *   Response: bare object { success: true, movedChannelCount }.
 *
 * Auth: scope livetv:admin
 * Mounted on:
 *   /api/admin/livetv/categories/[categoryId]/merge        (internal SPA surface)
 *   /api/v1/livetv/admin/categories/{categoryId}/merge     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    mergeCategories,
    categoryExists,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { MergeCategoryRequestSchema } from '$lib/schemas/livetv.js';
import { MergeCategoryResponseSchema } from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Merge a category into a target category',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Moves all channels from the source category (path) into the target category ' +
                '(body) and deletes the now-empty source category.',
            body: MergeCategoryRequestSchema,
            responses: {
                200: { schema: MergeCategoryResponseSchema, description: 'Categories merged' },
                401: 'Authentication required',
                404: 'Target category not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: MergeCategoryRequestSchema,
    },
    handlers: {
        /**
         * POST /livetv/admin/categories/{categoryId}/merge
         *
         * Merges sourceCategoryId (from path) into targetCategoryId (from body).
         * mount() has already validated ctx.input.body.
         */
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const sourceCategoryId = event.params.categoryId;
            if (!sourceCategoryId || !isUuid(sourceCategoryId)) {
                return ApiProblem.validationFailed('Invalid source category ID');
            }

            const { targetCategoryId } = ctx.input!.body as { targetCategoryId: string };

            if (!isUuid(targetCategoryId)) {
                return ApiProblem.validationFailed('Invalid target category ID');
            }
            if (sourceCategoryId === targetCategoryId) {
                return ApiProblem.validationFailed('Cannot merge category into itself');
            }

            const target = await categoryExists(sql, targetCategoryId);
            if (!target) {
                return ApiProblem.notFound('Target category not found');
            }

            const result = await mergeCategories(sql, sourceCategoryId, targetCategoryId);

            await invalidateLiveTvCaches();

            // eslint-disable-next-line callback-safety/no-success-key-in-response -- MergeCategoryResponseSchema declares success:true (see livetv.test.ts)
            return json({ success: true as const, movedChannelCount: result.movedChannelCount });
        },
    },
});
