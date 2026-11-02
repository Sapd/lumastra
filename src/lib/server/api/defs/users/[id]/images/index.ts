// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// ownership: any-authenticated-user — avatars are readable by every signed-in user (Watch Together, shared playlists); no per-user avatar visibility setting exists.

/** User artwork listing. Always exposes primary, served by the avatar byte route; generated initials are available when the avatar source chain misses. */

import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

const ImagesListResponseSchema = z.object({ id: z.string(), images: ImageSetSchema });

/**
 * Params schema for GET /users/{id}/images.
 *
 * `id` is a plain string path segment (NOT .uuid()): the handler resolves it
 * with its own version-agnostic isUuid() check (which also accepts no-dash
 * UUIDs). A stricter schema .uuid() would pre-reject formerly-valid ids the
 * handler accepts, so leniency is kept here and the handler stays authoritative.
 */
const UserImagesListParams = z.object({
    id: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Users'],
            summary: 'List available image roles for a user',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns which image roles are available for the given user. ' +
                'Users always expose `primary`, including generated initials when no avatar resolves. ' +
                'Even without a custom avatar, `GET /api/v1/users/{id}/images/avatar` may serve a Gravatar fallback. ' +
                'Requires authentication: an unauthenticated request gets `401`, so the endpoint is no user-existence oracle.',
            responses: {
                200: {
                    schema: ImagesListResponseSchema,
                    description: 'Available image roles',
                },
                400: 'Invalid user ID',
                401: 'Authentication required',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        params: UserImagesListParams,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { params } = event;
            const id = params.id ?? '';

            // A username is not accepted here: a name lookup would turn it into a
            // username → UUID oracle for every signed-in user.
            if (!id || !isUuid(id)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'User ID must be a UUID' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
            const images = (await userImageSets(sql, ctx.surface, [id])).get(id);
            if (!images) return ApiProblem.notFound('User not found');

            return json({ id, images });
        },
    },
});
