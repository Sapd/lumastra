// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/comments/index.ts — GET/POST /playlists/{id}/comments
 *
 * Chat messages are stored in the polymorphic `interactions` table
 * (target_type='playlist').
 *
 * Auth: any authenticated user who can access the playlist (member OR owner
 * OR visibility='public'). Non-members on a private playlist receive 404 to
 * avoid leaking the playlist's existence.
 *
 * Mounted at:
 *   src/routes/api/v1/playlists/[id]/comments/+server.ts
 */

import { makeCommentsDef } from '$lib/server/api/defs/interactions/handlers.js';
import { playlistAccessGate } from '$lib/server/api/defs/playlists/[id]/access-gate.js';
import type { RouteMetadata } from '$lib/server/openapi';
import { publicAuthorSchema } from '$lib/schemas/public-author.js';
import { z } from 'zod';
import { PageBlockSchema } from '$lib/schemas/api-for-you-responses';

const CommentSchema = z.object({
    id: z.string(),
    author: publicAuthorSchema,
    body: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
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
        tags: ['Playlists'],
        summary: 'List comments on a playlist',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Returns comments on a playlist. ' +
            'The caller must have access to the playlist (member, owner, or public). ' +
            "Non-members on a private playlist receive 404 to avoid leaking the playlist's existence.",
        responses: {
            200: {
                schema: CommentsResponseSchema,
                description: 'Comment list',
            },
            401: 'Authentication required',
            404: 'Playlist not found or not accessible, or comments and reactions are disabled',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    POST: {
        tags: ['Playlists'],
        summary: 'Post a comment on a playlist',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Adds a comment to a playlist. The caller must have access to the playlist. ' +
            'Returns 404 on access denial.',
        body: PostBodySchema,
        responses: {
            201: {
                schema: PostResponseSchema,
                description: 'Comment created',
            },
            400: 'Validation error',
            401: 'Authentication required',
            404: 'Playlist not found or not accessible, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeCommentsDef('playlist', playlistAccessGate, docs);
