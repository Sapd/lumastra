// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/library/ingest.ts — POST /api/v1/library/ingest (canonical alias:
 * /api/v1/libraries/ingest)
 *
 * Push a known set of file changes for ingest without walking the library.
 * Requires an admin PAT or service token with `tasks:run` scope.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/library/ingest/`
 * `+server.ts` (`authenticate()` + `requireScope(auth,'tasks:run')` wrapped in
 * a try/catch that emits a CUSTOM, self-documenting 403 message + inline
 * `LibraryIngestRequestSchema.safeParse` + `normalizeDelta`). Behaviour is
 * preserved BYTE-FOR-BYTE:
 *   - Auth: `{kind:'public'}` at the def level — DELIBERATELY not
 *     `{kind:'scope', anyOf:['tasks:run']}`. mount()'s declarative scope gate
 *     would short-circuit with the GENERIC `scope_required` envelope before
 *     the handler ever runs, discarding the route's custom 403 body ("...need
 *     an admin PAT or service token, not a regular user API token..."), which
 *     a colocated test (`server.test.ts` → "returns 403 with self-documenting
 *     message") asserts on verbatim. Auth therefore stays FULLY IN-HANDLER:
 *     `authenticate()` (its own throw → mount()'s `withMountErrorHandler`
 *     401-maps it identically to the original `withErrorHandler`) followed by
 *     a `requireScope` try/catch producing the exact original message.
 *   - Body validation stays IN-HANDLER (not the declarative `request.body`
 *     slot) — preserves the EXACT current wire contract (422
 *     `validation_failed` with a single `{ error: "…" }` string, not the
 *     `{ details:[…] }` envelope mount()'s declarative validator would emit).
 *   - `X-Event-Id` correlation header, Valkey delta-queue push-before-startRun
 *     ordering, `Idempotency-Key`, backpressure → 503 `dependency_unavailable`
 *     +`retryAfter`, and the 200 (deduped) / 202 (accepted) envelopes: all
 *     preserved.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 * The `libraries/ingest` canonical alias hand-mounts this SAME def (see
 * `src/routes/api/v1/libraries/ingest/+server.ts`), mirroring the
 * library/scan ↔ libraries/scan and library/paths ↔ libraries/paths pairs.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { problem, ApiProblem } from '$lib/server/api/problem.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import {
    authenticate,
    requireScope,
    ApiAuthError,
    type ApiAuth,
} from '$lib/server/tasks/api-auth.js';
import { manualRunActorFromApiAuth } from '$lib/server/tasks/run-trigger-actor.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { enqueueDeltaPayload } from '$lib/server/tasks/builtin/native/file-delta-ingest-queue.js';
import { BackpressureError } from '$lib/server/tasks/backpressure.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { LibraryIngestRequestSchema } from '$lib/schemas/api-v1.js';
import { normalizeDelta } from '../../../../../routes/api/v1/library/ingest/normalize.js';
import { apiUrl } from '$lib/shared/api-urls.js';

/**
 * Body-size cap (C15). This def declares NO `request.body` schema (see the
 * module docstring — body validation stays fully in-handler to preserve the
 * exact current wire contract), so mount()'s declarative `maxBodyBytes` never
 * applies here; the check below is the equivalent hand-rolled guard. 2 MB is
 * generous for the documented "chunk deltas larger than 5 000 entries"
 * guidance while still bounding the unauthenticated-body-size risk far below
 * adapter-node's 50 MB ceiling.
 */
const MAX_INGEST_BODY_BYTES = 2_000_000;

export const def = defineEndpoint({
    auth: { kind: 'public' },
    docs: {
        POST: {
            tags: ['Library'],
            summary: 'Push a delta for ingest',
            stability: 'beta',
            description:
                "Push a known set of file changes for ingest without walking the library. Supply an `Idempotency-Key` header so retries after 5xx/timeout are safe. Chunk deltas larger than 5 000 entries and keep a rename's upsert+remove in the same request. Requires an admin PAT or service token with `tasks:run` scope.",
            body: LibraryIngestRequestSchema,
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
                        // Optional on the 200 (dedup) path: the run was already in
                        // progress, so this request does not re-accept counts. The
                        // 202 (enqueued) path below always includes it.
                        accepted: z
                            .object({
                                upsert: z
                                    .number()
                                    .meta({ description: 'Number of upsert entries accepted' }),
                                remove: z
                                    .number()
                                    .meta({ description: 'Number of remove entries accepted' }),
                            })
                            .optional()
                            .meta({ description: 'Counts of accepted changes by operation' }),
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
                        accepted: z
                            .object({
                                upsert: z
                                    .number()
                                    .meta({ description: 'Number of upsert entries accepted' }),
                                remove: z
                                    .number()
                                    .meta({ description: 'Number of remove entries accepted' }),
                            })
                            .meta({ description: 'Counts of accepted changes by operation' }),
                    }),
                    description: 'Delta ingest accepted and enqueued',
                },
                400: 'Invalid request body',
                401: 'Authentication required',
                403: 'Insufficient scope (tasks:run required), or a valid credential of a kind this endpoint does not accept (e.g. a device-flow token). Permanent — re-authenticating will not grant access.',
                413: 'Request body exceeds the maximum size allowed for this endpoint',
                503: 'Queue at capacity — retry after the Retry-After header value',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            // auth:{kind:'public'} at the def level — the FULL auth check
            // (including the custom 403 message) stays in-handler; see the
            // module docstring for why the declarative {kind:'scope'} gate
            // can't be used here.
            // authenticate() is inside the try as well: a device-flow JWT is a
            // valid credential that this surface rejects, and it now throws
            // ApiAuthError(403). Letting that escape to withErrorHandler would
            // emit a generic envelope; clients deserve the same problem+json
            // 'forbidden' shape as the scope failure, since the two are the
            // same condition from the caller's side — a permanent capability
            // gap, not a dead session.
            let auth: ApiAuth;
            try {
                auth = await authenticate(event);
                requireScope(auth, 'tasks:run');
            } catch (e) {
                if (e instanceof ApiAuthError && e.statusCode === 403)
                    return problem('forbidden', {
                        error: 'tasks:run scope required — library triggers need an admin PAT or service token, not a regular user API token. See https://lumastra.org/developers/api/',
                    });
                throw e;
            }

            // C15: reject a declared-oversized body before buffering it, then
            // bound the streamed read itself so a missing/lying Content-Length
            // can't let an oversized body through anyway. This def has no
            // `request.body` schema, so mount()'s cap never runs for it — see
            // MAX_INGEST_BODY_BYTES above. Shares the exact mechanism mount.ts
            // and middleware/validate.ts use (bounded-body-reader.ts) rather
            // than the previous Content-Length-only check.
            if (isDeclaredContentLengthOverCap(event.request, MAX_INGEST_BODY_BYTES)) {
                return ApiProblem.payloadTooLarge();
            }

            const bodyText = await readBoundedBodyText(event.request, MAX_INGEST_BODY_BYTES);
            if (bodyText === BODY_TOO_LARGE) {
                return ApiProblem.payloadTooLarge();
            }

            const parseJson = (): unknown => {
                if (bodyText.trim() === '') return null;
                try {
                    return JSON.parse(bodyText);
                } catch {
                    return null;
                }
            };
            const parsed = LibraryIngestRequestSchema.safeParse(parseJson());
            if (!parsed.success)
                return problem('validation_failed', {
                    error: parsed.error.issues.map((i) => i.message).join(', '),
                });

            const sql = await aiDbService.getSql();
            if (!sql)
                return problem('dependency_unavailable', { error: 'AI database is unavailable' });
            const roots = (await getEnabledLibraryPaths(sql)).map((r) => ({
                id: r.id,
                sourcePrefix: r.source_prefix,
            }));

            const norm = normalizeDelta(parsed.data, roots);
            if (!norm.ok) return problem('validation_failed', { error: norm.message });

            if (!roots.some((r) => r.id === norm.libraryPathId)) {
                return problem('validation_failed', {
                    error: 'libraryPathId not found or disabled',
                });
            }

            const idempotencyKey = event.request.headers.get('idempotency-key') ?? undefined;
            // X-Event-Id: optional correlation id from push-delta callers (e.g. S3 notifications).
            // Forwarded into the task input so operators can correlate a run to its originating event.
            // RouteMetadata does not support request header declarations — documented here only.
            const eventId = event.request.headers.get('x-event-id') ?? undefined;
            try {
                // Payload travels out-of-band via the Valkey queue, NOT in the
                // deduped startRun input — a second concurrent request for the same
                // libraryPathId that comes back { deduped: true } below would
                // otherwise silently drop this upsert/remove list. See
                // file-delta-ingest-queue.ts / file-delta-ingest.ts for the full
                // design. Pushed BEFORE startRun so a deduped run still picks it up.
                await enqueueDeltaPayload(norm.libraryPathId, {
                    upsert: norm.upsert,
                    remove: norm.remove,
                    eventId,
                });
                const r = await orchestrator.startRun(
                    'file-delta-ingest',
                    {
                        libraryPathId: norm.libraryPathId,
                        eventId,
                    },
                    {
                        idempotencyKey,
                        trigger: { kind: 'manual', by: manualRunActorFromApiAuth(auth) },
                    },
                );
                if (r.deduped) {
                    return Response.json(
                        {
                            runId: r.runId,
                            deduped: true,
                            statusUrl: apiUrl(ctx.surface, `/runs/${r.runId}`),
                        },
                        { status: 200 },
                    );
                }
                return Response.json(
                    {
                        runId: r.runId,
                        deduped: false,
                        statusUrl: apiUrl(ctx.surface, `/runs/${r.runId}`),
                        accepted: { upsert: norm.upsert.length, remove: norm.remove.length },
                    },
                    { status: 202 },
                );
            } catch (err) {
                if (err instanceof BackpressureError) {
                    const s = Math.ceil(err.retryAfterMs / 1000);
                    return problem('dependency_unavailable', {
                        error: 'Queue at capacity',
                        retryAfter: s,
                    });
                }
                throw err;
            }
        },
    },
});
