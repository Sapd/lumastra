// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — this def is NOT generator-mounted. Its logic lives
// in the shared handler (src/lib/server/api/handlers/music-artist-detail.handler.ts),
// which both this delegate and the internal route
// (src/routes/api/music/artists/[id]/+server.ts) call with different
// {surface} options — see music-album-detail.handler.ts's
// file comment for the full rationale (identical pattern, mirrored here).

/**
 * defs/music/artists/[id].ts — GET /api/v1/music/artists/{id} (public/native).
 *
 * Delegate to the shared requireAuth-wrapped handler (Option B). See
 * defs/music/albums/[id].ts for the full rationale.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { MusicArtistDetailResponseSchema } from '$lib/schemas/api-music-responses.js';

export const def = defineEndpoint({
    // Runtime gate is `requireAuth` inside the shared handler.
    auth: { kind: 'public' },

    // OpenAPI docs for the /api/v1/music/artists/{id} surface. Migrated verbatim
    // from the retired src/routes/api/v1/music/artists/[id]/_openapi.ts.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get artist detail with discography',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns artist metadata plus full album list and track listing. ' +
                'Optional discogsAttribution contains exact Discogs artist/release URLs by selected field; display Data provided by Discogs adjacent to sourced content, without nofollow.',
            responses: {
                200: {
                    schema: MusicArtistDetailResponseSchema,
                    description: 'Artist detail with albums and tracks',
                },
                401: 'Authentication required',
                404: 'Artist not found',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        // Delegate to the shared handler, parameterized for the v1 surface.
        // Dynamic import keeps the OpenAPI generator (which statically
        // imports THIS def to read `docs`) from loading aiDbService's
        // runtime deps (→ valkey-glide native), which would otherwise hang
        // the generator.
        GET: async (event: RequestEvent) => {
            const { createArtistDetailHandler } =
                await import('$lib/server/api/handlers/music-artist-detail.handler.js');
            const handler = createArtistDetailHandler({ surface: 'v1' });
            return handler(event);
        },
    },
});
