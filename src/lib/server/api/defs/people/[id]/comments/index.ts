// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/people/[id]/comments/index.ts — GET/POST /people/{id}/comments
 *
 * Mounted at:
 *   src/routes/api/v1/people/[id]/comments/+server.ts
 */

import { makeCommentsDef } from '$lib/server/api/defs/interactions/handlers.js';
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
        tags: ['People'],
        summary: 'List comments on a person',
        stability: 'beta',
        auth: 'bearer',
        description: 'Returns comments posted on a person (actor/director/crew member).',
        responses: {
            200: {
                schema: CommentsResponseSchema,
                description: 'Comment list',
            },
            422: 'Invalid person handle; use tmdb:123 or a positive numeric alias. Aliases share one canonical interaction target.',
            401: 'Authentication required',
            404: 'Person not found, or comments and reactions are disabled',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    POST: {
        tags: ['People'],
        summary: 'Post a comment on a person',
        stability: 'beta',
        auth: 'bearer',
        description: 'Adds a comment to a person profile.',
        body: PostBodySchema,
        responses: {
            201: {
                schema: PostResponseSchema,
                description: 'Comment created',
            },
            400: 'Validation error',
            422: 'Invalid person handle; use tmdb:123 or a positive numeric alias. Aliases share one canonical interaction target.',
            401: 'Authentication required',
            404: 'Person not found, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeCommentsDef('person', undefined, docs);
