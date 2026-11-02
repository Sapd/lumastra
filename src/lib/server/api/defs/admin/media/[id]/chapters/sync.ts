// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/chapters/sync.ts
 *
 * POST /api/admin/media/[id]/chapters/sync
 *
 * Enqueues a chapter-sync job for a series. The task system provides run
 * history, cancellation, and visibility in the admin UI.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { started: boolean, runId: string, deduped?: boolean }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const ChapterSyncResponseSchema = z.object({
    started: z.boolean(),
    runId: z.string(),
    /** True when this click collapsed into an already-running run. */
    deduped: z.boolean().optional(),
});

export type ChapterSyncResponse = z.infer<typeof ChapterSyncResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const result = await orchestrator.startRun(
                'chapter-sync',
                // Explicit re-sync: probe the file again instead of reusing the
                // chapters already known for it.
                { mediaItemId: internalId, force: true },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: `admin/media/${internalId}/chapters/sync`,
                    },
                    priority: 1,
                    idempotencyKey: internalId,
                    subject: { type: 'mediaItem', id: internalId },
                },
            );

            return json(
                ChapterSyncResponseSchema.parse({
                    started: true,
                    runId: result.runId,
                    deduped: result.deduped,
                }),
            );
        },
    },
});
