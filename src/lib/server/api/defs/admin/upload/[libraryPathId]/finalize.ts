// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/upload/[libraryPathId]/finalize/[uploadId]
 *
 * Assembles all received chunks into the final file and optionally triggers
 * a file-delta-ingest task run.
 *
 * Auth:    library:admin (admin-scoped); caller must own the session.
 * Surface: internal
 *
 * Response: { path, runId?, status }
 * Errors:   problem+json (incl. 503 dependency_unavailable)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getUploadSessionById } from '$lib/server/database/queries/upload-sessions.queries.js';
import { getLibraryPathById } from '$lib/server/database/queries/library-paths.queries.js';
import { finalizeUpload } from '$lib/server/services/upload-session.service.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { enqueueDeltaPayload } from '$lib/server/tasks/builtin/native/file-delta-ingest-queue.js';
import { MAX_TOTAL_CHUNKS } from '$lib/schemas/api-upload-responses.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('upload.finalize');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const FinalizeBody = z.object({
    totalChunks: z.number().int().positive().max(MAX_TOTAL_CHUNKS),
    sha256: z.string().optional(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin', 'admin'] },
    visibility: 'internal',
    request: {
        body: FinalizeBody,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { libraryPathId, uploadId } = event.params;
            if (!libraryPathId || !uploadId) {
                return ApiProblem.validationFailed('Missing route parameters');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const session = await getUploadSessionById(sql, uploadId);
            if (!session) return ApiProblem.notFound('Upload session not found');
            if (session.library_path_id !== libraryPathId) {
                return ApiProblem.validationFailed(
                    'Upload session does not belong to this library path',
                );
            }
            // C20: prefer the Principal (populated for every credential path,
            // including a Bearer PAT/svc caller on this admin-scoped surface
            // via mount.ts's enforce() {kind:'scope'} fallback); fall back to
            // locals.user for cookie/session callers that predate Principal.
            // No default sentinel — an unresolved identity must 401, not
            // silently compare against '' (which never matches a real
            // uploader_user, but also never says WHY the caller was denied).
            const callerUser =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!callerUser) return ApiProblem.unauthorized();
            // SECURITY — session ownership: prevent cross-admin session interference.
            if (session.uploader_user !== callerUser) {
                return ApiProblem.forbidden('Upload session belongs to a different user');
            }

            const { totalChunks, sha256 } = ctx.input!.body;

            const libraryPath = await getLibraryPathById(sql, libraryPathId);
            if (!libraryPath) return ApiProblem.notFound('Library path not found');

            const { finalPath } = await finalizeUpload({
                sql,
                session,
                libraryRoot: libraryPath.path,
                expectedTotalChunks: totalChunks,
                clientSha256: sha256 ?? null,
            });

            let runId: string | undefined;
            let status: 'queued' | 'skipped' = 'skipped';
            try {
                // Push the payload before startRun — a race with another
                // caller (ancillary upload, ingest API) for the same
                // libraryPathId can come back { deduped: true }; the queue
                // is what guarantees this file still gets processed by
                // whichever run drains it. See file-delta-ingest-queue.ts.
                await enqueueDeltaPayload(libraryPathId, { upsert: [finalPath], remove: [] });
                const startResult = await orchestrator.startRun(
                    'file-delta-ingest',
                    { libraryPathId },
                    { trigger: { kind: 'in-process', sourceRoute: 'upload.finalize' } },
                );
                if (startResult.runId) {
                    runId = startResult.runId;
                    status = 'queued';
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn('[upload.finalize] file-delta-ingest trigger failed (non-fatal)', {
                    error: msg,
                });
            }

            return json({ path: finalPath, runId, status });
        },
    },
});
