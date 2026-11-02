// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/reconciliation-backfill
 *
 * Triggers the episode reconciliation backfill task — re-runs the content
 * matcher over existing series to correct historical mis-mappings.
 *
 *   - `{}`                        → library-wide stale-only drain.
 *   - `{ seriesMediaId }`         → re-run a single series.
 *   - `{ force: true }`           → re-sweep every eligible series.
 *   - `{ minConfidence, quarantineFloor, batchSize }` → tuning overrides.
 *
 * Auth: tasks:admin. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import {
    ReconciliationBackfillRequestSchema,
    ReconciliationBackfillResponseSchema,
} from '$lib/schemas/admin-reconciliation-backfill.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    request: {
        body: ReconciliationBackfillRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { seriesMediaId, batchSize, minConfidence, quarantineFloor, force } =
                ctx.input!.body;

            const result = await orchestrator.startRun(
                'reconciliation-backfill',
                { seriesMediaId, batchSize, minConfidence, quarantineFloor, force },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: 'admin/reconciliation-backfill',
                    },
                    priority: 1,
                    idempotencyKey: `reconciliation-backfill:${seriesMediaId ?? 'full'}:${
                        force ? 'force' : 'stale'
                    }`,
                },
            );

            return json(
                ReconciliationBackfillResponseSchema.parse({
                    runId: result.runId,
                    message: seriesMediaId
                        ? `Reconciliation backfill queued for series ${seriesMediaId}`
                        : 'Library-wide reconciliation backfill queued',
                }),
            );
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
