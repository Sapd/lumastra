// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { orchestrator } from './orchestrator.js';
import { BackpressureError } from './backpressure.js';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import { problem } from '$lib/server/api/problem.js';
import { manualRunActor } from './run-trigger-actor.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import type { z } from 'zod';
import type { FileHealthRecheckAcceptedSchema } from '$lib/schemas/file-health-recheck.js';

/** The same persisted, cancellable single-file run for both admin entry points. */
export async function enqueueFileHealthRecheck(
    fileId: string,
    event: RequestEvent,
): Promise<z.infer<typeof FileHealthRecheckAcceptedSchema> | Response> {
    try {
        const result = await orchestrator.startRun(
            'media-probe',
            { fileId: fileId.toLowerCase() },
            {
                trigger: { kind: 'manual', by: manualRunActor(event.locals.principal) },
            },
        );
        const accepted = { runId: result.runId, deduped: result.deduped === true };
        auditLog('media.file-health.recheck', fileId, auditActor(event), accepted);
        return accepted;
    } catch (err) {
        if (err instanceof BackpressureError)
            return problem('rate_limited', {
                error: 'Queue at capacity — retry after backoff',
                retryAfter: Math.ceil(err.retryAfterMs / 1000),
            });
        if (err instanceof TaskError && err.kind === 'permanent')
            return problem('validation_failed', { error: err.message, status: 400 });
        if (err instanceof TaskError && err.kind === 'transient')
            return problem('dependency_unavailable', { error: err.message, retryAfter: 5 });
        throw err;
    }
}
