// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/libraries/coverage/backlog.ts — GET /api/v1/libraries/coverage/backlog
 *
 * Media items awaiting metadata enrichment. Requires `library:admin` scope;
 * delegates to the internal admin read path.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/libraries/coverage/backlog/`
 * `+server.ts`, which did `enforce({kind:'scope', anyOf:['library:admin']})`
 * then `delegateToAdmin(event, adminGET)`. Behaviour is IDENTICAL — see
 * defs/libraries/integrity.ts for the full rationale of this pattern.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../../routes/api/admin/coverage/backlog/+server.js';
import { CoverageBacklogResponseSchema } from '$lib/schemas/api-admin-library-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get coverage sweep backlog per stage',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: CoverageBacklogResponseSchema,
                    description: 'Coverage sweep backlog counts per stage',
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
