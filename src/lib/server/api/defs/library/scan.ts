// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/library/scan.ts — POST /api/v1/library/scan
 *
 * Enqueues a full or scoped library scan. Requires an admin PAT or service
 * token with `tasks:run` scope.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/library/scan/+server.ts`
 * (`authenticate()` + `requireScope(auth,'tasks:run')` + inline
 * `LibraryScanRequestSchema.safeParse`). Behaviour is preserved BYTE-FOR-BYTE:
 *   - Auth: `{kind:'scope', anyOf:['tasks:run']}` → mount()'s enforce() maps this
 *     onto the SAME `authenticate()` + `scopeGranted()` primitives → same
 *     401/403.
 *   - Body validation stays IN-HANDLER (not the declarative `request.body`
 *     slot) — deliberately, to preserve the EXACT current wire contract:
 *       • same HTTP 422 `validation_failed` with the single `{ error: "…" }`
 *         string (mount()'s declarative validator would instead emit the
 *         `{ details:[…] }` envelope), and
 *       • no dependency on `Request.text()` (the declarative reader buffers the
 *         body via `.text()`, which json()-only unit-test mocks don't provide).
 *     This mirrors the documented precedent in defs/runs/index.ts and
 *     defs/tasks/[taskId]/run.ts, which keep validation in-handler for the same
 *     status-contract reason.
 *   - Trigger attribution: `by` comes from `authenticate(event).userId`, exactly
 *     as before (enforce() already gated the scope; this re-resolve only sources
 *     the actor id, keeping `by` identical to the hand-written route).
 *   - `Idempotency-Key`, backpressure → 503 `dependency_unavailable`+`retryAfter`,
 *     and the 200 (deduped) / 202 (accepted) success envelope: all preserved.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { problem } from '$lib/server/api/problem.js';
import { authenticate } from '$lib/server/tasks/api-auth.js';
import { manualRunActorFromApiAuth } from '$lib/server/tasks/run-trigger-actor.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { LibraryScanRequestSchema } from '$lib/schemas/api-v1.js';
import { apiUrl } from '$lib/shared/api-urls.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    docs: {
        POST: {
            visibility: 'internal',
            tags: ['Library'],
            summary: 'Trigger a library scan',
            stability: 'stable',
            description:
                'Enqueues a full or scoped library scan. Omit `libraryPathId` to scan all enabled paths. Requires an admin PAT or service token with `tasks:run` scope — regular user API tokens are not accepted.',
            body: LibraryScanRequestSchema,
            responses: {
                200: {
                    schema: z.object({
                        runId: z
                            .string()
                            .meta({ description: 'Task run ID (run_-prefixed id, not a UUID)' }),
                        deduped: z.boolean().meta({
                            description: 'True when an identical run was already in progress',
                        }),
                        statusUrl: z.string().meta({ description: 'URL to poll for run status' }),
                    }),
                    description: 'Deduplicated — an identical run was already in progress',
                },
                202: {
                    schema: z.object({
                        runId: z
                            .string()
                            .meta({ description: 'Task run ID (run_-prefixed id, not a UUID)' }),
                        deduped: z.boolean().meta({
                            description: 'True when an identical run was already in progress',
                        }),
                        statusUrl: z.string().meta({ description: 'URL to poll for run status' }),
                    }),
                    description: 'Scan accepted and enqueued',
                },
                400: 'Invalid request body',
                401: 'Authentication required',
                403: 'Insufficient scope — tasks:run required',
                503: 'Queue at capacity — retry after the Retry-After header value',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            // Scope was already enforced by mount() via {kind:'scope'}. Re-resolve
            // the identity here ONLY to source the trigger actor (the user id, or a
            // service token's `service:<name>` so automation isn't announced as
            // the creating admin's own run).
            const auth = await authenticate(event);

            const parsed = LibraryScanRequestSchema.safeParse(
                await event.request.json().catch(() => ({})),
            );
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: parsed.error.issues.map((i) => i.message).join(', '),
                });
            }

            const idempotencyKey = event.request.headers.get('idempotency-key') ?? undefined;

            try {
                const r = await orchestrator.startRun(
                    'file-library-scan',
                    { libraryPathId: parsed.data.libraryPathId },
                    {
                        idempotencyKey,
                        trigger: { kind: 'manual', by: manualRunActorFromApiAuth(auth) },
                    },
                );
                return Response.json(
                    {
                        runId: r.runId,
                        // `StartRunResult.deduped` is `boolean | undefined` — the
                        // orchestrator's fresh-run path returns `{ runId }` with no
                        // `deduped` key at all, it isn't set to `false`. Passing
                        // `r.deduped` straight through let `Response.json` (via
                        // `JSON.stringify`) drop the key on a fresh run, so the 202
                        // body came back with `deduped` MISSING — violating the
                        // response schema below, which declares it required. Coerce
                        // to a literal boolean, same as the sibling ingest.ts def.
                        deduped: r.deduped === true,
                        statusUrl: apiUrl(ctx.surface, `/runs/${r.runId}`),
                    },
                    { status: r.deduped ? 200 : 202 },
                );
            } catch (err) {
                if (err instanceof BackpressureError) {
                    const retryAfterSec = Math.ceil(err.retryAfterMs / 1000);
                    return problem('dependency_unavailable', {
                        error: 'Queue at capacity',
                        retryAfter: retryAfterSec,
                    });
                }
                throw err;
            }
        },
    },
});
