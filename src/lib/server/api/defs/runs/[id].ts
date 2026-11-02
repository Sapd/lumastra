// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/runs/{id}
 *
 * Requires `runs:read` scope.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { toPublicRun } from '$lib/server/tasks/run-event.js';
import { RunSchema } from '$lib/schemas/run.schema.js';
import { json } from '@sveltejs/kit';

// The handler returns orchestrator.getRun() FLAT (error.stack redacted). Reuse
// the canonical RunSchema (which re-exports the SDK Run shape); the previous
// local { run: {...stale fields} } wrapper matched neither the flatness nor the
// real state/trigger/stages/actor shape.
const RunDetailResponseSchema = RunSchema;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Runs'],
            summary: 'Get a task run',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns details for a single task run by UUID. Requires `runs:read` scope.',
            responses: {
                200: {
                    schema: RunDetailResponseSchema,
                    description: 'Run details',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Run not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['runs:read'] },
    handlers: {
        GET: async (event) => {
            const runId = event.params.id!;
            const run = await orchestrator.getRun(runId);
            if (!run) {
                return ApiProblem.notFound(`Run '${runId}' not found`);
            }

            // Drop error.stack and the internal trigger.idempotencyKey (see tasks/run-event.ts).
            const safeRun = toPublicRun(run);

            return json(safeRun);
        },
    },
});
