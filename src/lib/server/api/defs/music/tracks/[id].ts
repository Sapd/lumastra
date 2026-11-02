// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — this def is NOT generator-mounted. Its internal
// counterpart (src/routes/api/music/tracks/[id]/+server.ts) is a bespoke
// requireAuth-wrapped handler that stays authoritative and untouched; this def
// exists ONLY to carry the /api/v1/music/tracks/{id} doc metadata and delegate
// the v1 request to that internal handler (Option B — v1-only delegate).

/**
 * defs/music/tracks/[id].ts — GET /api/v1/music/tracks/{id} (public/native).
 *
 * Delegate to the raw `requireAuth(withErrorHandler(...))` internal handler
 * (Option B). See defs/music/albums.ts for the full rationale. The internal
 * handler selects the artwork surface from the request path, preserving v1
 * links for bearer clients and internal links for the web.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { MusicTrackDetailResponseSchema } from '$lib/schemas/api-music-responses.js';

export const def = defineEndpoint({
    // Runtime gate is `requireAuth` inside the delegated internal handler.
    auth: { kind: 'public' },

    // OpenAPI docs for the /api/v1/music/tracks/{id} surface. Migrated verbatim
    // from the retired src/routes/api/v1/music/tracks/[id]/_openapi.ts.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get track detail',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns full track metadata including audio features (BPM, key, energy, beat grid, intro/outro boundaries) computed at scan time, plus per-user context such as explicit feedback (like/dislike).',
            responses: {
                200: {
                    schema: MusicTrackDetailResponseSchema,
                    description: 'Track detail with audio features and user context',
                },
                401: 'Authentication required',
                404: 'Track not found',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        // Delegate to the untouched internal handler (dynamic import — see
        // defs/music/albums.ts for why static import would hang the generator).
        GET: async (event: RequestEvent) => {
            const internal =
                (await import('../../../../../../routes/api/music/tracks/[id]/+server.js')) as {
                    GET: RequestHandler;
                };
            return internal.GET(event);
        },
    },
});
