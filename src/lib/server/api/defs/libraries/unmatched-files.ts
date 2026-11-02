// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/libraries/unmatched-files.ts — GET /api/v1/libraries/unmatched-files
 *
 * Files that could not be matched to media items. Requires `library:admin`
 * scope; delegates to the internal admin read path.
 *
 * NOTE: Match/dismiss operations on unmatched files remain session-only
 * (human-judged, interactive confirm) — no write methods here.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/libraries/unmatched-files/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/unmatched-files/+server.js';
import { UnmatchedFilesCollectionResponseSchema } from '$lib/schemas/api-admin-library-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List unmatched personal media items',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: UnmatchedFilesCollectionResponseSchema,
                    description: 'Paginated unmatched media items with library group filters',
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
