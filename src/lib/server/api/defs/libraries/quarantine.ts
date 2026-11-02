// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/libraries/quarantine.ts — GET /api/v1/libraries/quarantine
 *
 * Quarantined media items. Requires `library:admin` scope; delegates to the
 * internal admin read path.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/libraries/quarantine/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/quarantine/+server.js';
import { QuarantineCollectionResponseSchema } from '$lib/schemas/api-admin-library-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List unresolved quarantine entries',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: QuarantineCollectionResponseSchema,
                    description: 'Paginated quarantine entries with unresolved count',
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
