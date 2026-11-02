// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/[id]/health/reset.ts
 *
 * POST /livetv/admin/channels/{channelId}/health/reset — clear the feed's failure streak.
 * The feed shows as `ok` again and, when LIVETV_HIDE_OFFLINE_AFTER_FAILURES hid its station,
 * the station reappears for viewers.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { LiveTvChannelHealthSchema } from '$lib/schemas/livetv-failures.js';
import { reset } from '$lib/server/database/queries/livetv-channel-health.queries.js';
import { EMPTY_HEALTH_VIEW } from '$lib/server/services/livetv/channel-health.service.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: "Reset a feed's playback health",
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Clears the consecutive-failure count of the feed. Use it after fixing the source, ' +
                'to see whether the channel plays again.',
            responses: {
                200: { schema: LiveTvChannelHealthSchema, description: 'Health after the reset' },
                401: 'Authentication required',
                404: 'Channel not found',
                422: 'Validation failed',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ channelId: z.string().min(1) }),
    },
    handlers: {
        POST: async (_event, ctx) => {
            const { channelId } = ctx.input!.params!;
            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'params.channelId', message: 'Must be a valid UUID' },
                ]);
            }
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const found = await reset(sql, channelId);
            if (!found) return ApiProblem.notFound('Channel not found');
            // The lineup caches hold the hide-offline decision's inputs; drop them.
            await invalidateLiveTvCaches();
            return json(EMPTY_HEALTH_VIEW);
        },
    },
});
