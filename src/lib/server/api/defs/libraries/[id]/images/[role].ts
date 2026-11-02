// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * libraries/{id}/images/{role} — library group image endpoint.
 *
 * Serves the auto-generated mosaic backdrop for a library group.
 * All roles (poster | backdrop | thumb | primary | logo | banner) map to the
 * same underlying 16:9 mosaic image — the library has one composite artwork.
 * Empty libraries fall back to a static placeholder.
 *
 * Auth: user — library images are not public (auth required to browse libraries).
 *
 * Class R: raw image bytes on success; problem+json on pre-stream failure.
 */

import { IMAGE_PROXY_RATE_LIMIT } from '$lib/server/middleware/valkey-rate-limit.js';
import { z } from 'zod';
import {
    LibraryImageQuery,
    libraryImageResponse,
} from '$lib/server/services/image-proxy/library-response.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    getLibraryBackdrop,
    getLibraryPlaceholder,
    isLibraryGroup,
} from '$lib/server/services/library-backdrop.service.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LibrariesImagesRoute');

const ALLOWED_ROLES = new Set(['poster', 'backdrop', 'thumb', 'primary', 'logo', 'banner']);

// ---------------------------------------------------------------------------
// Request schema — params
// ---------------------------------------------------------------------------

/**
 * Params schema for GET /libraries/{id}/images/{role}.
 *
 * `id` is a plain string path segment (NOT .uuid()): the handler runs its own
 * version-agnostic isUuid() check (which also accepts no-dash UUIDs) and 422s a
 * truly malformed id, so it stays authoritative. A stricter schema .uuid() here
 * would pre-reject formerly-valid ids (e.g. no-dash UUIDs) the handler accepts.
 */
const LibraryImageParams = z.object({
    id: z.string().min(1),
    role: z.string().min(1),
});

// Library-group access is checked before serving private artwork.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Admin'],
            summary: 'Get library image',
            stability: 'stable',
            auth: 'bearer',
            query: LibraryImageQuery,
            description:
                'Upstream provider work is limited to 2000 requests per 60 seconds per authenticated user or 300 per anonymous client IP, shared across image routes and surfaces. Cache hits and local files do not consume the provider budget. Uncached encodes have a separate limit of 1000 per 60 seconds per authenticated user or 300 per anonymous/signed client (verified user if available, otherwise IP); cache hits are free. Anonymous and signed requests always use tiered quality, and AVIF is limited to standard size presets. ' +
                'Returns an image for a library group by role ' +
                '(`poster`, `backdrop`, `thumb`, `primary`, `logo`, `banner`). ' +
                'All roles map to the same auto-generated composite mosaic artwork for the library. ' +
                'Authentication required (library browsing requires a session). ' +
                'Returns raw image bytes. Responses include ETag and stale-while-revalidate headers; ' +
                'a 304 is returned when `If-None-Match` matches the current ETag. ' +
                'Size presets: thumb=256, card=512, hd=1280 pixels wide; full=generated original. ' +
                'Responses are private and vary by Authorization and Cookie. Only bounded sizes with v are immutable.',
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/png'],
                    description: 'Library mosaic image bytes.',
                },
                304: {
                    description: 'Not Modified — client cache is current (ETag matched)',
                    headers: {
                        ETag: { description: 'Echoes the validator that matched.' },
                    },
                },
                400: 'Invalid library ID or role',
                401: 'Authentication required',
                404: 'Library not found or no image available',
                503: 'Database unavailable',
                429: 'Image request budget exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    rateLimit: IMAGE_PROXY_RATE_LIMIT,
    raw: true,
    request: {
        query: LibraryImageQuery,
        params: LibraryImageParams,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const { params, request, locals } = event;
            const id = params.id ?? '';
            const role = (params.role ?? '').toLowerCase();

            if (!id || !isUuid(id)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid library ID — must be a UUID' },
                ]);
            }
            if (!ALLOWED_ROLES.has(role)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'role',
                        message: `Invalid image role "${role}". Valid roles: ${[...ALLOWED_ROLES].join(', ')}`,
                    },
                ]);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // Distinguish "library doesn't exist" (404) from a DB error (503).
            let exists: boolean;
            try {
                exists = await isLibraryGroup(sql, id, toLibraryAccessUser(locals.user));
            } catch (err) {
                logger.warn('isLibraryGroup failed', { id, error: (err as Error).message });
                return ApiProblem.dependencyUnavailable('Database error checking library');
            }
            if (!exists) {
                return ApiProblem.notFound('Library not found');
            }

            const result =
                (await getLibraryBackdrop(sql, id)) ?? (await getLibraryPlaceholder(sql, id));
            if (!result) {
                logger.debug('No backdrop or placeholder available for library', { id });
                return ApiProblem.notFound('Library image not available');
            }

            return libraryImageResponse(result, request);
        },
    },
});
