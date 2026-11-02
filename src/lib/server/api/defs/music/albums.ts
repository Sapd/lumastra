// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — v1 delegates to the shared authenticated internal handler.
// The handler selects image URLs from the request surface and projects public DTOs.

import { z } from 'zod';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { MusicAlbumsResponseSchema } from '$lib/schemas/api-music-responses.js';

export const def = defineEndpoint({
    // Runtime gate is `requireAuth` inside the delegated internal handler.
    auth: { kind: 'public' },

    // OpenAPI docs for the /api/v1/music/albums surface. Migrated verbatim from
    // the retired src/routes/api/v1/music/albums/_openapi.ts. `auth: 'bearer'`
    // keeps the published security scheme identical.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Browse music albums',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns a paginated list of albums. Filter by genre or artist, sort by alpha, year, or recently added.',
            query: z.object({
                limit: z.coerce.number().int().min(1).max(200).optional().meta({
                    description: 'Maximum items to return (default: 50, max: 200)',
                }),
                offset: z.coerce.number().int().min(0).optional().meta({
                    description: 'Offset for pagination (default: 0)',
                }),
                genre: z.string().optional().meta({ description: 'Filter by genre name' }),
                artist: z
                    .string()
                    .optional()
                    .meta({
                        description:
                            "Filter by the album's HIERARCHY artist display name — the single " +
                            'artist the album row is parented to, matched case-insensitively and ' +
                            'in full. It does NOT match albums where the artist only appears as a ' +
                            'credited/featured artist, so it legitimately returns an empty list ' +
                            'for an artist whose album_count is non-zero: e.g. "Copper Lanterns" is ' +
                            'credited on Mira Vale\'s album "Signals at Dawn", which is parented to Mira ' +
                            'Vale. Use artistId instead unless you specifically want ' +
                            'album-artist-credited albums only.',
                    }),
                artistId: z
                    .string()
                    .optional()
                    .meta({
                        description:
                            'Filter by artist UUID. CREDIT-AWARE: returns albums the artist owns ' +
                            'plus albums carrying a track that credits them. This is the filter ' +
                            'that agrees with MusicArtistRow.album_count, and the one to use for ' +
                            'an artist album grid. Preferred over `artist` — resolving off the ' +
                            'internal UUID avoids duplicate and punctuation-variant artist names.',
                    }),
                sort: z.enum(['alpha', 'year', 'recent']).optional().meta({
                    description:
                        'Sort order: alpha (A-Z), year (newest first), recent (recently added). Default: recent',
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
                    schema: MusicAlbumsResponseSchema,
                    description: 'Paginated album list',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        // Delegate to the untouched internal handler. Dynamic import keeps the
        // OpenAPI generator (which statically imports THIS def to read `docs`)
        // from loading the internal handler's runtime deps (aiDbService →
        // valkey-glide native), which would otherwise hang the generator.
        GET: async (event: RequestEvent) => {
            const internal =
                (await import('../../../../../routes/api/music/albums/+server.js')) as {
                    GET: RequestHandler;
                };
            return internal.GET(event);
        },
    },
});
