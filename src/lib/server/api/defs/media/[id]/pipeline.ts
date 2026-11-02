// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/pipeline.ts
 *
 * GET  /api/v1/media/{id}/pipeline — fetch enrichment-pipeline state
 * POST /api/v1/media/{id}/pipeline — trigger/reset enrichment step
 *
 * Requires `media:admin` scope; delegates to the internal admin handlers.
 *
 * Schema source: $lib/schemas/api-media-responses (single source of truth,
 * mirrors the schemas in the admin def at defs/admin/media/[id]/pipeline/index.ts).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/pipeline/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    POST as adminPOST,
} from '../../../../../../routes/api/admin/media/[id]/pipeline/+server.js';
import {
    MediaPipelineGetResponseSchema,
    MediaPipelineResetResponseSchema,
} from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Media'],
            summary: 'Get media item processing pipeline state',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaPipelineGetResponseSchema,
                    description: 'Stage rows and summary counts',
                },
                401: 'Authentication required',
                404: 'Media item not found',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Media'],
            summary: 'Reset (or force-requeue) media pipeline stages',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaPipelineResetResponseSchema,
                    description: 'Number of stages reset',
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
        POST: async (event) => {
            return delegateToAdmin(event, adminPOST!);
        },
    },
});
