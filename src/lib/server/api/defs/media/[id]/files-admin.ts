// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/files-admin.ts — GET /api/v1/media/{id}/files
 *
 * List physical files attached to a media item. Requires `media:admin` scope;
 * delegates to the internal admin read path.
 *
 * NAMING NOTE: this file is named `files-admin.ts` (NOT the convention path
 * `files.ts`) because `defs/media/[id]/files.ts` already exists and is an
 * UNRELATED, already-generator-mounted def (`GET /api/media/[id]/files` →
 * `{ editions }`, the edition-picker endpoint consumed by the watch page). That
 * def's own v1 twin was never created (both its surfaces are hand-mounted), so
 * this v1-only admin "list files" endpoint can safely claim the
 * `/api/v1/media/{id}/files` path without colliding with it. Do NOT rename this
 * file to `files.ts` — doing so would silently overwrite the editions def.
 *
 * Schema source: MediaFilesResponseSchema in $lib/schemas/api-media-responses
 * (single source of truth, mirrors FilesResponseSchema in the admin def at
 * defs/admin/media/[id]/files.ts). The handler returns base file rows for the
 * item, or a union of base + child-context rows when ?children=true.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/files/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../../routes/api/admin/media/[id]/files/+server.js';
import { MediaFilesResponseSchema } from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Media'],
            summary: 'List files attached to a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaFilesResponseSchema,
                    description: 'Files attached to the media item',
                },
                401: 'Authentication required',
                404: 'Media item not found',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            const response = await delegateToAdmin(event, adminGET!);
            if (!response.ok) return response;
            // The internal admin response carries private diagnostic observations.
            // Parse the public schema here, where delegation otherwise bypasses it.
            const body: unknown = await response.json();
            return json(MediaFilesResponseSchema.parse(body), { status: response.status });
        },
    },
});
