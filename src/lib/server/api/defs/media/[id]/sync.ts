// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/sync.ts — POST /api/v1/media/{id}/sync
 *
 * Trigger per-item metadata sync (enqueues series sync). Requires `media:admin`
 * scope; delegates to the internal admin write path.
 *
 * Schema source: MediaSyncResponseSchema in $lib/schemas/api-media-responses
 * (union of two shapes from defs/admin/media/[id]/sync.ts):
 *   - Inline (includeChildren=false): { updated: boolean, fieldsChanged: string[] }
 *   - Queued (includeChildren=true):  { started: boolean, runId: string }
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/media/[id]/sync/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { POST as adminPOST } from '../../../../../../routes/api/admin/media/[id]/sync/+server.js';
import { MediaSyncResponseSchema } from '$lib/schemas/api-media-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    docs: {
        POST: {
            visibility: 'internal',
            tags: ['Media'],
            summary: 'Post media {id} sync',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaSyncResponseSchema,
                    description:
                        'Inline sync result ({ updated, fieldsChanged }) for single items, ' +
                        'or queued-job ack ({ started, runId }) for series with includeChildren=true',
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
