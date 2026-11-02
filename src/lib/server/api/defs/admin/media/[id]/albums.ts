// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/albums.ts
 *
 * GET /api/admin/media/[id]/albums
 *
 * Returns all albums for an artist. The [id] must resolve to an artist.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: albums[] (shape from getAlbumsForArtist)
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getAlbumsForArtist } from '$lib/server/database/queries/music-admin.queries.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const albums = await getAlbumsForArtist(sql, internalId);
            return json(albums);
        },
    },
});
