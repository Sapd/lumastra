// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/comments/index.ts — GET/POST /media/{id}/comments
 *
 * The media access gate runs before comment operations so that callers who
 * cannot access a media item (library-group restriction, age gate) cannot
 * read or post comments on it either. Returns 404 on denial — matching the
 * behaviour of GET /media/{id} itself.
 *
 * Mounted at:
 *   src/routes/api/v1/media/[id]/comments/+server.ts
 */

import { makeCommentsDef } from '$lib/server/api/defs/interactions/handlers.js';
import { mediaAccessGate } from '$lib/server/api/defs/media/[id]/access-gate.js';
import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';
import { PageBlockSchema } from '$lib/schemas/api-for-you-responses';

const CommentSchema = z.object({
    id: z.string(),
    userId: z.string(),
    username: z.string(),
    body: z.string(),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
});

const CommentsResponseSchema = z.object({
    items: z.array(CommentSchema),
    page: PageBlockSchema,
});

const PostBodySchema = z.object({
    body: z.string().min(1).meta({ description: 'Comment text' }),
});

const PostResponseSchema = CommentSchema;

const docs: RouteMetadata = {
    GET: {
        tags: ['Media'],
        summary: 'List media comments',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Returns comments on a media item. The caller must have access to the media item ' +
            '(library-group restriction and age gate apply — returns 404 on denial).',
        responses: {
            200: {
                schema: CommentsResponseSchema,
                description: 'Comment list',
            },
            401: 'Authentication required',
            404: 'Media not found or not accessible, or comments and reactions are disabled',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    POST: {
        tags: ['Media'],
        summary: 'Post a comment on media',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Adds a comment to a media item. The caller must have access to the media item. Returns 404 on access denial.',
        body: PostBodySchema,
        responses: {
            201: {
                schema: PostResponseSchema,
                description: 'Comment created',
            },
            400: 'Validation error',
            401: 'Authentication required',
            404: 'Media not found or not accessible, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeCommentsDef('media', mediaAccessGate, docs);
