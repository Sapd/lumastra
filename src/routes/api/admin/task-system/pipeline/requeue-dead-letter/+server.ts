// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/task-system/pipeline/requeue-dead-letter
 *
 * Operator override: requeue EVERY dead-lettered pipeline event in the
 * `event_outbox`. Clears `dead_letter`, resets attempts/backoff, and resets the
 * transient-error auto-requeue budget so each parked event gets a fresh full
 * run on the dispatcher's next tick. Backs the "Requeue" action on the
 * `outbox-dead-letter` attention item.
 *
 * The dispatcher already auto-requeues *transient* dead-letters on its own; this
 * is the manual escape hatch for events that exhausted the auto budget or
 * dead-lettered on a non-transient error the operator has since fixed.
 *
 * Body: {} (no scope — aggregate)  →  { count: <rows requeued> }
 * Auth: tasks:admin scope.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { PipelineRemediationService } from '$lib/server/services/pipeline-remediation.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const service = new PipelineRemediationService(sql);
            const count = await service.requeueDeadLetterEvents();

            auditLog('pipeline.requeue-dead-letter', 'event-outbox', auditActor(event), { count });

            return json({ count });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
