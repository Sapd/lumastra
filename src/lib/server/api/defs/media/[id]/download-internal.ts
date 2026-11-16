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
import {
    crossSiteForbiddenResponse,
    mediaAccessUserOf,
} from '$lib/server/services/download-access-guard.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';
import { handleDownloadFile } from '$lib/server/handlers/media-download-handler.js';

const DownloadQuery = z
    .object({ fileId: z.string().optional(), h: z.string().max(100).optional() })
    .strict();

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    raw: true,
    request: { query: DownloadQuery },
    handlers: {
        GET: async (event) => {
            const crossSite = crossSiteForbiddenResponse(event.request, event.url);
            if (crossSite) return crossSite;

            const rawId = event.params.id ?? '';
            if (!rawId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Media ID is required' },
                ]);
            }

            // The catalog id the page knows may be a composite or external id; the access
            // check, the lease and the log all use the internal media item id.
            const id = await resolveCatalogInternalId(event);
            if (!id) return ApiProblem.notFound('Media item not found');

            const sql = getDb();
            if (sql) {
                if (!(await checkMediaAccess(sql, id, mediaAccessUserOf(event.locals)))) {
                    return ApiProblem.notFound('Media item not found');
                }
            } else if (event.locals.principal?.isAdmin !== true) {
                return ApiProblem.dependencyUnavailable('Unable to verify content access');
            }

            return handleDownloadFile(event, { surface: 'web', itemId: id });
        },
    },
});
