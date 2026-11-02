// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/trickplay/generate.ts
 *
 * POST /api/admin/media/[id]/trickplay/generate
 *
 * Queues trickplay generation for a specific media item.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { runId: string, message: string, deduped?: boolean }
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { trickplayGenerateBodySchema } from '$lib/schemas/playback.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const TrickplayGenerateResponseSchema = z.object({
    runId: z.string(),
    message: z.string(),
    /**
     * True when the orchestrator collapsed this click into an already-running
     * run instead of queueing new work. Without it the UI reports "queued" for
     * a request that started nothing.
     */
    deduped: z.boolean().optional(),
});

export type TrickplayGenerateResponse = z.infer<typeof TrickplayGenerateResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: trickplayGenerateBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item');

            const { width, force } = ctx.input!.body as { width?: number; force?: boolean };

            const result = await orchestrator.startRun(
                'trickplay-generation',
                { mediaItemId: internalId, width, force },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: `admin/media/${internalId}/trickplay/generate`,
                    },
                    priority: 1,
                    idempotencyKey: force ? undefined : `trickplay:${internalId}`,
                    subject: { type: 'mediaItem', id: internalId },
                },
            );

            return json(
                TrickplayGenerateResponseSchema.parse({
                    runId: result.runId,
                    message: 'Trickplay generation queued for media item',
                    deduped: result.deduped,
                }),
            );
        },
    },
});
