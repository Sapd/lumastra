// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * users/{id}/images/{role}/{index} — §7.1 Nth image for a user role.
 *
 * Only `avatar` role is valid and only index 0 is available.
 * Delegates to users/{id}/images/{role} for index 0.
 *
 * Auth: GET any authenticated principal; PUT/DELETE selfOrAdmin.
 * Class R: raw image bytes on success (GET); problem+json otherwise.
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
 * Params schema for GET|PUT|DELETE /users/{id}/images/{role}/{index}.
 *
 * `id` is a plain string path segment (NOT .uuid()): PUT/DELETE run the
 * selfOrAdmin auth check and the role handler resolves/404s an unknown id, so a
 * malformed id must reach the handler to preserve 401/403/404 ordering rather
 * than a pre-auth 422.
 */
const UserImageIndexParams = z.object({
    id: z.string().min(1),
    role: z.string().min(1),
    index: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Users'],
            query: roleDef.docs?.GET?.query,
            summary: 'Get the Nth image for a user role',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the image at `{index}` for the given `{role}` for a user. ' +
                'Users expose the `avatar` role; only index 0 is available. ' +
                'Delegates to `GET /api/v1/users/{id}/images/{role}` for index 0. ' +
                'Requires authentication (401 otherwise). ' +
                'Returns raw image bytes.',
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/png'],
                    description: 'Image bytes',
                },
                302: 'Redirect to fallback placeholder image',
                400: 'Invalid role or index',
                401: 'Authentication required',
                404: 'User not found or index out of range',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'user' },
        PUT: { kind: 'selfOrAdmin', param: 'id' },
        DELETE: { kind: 'selfOrAdmin', param: 'id' },
    },
    raw: true,
    request: {
        query: roleDef.request?.query,
        params: UserImageIndexParams,
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
            // The delegate reads the URL directly. Pass only surface context so
            // indexed path input is not confused with the role route's input.
            const delegateCtx: Parameters<typeof roleHandler>[1] = {
                surface: ctx.surface,
                idempotencyKey: ctx.idempotencyKey,
            };
            return roleHandler(event, delegateCtx);
        },
    },
});
