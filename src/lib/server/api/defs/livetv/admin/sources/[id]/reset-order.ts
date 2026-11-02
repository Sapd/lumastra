// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/[id]/reset-order.ts
 *
 * POST /livetv/admin/sources/{sourceId}/reset-order
 *   Reset channel display order to the source M3U playlist order.
 *   Copies each channel's playlist_index into sort_order, discarding any
 *   guided-setup / manual reordering. Channels imported before playlist_index
 *   existed (NULL) are left untouched — run a refresh first to backfill them.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: { updated: number }  (bare object)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getSourceById } from '$lib/server/database/queries/livetv-sources.queries.js';
import { resetChannelSortToPlaylistOrder } from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { ResetChannelOrderResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Reset channel order to the source playlist order',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Copies each channel`s M3U playlist_index into sort_order, discarding any guided-' +
                'setup or manual reordering. Channels with a NULL playlist_index are left untouched.',
            responses: {
                200: {
                    schema: ResetChannelOrderResponseSchema,
                    description: 'Channel order reset',
                },
                401: 'Authentication required',
                404: 'Source not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ sourceId: z.string().min(1) }),
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;

            const source = await getSourceById(sql, sourceId);
            if (!source) return ApiProblem.notFound('Source not found');

            const updated = await resetChannelSortToPlaylistOrder(sql, sourceId);

            await invalidateLiveTvCaches();

            return json({ updated });
        },
    },
});
