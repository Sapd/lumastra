// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/[id]/epg.ts — PUT /livetv/admin/channels/{channelId}/epg
 *
 * Sets or clears the EPG channel-id match for a given channel.
 * Passing null for epgChannelId removes the match (unmatch).
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
import { UpdateEpgMatchRequestSchema } from '$lib/schemas/livetv.js';
import { updateEpgMatch } from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { ChannelUpdatedResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: 'Set or clear a channel EPG match',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Sets (or clears, with a null `epgChannelId`) the EPG channel-id match for a ' +
                'channel and marks it as a manual override.',
            body: UpdateEpgMatchRequestSchema,
            responses: {
                200: { schema: ChannelUpdatedResponseSchema, description: 'EPG match updated' },
                401: 'Authentication required',
                404: 'Channel not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ channelId: z.string().min(1) }),
        body: UpdateEpgMatchRequestSchema,
    },
    handlers: {
        /**
         * PUT /livetv/admin/channels/{channelId}/epg
         *
         * Writes (or clears) the epg_channel_id match for the channel and marks it
         * as a manual override. Invalidates the Live TV cache on success.
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

            const { epgChannelId } = ctx.input!.body!;

            const found = await updateEpgMatch(sql, channelId, epgChannelId, true);
            if (!found) return ApiProblem.notFound('Channel not found');

            await invalidateLiveTvCaches();

            return json({ updated: true });
        },
    },
});
