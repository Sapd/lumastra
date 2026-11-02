// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * libraries/{id}/images/{role}/{index} — §7.1 Nth image for a library role.
 *
 * Libraries serve one composite mosaic image per role, so only index 0 is
 * available. Delegates to libraries/{id}/images/{role} for index 0.
 *
 * Auth: user.
 * Class R: raw image bytes on success; problem+json on pre-stream failure.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { def as roleDef } from '../[role].js';

function parseIndex(raw: string): number | null {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Params schema for GET /libraries/{id}/images/{role}/{index}.
 *
 * `id` is a plain string (NOT .uuid()): this def delegates to the [role]
 * handler whose version-agnostic isUuid() check is authoritative, so a stricter
 * schema here would only pre-reject formerly-valid ids (e.g. no-dash UUIDs).
 */
const LibraryImageIndexParams = z.object({
    id: z.string().min(1),
    role: z.string().min(1),
    index: z.string().min(1),
});

// ownership: library-group — delegates to libraries/{id}/images/{role}, which checks
// library-group access before serving private artwork.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Admin'],
            query: roleDef.docs?.GET?.query,
            summary: 'Get the Nth image for a library role',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Upstream provider work is limited to 2000 requests per 60 seconds per authenticated user or 300 per anonymous client IP, shared across image routes and surfaces. Cache hits and local files do not consume the provider budget. Uncached encodes have a separate limit of 1000 per 60 seconds per authenticated user or 300 per anonymous/signed client (verified user if available, otherwise IP); cache hits are free. Anonymous and signed requests always use tiered quality, and AVIF is limited to standard size presets. ' +
                'Returns the image at `{index}` for the given `{role}` for a library. ' +
                'Libraries serve one composite mosaic image per role, so only index 0 is available. ' +
                'Delegates to `GET /api/v1/libraries/{id}/images/{role}` for index 0. ' +
                'Returns raw image bytes.',
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/png'],
                    description: 'Image bytes',
                },
                302: 'Redirect to fallback image',
                400: 'Invalid role or index out of range (only index 0 exists)',
                404: 'Library not found',
                429: 'Image request budget exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    rateLimit: roleDef.rateLimit,
    raw: true,
    request: {
        query: roleDef.request?.query,
        params: LibraryImageIndexParams,
    },
    handlers: {
        GET: async (event, ctx) => {
            const rawIndex = event.params.index ?? '0';
            const index = parseIndex(rawIndex);

            if (index === null) {
                return ApiProblem.validationFailed([
                    {
                        field: 'index',
                        message: `Invalid image index "${rawIndex}". Must be a non-negative integer.`,
                    },
                ]);
            }

            if (index > 0) {
                return ApiProblem.notFound(
                    `Image index ${index} not available. This role has only 1 image (index 0).`,
                );
            }

            const roleHandler = roleDef.handlers.GET;
            if (!roleHandler) {
                return ApiProblem.internalError('Image handler not available');
            }
            return roleHandler(event, { surface: ctx.surface, idempotencyKey: ctx.idempotencyKey });
        },
    },
});
