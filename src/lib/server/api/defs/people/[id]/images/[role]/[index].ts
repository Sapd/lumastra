// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * people/{id}/images/{role}/{index} — §7.1 Nth image for a person role.
 *
 * Only `profile` role is valid and only index 0 is available.
 * Delegates to the existing people/{id}/images/{role} handler for index 0.
 *
 * Auth: user.
 * Class R: raw image bytes on success; problem+json on pre-stream failure.
 */

import { parsePersonHandle } from '$lib/shared/person-handle.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { def as roleDef } from '../[role].js';

const PeopleImageIndexQuerySchema = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    size: z
        .enum(['thumb', 'card', 'full', 'w45', 'w185', 'h632', 'original'])
        .optional()
        .meta({ description: 'Named size preset' }),
    quality: z.coerce
        .number()
        .int()
        .optional()
        .meta({ description: 'Ignored by the delegated [role] handler outside its valid range' }),
});

function parseIndex(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Query schema for GET /people/{id}/images/{role}/{index}.
 *
 * Mirrors people/{id}/images/{role} — same optional query params.
 */
const PeopleImageIndexQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    size: z.enum(['thumb', 'card', 'full', 'w45', 'w185', 'h632', 'original']).optional(),
    // Coercion only; the delegated [role] handler ignores out-of-range quality.
    quality: z.coerce.number().int().optional(),
});

// ownership: none — see people/[id]/images/index.ts. Provider artwork, no
// per-user dimension.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['People'],
            summary: 'Get the Nth image for a person role',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Upstream provider work is limited to 2000 requests per 60 seconds per authenticated user or 300 per anonymous client IP, shared across image routes and surfaces. Cache hits and local files do not consume the provider budget. Uncached encodes have a separate limit of 1000 per 60 seconds per authenticated user or 300 per anonymous/signed client (verified user if available, otherwise IP); cache hits are free. Anonymous and signed requests always use tiered quality, and AVIF is limited to standard size presets. ' +
                'Returns the image at `{index}` for the given `{role}` for a person. ' +
                'People expose the `profile` role; only index 0 is available. ' +
                'Delegates to `GET /api/v1/people/{id}/images/{role}` for index 0. ' +
                'Returns raw image bytes.',
            query: PeopleImageIndexQuerySchema,
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/png'],
                    description: 'Image bytes',
                },
                302: 'Redirect to fallback image',
                422: 'Invalid person handle or index',
                401: 'Authentication required',
                404: 'Person not found or index out of range',
                429: 'Image request budget exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    rateLimit: roleDef.rateLimit,
    raw: true,
    request: {
        query: PeopleImageIndexQuery,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (!parsePersonHandle(event.params.id ?? '').ok)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid person handle' },
                ]);
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
            return roleHandler(event, ctx);
        },
    },
});
