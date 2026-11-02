// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/chapters.ts — GET /api/v1/media/{id}/chapters
 *
 * List detected chapter data. Requires `media:admin` scope; delegates to the
 * internal admin read path.
 *
 * Schema source: MediaChaptersResponseSchema in $lib/schemas/api-media-responses
 * (single source of truth, mirrors ChaptersResponseSchema in the admin
 * media-chapters def at defs/admin/media/[id]/chapters/index.ts). The v1 handler
 * delegates to that admin route, which returns json({ chapters, episodesWithChapters })
 * where chapters is an array of stored chapter markers with startMs/endMs.
 * NOTE: this is DISTINCT from the selected-file playback timeline response.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/chapters/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../../routes/api/admin/media/[id]/chapters/+server.js';
import { MediaChaptersResponseSchema } from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Media'],
            summary: 'Get media {id} chapters',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaChaptersResponseSchema,
                    description:
                        'Stored chapter markers for the media item (or all chapters by episode for a series)',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
    },
});
