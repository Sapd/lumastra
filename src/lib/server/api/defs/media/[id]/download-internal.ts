// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/download-internal.ts — GET /api/media/{id}/download
 *
 * Browser-session twin of GET /api/v1/media/{id}/download. Same handler, same
 * gate order (auth, library/age access = 404, then FEATURE_MEDIA_DOWNLOAD,
 * canDownload = 403, leases/limits = 429, download log), only the log surface
 * differs (`web`). The web download queue opens this URL as a plain link, so
 * the browser's own download manager streams it with Range/resume.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { handleDownloadFile } from '$lib/server/handlers/media-download-handler.js';

const DownloadQuery = z.object({ fileId: z.string().optional() }).strict();

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    raw: true,
    request: { query: DownloadQuery },
    handlers: {
        GET: async (event) => {
            const id = event.params.id ?? '';
            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Media ID is required' },
                ]);
            }

            const sql = getDb();
            if (sql) {
                if (!(await checkMediaAccess(sql, id, event.locals.user))) {
                    return ApiProblem.notFound('Media item not found');
                }
            } else if (event.locals.principal?.isAdmin !== true) {
                return ApiProblem.dependencyUnavailable('Unable to verify content access');
            }

            return handleDownloadFile(event, { surface: 'web' });
        },
    },
});
