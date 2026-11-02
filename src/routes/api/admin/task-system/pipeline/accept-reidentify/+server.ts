// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/task-system/pipeline/accept-reidentify
 *
 * Stage-wide "accept as expected": flip a stage's PERMANENT (non-retryable)
 * `failed_permanent` dead-letters to `skipped_permanent`. Backs the "Accept as
 * expected" action on a `needs-reidentification` attention item — the closure
 * path for data problems a retry can never fix (e.g. content genuinely not on
 * TMDB). Self-heals: re-identifying the underlying media later flips the row back
 * to pending via the usual invalidation path.
 *
 * Body: { stageId: string, reason?: string }  →  { count: <rows accepted> }
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

            const { stageId, reason } = ctx.input!.body;
            const service = new PipelineRemediationService(sql);
            const count = await service.acceptReidentifyForStage(stageId, reason);

            auditLog('pipeline.accept-reidentify', stageId, auditActor(event), { count, reason });

            return json({ count });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
