// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/episodes/reorder.ts
 *
 * PUT /api/admin/media/[id]/episodes/reorder
 *
 * Reorders episodes within a series by updating episode_number.
 * All items must belong to the given series.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { message: string }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { ReorderEpisodesRequestSchema } from '$lib/schemas/admin-episodes.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    verifyEpisodesBelongToSeries,
    reorderEpisodes,
} from '$lib/server/database/queries/episode-reorder.queries.js';

const logger = Logger.for('AdminEpisodesReorder');

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const ReorderResponseSchema = z.object({
    message: z.string(),
});

export type ReorderResponse = z.infer<typeof ReorderResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: ReorderEpisodesRequestSchema,
    },
    handlers: {
        PUT: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const { items } = ctx.input!.body;
            if (new Set(items.map((item) => item.episodeNumber)).size !== items.length) {
                return ApiProblem.validationFailed('Episode numbers must be unique');
            }
            const itemIds = items.map((i: { id: string }) => i.id);

            const existingIds = await verifyEpisodesBelongToSeries(sql, internalId, itemIds);
            const invalid = itemIds.filter((id: string) => !existingIds.has(id));
            if (invalid.length > 0) {
                return ApiProblem.validationFailed(
                    `Episodes not found in series: ${invalid.join(', ')}`,
                );
            }

            await reorderEpisodes(sql, items);

            MediaLifecycleService.afterMetadataChanged(internalId, ['episode_order']).catch(
                (err: unknown) => {
                    logger.error(
                        'afterMetadataChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { internalId, source: 'admin/episodes/reorder' },
                    );
                },
            );

            return json(
                ReorderResponseSchema.parse({ message: `Reordered ${items.length} episodes` }),
            );
        },
    },
});
