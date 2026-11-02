// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/external-ids.ts
 *
 * GET    /api/v1/media/{id}/external-ids — list external IDs
 * PUT    /api/v1/media/{id}/external-ids — add/update external ID
 * DELETE /api/v1/media/{id}/external-ids?provider=tmdb — remove external ID
 *
 * Requires `media:admin` scope; delegates to the internal admin handlers.
 *
 * Schema source: $lib/schemas/api-media-responses (single source of truth,
 * mirrors the schemas in the admin def at defs/admin/media/[id]/external-ids.ts).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/external-ids/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    PUT as adminPUT,
    DELETE as adminDELETE,
} from '../../../../../../routes/api/admin/media/[id]/external-ids/+server.js';
import {
    ExternalIdsGetResponseSchema,
    ExternalIdMutateResponseSchema,
    ExternalIdDeleteResponseSchema,
} from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Media'],
            summary: 'List external IDs for a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ExternalIdsGetResponseSchema,
                    description: 'All external provider IDs for the media item',
                },
                401: 'Authentication required',
                404: 'Media item not found',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Media'],
            summary: 'Upsert an external ID for a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ExternalIdMutateResponseSchema,
                    description: 'External ID upserted',
                },
                401: 'Authentication required',
                404: 'Media item not found',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Media'],
            summary: 'Remove an external ID from a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: { schema: ExternalIdDeleteResponseSchema, description: 'External ID removed' },
                401: 'Authentication required',
                404: 'Media item or external ID not found',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
        PUT: async (event) => {
            return delegateToAdmin(event, adminPUT!);
        },
        DELETE: async (event) => {
            return delegateToAdmin(event, adminDELETE!);
        },
    },
});
