// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/bulk-metadata.ts
 *
 * PUT /api/admin/media/bulk-metadata
 *
 * Bulk-merge custom_metadata for a list of media items.
 * Does NOT lock items — bulk edits from content managers should not prevent sync.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { updatedCount: number, skippedCount: number }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { bulkUpdateCustomMetadata } from '$lib/server/database/queries/non-entertainment-browse.queries.js';
import { reservedCustomMetadataKeys } from '$lib/server/utils/custom-metadata-reserved.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

export const BulkMetadataRequestSchema = z.object({
    // Bounded to cap resource use — the merge runs one statement per id. Chunk
    // client-side for larger batches.
    ids: z.array(z.string().guid()).min(1).max(500),
    // Request-side raw merge payload: arbitrary custom_metadata fields chosen by
    // the admin, bulk-merged into each item's freeform JSONB column verbatim.
    // No fixed schema is possible (heterogeneous per-key value types) — but the
    // key count is capped so an unbounded blob can't be merged verbatim.
    metadata: z.record(z.string(), z.unknown()).refine((m) => Object.keys(m).length <= 100, {
        message: 'metadata may not exceed 100 keys',
    }),
});

export const BulkMetadataResponseSchema = z.object({
    updatedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
});

export type BulkMetadataRequest = z.infer<typeof BulkMetadataRequestSchema>;
export type BulkMetadataResponse = z.infer<typeof BulkMetadataResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: BulkMetadataRequestSchema,
    },
    handlers: {
        PUT: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { ids, metadata } = ctx.input!.body;
            const reserved = reservedCustomMetadataKeys(metadata);
            if (reserved.length > 0) {
                return ApiProblem.validationFailed(
                    `Server-managed metadata keys cannot be set here: ${reserved.join(', ')}`,
                );
            }

            const updatedCount = await bulkUpdateCustomMetadata(sql, ids, metadata);
            const skippedCount = ids.length - updatedCount;

            return json(BulkMetadataResponseSchema.parse({ updatedCount, skippedCount }));
        },
    },
});
