// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/radio/[id]/images/[role].ts
 * GET /api/music/radio/{id}/image/{role}
 * (also mounted at GET /api/v1/music/radio/stations/{id}/images/{role})
 *
 * Serves live metadata images for a radio station — DJ photo, show artwork,
 * or up-next track art. These are fetched and cached from the station's live
 * metadata feed, not stored in the media library.
 *
 * Contract:
 *  - Class R (raw): binary image bytes on success; problem+json on pre-stream failure.
 *  - Allowed roles: dj | show | up-next
 *  - 404 when no image is cached for the requested role.
 *  - Auth: any authenticated user (same as the station list + now-playing).
 *
 * Surface: 'internal' on /api/music/radio, 'v1' on /api/v1/music/radio/stations.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy/index.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

const RadioImageQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; ignored for resolution.'),
});

const ALLOWED_ROLES = new Set(['dj', 'show', 'up-next']);

// ownership: none — a radio station is not user-owned, but gated the same way
// as its siblings [id]/stream and [id]/now-playing: checkMediaAccess (library
// + age) before any station data is exposed.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get a radio station\'s image',
            stability: 'beta',
            auth: 'bearer',
            query: RadioImageQuery,
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/png', 'image/webp'],
                    description: 'Station image (JPEG, PNG, or WebP)',
                },
                401: 'Authentication required',
                404: 'Station or image not found',
                500: 'Internal server error',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'user' },
    raw: true,

    request: {
        query: RadioImageQuery,
        params: z.object({
            id: z.string().min(1),
            role: z.string().min(1),
        }),
    },

    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const stationId = event.params.id;
            const role = event.params.role;

            if (!stationId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Missing station ID' },
                ]);
            }
            if (!role || !ALLOWED_ROLES.has(role)) {
                return ApiProblem.notFound(
                    `Invalid image role "${role ?? ''}". Valid roles: dj, show, up-next`,
                );
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const rows = (await sql`
                SELECT id FROM media_items
                WHERE id = ${stationId} AND media_type = 'radio'
                LIMIT 1
            `) as unknown as { id: string }[];

            if (rows.length === 0) return ApiProblem.notFound('Radio station not found');

            // Gate by library + age before exposing cached station artwork —
            // matches the sibling [id]/stream and [id]/now-playing routes.
            if (!(await checkMediaAccess(sql, rows[0].id, user))) {
                return ApiProblem.notFound('Radio station not found');
            }

            const svc = getImageProxyService();
            const image = await svc.getRadioMetadataImage(
                stationId,
                role as 'dj' | 'show' | 'up-next',
            );
            if (!image) return ApiProblem.notFound('No image available for this role');

            return imageResponse({ ...image, buffer: Buffer.from(image.buffer) }, event.request, { scope: 'private', maxAge: 300, bounded: false });
        },
    },
});
