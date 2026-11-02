// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Library artwork listing. Generated mosaics expose primary and backdrop with content-hash revisions and bounded size variants. */

import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { libraryImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { getLibraryBackdropHash } from '$lib/server/services/library-backdrop.service.js';
import { IMAGE_PROXY_RATE_LIMIT } from '$lib/server/middleware/valkey-rate-limit.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { isLibraryGroup } from '$lib/server/services/library-backdrop.service.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';

const ImagesListResponseSchema = z.object({ id: z.string(), images: ImageSetSchema });

/**
 * Params schema for GET /libraries/{id}/images.
 *
 * `id` is a plain string (NOT .uuid()): the handler's own version-agnostic
 * isUuid() check is authoritative and 422s a malformed id, so a stricter schema
 * here would only pre-reject formerly-valid ids (e.g. no-dash UUIDs).
 */
const LibraryImagesListParams = z.object({
    id: z.string().min(1),
});

// Library-group permissions are checked before advertising artwork.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Admin'],
            summary: 'List available image roles for a library',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Upstream provider work is limited to 2000 requests per 60 seconds per authenticated user or 300 per anonymous client IP, shared across image routes and surfaces. Cache hits and local files do not consume the provider budget. Uncached encodes have a separate limit of 1000 per 60 seconds per authenticated user or 300 per anonymous/signed client (verified user if available, otherwise IP); cache hits are free. Anonymous and signed requests always use tiered quality, and AVIF is limited to standard size presets. ' +
                'Returns which image roles are available for the given library group. ' +
                'Libraries serve a single composite mosaic artwork under all roles ' +
                '(poster, backdrop, thumb, primary, logo, banner). ' +
                'Does not return raw image bytes — use `GET /api/v1/libraries/{id}/images/{role}` for that.',
            responses: {
                200: {
                    schema: ImagesListResponseSchema,
                    description: 'Available image roles',
                },
                400: 'Invalid library ID',
                401: 'Authentication required',
                404: 'Library not found',
                503: 'Database unavailable',
                429: 'Image request budget exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    rateLimit: IMAGE_PROXY_RATE_LIMIT,
    request: {
        params: LibraryImagesListParams,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { params, locals } = event;
            const id = params.id ?? '';

            if (!id || !isUuid(id)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Library ID must be a UUID' },
                ]);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            let exists: boolean;
            try {
                exists = await isLibraryGroup(sql, id, toLibraryAccessUser(locals.user));
            } catch {
                return ApiProblem.dependencyUnavailable('Database error checking library');
            }

            if (!exists) {
                return ApiProblem.notFound('Library not found');
            }

            const images = libraryImageSet(ctx.surface, id, await getLibraryBackdropHash(sql, id));

            return json({ id, images });
        },
    },
});
