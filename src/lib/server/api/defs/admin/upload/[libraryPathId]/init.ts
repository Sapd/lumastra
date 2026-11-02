// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/upload/[libraryPathId]/init
 *
 * Initialises a new chunked-upload session for a home-video / personal / training
 * / educational library path.
 *
 * Auth:    library:admin (admin-scoped)
 * Surface: internal
 *
 * Response: 201 { uploadId, chunkSize, expiresAt }
 * Errors:   problem+json (incl. 503 dependency_unavailable)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getLibraryPathById } from '$lib/server/database/queries/library-paths.queries.js';
import { countActiveUploadSessionsForUser } from '$lib/server/database/queries/upload-sessions.queries.js';
import {
    initUpload,
    UPLOADABLE_LIBRARY_TYPES,
} from '$lib/server/services/upload-session.service.js';
import { MAX_TOTAL_CHUNKS } from '$lib/schemas/api-upload-responses.js';
import { hasControlChars } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/filename-safety.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const InitBody = z.object({
    // P1 (fix plan 6, S-P1): a raw control character (e.g. `\n`) surviving in
    // `filename` is rejected here — the first seam an uploaded name crosses;
    // the same `hasControlChars()` check guards every later one (listed in
    // `filename-safety.ts`) — so it can never reach the ffmpeg concat list
    // opened under `-safe 0`.
    filename: z
        .string()
        .min(1)
        .max(512)
        .refine((v) => !hasControlChars(v), {
            message: 'filename must not contain control characters',
        }),
    mimeType: z.string().min(1),
    totalSize: z.number().int().positive(),
    totalChunks: z.number().int().positive().max(MAX_TOTAL_CHUNKS),
    // F4 (fix plan 6, Task 7 fix round 1): same shared guard as filename —
    // destinationFolder is also checked again in resolveUnderRoot()
    // (library-path-safety.ts) as the containment chokepoint every caller
    // shares, this is the earlier, request-validation-time rejection.
    destinationFolder: z
        .string()
        .optional()
        .refine((v) => v === undefined || !hasControlChars(v), {
            message: 'destinationFolder must not contain control characters',
        }),
    metadata: z.record(z.string(), z.string()).optional(),
});

/** Maximum number of concurrent active upload sessions per user. */
const MAX_CONCURRENT_SESSIONS_PER_USER = 3;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin', 'admin'] },
    visibility: 'internal',
    request: {
        body: InitBody,
    },
    handlers: {
        POST: async (event, ctx) => {
            const libraryPathId = event.params.libraryPathId;
            if (!libraryPathId) return ApiProblem.validationFailed('Missing libraryPathId');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const libraryPath = await getLibraryPathById(sql, libraryPathId);
            if (!libraryPath) return ApiProblem.notFound('Library path not found');

            if (!UPLOADABLE_LIBRARY_TYPES.has(libraryPath.media_type)) {
                return ApiProblem.validationFailed(
                    `Uploads are only supported for non-entertainment library types (home_video, training, educational, personal). This library is type: ${libraryPath.media_type}`,
                );
            }

            const { filename, mimeType, totalSize, totalChunks, destinationFolder } =
                ctx.input!.body;

            // C20: prefer the Principal (populated for every credential path,
            // including a Bearer PAT/svc caller on this admin-scoped surface
            // via mount.ts's enforce() {kind:'scope'} fallback); fall back to
            // locals.user for cookie/session callers that predate Principal.
            // No default sentinel — an unresolved identity must 401, not pool
            // under a shared string with every other unresolved caller.
            const uploaderUser =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!uploaderUser) return ApiProblem.unauthorized();

            const activeSessions = await countActiveUploadSessionsForUser(sql, uploaderUser);
            if (activeSessions >= MAX_CONCURRENT_SESSIONS_PER_USER) {
                return ApiProblem.validationFailed(
                    `Too many active upload sessions (${activeSessions}/${MAX_CONCURRENT_SESSIONS_PER_USER}). Finalize or abort existing sessions before starting a new one.`,
                );
            }

            const result = await initUpload({
                sql,
                libraryPathId,
                libraryRoot: libraryPath.path,
                uploaderUser,
                filename,
                mimeType,
                totalSize,
                totalChunks,
                destinationFolder: destinationFolder ?? '',
                sha256Expected: null,
            });

            return json(result, { status: 201 });
        },
    },
});
