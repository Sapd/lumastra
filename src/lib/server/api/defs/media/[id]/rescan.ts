// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/rescan.ts — POST /api/v1/media/{id}/rescan
 *
 * Trigger on-demand audio analysis. Requires `media:admin` scope; delegates to
 * the internal admin write path.
 *
 * Schema source: MediaRescanResponseSchema in $lib/schemas/api-media-responses
 * (authored from RescanResponseSchema in defs/admin/media/[id]/rescan.ts which
 * returns json({ bpm, key, energy, danceability, loudness_lufs }) — all nullable).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/rescan/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { POST as adminPOST } from '../../../../../../routes/api/admin/media/[id]/rescan/+server.js';
import { MediaRescanResponseSchema } from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Media'],
            summary: 'Post media {id} rescan',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaRescanResponseSchema,
                    description: 'Essentia audio analysis result',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event) => {
            return delegateToAdmin(event, adminPOST!);
        },
    },
});
