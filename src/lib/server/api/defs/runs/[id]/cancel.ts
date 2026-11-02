// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/runs/{id}/cancel
 *
 * Requires `tasks:run` scope.
 * Body: `force` (bool) — hard-cancel; `hard` accepted as a migration alias.
 * `reason` (string, optional) — audit log annotation.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { CancelRunRequestSchema } from '$lib/schemas/api-v1.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

const CancelRunBodySchema = z.object({
    force: z
        .boolean()
        .optional()
        .meta({ description: 'Hard-cancel (SIGKILL) rather than graceful stop' }),
    reason: z.string().max(255).optional().meta({ description: 'Optional audit log annotation' }),
});

// The handler emits { accepted, deferred? } — not { cancelled, runId }.
const CancelRunResponseSchema = z.object({
    accepted: z.boolean().meta({ description: 'Whether the cancel request was accepted' }),
    deferred: z.string().optional().meta({
        description: 'Set when a hard-kill was scheduled rather than applied immediately',
    }),
    alreadyCancelling: z
        .boolean()
        .optional()
        .meta({
            description:
                'True when a graceful cancel was already in progress, so this request changed ' +
                'nothing. Send `force: true` to escalate to a hard-kill.',
        }),
});

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Runs'],
            summary: 'Cancel a run',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Cancels a running or queued task run. Selected-file Media Probe rechecks require an admin principal. ' +
                '`force: true` triggers hard-cancel. Requires `tasks:run` scope.',
            body: CancelRunBodySchema,
            responses: {
                200: {
                    schema: CancelRunResponseSchema,
                    description: 'Run cancelled',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Run not found',
                409: 'Run has already finished',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    /**
     * REQUEST CONTRACT — POST body.
     *
     * Derived from CancelRunRequestSchema in api-v1.ts.  mount() validates
     * before the handler runs; the handler's own safeParse() is unchanged.
     * The `hard` alias field is accepted for migration compat.
     * Unknown fields are stripped (no .strict()).
     */
    request: {
        body: CancelRunRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const runId = event.params.id!;
            if (!event.locals.principal?.isAdmin) {
                const run = await orchestrator.getRun(runId);
                if (!run) return ApiProblem.notFound(`Run '${runId}' not found`);
                if (
                    run?.taskId === 'media-probe' &&
                    run.input &&
                    typeof run.input === 'object' &&
                    'fileId' in run.input
                )
                    return ApiProblem.forbidden();
            }

            // mount() has already validated + parsed the body via the `request`
            // contract — use ctx.input.body to avoid re-reading the consumed stream.
            // Fall back to manual parse for callers that bypass mount() in tests.
            let parsed: ReturnType<typeof CancelRunRequestSchema.safeParse>;
            if (ctx.input?.body !== undefined) {
                parsed = { success: true as const, data: ctx.input.body };
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    rawBody = {};
                }
                parsed = CancelRunRequestSchema.safeParse(rawBody);
            }
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid cancel request body',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }

            // `force` is the new canonical field; `hard` is the migration alias.
            const forceFlag = parsed.data.force ?? parsed.data.hard ?? false;
            const { reason } = parsed.data;

            const result = await orchestrator.cancelRun(runId, {
                hard: forceFlag,
                reason,
            });

            if (!result.accepted) {
                // A run that finished between render and confirm is the normal
                // cancel race: 409, so clients can tell it from a wrong id.
                if (result.reason === 'terminal') {
                    return problem('conflict', { error: `Run '${runId}' has already finished` });
                }
                return ApiProblem.notFound(`Run '${runId}' not found`);
            }

            // Security fix C24 (2026-09-16): auditActor(event) resolves the
            // USERNAME, not the users.id UUID the hand-built object below
            // used to pass as `username` — see work-profile.ts for the
            // GDPR-erasure rationale.
            auditLog('run.cancel', runId, auditActor(event), {
                force: forceFlag,
                reason,
                deferred: result.deferred,
            });

            return json({
                accepted: result.accepted,
                ...(result.deferred ? { deferred: result.deferred } : {}),
                ...(result.reason === 'already_cancelling' ? { alreadyCancelling: true } : {}),
            });
        },
    },
});
