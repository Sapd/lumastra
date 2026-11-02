// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/tracks.ts
 *
 * GET /api/admin/media/[id]/tracks
 *
 * Returns all tracks for an album. The [id] must resolve to an album.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: tracks[] (shape from getTracksForAlbum)
 * 503 dependency_unavailable when DB is down.
 */

import { ArtistTracksQuerySchema } from '$lib/schemas/music-credit-review.js';
import {
    getAdminArtistTracks,
    getAdminTrackContainerType,
} from '$lib/server/database/queries/admin-artist-tracks.queries.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getTracksForAlbum } from '$lib/server/database/queries/music-admin.queries.js';

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

            const item = await getAdminTrackContainerType(sql, internalId);
            if (!item) return ApiProblem.notFound('Media item not found');
            if (item === 'artist') {
                const parsed = ArtistTracksQuerySchema.safeParse(
                    Object.fromEntries(event.url.searchParams),
                );
                if (!parsed.success)
                    return ApiProblem.validationFailed('Invalid artist track filters');
                return json(await getAdminArtistTracks(sql, internalId, parsed.data));
            }
            const tracks = await getTracksForAlbum(sql, internalId);
            // getTracksForAlbum returns a typed array; pass through as-is.
            return json(tracks);
        },
    },
});
