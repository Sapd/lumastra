// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/metadata-admin.ts
 *
 * GET   /api/v1/media/{id}/metadata — fetch custom metadata JSONB
 * PATCH /api/v1/media/{id}/metadata — write custom metadata fields
 *
 * Requires `media:admin` scope; delegates to the internal admin handlers.
 *
 * NAMING NOTE: this file is named `metadata-admin.ts` (NOT the convention path
 * `metadata.ts`) because `defs/media/[id]/metadata.ts` already exists and is an
 * UNRELATED, already-generator-mounted def (`GET/PATCH/DELETE /api/media/[id]/metadata`
 * — lock-status + editable-metadata endpoint, admin-gated with a different
 * response shape). That def's own v1 twin was never created (both its surfaces
 * are hand-mounted), so this v1-only "custom metadata JSONB" endpoint can
 * safely claim the `/api/v1/media/{id}/metadata` path without colliding with
 * it. Do NOT rename this file to `metadata.ts` — doing so would silently
 * overwrite the lock-status def.
 *
 * Schema source: $lib/schemas/api-media-responses (single source of truth,
 * mirrors the schemas in the admin def at defs/admin/media/[id]/metadata.ts).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/metadata/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    PATCH as adminPATCH,
} from '../../../../../../routes/api/admin/media/[id]/metadata/+server.js';
import {
    MediaMetadataGetResponseSchema,
    MediaMetadataPatchResponseSchema,
} from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Media'],
            summary: 'Get custom metadata for a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaMetadataGetResponseSchema,
                    description: 'Custom metadata JSONB field',
                },
                401: 'Authentication required',
                404: 'Media item not found',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Media'],
            summary: 'Merge custom metadata into a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: { schema: MediaMetadataPatchResponseSchema, description: 'Metadata updated' },
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
        PATCH: async (event) => {
            return delegateToAdmin(event, adminPATCH!);
        },
    },
});
