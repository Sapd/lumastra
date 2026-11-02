// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/task-system/pipeline/accept-reidentify-item
 *
 * Per-item "accept as expected": flip ONE non-retryable `failed_permanent`
 * dead-letter to `skipped_permanent`. Backs the "Not on TMDB — accept" verb
 * on Library → Fix matches' "Broken match" view (/admin/library/fix-matches
 * ?view=broken), formerly /admin/operations/reidentify. Self-heals: re-
 * identifying the item later returns the row to pending via the usual
 * invalidation path.
 *
 * Body: { mediaItemId: string (uuid), stageId: string, reason?: string }  →  { count: 0 | 1 }
 * Auth: tasks:admin scope.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { PipelineRemediationService } from '$lib/server/services/pipeline-remediation.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const BodySchema = z.object({
    mediaItemId: z.string().guid().describe('media_items.id'),
    stageId: z.string().min(1).describe('Pipeline stage id'),
    reason: z.string().min(1).optional().describe('Operator-supplied skip reason'),
});

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    request: {
        body: BodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const { mediaItemId, stageId, reason } = ctx.input!.body;
            const service = new PipelineRemediationService(sql);
            const count = await service.acceptReidentifyItem(mediaItemId, stageId, reason);

            auditLog('pipeline.accept-reidentify-item', mediaItemId, auditActor(event), {
                stageId,
                count,
                reason,
            });

            return json({ count });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
