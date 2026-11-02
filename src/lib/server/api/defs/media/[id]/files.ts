// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/files.ts — GET /api/media/[id]/files
 *
 * Returns distinct edition values for a media item.
 * Consumed by the watch page to offer an edition picker when multiple editions
 * are available (Director's Cut, Theatrical, etc.).
 *
 * Contract:
 *   GET /media/{id}/files
 *     → bare object  { editions: string[] }
 *
 * Auth: user (any authenticated caller).  Surface: internal.
 * 503 dependency_unavailable when DB is down.
 */

import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getEditionsForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const user = event.locals.user;
            if (
                !user ||
                !(await checkMediaAccess(sql, internalId, {
                    ...user,
                    mediaAccessIsAdmin: event.locals.principal?.isAdmin ?? user.mediaAccessIsAdmin,
                }))
            ) {
                return ApiProblem.notFound('Media item not found');
            }

            const editions = await getEditionsForMediaItem(sql, internalId);
            return json({ editions });
        },
    },
});
