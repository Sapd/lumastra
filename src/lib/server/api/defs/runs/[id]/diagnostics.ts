// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /runs/{id}/diagnostics — ADMIN-ONLY run diagnostics.
 *
 * WHY THIS EXISTS AS A SEPARATE ENDPOINT
 * --------------------------------------
 * `defs/runs/[id].ts` strips `error.stack` before responding, and that
 * redaction must STAY. That def is dual-mounted (`/api/runs/{id}` and
 * `/api/v1/runs/{id}`) behind `auth: {kind:'scope', anyOf:['runs:read']}`, and
 * `runs:read` is NOT an admin-only scope:
 *
 *   • `expandScopes()` (api/principal.ts) expands the coarse `read` alias to
 *     include `runs:read`;
 *   • `buildPrincipal()` gives every NON-admin session `['read','write']`;
 *   • `scopeGranted()` (tasks/api-auth.ts) also accepts a bare `read`/`write`
 *     token scope for `runs:read`.
 *
 * So any logged-in user and any `read`-scoped PAT can call `GET /runs/{id}`.
 * Relaxing its redaction would publish internal filesystem paths to the whole
 * user base, not just admins.
 *
 * This endpoint carries the stack instead, gated on `auth: {kind:'admin'}` —
 * which `enforce()` resolves from `locals.principal.isAdmin` and therefore
 * behaves identically on both surfaces (mount() never reads the URL prefix).
 *
 * It also returns the server-side redaction roots so the admin UI can run
 * `formatTaskRunReport(..., 'github')` without hardcoding library paths.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { getDb } from '$lib/server/database/connection.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { config } from '$lib/server/config.js';
import { RunDiagnosticsSchema } from '$lib/schemas/run.schema.js';
import { typedJson } from '$lib/server/utils/typed-response.js';

export const def = defineEndpoint({
    docs: {
        // Operator diagnostics, not part of the public API contract — the admin
        // UI is the only consumer, same treatment as the other admin-only defs.
        visibility: 'internal',
        GET: {
            tags: ['Runs'],
            summary: 'Get admin diagnostics for a task run',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the unredacted error (including the stack trace) for a single run, ' +
                'plus the server-side path-redaction roots the admin UI needs to produce a ' +
                'shareable report. Admin only — `GET /runs/{id}` deliberately strips the stack.',
            responses: {
                200: { schema: RunDiagnosticsSchema, description: 'Run diagnostics' },
                401: 'Authentication required',
                403: 'Admin required',
                404: 'Run not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'admin' },
    handlers: {
        GET: async (event) => {
            const runId = event.params.id!;
            const run = await orchestrator.getRun(runId);
            if (!run) {
                return ApiProblem.notFound(`Run '${runId}' not found`);
            }

            // Filesystem-backed library paths only (the default) — a remote
            // provider's sentinel URI is not something a path-redaction rule
            // should ever match against.
            const sql = getDb();
            const libraryPaths = sql ? await getEnabledLibraryPaths(sql) : [];

            return typedJson(RunDiagnosticsSchema, {
                runId: run.id,
                error: run.error
                    ? {
                          message: run.error.message,
                          kind: run.error.kind,
                          stack: run.error.stack,
                      }
                    : null,
                redaction: {
                    libraryRoots: libraryPaths.map((p) => p.path),
                    transcodeRoot: config.FFMPEG_TRANSCODE_DIR,
                },
            });
        },
    },
});
