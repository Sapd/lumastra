// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/categories/[id]/channel-count.ts
 *
 * GET /livetv/admin/categories/{categoryId}/channel-count
 *   Returns the number of channels assigned to the given category.
 *   Response: bare object { count }.
 *
 * Auth: scope livetv:admin
 * Mounted on:
 *   /api/admin/livetv/categories/[categoryId]/channel-count        (internal SPA surface)
 *   /api/v1/livetv/admin/categories/{categoryId}/channel-count     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getCategoryChannelCount } from '$lib/server/database/queries/livetv-channels.queries.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { CategoryChannelCountResponseSchema } from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Get the channel count for a category',
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: { schema: CategoryChannelCountResponseSchema, description: 'Channel count' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    handlers: {
        /**
         * GET /livetv/admin/categories/{categoryId}/channel-count
         *
         * Reads the channel count for the given category.
         * Used by the merge confirmation UI to show the user how many channels
         * will be moved.
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

            const count = await getCategoryChannelCount(sql, categoryId);

            // Bare object: { count }
            return json({ count });
        },
    },
});
