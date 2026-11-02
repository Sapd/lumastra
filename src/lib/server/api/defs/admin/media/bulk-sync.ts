// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/bulk-sync.ts
 *
 * POST /api/admin/media/bulk-sync
 *
 * Bulk metadata sync for an admin-selected batch of media items. Unlike
 * bulk-lock.ts, this hits the metadata provider (TMDB) once per item — a
 * synchronous request over a large batch would blow the request timeout, so
 * this ENQUEUES a `bulk-media-sync` task run and returns immediately. Progress
 * and completion are polled via the generic /api/runs/{jobId} endpoint (same
 * pattern as /api/admin/auto-identify), not by re-POSTing here.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { started: true, jobId: string }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

export const BulkSyncRequestSchema = z.object({
    // Bounded to cap the run's own workload — mirrors bulk-metadata.ts's cap.
    // Chunk client-side for larger batches.
    ids: z.array(z.string().guid()).min(1).max(500),
    includeChildren: z.boolean().optional().default(false),
    forceChildren: z.boolean().optional().default(false),
});

export const BulkSyncEnqueueResponseSchema = z.object({
    started: z.literal(true),
    jobId: z.string(),
});

export type BulkSyncRequest = z.infer<typeof BulkSyncRequestSchema>;
export type BulkSyncEnqueueResponse = z.infer<typeof BulkSyncEnqueueResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: BulkSyncRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { ids, includeChildren, forceChildren } = ctx.input!.body;

            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            const result = await orchestrator.startRun(
                'bulk-media-sync',
                { mediaItemIds: ids, includeChildren, forceChildren },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: 'admin/media/bulk-sync',
                    },
                    priority: 1,
                },
            );

            return json(
                BulkSyncEnqueueResponseSchema.parse({
                    started: true,
                    jobId: result.runId,
                }),
            );
        },
    },
});
