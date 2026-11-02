// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PUT /api/admin/upload/[libraryPathId]/chunks/[uploadId]/[chunkIndex]
 *
 * Receives one binary chunk for an active upload session.
 *
 * Auth:    library:admin (admin-scoped); caller must own the session.
 * Surface: internal
 *
 * Response: { received: true, chunkIndex, chunksReceived }
 * Errors:   problem+json (incl. 503 dependency_unavailable)
 *
 * NOTE: The body is raw binary (application/octet-stream), not JSON, so this
 * handler reads `event.request.arrayBuffer()` directly.  The `raw: true` flag
 * tells mount() that the success response is non-JSON.  Error responses still
 * use problem+json.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getUploadSessionById } from '$lib/server/database/queries/upload-sessions.queries.js';
import { writeChunk } from '$lib/server/services/upload-session.service.js';
import { config } from '$lib/server/config.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin', 'admin'] },
    visibility: 'internal',
    // raw: true because the request body is binary, not JSON.
    // Error responses still use problem+json.
    raw: true,
    handlers: {
        PUT: async (event) => {
            const { libraryPathId, uploadId, chunkIndex: chunkIndexStr } = event.params;
            if (!libraryPathId || !uploadId || !chunkIndexStr) {
                return ApiProblem.validationFailed('Missing route parameters');
            }

            // Digits only: parseInt('3abc') is 3, so a malformed index used to
            // write chunk 3.
            const chunkIndex = /^\d{1,9}$/.test(chunkIndexStr) ? Number(chunkIndexStr) : NaN;
            if (isNaN(chunkIndex)) {
                return ApiProblem.validationFailed(`Invalid chunkIndex: ${chunkIndexStr}`);
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

            // Refuse an oversized chunk from its declared length before
            // buffering it (the body is drained by request-body-drain).
            const declaredLength = Number(event.request.headers.get('content-length') ?? NaN);
            if (
                Number.isFinite(declaredLength) &&
                declaredLength > config.UPLOAD_CHUNK_SIZE_MB * 1024 * 1024
            ) {
                return ApiProblem.validationFailed(
                    `Chunk size ${declaredLength} exceeds limit of ${config.UPLOAD_CHUNK_SIZE_MB} MB`,
                );
            }

            const body = await event.request.arrayBuffer();
            const data = Buffer.from(body);

            const maxChunkBytes = config.UPLOAD_CHUNK_SIZE_MB * 1024 * 1024;
            if (data.length > maxChunkBytes) {
                return ApiProblem.validationFailed(
                    `Chunk size ${data.length} exceeds limit of ${config.UPLOAD_CHUNK_SIZE_MB} MB`,
                );
            }
            if (data.length === 0) {
                return ApiProblem.validationFailed('Empty chunk not allowed');
            }

            const chunksReceived = await writeChunk(sql, session, chunkIndex, data);

            return json({ received: true as const, chunkIndex, chunksReceived });
        },
    },
});
