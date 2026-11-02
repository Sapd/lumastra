// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/task-system/pipeline/retry-stage
 *
 * Stage-wide bulk retry: flip every `failed_permanent` row for a stage back to
 * `pending` so stage-sweep retries the whole dead-letter group. Backs the
 * "Retry all" action on a dead-letter attention item.
 *
 * Body: { stageId: string }  →  { count: <rows reset> }
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

            const { stageId } = ctx.input!.body;
            const service = new PipelineRemediationService(sql);
            const count = await service.resetFailedForStage(stageId);

            auditLog('pipeline.retry-stage', stageId, auditActor(event), { count });

            return json({ count });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
