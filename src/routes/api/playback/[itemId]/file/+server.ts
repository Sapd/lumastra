// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/api/playback/[itemId]/file/+server.ts
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { serveContainedMediaFile } from '$lib/server/utils/file-streaming.js';
import {
    resolveMediaPath,
    isPathWithinLibraryRoots,
} from '$lib/server/utils/media-path-resolver.js';
import { resolveMediaFiles } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service.js';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';

export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(async ({ locals, request, url }) => {
                const sql = await aiDbService.getSql();
                if (!sql) return ApiResponses.error('Database unavailable');

                const username = locals.user?.username;
                if (!username) return ApiResponses.unauthorized();

                const kickStatus = await checkSessionKickCooldown(username);
                if (kickStatus.kicked) {
                    return ApiResponses.kicked(kickStatus.remainingSeconds!);
                }

                const { internalId } = locals.resolvedIds ?? {};
                if (!internalId) return ApiResponses.notFound('Media not found');

                if (url.searchParams.has('mediaSourceId') || url.searchParams.has('MediaSourceId'))
                    return ApiResponses.badRequest('Use fileId');
                const requestedFileId = url.searchParams.get('fileId');
                if (requestedFileId === null) {
                    return ApiResponses.badRequest('fileId is required');
                }

                if (!UUID_RE_LOOSE.test(requestedFileId))
                    return ApiResponses.notFound('File not found');
                const files = await resolveMediaFiles(sql, internalId, {
                    fileId: requestedFileId,
                });
                const filePath = files[0]?.file_path ?? null;

                if (!filePath) {
                    return ApiResponses.notFound(
                        'File path not available — call playback info first',
                    );
                }

                const pathInfo = await resolveMediaPath(
                    filePath,
                    { skipLocalAccessCheck: true },
                    sql,
                );
                if (!pathInfo?.isAccessible) {
                    return ApiResponses.error(
                        `Media file not accessible: ${pathInfo?.reason ?? 'unknown'}`,
                    );
                }

                const containerPath = pathInfo.containerPath;

                // Defense-in-depth: the path is DB-sourced (scanner-written), but verify it
                // resolves inside a configured library root before streaming it, so a tampered
                // media_files row cannot serve arbitrary host files.
                if (!(await isPathWithinLibraryRoots(sql, containerPath))) {
                    return ApiResponses.notFound('Media not found');
                }

                // fileSize is always set when isAccessible === true (from stat() inside resolveMediaPath).
                // Guard explicitly so a future refactor cannot silently serve Content-Length: 0.
                const fileSize = pathInfo.fileSize;
                if (!fileSize) {
                    return ApiResponses.error('File size unavailable');
                }

                // The row was checked at scan time; a link swapped in since is re-contained.
                return (
                    (await serveContainedMediaFile(containerPath, request.headers.get('range'))) ??
                    ApiResponses.notFound('Media not found')
                );
            }),
        ),
    ),
);
