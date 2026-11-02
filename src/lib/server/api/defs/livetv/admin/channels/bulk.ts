// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/bulk.ts — PUT /livetv/admin/channels/bulk
 *
 * Applies a bulk action (hide/show/setQuality/moveToCategory) to a set of
 * channels identified by UUID. Up to 1 000 channels per request.
 *
 * Response: 200 bare object { updatedCount: number }
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * 503 dependency_unavailable when the database is unreachable.
 * 422 validation_failed on invalid body (enforced by BulkUpdateChannelsRequestSchema).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { BulkUpdateChannelsRequestSchema } from '$lib/schemas/livetv.js';
import {
    bulkUpdateChannels,
    getCategoryById,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { BulkChannelUpdateResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: 'Bulk update multiple channels',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: BulkChannelUpdateResponseSchema,
                    description: 'Number of channels updated',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: BulkUpdateChannelsRequestSchema,
    },
    handlers: {
        /**
         * PUT /livetv/admin/channels/bulk
         *
         * Applies the requested bulk action to all channel IDs in the body.
         * Returns the count of affected rows. Invalidates the Live TV cache.
         */
        PUT: async (_event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { channelIds, action, qualityTier, categoryId } = ctx.input!.body!;

            const updates: {
                isVisible?: boolean;
                qualityTier?: string;
                categoryId?: string;
            } = {};
            switch (action) {
                case 'hide':
                    updates.isVisible = false;
                    break;
                case 'show':
                    updates.isVisible = true;
                    break;
                case 'setQuality':
                    updates.qualityTier = qualityTier;
                    break;
                case 'moveToCategory':
                    if (categoryId && !(await getCategoryById(sql, categoryId))) {
                        return ApiProblem.validationFailed('Category not found');
                    }
                    updates.categoryId = categoryId;
                    break;
            }

            const updatedCount = await bulkUpdateChannels(sql, channelIds, updates);

            await invalidateLiveTvCaches();

            return json({ updatedCount });
        },
    },
});
