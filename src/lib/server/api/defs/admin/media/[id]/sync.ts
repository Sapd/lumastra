// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/sync.ts
 *
 * POST /api/admin/media/[id]/sync
 *
 * Per-media-item metadata sync.
 * Single item (includeChildren=false): executes inline, returns sync result.
 * Series (includeChildren=true): enqueues series-sync job.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response (inline): { started?: never, runId?: never, ...syncResult }
 * Response (queued): { started: boolean, runId: string, deduped?: boolean }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { syncSingleItem } from '$lib/server/services/metadata-sync-single.service.js';
import { SyncRequestSchema } from '$lib/schemas/metadata-sync.js';
import { isEpisode, isSeason } from '$lib/server/utils/media-types.js';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const SyncQueuedResponseSchema = z.object({
    success: z.literal(true),
    started: z.boolean(),
    runId: z.string(),
    /** True when this click collapsed into an already-running run. */
    deduped: z.boolean().optional(),
});

export type SyncQueuedResponse = z.infer<typeof SyncQueuedResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: SyncRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const { includeChildren, forceChildren } = ctx.input!.body;

            const [typeRow] = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${internalId}
            `;
            if (!typeRow) return ApiProblem.notFound('Media item not found');
            if (isEpisode(typeRow.media_type) || isSeason(typeRow.media_type)) {
                return ApiProblem.validationFailed(
                    'Cannot sync episode or season directly — sync the parent series instead',
                );
            }

            if (!includeChildren) {
                const result = await syncSingleItem(sql, internalId, {
                    force: true,
                    respectLocks: true,
                });
                // eslint-disable-next-line callback-safety/no-success-key-in-response -- Internal legacy SyncResponseSchema exposes operation success alongside updated/fieldsChanged.
                return json({ success: true, ...result });
            }

            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            const result = await orchestrator.startRun(
                'series-sync',
                {
                    mediaItemId: internalId,
                    force: true,
                    respectLocks: true,
                    forceChildren,
                    // Explicit admin re-sync: expand a not-yet-owned series on purpose.
                    forceCreateChildren: true,
                },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: `admin/media/${internalId}/sync`,
                    },
                    priority: 1,
                    idempotencyKey: internalId,
                    subject: { type: 'mediaItem', id: internalId },
                },
            );

            return json(
                SyncQueuedResponseSchema.parse({
                    success: true,
                    started: true,
                    runId: result.runId,
                    deduped: result.deduped,
                }),
            );
        },
    },
});
