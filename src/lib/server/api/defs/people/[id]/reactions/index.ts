// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/people/[id]/reactions/index.ts
 * GET/PUT/DELETE /people/{id}/reactions
 *
 * Mounted at:
 *   src/routes/api/v1/people/[id]/reactions/+server.ts
 */

import { makeReactionsDef } from '$lib/server/api/defs/interactions/handlers.js';
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
        tags: ['People'],
        summary: 'Get reactions on a person',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Returns aggregated reaction counts for a person, and whether the caller reacted with each emoji.',
        responses: {
            200: {
                schema: ReactionsResponseSchema,
                description: 'Reaction counts',
            },
            422: 'Invalid person handle; use tmdb:123 or a positive numeric alias. Aliases share one canonical interaction target.',
            401: 'Authentication required',
            404: 'Person not found, or comments and reactions are disabled',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    PUT: {
        tags: ['People'],
        summary: 'Add or update a reaction on a person',
        stability: 'beta',
        auth: 'bearer',
        description: "Adds the caller's reaction (by emoji) to a person. Idempotent upsert.",
        body: ReactionBodySchema,
        responses: {
            204: 'Reaction added (no content)',
            400: 'Validation error',
            422: 'Invalid person handle; use tmdb:123 or a positive numeric alias. Aliases share one canonical interaction target.',
            401: 'Authentication required',
            404: 'Person not found, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    DELETE: {
        tags: ['People'],
        summary: "Remove the caller's reaction from a person",
        stability: 'beta',
        auth: 'bearer',
        description:
            "Removes the caller's reaction with the emoji in the `emoji` query parameter from a person. Idempotent — no-op if not present.",
        query: ReactionQuerySchema,
        responses: {
            204: 'Reaction removed (no content)',
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

export const def = makeReactionsDef('person', undefined, docs);
