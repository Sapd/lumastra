// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/index.ts — GET /livetv/admin/channels
 *
 * Returns the full admin channel list grouped by category.
 * Response: bare grouped object { categories, totalChannels, visibleChannels }
 *   (not a paginate envelope — the data is inherently grouped/nested, not a flat
 *   collection, so a {items,page} envelope would not be meaningful here).
 *
 * Optional query param:
 *   ?sourceId=<uuid>   filter to a single IPTV source
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * 503 dependency_unavailable when the database is unreachable.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getChannelsForAdmin } from '$lib/server/database/queries/livetv-channels.queries.js';
import { groupChannelsByCategory } from '$lib/server/utils/livetv-admin-transforms.js';
import { AdminChannelsResponseSchema } from '$lib/schemas/livetv';
import { ensureChannelNumbers } from '$lib/server/services/livetv/channel-numbers.service.js';
import { withHealth } from '$lib/server/services/livetv/channel-health.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LiveTvAdminChannels');

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'List admin channels grouped by category',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: AdminChannelsResponseSchema,
                    description: 'Channels grouped by category with admin fields',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            sourceId: z.string().optional(),
        }),
    },
    handlers: {
        /**
         * GET /livetv/admin/channels
         *
         * Returns all channels grouped by category with admin-facing fields
         * (epgChannelId, adminDisplayName, backupGroupId, etc.).
         * An optional ?sourceId= query param filters to a single IPTV source.
         */
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const sourceId = ctx.input?.query?.sourceId;
            // Number new stations (and free lost numbers) first, so the list
            // shows what viewers get. Never fatal for the admin list.
            let numberOverflow: Map<string, number> | undefined;
            try {
                numberOverflow = (await ensureChannelNumbers(sql)).overflow;
            } catch (error) {
                logger.warn('Channel numbers unavailable', {
                    error: (error as Error).message,
                });
            }
            const rows = await getChannelsForAdmin(sql, sourceId);
            const data = groupChannelsByCategory(rows, numberOverflow);
            // Each category's channels get their feed health (ok when no failure was recorded).
            const withHealthByCategory = await Promise.all(
                data.categories.map(async (category) => ({
                    ...category,
                    channels: await withHealth(sql, category.channels),
                })),
            );

            return json({ ...data, categories: withHealthByCategory });
        },
    },
});
