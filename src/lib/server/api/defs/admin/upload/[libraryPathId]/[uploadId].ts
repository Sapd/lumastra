// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/admin/upload/[libraryPathId]/[uploadId]
 *
 * Aborts an in-progress upload session and cleans up staging files.
 *
 * Auth:    library:admin (admin-scoped); caller must own the session.
 * Surface: internal
 *
 * Response: { deleted: true }
 * Errors:   problem+json (incl. 503 dependency_unavailable)
 */

import { UUID_RE } from '$lib/utils/id-patterns.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getUploadSessionById } from '$lib/server/database/queries/upload-sessions.queries.js';
import { resolveUploadAttachmentTargets } from '$lib/server/database/queries/upload-attachment-targets.queries.js';
import { getLibraryPathById } from '$lib/server/database/queries/library-paths.queries.js';
import { UploadAttachmentTargetsSchema } from '$lib/schemas/api-upload-responses.js';
import { abortUpload } from '$lib/server/services/upload-session.service.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin', 'admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const { libraryPathId, uploadId } = event.params;
            if (!libraryPathId || !uploadId)
                return ApiProblem.validationFailed('Missing route parameters');
            if (!UUID_RE.test(libraryPathId) || !UUID_RE.test(uploadId))
                return ApiProblem.notFound('Upload session not found');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
            const session = await getUploadSessionById(sql, uploadId);
            if (!session || session.library_path_id !== libraryPathId)
                return ApiProblem.notFound('Upload session not found');
            const caller = event.locals.principal?.username ?? event.locals.user?.username;
            if (!caller) return ApiProblem.unauthorized();
            if (caller !== session.uploader_user)
                return ApiProblem.forbidden('Upload session belongs to a different user');
            const library = await getLibraryPathById(sql, libraryPathId);
            if (!library) return ApiProblem.notFound('Library path not found');
            return json(
                UploadAttachmentTargetsSchema.parse(
                    await resolveUploadAttachmentTargets(sql, session, library.path),
                ),
            );
        },
        DELETE: async (event) => {
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

            await abortUpload(sql, session);

            return json({ deleted: true as const });
        },
    },
});
