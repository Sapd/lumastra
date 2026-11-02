// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/pipeline/timeline.ts
 *
 * GET /api/admin/media/[id]/pipeline/timeline
 *
 * Composed per-item pipeline timeline: stages, run refs, stuck-reason
 * diagnosis, event_outbox history, summary. Delegates to PipelineTimelineService.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: PipelineTimelineResponse (validated via PipelineTimelineResponseSchema)
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { PipelineTimelineService } from '$lib/server/services/pipeline-timeline.service.js';
import { PipelineTimelineResponseSchema } from '$lib/schemas/pipeline-timeline.schema.js';

// Re-export for route-file convenience
export { PipelineTimelineResponseSchema };

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

            const service = new PipelineTimelineService(sql);
            const payload = await service.buildTimeline(internalId);
            // Validate before responding so a shape regression surfaces here.
            return json(PipelineTimelineResponseSchema.parse(payload));
        },
    },
});
