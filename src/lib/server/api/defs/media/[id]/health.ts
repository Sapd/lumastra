// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/health.ts — GET /api/v1/media/{id}/health
 *
 * File-health probe for a single item. Requires `media:admin` scope; delegates
 * to the internal admin read path.
 *
 * Schema source: MediaHealthResponseSchema in $lib/schemas/api-media-responses
 * (single source of truth, mirrors HealthGetResponseSchema in the admin def at
 * defs/admin/media/[id]/health/index.ts).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/health/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../../routes/api/admin/media/[id]/health/+server.js';
import { MediaHealthResponseSchema } from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Media'],
            summary: 'Get media item health report',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaHealthResponseSchema,
                    description: 'Health report (null when not yet computed)',
                },
                401: 'Authentication required',
                404: 'Media item not found',
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
