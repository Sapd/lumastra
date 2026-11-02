// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/pipeline/reevaluate.ts
 *
 * POST /api/admin/media/[id]/pipeline/reevaluate
 *
 * Force re-evaluate eligibility + enqueue for one item's pipeline.
 * Body: { stageId?: string } — omit to re-evaluate every applicable stage.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { enqueued: number, skipped: number }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { readStageBody } from './stage-body.js';
import { getDb } from '$lib/server/database/connection.js';
import { PipelineRemediationService } from '$lib/server/services/pipeline-remediation.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const ReevaluateResponseSchema = z.object({
    enqueued: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
});

export type ReevaluateResponse = z.infer<typeof ReevaluateResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            // No body = every stage; a malformed one is a 400, never "all".
            const parsed = await readStageBody(event.request);
            if (!parsed.ok) return parsed.response;
            const stageId = parsed.stageId;

            const service = new PipelineRemediationService(sql);
            const result = await service.reevaluate(internalId, stageId);
            // Audited with the AFFECTED COUNTS, not merely the attempt. The five
            // stage-wide remediation verbs already do this; these per-item ones
            // did not, which is the exact shape of a recorded incident — an
            // operator correction that reported success, changed nothing, and
            // left no trail proving it. `enqueued: 0` is the interesting value.
            auditLog(
                'pipeline.item.reevaluate',
                `${internalId}:${stageId ?? '*'}`,
                auditActor(event),
                { enqueued: result.enqueued, skipped: result.skipped },
            );
            return json(ReevaluateResponseSchema.parse(result));
        },
    },
});
