// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/browser-children.ts
 *
 * GET /api/admin/media/[id]/browser-children
 *
 * A series' seasons and episodes with their issue badges, for the admin media
 * browser's in-place drill-down (triage spec §4). Missing episodes are
 * included (hasFiles false) — a completeness check is half the point.
 *
 * Auth: admin.  Surface: internal-only.
 * 404 when the item does not exist or is not a series.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { getMediaItemById } from '$lib/server/database/queries/admin-media.queries.js';
import { getBrowserChildren } from '$lib/server/services/admin-media-browser-children.js';
import { features } from '$lib/server/config.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import { BrowserChildrenResponseSchema } from '$lib/schemas/api-admin-browser-children.js';

export { BrowserChildrenResponseSchema };

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            // Admin pool, like the browser page itself: off the playback hot path.
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const item = await getMediaItemById(sql, internalId);
            if (!item || !isSeries(item.media_type)) {
                return ApiProblem.notFound('Series not found');
            }

            const result = await getBrowserChildren(sql, internalId, features.jellyfinSync);
            return json(BrowserChildrenResponseSchema.parse(result));
        },
    },
});
