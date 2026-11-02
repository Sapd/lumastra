// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — this def is NOT generator-mounted. Its logic lives
// in the shared handler (src/lib/server/api/handlers/music-album-detail.handler.ts),
// which both this delegate and the internal route
// (src/routes/api/music/albums/[id]/+server.ts) call with different
// {surface} options — see that handler's file comment for
// why v1 needs a distinct surface signal here.

/**
 * defs/music/albums/[id].ts — GET /api/v1/music/albums/{id} (public/native).
 *
 * WHY A DELEGATE (not a ported handler / dual-mount): the shared handler is
 * wrapped in `requireAuth(withErrorHandler(...))`, NOT a def. Porting it into
 * mount()'s auth/response pipeline (Option A) would change the 401 body on
 * BOTH the v1 AND the internal surface. To keep runtime behaviour identical,
 * both surfaces call the same requireAuth-wrapped handler, parameterized
 * on {surface}.
 *
 * AUTH: `auth: { kind: 'public' }` makes mount()'s enforce() a NO-OP, so the
 * REAL gate is `requireAuth` inside the delegated handler. `docs.GET.auth:
 * 'bearer'` keeps the PUBLISHED security scheme unchanged.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { MusicAlbumDetailResponseSchema } from '$lib/schemas/api-music-responses.js';

export const def = defineEndpoint({
    // Runtime gate is `requireAuth` inside the shared handler.
    auth: { kind: 'public' },

    // OpenAPI docs for the /api/v1/music/albums/{id} surface. Migrated verbatim
    // from the retired src/routes/api/v1/music/albums/[id]/_openapi.ts.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get album detail with track list',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns full album metadata including all tracks with audio features. ' +
                'Optional discogsAttribution contains exact Discogs artist/release URLs by selected field (including inherited artwork); display Data provided by Discogs adjacent to sourced content, without nofollow.',
            responses: {
                200: {
                    schema: MusicAlbumDetailResponseSchema,
                    description: 'Album detail with tracks',
                },
                401: 'Authentication required',
                404: 'Album not found',
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
            const { createAlbumDetailHandler } =
                await import('$lib/server/api/handlers/music-album-detail.handler.js');
            const handler = createAlbumDetailHandler({ surface: 'v1' });
            return handler(event);
        },
    },
});
