// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — v1 delegates to the shared authenticated internal handler.
// The handler selects image URLs from the request surface and projects public DTOs.

import { z } from 'zod';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { MusicArtistsResponseSchema } from '$lib/schemas/api-music-responses.js';

export const def = defineEndpoint({
    // Runtime gate is `requireAuth` inside the delegated internal handler.
    auth: { kind: 'public' },

    // OpenAPI docs for the /api/v1/music/artists surface. Migrated verbatim from
    // the retired src/routes/api/v1/music/artists/_openapi.ts.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Browse music artists',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns a paginated list of artists. Filter by genre, sort by alpha, year, or recently added.',
            query: z.object({
                limit: z.coerce.number().int().min(1).max(200).optional().meta({
                    description: 'Maximum items to return (default: 100, max: 200)',
                }),
                offset: z.coerce.number().int().min(0).optional().meta({
                    description: 'Offset for pagination (default: 0)',
                }),
                genre: z.string().optional().meta({ description: 'Filter by genre name' }),
                sort: z.enum(['alpha', 'year', 'recent']).optional().meta({
                    description:
                        'Sort order: alpha (A-Z), year (newest first), recent (recently added). Default: alpha',
                }),
                includeTotal: z
                    .enum(['1', 'true'])
                    .optional()
                    .meta({
                        description:
                            'Include page.total (an extra COUNT over the same filters). ' +
                            'Omit on infinite-scroll pages — hasMore is enough there.',
                    }),
            }),
            responses: {
                200: {
                    schema: MusicArtistsResponseSchema,
                    description: 'Paginated artist list',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        // Delegate to the untouched internal handler (dynamic import — see
        // defs/music/albums.ts for why static import would hang the generator).
        GET: async (event: RequestEvent) => {
            const internal =
                (await import('../../../../../routes/api/music/artists/+server.js')) as {
                    GET: RequestHandler;
                };
            return internal.GET(event);
        },
    },
});
