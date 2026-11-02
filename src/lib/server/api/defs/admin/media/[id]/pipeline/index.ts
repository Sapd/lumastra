// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/pipeline/index.ts
 *
 * GET  /api/admin/media/[id]/pipeline  — stage-state rows + summary
 * POST /api/admin/media/[id]/pipeline  — reset failed_permanent stages
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response:  { rows: StageStateRow[], summary: PipelineSummary }
 * POST response: { reset: number }
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { readStageBody } from './stage-body.js';
import { getDb } from '$lib/server/database/connection.js';
import { findRowsByItem } from '$lib/server/database/queries/stage-state.queries.js';
import { PipelineRemediationService } from '$lib/server/services/pipeline-remediation.service.js';
import {
    MediaPipelineGetResponseSchema,
    MediaPipelineResetResponseSchema,
    type MediaPipelineGetResponse,
    type MediaPipelineResetResponse,
} from '$lib/schemas/api-media-responses.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

// ---------------------------------------------------------------------------
// Response schemas — single-sourced from $lib/schemas/api-media-responses
// (also used by the v1 _openapi.ts at routes/api/v1/media/[id]/pipeline).
// ---------------------------------------------------------------------------

export const PipelineGetResponseSchema = MediaPipelineGetResponseSchema;
export const PipelineResetResponseSchema = MediaPipelineResetResponseSchema;

export type PipelineGetResponse = MediaPipelineGetResponse;
export type PipelineResetResponse = MediaPipelineResetResponse;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const rows = await findRowsByItem(sql, internalId);
            const summary = {
                total: rows.length,
                completed: rows.filter((r) => r.status === 'completed').length,
                in_progress: rows.filter((r) => r.status === 'running').length,
                failed: rows.filter(
                    (r) => r.status === 'failed_transient' || r.status === 'failed_permanent',
                ).length,
                pending: rows.filter((r) => r.status === 'pending').length,
                obsolete: rows.filter((r) => r.status === 'obsolete').length,
                skipped: rows.filter(
                    (r) => r.status === 'skipped_permanent' || r.status === 'skipped_transient',
                ).length,
            };

            return json(PipelineGetResponseSchema.parse({ rows, summary }));
        },

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
            const result = await service.resetFailed(internalId, stageId);
            // Audited with the AFFECTED COUNT, not merely the attempt. The five
            // stage-wide remediation verbs already do this; these per-item ones
            // did not, which is the exact shape of a recorded incident — an
            // operator correction that reported success, changed nothing, and
            // left no trail proving it. A zero here is the interesting value.
            auditLog('pipeline.item.retry', `${internalId}:${stageId ?? '*'}`, auditActor(event), {
                affected: result.reset,
            });
            return json(PipelineResetResponseSchema.parse(result));
        },
    },
});
