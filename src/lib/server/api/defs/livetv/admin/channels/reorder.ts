// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/reorder.ts — PUT /livetv/admin/channels/reorder
 *
 * Batch-updates the sort order of channels and/or categories in a single
 * transaction. At least one of channels[] or categories[] must be non-empty
 * (enforced by the schema's .refine()).
 *
 * Response: 200 bare object { reordered: true }
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * 503 dependency_unavailable when the database is unreachable.
 * 422 validation_failed on invalid body (enforced by ReorderChannelsRequestSchema).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { ReorderChannelsRequestSchema } from '$lib/schemas/livetv.js';
import {
    batchUpdateChannelSortOrder,
    batchUpdateCategorySortOrder,
    listCategories,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { ChannelsReorderedResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: 'Reorder channels',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ChannelsReorderedResponseSchema,
                    description: 'Channel order updated',
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
        body: ReorderChannelsRequestSchema,
        // A whole-lineup reorder: ~110 bytes per channel entry, and a large IPTV
        // provider has 12k+ channels; the schema allows 50,000 rows (~5.5 MB).
        // The admin UI sends only changed rows, so this is the worst case.
        maxBodyBytes: 6_000_000,
    },
    handlers: {
        /**
         * PUT /livetv/admin/channels/reorder
         *
         * Applies channel and category sort-order updates in a single DB transaction.
         * Both arrays are optional individually but at least one must be non-empty.
         * Invalidates the Live TV cache on success.
         */
        PUT: async (_event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const body = ctx.input!.body!;

            // Validate all category references before either batch is written.
            const categoryIds = new Set([
                ...(body.categories ?? []).map((category) => category.id),
                ...(body.channels ?? []).flatMap((channel) =>
                    channel.categoryId ? [channel.categoryId] : [],
                ),
            ]);
            if (categoryIds.size > 0) {
                const existing = new Set(
                    (await listCategories(sql)).map((category) => category.id),
                );
                if ([...categoryIds].some((id) => !existing.has(id.toLowerCase()))) {
                    return ApiProblem.validationFailed('Category not found');
                }
            }

            await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as typeof sql;
                if (body.channels?.length) {
                    await batchUpdateChannelSortOrder(tx, body.channels);
                }
                if (body.categories?.length) {
                    await batchUpdateCategorySortOrder(tx, body.categories);
                }
            });

            await invalidateLiveTvCaches();

            return json({ reordered: true });
        },
    },
});
