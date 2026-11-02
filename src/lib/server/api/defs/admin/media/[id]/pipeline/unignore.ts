// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/pipeline/unignore.ts
 *
 * POST /api/admin/media/[id]/pipeline/unignore
 *
 * Un-ignore: the reverse of `give-up` / `accept-reidentify-item`. Restores ONE
 * `skipped_permanent` (item, stageId) row to `pending` so it re-enters normal
 * stage-sweep processing. Before this endpoint existed, the only way back from
 * `skipped_permanent` was `invalidateByEvent` firing on a content or identity
 * change — an operator who ignored the wrong item had no escape hatch.
 *
 * Body: { stageId: string }
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { restored: number }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { PipelineRemediationService } from '$lib/server/services/pipeline-remediation.service.js';
import { isRecord, toString } from '$lib/utils/data-extraction.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const UnignoreResponseSchema = z.object({
    restored: z.number().int().min(0).max(1),
});

export type UnignoreResponse = z.infer<typeof UnignoreResponseSchema>;

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

            let stageId: string | undefined;
            try {
                const body: unknown = await event.request.json();
                if (isRecord(body) && body.stageId != null) {
                    stageId = toString(body.stageId)?.trim();
                }
            } catch {
                // fall through to the missing-stageId guard
            }

            if (!stageId) {
                return ApiProblem.validationFailed('stageId is required');
            }

            const service = new PipelineRemediationService(sql);
            const result = await service.unignoreItem(internalId, stageId);
            // Audited with the AFFECTED COUNT, not merely the attempt. The five
            // stage-wide remediation verbs already do this; these per-item ones
            // did not, which is the exact shape of a recorded incident — an
            // operator correction that reported success, changed nothing, and
            // left no trail proving it. A zero here is the interesting value.
            auditLog(
                'pipeline.item.unignore',
                `${internalId}:${stageId ?? '*'}`,
                auditActor(event),
                { affected: result.restored },
            );
            return json(UnignoreResponseSchema.parse(result));
        },
    },
});
