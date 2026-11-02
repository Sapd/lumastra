// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/[id].ts — PUT /livetv/admin/channels/{channelId}
 *
 * Partially updates a single channel's admin-facing fields.
 * At least one field must be provided (enforced by the schema's .refine()).
 *
 * Response: 200 bare object { updated: true }
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * 503 dependency_unavailable when the database is unreachable.
 * 404 not_found when the channel UUID does not exist.
 * 422 validation_failed on invalid body or non-UUID channelId.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { UpdateChannelRequestSchema } from '$lib/schemas/livetv.js';
import { updateChannel } from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { ChannelUpdatedResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: 'Update an admin channel',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: { schema: ChannelUpdatedResponseSchema, description: 'Channel updated' },
                401: 'Authentication required',
                404: 'Channel not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ channelId: z.string().min(1) }),
        body: UpdateChannelRequestSchema,
    },
    handlers: {
        /**
         * PUT /livetv/admin/channels/{channelId}
         *
         * Applies a partial update (isVisible, qualityTier, adminDisplayName,
         * categoryId) to the given channel. Invalidates the Live TV cache on success.
         */
        PUT: async (_event, ctx) => {
            const { channelId } = ctx.input!.params!;

            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'params.channelId', message: 'Must be a valid UUID' },
                ]);
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const found = await updateChannel(sql, channelId, ctx.input!.body!);
            if (!found) return ApiProblem.notFound('Channel not found');

            await invalidateLiveTvCaches();

            return json({ updated: true });
        },
    },
});
