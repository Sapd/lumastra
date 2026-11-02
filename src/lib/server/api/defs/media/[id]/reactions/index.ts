// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/reactions/index.ts — GET/PUT/DELETE /media/{id}/reactions
 *
 * The media access gate runs before reaction operations so that callers who
 * cannot access a media item cannot list or post reactions on it either.
 * Returns 404 on denial — matching GET /media/{id} behaviour.
 *
 * Mounted at:
 *   src/routes/api/v1/media/[id]/reactions/+server.ts
 */

import { makeReactionsDef } from '$lib/server/api/defs/interactions/handlers.js';
import { mediaAccessGate } from '$lib/server/api/defs/media/[id]/access-gate.js';
import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';

const ReactionItemSchema = z.object({
    emoji: z.string().meta({ description: 'The emoji character' }),
    count: z.number().int().meta({ description: 'Number of users who reacted with this emoji' }),
    reactedByMe: z
        .boolean()
        .meta({ description: 'Whether the caller has reacted with this emoji' }),
});

const ReactionsResponseSchema = z.object({
    items: z.array(ReactionItemSchema),
});

const ReactionBodySchema = z.object({
    emoji: z.string().min(1).meta({ description: 'Emoji reaction character' }),
});

const ReactionQuerySchema = z.object({
    emoji: z.string().min(1).meta({ description: 'Emoji reaction character to remove' }),
});

const docs: RouteMetadata = {
    GET: {
        tags: ['Media'],
        summary: 'Get reactions on a media item',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Returns aggregated reaction counts for a media item, and whether the caller reacted ' +
            'with each emoji. The media access gate applies — returns 404 if the caller cannot access the item.',
        responses: {
            200: {
                schema: ReactionsResponseSchema,
                description: 'Reaction counts',
            },
            401: 'Authentication required',
            404: 'Media not found or not accessible, or comments and reactions are disabled',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    PUT: {
        tags: ['Media'],
        summary: 'Add or update a reaction on a media item',
        stability: 'beta',
        auth: 'bearer',
        description:
            "Adds the caller's reaction (by emoji) to a media item. Idempotent upsert. " +
            'The media access gate applies — returns 404 if the caller cannot access the item.',
        body: ReactionBodySchema,
        responses: {
            204: 'Reaction added (no content)',
            400: 'Validation error',
            401: 'Authentication required',
            404: 'Media not found or not accessible, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    DELETE: {
        tags: ['Media'],
        summary: "Remove the caller's reaction from a media item",
        stability: 'beta',
        auth: 'bearer',
        description:
            "Removes the caller's reaction with the emoji in the `emoji` query parameter from a media item. Idempotent — no-op if not present. " +
            'The media access gate applies.',
        query: ReactionQuerySchema,
        responses: {
            204: 'Reaction removed (no content)',
            400: 'Validation error',
            401: 'Authentication required',
            404: 'Media not found or not accessible, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeReactionsDef('media', mediaAccessGate, docs);
