// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/[id]/number.ts
 *
 * PUT    /livetv/admin/channels/{channelId}/number — give the channel's station a
 *        number and pin it. 409 when another station has it (unless `swap`).
 * DELETE /livetv/admin/channels/{channelId}/number — unpin: the number stays, but
 *        renumbering and freeing hidden numbers may change it again.
 *
 * A number belongs to the station card: all feeds of a backup group share it.
 * Design: docs/superpowers/specs/2026-10-16-livetv-channel-numbers-design.md.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    ChannelNumberResponseSchema,
    ChannelUpdatedResponseSchema,
    SetChannelNumberRequestSchema,
} from '$lib/schemas/livetv.js';
import {
    setChannelNumber,
    unpinChannelNumber,
} from '$lib/server/services/livetv/channel-numbers.service.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: "Set a channel's number",
            stability: 'experimental',
            auth: 'bearer',
            description:
                "Gives the channel's station (all feeds of its backup group) this number and pins " +
                'it. When another station has the number the call fails with 409 and the other ' +
                "station's name in `details`, unless `swap` is true.",
            body: SetChannelNumberRequestSchema,
            responses: {
                200: { schema: ChannelNumberResponseSchema, description: 'Number set' },
                401: 'Authentication required',
                404: 'Channel not found',
                409: 'Another station has this number',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Live TV'],
            summary: "Unpin a channel's number",
            stability: 'experimental',
            auth: 'bearer',
            responses: {
                200: { schema: ChannelUpdatedResponseSchema, description: 'Number unpinned' },
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
    },
    handlers: {
        PUT: async (event, ctx) => {
            const { channelId } = ctx.input!.params!;
            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'params.channelId', message: 'Must be a valid UUID' },
                ]);
            }
            let rawBody: unknown;
            try {
                rawBody = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }
            const parsed = SetChannelNumberRequestSchema.safeParse(rawBody);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((issue) => ({
                        field: issue.path.join('.'),
                        message: issue.message,
                    })),
                );
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const result = await setChannelNumber(sql, channelId, parsed.data.number, {
                swap: parsed.data.swap === true,
            });
            switch (result.status) {
                case 'not_found':
                    return ApiProblem.notFound('Channel not found');
                case 'invalid':
                    return ApiProblem.validationFailed([
                        { field: 'number', message: 'Must be between 1 and 9999' },
                    ]);
                case 'conflict':
                    return ApiProblem.conflict('Another channel has this number', {
                        details: result.holderName ?? '',
                    });
                case 'ok':
                    await invalidateLiveTvCaches();
                    return json({ number: result.number });
            }
        },

        DELETE: async (_event, ctx) => {
            const { channelId } = ctx.input!.params!;
            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'params.channelId', message: 'Must be a valid UUID' },
                ]);
            }
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const found = await unpinChannelNumber(sql, channelId);
            if (!found) return ApiProblem.notFound('Channel not found');
            await invalidateLiveTvCaches();
            return json({ updated: true as const });
        },
    },
});
