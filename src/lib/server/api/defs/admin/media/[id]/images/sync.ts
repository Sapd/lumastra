// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/images/sync.ts
 *
 * POST /api/admin/media/[id]/images/sync
 *
 * Queues image sync (local file scanning + optional video extraction).
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { runId: string, message: string }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { imageSyncBodySchema } from '$lib/schemas/playback.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const ImageSyncResponseSchema = z.object({
    deduped: z.boolean().optional(),
    runId: z.string(),
    message: z.string(),
});

export type ImageSyncResponse = z.infer<typeof ImageSyncResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: imageSyncBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item');

            const { artworkType, extractVideo, force, mode, scope } = ctx.input!.body;

            const result = await orchestrator.startRun(
                'image-sync',
                { mediaItemId: internalId, mode, scope, extractVideo, artworkType, force },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: `admin/media/${internalId}/images/sync`,
                    },
                    priority: 1,
                    // Like every other task button on the detail page: the
                    // subject is how the page's tracker finds the run's
                    // progress, and the key collapses a double click into one
                    // run. A forced sync always starts a new one.
                    subject: { type: 'mediaItem', id: internalId },
                    idempotencyKey: force
                        ? undefined
                        : `${internalId}:${mode ?? 'default'}:${scope ?? 'default'}:${artworkType ?? 'all'}:${extractVideo ? 'video' : 'no-video'}`,
                },
            );

            return json(
                ImageSyncResponseSchema.parse({
                    runId: result.runId,
                    deduped: result.deduped,
                    message: result.deduped ? 'Image sync already running' : 'Image sync queued',
                }),
            );
        },
    },
});
