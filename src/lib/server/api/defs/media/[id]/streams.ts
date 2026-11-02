// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/streams.ts — GET /api/v1/media/{id}/streams
 *
 * List transcode streams for a media item. Requires `media:admin` scope;
 * delegates to the internal admin read path.
 *
 * Schema source: MediaStreamsResponseSchema in $lib/schemas/api-media-responses
 * (authored from the StreamsResponseSchema shape in
 * defs/admin/media/[id]/streams.ts which returns json({ streams: MediaStreamRow[] })).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/streams/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../../routes/api/admin/media/[id]/streams/+server.js';
import { MediaStreamsResponseSchema } from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        GET: {
            visibility: 'internal',
            tags: ['Media'],
            summary: 'Get media {id} streams',
            stability: 'protocol',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaStreamsResponseSchema,
                    description: 'Video, audio, and subtitle track rows for this media item',
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
