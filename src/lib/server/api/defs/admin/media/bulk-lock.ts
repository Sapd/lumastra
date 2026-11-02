// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/bulk-lock.ts
 *
 * PATCH /api/admin/media/bulk-lock
 *
 * Bulk lock/unlock media items (cheap DB-only op — one UPDATE statement for
 * the whole batch). This is the DB-only counterpart to bulk-sync.ts: locking
 * never calls a provider, so it does not need to be enqueued as a task.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { updatedCount: number, skippedCount: number, failedIds: string[] }
 * `failedIds` names the ids that did not match a row, so a caller that fails
 * for everyone can retry the same selection instead of re-picking it.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { bulkSetLockMediaItems } from '$lib/server/database/queries/media-items.queries.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

export const BulkLockRequestSchema = z.object({
    // Bounded to cap resource use — mirrors bulk-metadata.ts's cap. Chunk
    // client-side for larger batches.
    ids: z.array(z.string().guid()).min(1).max(500),
    locked: z.boolean(),
});

export const BulkLockResponseSchema = z.object({
    updatedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failedIds: z.array(z.string()),
});

export type BulkLockRequest = z.infer<typeof BulkLockRequestSchema>;
export type BulkLockResponse = z.infer<typeof BulkLockResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: BulkLockRequestSchema,
    },
    handlers: {
        PATCH: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { ids, locked } = ctx.input!.body;
            // Only meaningful when locking — unlock always clears the field,
            // mirroring the single-item DELETE /api/media/[id]/metadata path.
            const lockedBy = locked ? (event.locals.user?.username ?? null) : null;

            const updatedIds = await bulkSetLockMediaItems(sql, ids, locked, lockedBy);
            const updatedSet = new Set(updatedIds);
            const failedIds = ids.filter((id) => !updatedSet.has(id));

            return json(
                BulkLockResponseSchema.parse({
                    updatedCount: updatedIds.length,
                    skippedCount: failedIds.length,
                    failedIds,
                }),
            );
        },
    },
});
