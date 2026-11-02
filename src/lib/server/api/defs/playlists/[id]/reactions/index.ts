// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/reactions/index.ts
 * GET/PUT/DELETE /playlists/{id}/reactions
 *
 * Non-members on a private playlist receive 404 — matching the playlist
 * access semantics enforced on comments and the legacy chat route.
 *
 * Mounted at:
 *   src/routes/api/v1/playlists/[id]/reactions/+server.ts
 */

import { makeReactionsDef } from '$lib/server/api/defs/interactions/handlers.js';
import { playlistAccessGate } from '$lib/server/api/defs/playlists/[id]/access-gate.js';
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
        tags: ['Playlists'],
        summary: 'Get reactions on a playlist',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Returns aggregated reaction counts for a playlist, and whether the caller reacted with each emoji. ' +
            'The playlist access gate applies.',
        responses: {
            200: {
                schema: ReactionsResponseSchema,
                description: 'Reaction counts',
            },
            401: 'Authentication required',
            404: 'Playlist not found or not accessible, or comments and reactions are disabled',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    PUT: {
        tags: ['Playlists'],
        summary: 'Add or update a reaction on a playlist',
        stability: 'beta',
        auth: 'bearer',
        description:
            "Adds the caller's reaction (by emoji) to a playlist. Idempotent upsert. " +
            'The playlist access gate applies.',
        body: ReactionBodySchema,
        responses: {
            204: 'Reaction added (no content)',
            400: 'Validation error',
            401: 'Authentication required',
            404: 'Playlist not found or not accessible, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
    DELETE: {
        tags: ['Playlists'],
        summary: "Remove the caller's reaction from a playlist",
        stability: 'beta',
        auth: 'bearer',
        description:
            "Removes the caller's reaction with the emoji in the `emoji` query parameter from a playlist. Idempotent — no-op if not present.",
        query: ReactionQuerySchema,
        responses: {
            204: 'Reaction removed (no content)',
            400: 'Validation error',
            401: 'Authentication required',
            404: 'Playlist not found or not accessible, or comments and reactions are disabled',
            429: 'Rate limit exceeded',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};

export const def = makeReactionsDef('playlist', playlistAccessGate, docs);
